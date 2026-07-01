// Server-side Google Drive access — NO per-user login.
// The server reads the shared folder on everyone's behalf, so the dashboard can
// list + open sheets without any Google popup/consent in the browser.
//
// Two ways to authorize (pick ONE via env — see .env.example):
//
//   A) Service account (folder stays private):
//        GOOGLE_SERVICE_ACCOUNT_JSON = the full service-account key JSON (as one
//        line), OR GOOGLE_SERVICE_ACCOUNT_KEY_FILE = path to that .json file.
//        Then share the Drive folder with the service account's client_email.
//
//   B) API key (folder must be "Anyone with the link can view"):
//        GOOGLE_DRIVE_API_KEY = a Google API key with the Drive API enabled.
//
//   GOOGLE_DRIVE_FOLDER_ID = the folder id from its Drive URL (required).
//
// No extra npm packages: the service-account JWT is signed with Node's crypto.

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.VITE_GOOGLE_DRIVE_FOLDER_ID || ''
const API_KEY = process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY || ''
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''
const SA_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || ''

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ACCEPTED = new Set([SHEET_MIME, XLSX_MIME, 'application/vnd.ms-excel', 'text/csv'])
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

// Load the service-account key (from inline JSON or a file), if configured.
function loadServiceAccount() {
  try {
    if (SA_JSON) return JSON.parse(SA_JSON)
    if (SA_FILE) return JSON.parse(readFileSync(SA_FILE, 'utf8'))
  } catch (e) {
    throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON / key file: ${e.message}`)
  }
  return null
}

const serviceAccount = loadServiceAccount()

export const mode = serviceAccount ? 'service-account' : (API_KEY ? 'api-key' : 'none')
export const driveConfigured = () => !!FOLDER_ID && mode !== 'none'
export function driveStatusDetail() {
  if (!FOLDER_ID) return 'Set GOOGLE_DRIVE_FOLDER_ID to the shared folder id.'
  if (mode === 'none') return 'Set GOOGLE_SERVICE_ACCOUNT_JSON (private folder) or GOOGLE_DRIVE_API_KEY (public folder).'
  return null
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Mint (and cache) a Google OAuth access token from the service-account key by
// signing a JWT and exchanging it at the token endpoint.
let cachedToken = null
let tokenExpiry = 0
async function getServiceAccountToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: serviceAccount.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(serviceAccount.private_key)
  const assertion = `${signingInput}.${b64url(signature)}`

  const res = await fetch(claim.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const json = await res.json()
  cachedToken = json.access_token
  tokenExpiry = Date.now() + Number(json.expires_in || 3600) * 1000
  return cachedToken
}

// Build the auth bits for a Drive REST request: a Bearer header (service account)
// or a ?key= query param (API key).
async function authFor() {
  if (mode === 'service-account') return { headers: { Authorization: `Bearer ${await getServiceAccountToken()}` }, keyParam: '' }
  return { headers: {}, keyParam: `&key=${encodeURIComponent(API_KEY)}` }
}

// List the accepted sheet files (Google Sheets / .xlsx / .xls / .csv) directly
// inside the configured folder.
export async function listFolderFiles() {
  if (!driveConfigured()) throw new Error(driveStatusDetail() || 'Google Drive not configured.')
  const { headers, keyParam } = await authFor()
  const params = new URLSearchParams({
    q: `'${FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'name',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}${keyParam}`, { headers })
  if (!res.ok) throw new Error(`Google Drive list failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const json = await res.json()
  return (json.files || []).filter((f) => ACCEPTED.has(f.mimeType) || /\.(xlsx|xls|csv)$/i.test(f.name || ''))
}

// Download one file's bytes. Google Sheets are exported to .xlsx; other sheet
// files are downloaded as-is. Returns { buffer, filename, contentType }.
export async function downloadFile(fileId) {
  if (!driveConfigured()) throw new Error(driveStatusDetail() || 'Google Drive not configured.')
  const { headers, keyParam } = await authFor()

  // Look up the file's mime type + name first (so we know export vs. direct).
  const metaParams = new URLSearchParams({ fields: 'id,name,mimeType', supportsAllDrives: 'true' })
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?${metaParams}${keyParam}`, { headers })
  if (!metaRes.ok) throw new Error(`Google Drive metadata failed: HTTP ${metaRes.status}`)
  const meta = await metaRes.json()
  const isSheet = meta.mimeType === SHEET_MIME

  const url = isSheet
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}${keyParam}`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true${keyParam}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Google Drive download failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const filename = isSheet ? `${meta.name || 'sheet'}.xlsx` : (meta.name || 'sheet.xlsx')
  return { buffer, filename, contentType: isSheet ? XLSX_MIME : (res.headers.get('content-type') || XLSX_MIME) }
}
