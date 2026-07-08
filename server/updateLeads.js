// Update EXISTING doctor Leads in UAT from an uploaded sheet — never creates a
// Lead (that's the create path in process.js). For every selected code that is
// already in UAT it: (a) backfills/updates the Lead's scalar fields when the
// sheet differs, (b) appends the employee's role profile if missing, and
// (c) appends a new Address when the sheet's address isn't already on the Lead.
//
// Three rules, agreed with the CRM owner:
//   1. ADDRESSES ARE APPEND-ONLY. Match the sheet address against the Lead's
//      existing addresses on address_line1 + city (case-insensitive). If it
//      matches one, leave it. If it matches none, CREATE it as a new Address.
//      Existing addresses are never edited or deleted — old data we don't have
//      in the sheet must be preserved.
//   2. ROLE PROFILES ARE ONE-PER-DEPARTMENT. A Lead's custom_role_profile child
//      table can carry several departments (CND / Elbrit / Vasco …). The sheet's
//      employee owns exactly ONE department, so for THAT department we keep a
//      single row carrying the sheet's role profile: add it if the department is
//      absent, and if the department already exists under a different (old) role
//      profile — or is duplicated across rows — delete those and add the sheet's
//      value. Every OTHER department's rows are kept exactly (matched by their
//      child-row `name`), never touched.
//   3. SCALARS UPDATE ON CHANGE ONLY. A field is written only when the sheet has
//      a value that differs (after normalization) from what's in UAT. A blank
//      sheet value never overwrites an existing UAT value.
//
// Desired values are built with the SAME builders the create path uses
// (transform.js buildLead/buildAddress) so create and update stay identical.
//
// Speed: role profiles + addresses can't be bulk-read (child tables / Dynamic
// Link), so each doctor costs 1 Lead GET + 1 Address GET, then only the writes
// it actually needs — run concurrently, with 5xx retries. The frontend drives
// the offset loop, so no single call risks the serverless timeout.

import { buildLead, buildAddress, strip, extractEmpId, resolveEmp, invalidLinkFields } from './transform.js'
import { fetchTerritories, makeTerritoryResolver, fetchDoctypeNames, ensureLinkValues } from './territory.js'
import { makeTokenResolver } from './hqMatch.js'
import { leadCode } from './leadIndex.js'

// ---- normalizers (kept in step with src/lib/reconcile.js) -------------------
const text = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' ').toLowerCase())
const nameNorm = (v) => text(v).replace(/^(dr|dr\.|mr|mr\.|mrs|mrs\.|ms|ms\.|prof|prof\.)\s+/i, '')
const hqNorm = (v) => text(v).replace(/^hq[-\s]*/i, '')
const stateNorm = (v) => text(v).replace(/[^a-z0-9]/g, '')
const phoneNorm = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
const isBlank = (v) => v == null || String(v).trim() === ''
const NUM_TOL = 1e-3 // ~100m — don't rewrite geo when the sheet is only a rounding apart

// Full-address identity key: line1 + line2 + city + pincode (normalized). Two
// addresses are "the same" only when ALL of these match; any difference makes
// the sheet address a new, separate address.
const addrKey = (a) => [a.address_line1, a.address_line2, a.city, a.pincode].map((v) => text(v)).join('|')

// Scalar fields synced on update: desired-Lead key → live-Lead key + normalizer.
// (Operational fields — status, lead_owner, company, salutation — are left alone.)
const SCALAR_FIELDS = [
  { key: 'first_name', norm: nameNorm },
  { key: 'custom_specialty', norm: text },
  { key: 'custom_qualification', norm: text },
  { key: 'custom_category', norm: text },
  { key: 'custom_category1', norm: text },
  { key: 'custom_category2', norm: text },
  { key: 'custom_category3', norm: text },
  { key: 'mobile_no', norm: phoneNorm },
  { key: 'territory', norm: hqNorm },
  { key: 'state', norm: stateNorm },
  { key: 'city', norm: text },
  // Normalize the doctor code to the zero-stripped form (matching the DR-<code>
  // ID). The DESIRED value is already stripped (buildLead uses strip), and we
  // compare the RAW stored value — so a blank code gets filled AND a zero-padded
  // one like "00004444" is rewritten to "4444". An already-clean code is a no-op.
  { key: 'custom_doctor_code', norm: (v) => String(v ?? '').trim() },
]

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

