// Merge padded duplicate Leads into their clean form, then delete the padded one.
//
// For each duplicate set { code, keep: "DR-<code>", remove: ["DR-000<code>", …] }:
//   1. Move every address on a `remove` Lead onto `keep` (repoint the Dynamic
//      Link). If `keep` already has the same address (same line1 + pincode), the
//      redundant copy is deleted instead — so no duplicate addresses pile up.
//   2. Delete the `remove` Lead — but ONLY once all its addresses are handled,
//      so nothing is orphaned.
//
// Frappe's built-in rename-with-merge is NOT used: on this instance (40k+ Leads)
// it hits a lock-wait timeout. These direct, per-record ops stay fast and are
// safe to continue-on-error. The frontend drives the offset loop.

const addrKey = (a) => `${String(a.address_line1 || '').trim().toLowerCase()}|${String(a.pincode || '').trim()}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// UAT returns transient 502 / lock-wait timeouts under write load. Retry any
// 5xx (or network error) a few times with backoff before giving up; 404 and
// other 4xx are returned immediately (not transient).
async function fetchRetry(url, opts, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts)
      if (r.status < 500) return r
      last = new Error(`HTTP ${r.status}`)
    } catch (e) { last = e }
    if (i < tries - 1) await sleep(600 * (i + 1))
  }
  if (last instanceof Response) return last
  throw last || new Error('request failed')
}

async function getJSON(url, headers, label) {
  const r = await fetchRetry(url, { headers })
  if (r.ok) return r.json()
  let body = ''
  try { body = await r.text() } catch { /* ignore */ }
  let detail = ''
  try { const j = JSON.parse(body); detail = j.exception || j.message || j._server_messages || '' } catch { detail = body }
  throw new Error(`${label}: HTTP ${r.status}${detail ? ` — ${String(detail).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`)
}

async function send(method, url, headers, body) {
  let r
  try {
    r = await fetchRetry(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  } catch (e) { return { ok: false, status: 0, error: e.message } }
  if (r.ok) return { ok: true, status: r.status }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || '' } catch { detail = r.statusText }
  return { ok: false, status: r.status, error: String(detail).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) }
}

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

async function fetchAddressDocs(base, headers, leadName) {
  const filters = JSON.stringify([['Dynamic Link', 'link_name', '=', leadName], ['Dynamic Link', 'link_doctype', '=', 'Lead']])
  const url = `${base}/api/resource/Address?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent('["name","address_line1","pincode"]')}&limit_page_length=0`
  const j = await getJSON(url, headers, `Address list ${leadName}`)
  return j.data || []
}

// Repoint an address's Lead link to `keep` (preserving any non-Lead links).
async function repointAddress(base, headers, addrName, keep) {
  const doc = (await getJSON(`${base}/api/resource/Address/${encodeURIComponent(addrName)}`, headers, `Address get ${addrName}`)).data
  const links = (doc.links || []).map((l) => (l.link_doctype === 'Lead' ? { ...l, link_name: keep } : l))
  if (!links.some((l) => l.link_doctype === 'Lead' && l.link_name === keep)) links.push({ link_doctype: 'Lead', link_name: keep })
  return send('PUT', `${base}/api/resource/Address/${encodeURIComponent(addrName)}`, headers, { links })
}

async function mergeSet(base, headers, set) {
  const keep = set.keep
  const removes = set.remove || []
  const res = { code: set.code, keep, removedLeads: [], movedAddresses: 0, deletedAddresses: 0, ok: true, errors: [] }

  const keepKeys = new Set()
  try { (await fetchAddressDocs(base, headers, keep)).forEach((a) => keepKeys.add(addrKey(a))) }
  catch (e) { res.errors.push(`keep addresses: ${e.message}`); res.ok = false }

  for (const rem of removes) {
    try {
      const remAddrs = await fetchAddressDocs(base, headers, rem)
      let handled = true
      for (const a of remAddrs) {
        const k = addrKey(a)
        if (keepKeys.has(k)) {
          const d = await send('DELETE', `${base}/api/resource/Address/${encodeURIComponent(a.name)}`, headers)
          if (d.ok || d.status === 404) res.deletedAddresses++
          else { handled = false; res.errors.push(`addr del ${a.name}: ${d.error}`) }
        } else {
          const rp = await repointAddress(base, headers, a.name, keep)
          if (rp.ok) { res.movedAddresses++; keepKeys.add(k) }
          else { handled = false; res.errors.push(`addr move ${a.name}: ${rp.error}`) }
        }
      }
      if (!handled) { res.ok = false; res.errors.push(`kept ${rem} — address step failed, not deleted`); continue }
      // Delete the padded Lead (fetchRetry handles transient lock-wait 5xx).
      const d = await send('DELETE', `${base}/api/resource/Lead/${encodeURIComponent(rem)}`, headers)
      if (d.ok || d.status === 404) res.removedLeads.push(rem)
      else { res.ok = false; res.errors.push(`delete ${rem}: ${d.error}`) }
    } catch (e) { res.ok = false; res.errors.push(`${rem}: ${e.message}`) }
  }
  return res
}

// { base, authHeaders, duplicates:[{code,keep,remove[]}], offset, batchSize }
export async function runMerge({ base, authHeaders, duplicates, offset = 0, batchSize = 20 }) {
  if (!Array.isArray(duplicates) || duplicates.length === 0) throw new Error('duplicates[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = duplicates.slice(offset, offset + batchSize)
  const results = []
  const counts = { sets: 0, removedLeads: 0, movedAddresses: 0, deletedAddresses: 0, errors: 0 }

  await mapLimit(batch, 2, async (set) => {
    const r = await mergeSet(base, headers, set)
    results.push(r)
    if (r.ok && r.errors.length === 0) counts.sets++
    counts.removedLeads += r.removedLeads.length
    counts.movedAddresses += r.movedAddresses
    counts.deletedAddresses += r.deletedAddresses
    counts.errors += r.errors.length
  })

  const done = offset + batchSize >= duplicates.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: duplicates.length, counts, results }
}
