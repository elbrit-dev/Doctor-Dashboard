// Netlify function — list the shared Drive folder's sheets (server-side, no login).
// Cloud equivalent of GET /api/drive/files. Reads Google config from Netlify
// environment variables (see server/googleDrive.js for the accepted vars).
// ?deep=1 also walks one level of sub-folders (each file gets a `folder` name).
import { driveConfigured, driveStatusDetail, listFolderFiles, listSheetsDeep } from '../../server/googleDrive.js'

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (!driveConfigured()) return json({ configured: false, detail: driveStatusDetail(), files: [] })
  const deep = ['1', 'true'].includes(new URL(req.url).searchParams.get('deep') || '')
  try {
    const files = deep ? await listSheetsDeep() : await listFolderFiles()
    return json({ configured: true, files })
  } catch (err) {
    return json({ configured: true, error: 'Google Drive list failed', detail: err.message }, 502)
  }
}
