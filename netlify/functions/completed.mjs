// Shared "Completed" tracking across ALL users of the dashboard link.
// GET  /api/completed        → { ids: [driveFileId, …] }
// POST /api/completed {id, done?} → add (done!==false) or remove the id; returns the list.
// Backed by Netlify Blobs (a tiny built-in KV) so a sheet one person marks
// Completed shows Completed for everyone. Degrades to an empty list (local-only)
// if Blobs isn't available, so the app never breaks.

import { getStore } from '@netlify/blobs'

const KEY = 'ids'
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async (event) => {
  let store
  try { store = getStore('dvd-completed') } catch { return json(200, { ids: [], shared: false }) }

  const read = async () => {
    try { return (await store.get(KEY, { type: 'json' })) || [] } catch { return [] }
  }

  if (event.httpMethod === 'GET') {
    return json(200, { ids: await read(), shared: true })
  }
  if (event.httpMethod === 'POST') {
    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
    const id = String(body.id || '')
    if (!id) return json(400, { error: 'id is required' })
    const set = new Set(await read())
    if (body.done === false) set.delete(id); else set.add(id)
    const ids = [...set]
    try { await store.setJSON(KEY, ids) } catch { return json(502, { error: 'Could not persist', ids }) }
    return json(200, { ids, shared: true })
  }
  return json(405, { error: 'Method not allowed' })
}
