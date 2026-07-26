// Netlify function — list the shared Drive folder's sheets (server-side, no login).
// Cloud equivalent of GET /api/drive/files. Reads Google config from Netlify
// environment variables (see server/googleDrive.js for the accepted vars).
import { driveConfigured, driveStatusDetail, listFolderFiles } from '../../server/googleDrive.js'

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async () => {
  if (!driveConfigured()) return json({ configured: false, detail: driveStatusDetail(), files: [] })
  try {
    const files = await listFolderFiles()
    return json({ configured: true, files })
  } catch (err) {
    return json({ configured: true, error: 'Google Drive list failed', detail: err.message }, 502)
  }
}
