// Google Drive access for the dashboard — NO browser login.
// All Drive traffic goes through the server (/api/drive/*), which reads the
// shared folder with its own credentials. The browser only lists + downloads;
// there is no Google popup, consent, or OAuth token here anymore.

// List the sheets in the shared folder. Returns { configured, files, detail? }.
// `deep` also returns the sheets inside each sub-folder, each carrying the
// `folder` name it came from — new batches of work arrive as a new sub-folder.
export async function listFolderFiles({ deep = false } = {}) {
  const res = await fetch(`/api/drive/files${deep ? '?deep=1' : ''}`, { headers: { Accept: 'application/json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return { configured: body.configured !== false, files: body.files || [], detail: body.detail || null }
}

// Download one listed file (by {id,name}) as a browser File — same shape the
// local-upload path produces, so parseSheet() can read it unchanged.
export async function downloadFromDrive(doc) {
  const res = await fetch(`/api/drive/file/${encodeURIComponent(doc.id)}`, { headers: { Accept: '*/*' } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || `Google Drive download failed: HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const name = doc.name && /\.(xlsx|xls|csv)$/i.test(doc.name) ? doc.name : `${doc.name || 'sheet'}.xlsx`
  return new File([blob], name, { type: blob.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
