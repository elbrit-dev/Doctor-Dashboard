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
// drive.file: the app only ever sees files the user explicitly picks — the
// narrowest scope that still lets the Picker hand us the chosen file.
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PICK_MIMES = `${SHEET_MIME},${XLSX_MIME},application/vnd.ms-excel,text/csv`

export const driveConfigured = () => !!(API_KEY && CLIENT_ID)

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
      const view = new gp.DocsView(gp.ViewId.DOCS)
        .setMimeTypes(PICK_MIMES)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
      const picker = new gp.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .addView(view)
        .addView(new gp.DocsView(gp.ViewId.SPREADSHEETS))
        .setTitle('Select a doctor sheet')
        .setCallback((data) => {
          if (data.action === gp.Action.PICKED) resolve(data.docs[0])
          else if (data.action === gp.Action.CANCEL) resolve(null)
        })
        .build()
      picker.setVisible(true)
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