// ---- bulk reads (once per batch) --------------------------------------------
const g = (r, k) => { const v = r[k]; return v == null ? '' : String(v).trim() }
const pad8 = (c) => strip(c).padStart(8, '0')

// Map each stripped code → its primary Lead name, tolerating zero-padding and a
// blank custom_doctor_code (match by DR-<code> name too). Prefer the clean
// "DR-<code>" form; fall back to whatever single Lead carries the code.
async function resolveLeadNames(base, headers, codes) {
  const names = [], dcodes = []
  for (const c of codes) { names.push(`DR-${c}`, `DR-${pad8(c)}`); dcodes.push(c, pad8(c)) }
  const fields = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code']))
  const CH = 90
  const rows = []
  const q = async (field, values) => {
    for (let i = 0; i < values.length; i += CH) {
      const filters = encodeURIComponent(JSON.stringify([[field, 'in', values.slice(i, i + CH)]]))
      const j = await getJSON(`${base}/api/resource/Lead?fields=${fields}&filters=${filters}&limit_page_length=0`, headers, 'Lead name resolve')
      rows.push(...(j.data || []))
    }
  }
  await q('name', [...new Set(names)])
  await q('custom_doctor_code', [...new Set(dcodes)])
  const byCode = {}
  // Use leadCode (NOT transform.strip): strip('') === '0', which would index a
  // blank-doctor-code Lead under "0" and hide it from lookup. leadCode falls back
  // to the DR-<code> name, so DR-38265 with an empty code still resolves to 38265.
  for (const l of rows) {
    const c = leadCode(l); if (!c) continue
    if (!byCode[c] || l.name === `DR-${c}`) byCode[c] = l.name
  }
  return byCode
}

async function fetchEmployees(base, headers, empCodes) {
  if (empCodes.length === 0) return {}
  // `department` tells us which department the employee's role profile belongs to,
  // so the update can collapse that department to the sheet's single value.
  const fields = encodeURIComponent(JSON.stringify(['name', 'role_id', 'custom_role_profile', 'department']))
  const filters = encodeURIComponent(JSON.stringify([['name', 'in', empCodes]]))
  const j = await getJSON(`${base}/api/resource/Employee?fields=${fields}&filters=${filters}&limit_page_length=0`, headers, 'Employee fetch')
  const map = {}
  for (const e of (j.data || [])) map[e.name] = e
  return map
}

// Full Lead doc (scalars + custom_role_profile child rows) for one Lead.
async function fetchLeadDoc(base, headers, name) {
  const j = await getJSON(`${base}/api/resource/Lead/${encodeURIComponent(name)}`, headers, `Lead ${name}`)
  return j.data
}

// All Address docs linked to a Lead via the Dynamic Link child table.
async function fetchAddresses(base, headers, name) {
  const filters = encodeURIComponent(JSON.stringify([
    ['Dynamic Link', 'link_name', '=', name],
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
  ]))
  try {
    const j = await getJSON(`${base}/api/resource/Address?filters=${filters}&fields=${encodeURIComponent('["address_line1","address_line2","city","pincode"]')}&limit_page_length=50`, headers, 'Address fetch')
    return j.data || []
  } catch { return [] }
}

// ---- per-doctor diff --------------------------------------------------------
// Scalar patch: desired (from buildLead) vs live, changed non-blank fields only.
function scalarPatch(desired, live) {
  const patch = {}
  for (const f of SCALAR_FIELDS) {
    const dv = desired[f.key]
    if (isBlank(dv)) continue // never blank out an existing UAT value
    if (f.norm(dv) !== f.norm(live[f.key])) patch[f.key] = dv
  }
  // Geo: only when the sheet carries a real coordinate that differs.
  if (!isBlank(desired.custom_latitude)) {
    const a = Number(desired.custom_latitude), b = Number(live.custom_latitude)
    const bBlank = isBlank(live.custom_latitude) || b === 0
    if (bBlank || Math.abs(a - b) > NUM_TOL) {
      patch.custom_latitude = desired.custom_latitude
      patch.custom_longitude = desired.custom_longitude
      if (!isBlank(desired.custom_latitude_and_longitude)) patch.custom_latitude_and_longitude = desired.custom_latitude_and_longitude
    }
  }
  return patch
}

