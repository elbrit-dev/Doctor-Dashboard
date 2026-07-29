// Fetch every doctor Lead in UAT for create/skip/duplicate decisions.
//
// A doctor code counts as "already in UAT" if EITHER a Lead carries that
// custom_doctor_code OR a Lead is NAMED DR-<code>. The union matters: some Leads
// were created with a DR- name but a BLANK custom_doctor_code (legacy/import
// data). Filtering only on `custom_doctor_code is set` misses them, so they were
// wrongly listed "to create" — and creating DR-<code> then fails with
// 409 DuplicateEntryError ("Duplicate entry 'DR-xxxx' for key 'PRIMARY'").

const FIELDS = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code']))

export async function fetchDoctorLeads(base, headers) {
  const q = async (filters) => {
    const f = encodeURIComponent(JSON.stringify(filters))
    const r = await fetch(`${base}/api/resource/Lead?fields=${FIELDS}&filters=${f}&limit_page_length=0`, { headers })
    if (!r.ok) throw new Error(`Lead list: HTTP ${r.status} ${r.statusText}`)
    return (await r.json()).data || []
  }
  const [byCode, byName] = await Promise.all([
    q([['custom_doctor_code', 'is', 'set']]),
    q([['name', 'like', 'DR-%']]),
  ])
  const seen = new Map() // dedupe by Lead name
  for (const l of [...byCode, ...byName]) if (!seen.has(l.name)) seen.set(l.name, l)
  return [...seen.values()]
}

// The same union, plus each Lead's status, as a COMPACT [name, code, status]
// triple — small enough to ship the whole table to the browser in one response
// so a big sheet (tens of thousands of codes) can be matched locally instead of
// with one ERP round trip per code. At ~35 bytes/Lead even 100k Leads is ~3.5MB,
// inside the serverless response cap; if the table ever outgrows that, page this
// endpoint and merge the pages in the browser rather than going back to per-code
// queries — a retirement sheet holds ~47k distinct codes.
const STATUS_FIELDS = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code', 'status']))

export async function fetchLeadStatusIndex(base, headers) {
  const q = async (filters) => {
    const f = encodeURIComponent(JSON.stringify(filters))
    const r = await fetch(`${base}/api/resource/Lead?fields=${STATUS_FIELDS}&filters=${f}&limit_page_length=0`, { headers })
    if (!r.ok) throw new Error(`Lead list: HTTP ${r.status} ${r.statusText}`)
    return (await r.json()).data || []
  }
  const [byCode, byName] = await Promise.all([
    q([['custom_doctor_code', 'is', 'set']]),
    q([['name', 'like', 'DR-%']]),
  ])
  const seen = new Map()
  for (const l of [...byCode, ...byName]) if (!seen.has(l.name)) seen.set(l.name, l)
  return [...seen.values()].map((l) => [l.name, String(l.custom_doctor_code ?? ''), l.status || ''])
}

// Normalized doctor code for a Lead: prefer custom_doctor_code, else the DR-
// name. Digits only, leading zeros stripped — matches the sheet's strip().
export const leadCode = (l) => {
  const dc = String(l.custom_doctor_code || '').replace(/\D/g, '').replace(/^0+/, '')
  if (dc) return dc
  return String(l.name || '').replace(/^DR-?/i, '').replace(/\D/g, '').replace(/^0+/, '')
}
