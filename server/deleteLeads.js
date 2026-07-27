// List and delete the zero-padded doctor Leads (name starts with "DR-0", e.g.
// DR-00006612 / DR-0006612) — the padded duplicates left behind after the clean
// DR-<code> twin has been reconciled. Deleting a Lead is blocked by its linked
// Contact / Address (Dynamic Link), so we cascade: remove those first, then the
// Lead. Batched + concurrent; the frontend drives the offset loop.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchRetry(url, opts, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts)
      if (r.status < 500) return r
      last = new Error(`HTTP ${r.status}`)
    } catch (e) { last = e }
    if (i < tries - 1) await sleep(500 * (i + 1))
  }
  throw last || new Error('request failed')
}

async function getJSON(url, headers, label) {
  const r = await fetchRetry(url, { headers })
  if (r.ok) return r.json()
  let body = ''
  try { body = await r.text() } catch { /* ignore */ }
  throw new Error(`${label}: HTTP ${r.status}${body ? ` — ${String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`)
}

async function del(url, headers) {
  let r
  try { r = await fetchRetry(url, { method: 'DELETE', headers }) }
  catch (e) { return { ok: false, status: 0, error: e.message } }
  if (r.ok) return { ok: true, status: r.status }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || '' } catch { try { detail = await r.text() } catch { detail = r.statusText } }
  return { ok: false, status: r.status, error: String(detail).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) }
}

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

// All Leads whose NAME starts with "DR-0" (the zero-padded form). One list query
// per chunk of the page-length; returns [{ name, code, leadName, territory }].
export async function fetchZeroLeads({ base, authHeaders }) {
  const headers = { ...authHeaders, Accept: 'application/json' }
  const fields = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code', 'lead_name', 'territory']))
  const filters = encodeURIComponent(JSON.stringify([['name', 'like', 'DR-0%']]))
  const j = await getJSON(`${base}/api/resource/Lead?fields=${fields}&filters=${filters}&limit_page_length=0&order_by=${encodeURIComponent('name asc')}`, headers, 'Zero-lead list')
  return (j.data || []).map((l) => ({
    name: l.name,
    code: String(l.custom_doctor_code ?? '').trim(),
    leadName: l.lead_name || '',
    territory: l.territory || '',
  }))
}

// Docs of `doctype` linked to a Lead via the Dynamic Link child table.
async function linkedDocs(base, headers, doctype, leadName) {
  const filters = encodeURIComponent(JSON.stringify([
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
    ['Dynamic Link', 'link_name', '=', leadName],
  ]))
  try {
    const j = await getJSON(`${base}/api/resource/${encodeURIComponent(doctype)}?filters=${filters}&fields=${encodeURIComponent('["name"]')}&limit_page_length=0`, headers, `${doctype} links`)
    return (j.data || []).map((d) => d.name)
  } catch { return [] }
}

// Cascade-delete one Lead: its linked Contacts + Addresses first (they block the
// Lead delete), then the Lead itself.
async function deleteLead(base, headers, leadName) {
  const removed = { contacts: 0, addresses: 0 }
  for (const doctype of ['Contact', 'Address']) {
    // eslint-disable-next-line no-await-in-loop
    const names = await linkedDocs(base, headers, doctype, leadName)
    for (const n of names) {
      // eslint-disable-next-line no-await-in-loop
      const r = await del(`${base}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(n)}`, headers)
      if (r.ok) removed[doctype === 'Contact' ? 'contacts' : 'addresses']++
      // A link failure on a shared doc isn't fatal here — the Lead delete below
      // will surface a clear error if something still references it.
    }
  }
  const r = await del(`${base}/api/resource/Lead/${encodeURIComponent(leadName)}`, headers)
  return { ...r, removed }
}

// { base, authHeaders, names[], offset, batchSize, concurrency }
export async function runDeleteLeads({ base, authHeaders, names, offset = 0, batchSize = 40, concurrency = 6 }) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('names[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = names.slice(offset, offset + batchSize)
  const counts = { deleted: 0, errors: 0, contacts: 0, addresses: 0 }
  const results = []

  await mapLimit(batch, concurrency, async (name) => {
    const out = await deleteLead(base, headers, name)
    counts.contacts += out.removed.contacts
    counts.addresses += out.removed.addresses
    if (out.ok) { counts.deleted++; results.push({ name, ok: true }) }
    else { counts.errors++; results.push({ name, ok: false, status: out.status, error: out.error }) }
  })

  const done = offset + batchSize >= names.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: names.length, counts, results }
}
