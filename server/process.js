// Stateless batch engine shared by the Netlify function (netlify/functions/process.js)
// and the local dev proxy (server/index.js). The FRONTEND owns the offset loop;
// each call processes exactly one slice and reports `nextOffset`, so no single
// invocation risks the serverless timeout.
//
// On every call it re-fetches fresh from ERPNext (employees for this batch +
// ALL existing coded Leads) so re-running a batch never double-creates: a code
// created on the previous pass now shows up as `skip`.

import { transformRow } from './transform.js'
import { fetchDoctorLeads, leadCode } from './leadIndex.js'

// ---- ERPNext reads ----------------------------------------------------------
async function fetchEmployees(base, headers, empCodes) {
  if (empCodes.length === 0) return {}
  const fields = encodeURIComponent(JSON.stringify(['name', 'role_id', 'custom_role_profile', 'department', 'fsl_hq']))
  const filters = encodeURIComponent(JSON.stringify([['name', 'in', empCodes]]))
  const r = await fetch(`${base}/api/resource/Employee?fields=${fields}&filters=${filters}&limit_page_length=0`, { headers })
  if (!r.ok) throw new Error(`Employee fetch: HTTP ${r.status} ${r.statusText}`)
  const j = await r.json()
  const map = {}
  for (const e of (j.data || [])) map[e.name] = e
  return map
}

async function fetchExistingCodes(base, headers) {
  const leads = await fetchDoctorLeads(base, headers)
  const set = new Set(); const names = new Map() // normalized code -> [Lead names]
  for (const l of leads) {
    const c = leadCode(l)
    if (!c) continue
    set.add(c)
    if (!names.has(c)) names.set(c, [])
    names.get(c).push(l.name)
  }
  return { set, names }
}

// ---- ERPNext writes ---------------------------------------------------------
async function send(method, url, headers, body) {
  const r = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (r.ok) return { ok: true, status: r.status }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || JSON.stringify(j) } catch { detail = r.statusText }
  return { ok: false, status: r.status, error: String(detail).slice(0, 500) }
}

// Run `fn` over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

// ---- One batch (CREATE only) ------------------------------------------------
// { base, authHeaders, rows, offset, batchSize }
// Creates a new Lead (+ Address when present) for every code not already in UAT.
// Codes already in UAT are skipped; rows with no employee / role profile are
// reported as exceptions. Re-running is safe — a just-created code is now a skip.
export async function runProcess({ base, authHeaders, rows, offset = 0, batchSize = 50 }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows[] is required')

  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = rows.slice(offset, offset + batchSize)
  const empCodes = [...new Set(batch.map((r) => String(r['Emp Code'] ?? '').trim()).filter(Boolean))]

  const [empMap, existing] = await Promise.all([
    fetchEmployees(base, headers, empCodes),
    fetchExistingCodes(base, headers),
  ])

  const transformed = batch.map((r) => transformRow(r, empMap, existing.set))

  const counts = { created: 0, skipped: 0, exceptions: 0, errors: 0 }
  const results = []
  const exceptions = []
  const toCreate = []

  for (const t of transformed) {
    if (t.kind === 'exception') { counts.exceptions++; exceptions.push(t); continue }
    if (t.kind === 'skip') { counts.skipped++; continue } // already in UAT
    toCreate.push(t) // kind 'create'
  }

  await mapLimit(toCreate, 5, async (t) => {
    const res = await send('POST', `${base}/api/resource/Lead`, headers, t.lead)
    results.push({ code: t.code, op: 'create_lead', ok: res.ok, status: res.status, error: res.error })
    if (res.ok) {
      counts.created++
      if (t.hasAddress && t.address) {
        const ar = await send('POST', `${base}/api/resource/Address`, headers, t.address)
        results.push({ code: t.code, op: 'create_address', ok: ar.ok, status: ar.status, error: ar.error })
        if (!ar.ok) counts.errors++
      }
    } else {
      counts.errors++
    }
  })

  const done = offset + batchSize >= rows.length
  return {
    processed: batch.length,
    nextOffset: done ? null : offset + batchSize,
    done,
    total: rows.length,
    counts,
    results,
    exceptions,
  }
}
