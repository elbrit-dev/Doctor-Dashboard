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

// Normalized doctor code for a Lead: prefer custom_doctor_code, else the DR-
// name. Digits only, leading zeros stripped — matches the sheet's strip().
export const leadCode = (l) => {
  const dc = String(l.custom_doctor_code || '').replace(/\D/g, '').replace(/^0+/, '')
  if (dc) return dc
  return String(l.name || '').replace(/^DR-?/i, '').replace(/\D/g, '').replace(/^0+/, '')
}