// { base, authHeaders, rows, offset, batchSize, concurrency }
export async function runUpdate({ base, authHeaders, rows, offset = 0, batchSize = 40, concurrency = 8 }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = rows.slice(offset, offset + batchSize)

  const codes = [...new Set(batch.map((r) => strip(g(r, 'Dr. Code'))).filter(Boolean))]
  // Emp Code + the id embedded in the Emp Name (vacant-code fallback).
  const empCodes = [...new Set(batch.flatMap((r) => [g(r, 'Emp Code'), extractEmpId(g(r, 'Emp Name'))].filter(Boolean)))]
  const [nameByCode, empMap, territories, specialties, qualifications] = await Promise.all([
    resolveLeadNames(base, headers, codes),
    fetchEmployees(base, headers, empCodes),
    fetchTerritories(base, headers),
    fetchDoctypeNames(base, headers, 'Specialty'),
    fetchDoctypeNames(base, headers, 'Doctor Qualification'),
  ])
  const resolveTerritory = makeTerritoryResolver(territories)
  const resolveSpecialty = makeTokenResolver(specialties)
  // Qualification goes in AS-IS (create any missing value, then exact lookup).
  const rawQuals = [...new Set(batch.map((r) => String(g(r, 'Qualification') ?? '').trim()).filter(Boolean))]
  const qualMap = await ensureLinkValues(base, headers, 'Doctor Qualification', 'qualification', rawQuals, qualifications)
  const resolveQualification = (v) => qualMap[String(v ?? '').trim()] || null

  const counts = { updated: 0, unchanged: 0, addressAdded: 0, roleAdded: 0, roleDeduped: 0, notFound: 0, errors: 0 }
  const results = []

  const processRow = async (r) => {
    const code = strip(g(r, 'Dr. Code'))
    const dr = g(r, 'Dr. Name')
    const name = nameByCode[code]
    if (!code) return
    if (!name) { counts.notFound++; results.push({ code, ok: false, error: 'not_in_uat' }); return }

    // Desired bodies from the SAME create builders (Link fields resolved to real
    // Territory / Specialty / Doctor Qualification values; unresolved ones are
    // dropped so the write doesn't 417).
    const resolvedTerr = resolveTerritory(g(r, 'HQ'))
    const desiredLead = buildLead(r, code, name, dr, '', {
      territory: resolvedTerr,
      specialty: resolveSpecialty(g(r, 'Speciality')) || '',
      qualification: resolveQualification(g(r, 'Qualification')) || '',
    })
    // If the HQ can't be confidently matched, leave UAT's territory untouched
    // rather than trying to write an invalid one (which would just error).
    if (!resolvedTerr) desiredLead.territory = ''
    const desiredAddr = buildAddress(r, name, dr)

    let live, addresses
    try {
      [live, addresses] = await Promise.all([fetchLeadDoc(base, headers, name), fetchAddresses(base, headers, name)])
    } catch (e) { counts.errors++; results.push({ code, name, ok: false, error: e.message }); return }

    // (3) scalar changes
    const patch = scalarPatch(desiredLead, live)

    // (2) role profile — the sheet's employee owns ONE department. Keep every
    // OTHER department's rows verbatim, and collapse THIS employee's department to
    // a single row carrying the sheet's role profile: add it if the department is
    // absent; if the department already exists under a different (old) role profile
    // — or is duplicated across rows — delete those and add the sheet's value.
    // Vacant Emp Code falls back to the id embedded in the Emp Name.
    const emp = resolveEmp(r, empMap)
    const rp = emp ? (emp.role_id || emp.custom_role_profile || '').trim() : ''
    const rpDept = emp ? (emp.department || '').trim() : ''
    const liveRoles = Array.isArray(live.custom_role_profile) ? live.custom_role_profile : []
    // A live row belongs to the sheet employee's department when it shares the
    // department, OR already carries the exact role profile (covers a row whose
    // department ERPNext hasn't fetched yet). Rows of a different department are
    // never matched, so they're always preserved.
    const sameDept = (x) => (rpDept && text(x.department) === text(rpDept)) || (rp && (x.role_profile_list || '').trim() === rp)
    let roleAdded = false, roleDeduped = false, removedRoles = []
    if (rp) {
      const others = liveRoles.filter((x) => !sameDept(x))
      const mine = liveRoles.filter((x) => sameDept(x))
      // Already correct: exactly one row for this department, and it's the sheet's.
      const alreadyCorrect = mine.length === 1 && (mine[0].role_profile_list || '').trim() === rp
      if (!alreadyCorrect) {
        patch.custom_role_profile = [
          ...others.map((x) => ({ name: x.name, role_profile_list: x.role_profile_list })),
          { role_profile_list: rp },
        ]
        removedRoles = mine.map((x) => (x.role_profile_list || '').trim()).filter(Boolean)
        roleAdded = mine.length === 0   // department was absent → pure add
        roleDeduped = mine.length > 0   // replaced ≥1 old/duplicate row for this dept
      }
    }
    const roleChanged = roleAdded || roleDeduped

    // (1) address — append a new one only if ALL address lines (line1, line2,
    // city, pincode) match none of the Lead's existing addresses. Any difference
    // → treated as a different address and added as a second block (append-only;
    // existing addresses are never edited).
    let needAddress = false
    if (desiredAddr) {
      const key = addrKey(desiredAddr)
      const match = addresses.some((a) => addrKey(a) === key)
      needAddress = !match
    }

    const leadFields = Object.keys(patch).filter((k) => k !== 'custom_role_profile')
    if (leadFields.length === 0 && !roleChanged && !needAddress) {
      counts.unchanged++
      results.push({ code, name, ok: true, leadFields: [], roleAdded: false, roleDeduped: false, addressAdded: false })
      return
    }

    let ok = true, error, droppedLinks
    if (Object.keys(patch).length > 0) {
      const url = `${base}/api/resource/Lead/${encodeURIComponent(name)}`
      let res = await send('PUT', url, headers, patch)
      // Invalid link value (e.g. Specialty "GYNAEC", Qualification "DGO")? Drop
      // just those fields and retry, so the rest of the row still updates.
      if (!res.ok && /could not find/i.test(res.error || '')) {
        const bad = invalidLinkFields(res.error).filter((f) => f in patch)
        if (bad.length) {
          const reduced = { ...patch }; bad.forEach((f) => delete reduced[f])
          res = Object.keys(reduced).length ? await send('PUT', url, headers, reduced) : { ok: true }
          if (res.ok) droppedLinks = bad
        }
      }
      if (res.ok) { counts.updated++; if (roleAdded) counts.roleAdded++; if (roleDeduped) counts.roleDeduped++ }
      else { ok = false; error = res.error; counts.errors++ }
    }
    if (ok && needAddress) {
      const ar = await send('POST', `${base}/api/resource/Address`, headers, desiredAddr)
      if (ar.ok) counts.addressAdded++
      // A duplicate auto-name means an equivalent address already exists — not a
      // real failure, so don't fail the row over it.
      else if (/duplicate entry/i.test(ar.error || '')) { /* skip, already present */ }
      else { ok = false; error = ar.error; counts.errors++ }
    }
    results.push({ code, name, ok, error, leadFields, roleAdded, roleDeduped, removedRoles, addressAdded: needAddress, droppedLinks })
  }

  // Group rows by their resolved Lead so the SAME Lead is never written by two
  // workers at once. Child-table PUTs are last-write-wins, so a doctor appearing
  // in several rows / departments within one batch could otherwise drop a dedupe
  // or an add. Different Leads still run concurrently; rows sharing a Lead run one
  // after another (rows with no resolved Lead get a unique key, so they don't
  // serialize against each other).
  const groups = new Map()
  batch.forEach((r, i) => {
    const code = strip(g(r, 'Dr. Code'))
    const key = (code && nameByCode[code]) || `__row_${i}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  })
  await mapLimit([...groups.values()], concurrency, async (group) => {
    for (const r of group) {
      // eslint-disable-next-line no-await-in-loop
      await processRow(r)
    }
  })

  const done = offset + batchSize >= rows.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: rows.length, counts, results }
}
