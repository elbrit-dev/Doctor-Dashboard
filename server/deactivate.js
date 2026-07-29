// Mark the doctors listed in a sheet INACTIVE in ERPNext.
//
// WHICH Leads those are is decided in the browser, against the compact Lead index
// from /api/lead-index (see src/lib/matchCodes.js): a retirement sheet can carry
// ~47k distinct codes, far too many to resolve with an ERP query per code. This
// module owns only the write half.
//
// The write is a single field update: status = "Inactive". Per the UAT Property
// Setter the field's only options are Active and Inactive (default Active), so
// nothing else has to be touched. Idempotent — re-running on an already-Inactive
// Lead just writes the same value again. Batched + concurrent; the frontend drives
// the offset loop. All ops retry on transient 5xx.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The status value the Doctor form uses for a deactivated doctor.
export const INACTIVE = 'Inactive'

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
  throw last || new Error('request failed')
}

const clean1 = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

// One PUT per Lead. Frappe echoes the saved doc back, so the response itself
// confirms that status really landed as Inactive.
async function setInactive(base, headers, name) {
  let r
  try {
    r = await fetchRetry(`${base}/api/resource/Lead/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: INACTIVE }),
    })
  } catch (e) {
    return { name, ok: false, error: e.message, status: 0 }
  }
  if (r.ok) {
    let saved = ''
    try { saved = (await r.json())?.data?.status || '' } catch { /* body is best-effort */ }
    return { name, ok: true, saved, verified: saved ? saved.toLowerCase() === INACTIVE.toLowerCase() : null }
  }
  if (r.status === 404) return { name, ok: false, notFound: true, status: 404, error: 'Lead no longer exists — reload the index' }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || '' }
  catch { try { detail = await r.text() } catch { detail = r.statusText } }
  return { name, ok: false, status: r.status, error: clean1(detail).slice(0, 300) }
}

// { base, authHeaders, names:[...], offset, batchSize, concurrency }
export async function runDeactivate({ base, authHeaders, names, offset = 0, batchSize = 40, concurrency = 6 }) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('names[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = names.slice(offset, offset + batchSize)

  const counts = { deactivated: 0, notFound: 0, unverified: 0, errors: 0 }
  const results = []

  await mapLimit(batch, concurrency, async (name) => {
    const r = await setInactive(base, headers, name)
    if (r.ok) {
      counts.deactivated++
      if (r.verified === false) counts.unverified++
    } else if (r.notFound) counts.notFound++
    else counts.errors++
    results.push(r)
  })

  const done = offset + batchSize >= names.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: names.length, counts, results }
}
