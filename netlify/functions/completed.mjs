// Shared "Completed" tracking across ALL users of the dashboard link.
// GET  /api/completed        → { ids: [driveFileId, …] }
// POST /api/completed {id, done?} → add (done!==false) or remove the id; returns the list.
// Backed by Netlify Blobs (a tiny built-in KV) so a sheet one person marks
// Completed shows Completed for everyone. Degrades to an empty list (local-only)
// if Blobs isn't available, so the app never breaks.

import { getStore } from '@netlify/blobs'

const KEY = 'ids'
const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  let store
  try { store = getStore('dvd-completed') } catch { return json({ ids: [], shared: false }) }

  const read = async () => {
    try { return (await store.get(KEY, { type: 'json' })) || [] } catch { return [] }
  }

  if (req.method === 'GET') {
    return json({ ids: await read(), shared: true })
  }
  if (req.method === 'POST') {
    let body = {}
    try { body = await req.json() } catch { /* ignore */ }
    const id = String(body.id || '')
    if (!id) return json({ error: 'id is required' }, 400)
    const set = new Set(await read())
    if (body.done === false) set.delete(id); else set.add(id)
    const ids = [...set]
    try { await store.setJSON(KEY, ids) } catch { return json({ error: 'Could not persist', ids }, 502) }
    return json({ ids, shared: true })
  }
  return json({ error: 'Method not allowed' }, 405)
}
