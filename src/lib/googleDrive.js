// Google Drive file picker → returns a browser File the existing parseSheet()
// can read (same as a local upload). Uses the Google Picker API for the chooser
// and Google Identity Services (GIS) for OAuth. Google Sheets are exported to
// .xlsx on download; .xlsx/.xls/.csv files are downloaded as-is.
//
// Requires two build-time env vars (Vite exposes only VITE_*-prefixed vars to
// the browser — safe, these are public client identifiers, not secrets):
//   VITE_GOOGLE_API_KEY    — API key from the Google Cloud project
//   VITE_GOOGLE_CLIENT_ID  — OAuth 2.0 Web client ID (this site's origin must be
//                            listed under "Authorized JavaScript origins")
// The Google Cloud project must have the Picker API and Drive API enabled.

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
// Optional: lock the picker to ONE Drive folder so users only see the sheets in
// it (not their whole Drive). Take the id from the folder URL:
//   https://drive.google.com/drive/folders/<THIS_IS_THE_FOLDER_ID>
const FOLDER_ID = import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID
// drive.readonly: needed so the Picker can LIST an existing folder's contents.
// (drive.file only exposes files the app itself created/previously picked, so a
// setParent() folder view shows up EMPTY. We only ever read the one sheet the
// user selects.)
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PICK_MIMES = `${SHEET_MIME},${XLSX_MIME},application/vnd.ms-excel,text/csv`
const ACCEPTED = new Set([SHEET_MIME, XLSX_MIME, 'application/vnd.ms-excel', 'text/csv'])

export const driveConfigured = () => !!(API_KEY && CLIENT_ID)
export const folderConfigured = () => driveConfigured() && !!FOLDER_ID

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve()
    const s = document.createElement('script')
    s.src = src; s.async = true; s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

let pickerReady = false
async function ensurePicker() {
  await loadScript('https://apis.google.com/js/api.js')
  if (!pickerReady) {
    await new Promise((resolve, reject) => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Failed to load Google Picker')) }))
    pickerReady = true
  }
}

async function ensureGis() {
  await loadScript('https://accounts.google.com/gsi/client')
}

// One interactive OAuth token per pick (GIS handles caching/consent).
function requestToken() {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => (resp.error ? reject(new Error(resp.error_description || resp.error)) : resolve(resp.access_token)),
    })
    client.requestAccessToken({ prompt: '' })
  })
}

function showPicker(token) {
  return new Promise((resolve, reject) => {
    try {
      const gp = window.google.picker
      // Base view: the sheet file types we accept.
      const view = new gp.DocsView(gp.ViewId.DOCS)
        .setMimeTypes(PICK_MIMES)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)

      const builder = new gp.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setTitle('Select a doctor sheet')
        .setCallback((data) => {
          if (data.action === gp.Action.PICKED) resolve(data.docs[0])
          else if (data.action === gp.Action.CANCEL) resolve(null)
        })

      if (FOLDER_ID) {
        // Restrict to ONE folder: root the view there and hide the left-hand
        // navigation so users can't browse the rest of Drive. Only the files
        // (and any sub-folders) inside that folder are shown.
        view.setParent(FOLDER_ID)
        builder.addView(view).enableFeature(gp.Feature.NAV_HIDDEN)
      } else {
        // Unrestricted: the accepted-types view + an all-spreadsheets view.
        builder.addView(view).addView(new gp.DocsView(gp.ViewId.SPREADSHEETS))
      }

      builder.build().setVisible(true)
    } catch (e) { reject(e) }
  })
}

async function downloadAsFile(doc, token) {
  const isSheet = doc.mimeType === SHEET_MIME
  const url = isSheet
    ? `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google Drive download failed: HTTP ${res.status}`)
  const blob = await res.blob()
  const name = isSheet ? `${doc.name || 'sheet'}.xlsx` : (doc.name || 'sheet.xlsx')
  return new File([blob], name, { type: blob.type || XLSX_MIME })
}

// Open the Google Drive picker and return the chosen file as a browser File,
// or null if the user cancels. Throws with a readable message on any failure.
export async function pickFromDrive() {
  if (!driveConfigured()) {
    throw new Error('Google Drive is not configured. Set VITE_GOOGLE_API_KEY and VITE_GOOGLE_CLIENT_ID (and enable the Picker + Drive APIs), then rebuild.')
  }
  await Promise.all([ensurePicker(), ensureGis()])
  const token = await requestToken()
  const doc = await showPicker(token)
  if (!doc) return null
  return downloadAsFile(doc, token)
}

// ── Inline folder listing (no Picker UI) ─────────────────────────────────────
// Get an OAuth access token, cached until ~1 min before expiry. interactive
// false → silent attempt (rejects if the user hasn't consented yet); the caller
// then shows a one-time "Connect" gesture and calls again with interactive:true.
let cachedToken = null
let tokenExpiry = 0
export function getDriveToken({ interactive = true } = {}) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    try {
      if (!driveConfigured()) throw new Error('Google Drive is not configured (set VITE_GOOGLE_API_KEY and VITE_GOOGLE_CLIENT_ID, then rebuild).')
      if (cachedToken && Date.now() < tokenExpiry - 60000) return resolve(cachedToken)
      await ensureGis()
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error))
          cachedToken = resp.access_token
          tokenExpiry = Date.now() + Number(resp.expires_in || 3600) * 1000
          resolve(cachedToken)
        },
        error_callback: (err) => reject(new Error(err?.message || 'Google authorization failed')),
      })
      client.requestAccessToken({ prompt: interactive ? '' : 'none' })
    } catch (e) { reject(e) }
  })
}

// List the accepted sheet files (Google Sheets / .xlsx / .xls / .csv) directly
// inside the configured folder. Works for a My Drive folder or a Shared Drive.
export async function listFolderFiles(token) {
  if (!FOLDER_ID) throw new Error('No Drive folder configured (set VITE_GOOGLE_DRIVE_FOLDER_ID).')
  const params = new URLSearchParams({
    q: `'${FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'name',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google Drive list failed: HTTP ${res.status}`)
  const json = await res.json()
  return (json.files || []).filter((f) => ACCEPTED.has(f.mimeType) || /\.(xlsx|xls|csv)$/i.test(f.name || ''))
}

// Download one listed file (by {id,name,mimeType}) as a browser File.
export const downloadFromDrive = (doc, token) => downloadAsFile(doc, token)
