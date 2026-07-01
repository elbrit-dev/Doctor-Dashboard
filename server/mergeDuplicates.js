// Merge padded duplicate Leads INTO their clean form — data only, no delete.
//
// Reality check against UAT: the padded DR-000<code> Leads have NO addresses
// (verified across all 2.5k of them), so there is nothing to "move". What DOES
// differ is field data (e.g. the clean DR-<code> often lacks custom_doctor_code
// while the padded one has it, and vice-versa). So the merge backfills the clean
// Lead's BLANK fields from the padded one — it never overwrites a value the
// clean Lead already has, so it is safe.
//
// Architecture for speed: per batch we do ONE bulk read (name IN […], chunked to
// keep the URL short) to pull both records' data, then fast concurrent PUTs
// (~0.5s each) only on the clean Leads that actually need a backfill. No slow
// per-record reads, no ~4.5s Lead deletes. Deleting the padded Leads is done
// separately in ERPNext. All ops retry on transient 5xx.

const strip = (c) => String(c || '').replace(/\D/g, '').replace(/^0+/, '')
const isBlank = (v) => v == null || String(v).trim() === ''

// Scalar fields backfilled from the padded Lead when the clean one is blank.
const MERGE_FIELDS = ['custom_specialty', 'custom_qualification', 'custom_category', 'territory', 'state', 'city', 'mobile_no', 'whatsapp_no', 'phone']
const FETCH_FIELDS = ['name', 'custom_doctor_code', ...MERGE_FIELDS, 'custom_latitude', 'custom_longitude', 'custom_latitude_and_longitude']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  try { r = await fetchRetry(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) }
  catch (e) { return { ok: false, status: 0, error: e.message } }
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

// One bulk read of many Leads' data, chunked so the IN(...) URL stays short.
async function bulkFetchLeads(base, headers, names) {
  const out = {}
  const CH = 90
  const fields = encodeURIComponent(JSON.stringify(FETCH_FIELDS))
  for (let i = 0; i < names.length; i += CH) {
    const filters = encodeURIComponent(JSON.stringify([['name', 'in', names.slice(i, i + CH)]]))
    const j = await getJSON(`${base}/api/resource/Lead?fields=${fields}&filters=${filters}&limit_page_length=0`, headers, 'Lead bulk read')
    for (const d of (j.data || [])) out[d.name] = d
  }
  return out
}

// The backfill patch for one set: clean's blank fields filled from the padded.
function computeBackfill(set, data) {
  const keep = data[set.keep]
  if (!keep) return { error: `clean ${set.keep} not found` }
  const patch = {}
  if (isBlank(keep.custom_doctor_code)) patch.custom_doctor_code = strip(set.code)
  for (const rem of (set.remove || [])) {
    const rd = data[rem]
    if (!rd) continue
    for (const f of MERGE_FIELDS) {
      if (patch[f] === undefined && isBlank(keep[f]) && !isBlank(rd[f])) patch[f] = rd[f]
    }
    const keepGeoMissing = isBlank(keep.custom_latitude) || Number(keep.custom_latitude) === 0
    if (patch.custom_latitude === undefined && keepGeoMissing && rd.custom_latitude && Number(rd.custom_latitude) !== 0) {
      patch.custom_latitude = rd.custom_latitude
      patch.custom_longitude = rd.custom_longitude
      if (!isBlank(rd.custom_latitude_and_longitude)) patch.custom_latitude_and_longitude = rd.custom_latitude_and_longitude
    }
  }
  return { patch }
}

// { base, authHeaders, duplicates:[{code,keep,remove[]}], offset, batchSize, concurrency }
export async function runMerge({ base, authHeaders, duplicates, offset = 0, batchSize = 25, concurrency = 6 }) {
  if (!Array.isArray(duplicates) || duplicates.length === 0) throw new Error('duplicates[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = duplicates.slice(offset, offset + batchSize)

  const names = [...new Set(batch.flatMap((s) => [s.keep, ...(s.remove || [])]))]
  const data = await bulkFetchLeads(base, headers, names)

  const counts = { merged: 0, fieldsFilled: 0, skipped: 0, errors: 0 }
  const results = []

  await mapLimit(batch, concurrency, async (set) => {
    const { patch, error } = computeBackfill(set, data)
    if (error) { counts.errors++; results.push({ code: set.code, keep: set.keep, ok: false, error }); return }
    const keys = Object.keys(patch)
    if (keys.length === 0) { counts.skipped++; results.push({ code: set.code, keep: set.keep, ok: true, filled: [] }); return }
    const r = await send('PUT', `${base}/api/resource/Lead/${encodeURIComponent(set.keep)}`, headers, patch)
    if (r.ok) { counts.merged++; counts.fieldsFilled += keys.length; results.push({ code: set.code, keep: set.keep, ok: true, filled: keys }) }
    else { counts.errors++; results.push({ code: set.code, keep: set.keep, ok: false, error: r.error, filled: keys }) }
  })

  const done = offset + batchSize >= duplicates.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: duplicates.length, counts, results }
}
