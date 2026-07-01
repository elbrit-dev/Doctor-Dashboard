// Netlify function — list the shared Drive folder's sheets (server-side, no login).
// Cloud equivalent of GET /api/drive/files. Reads Google config from Netlify
// environment variables (see server/googleDrive.js for the accepted vars).
import { driveConfigured, driveStatusDetail, listFolderFiles } from '../../server/googleDrive.js'

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async () => {
  if (!driveConfigured()) return json(200, { configured: false, detail: driveStatusDetail(), files: [] })
  try {
    const files = await listFolderFiles()
    return json(200, { configured: true, files })
  } catch (err) {
    return json(502, { configured: true, error: 'Google Drive list failed', detail: err.message })
  }
}
