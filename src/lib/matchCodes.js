// Match a sheet's doctor codes to ERP Leads, zero-padding and all.
//
// The same doctor can be written four ways: the sheet pads its codes
// (00075529), a Lead can be NAMED clean (DR-75529) or padded (DR-00075529), and
// custom_doctor_code can itself hold either form. Stripping leading zeros on
// every side collapses all four to one join key, so padded and clean forms match
// each other automatically.
//
// A Lead answers to BOTH the code in its name AND the one in custom_doctor_code:
// legacy imports left some Leads with a DR- name and a blank code, and a few
// disagree outright. Indexing under both keys means a match on either counts.
//
// This runs in the browser against the compact index from /api/lead-index — a
// retirement sheet can carry ~47k distinct codes, far too many for one ERP query
// each.

// The join key: digits only, leading zeros gone.
export const strip = (c) => String(c ?? '').replace(/\D/g, '').replace(/^0+/, '')

// compact: [[name, custom_doctor_code, status], ...] → Map<code, lead[]>
export function buildLeadIndex(compact) {
  const idx = new Map()
  for (const [name, code, status] of compact || []) {
    const lead = {
      name,
      status: status || '',
      padded: /^DR-0/i.test(name || ''),
      inactive: String(status || '').trim().toLowerCase() === 'inactive',
    }
    const keys = new Set([strip(String(name ?? '').replace(/^DR-?/i, '')), strip(code)])
    for (const k of keys) {
      if (!k) continue
      const at = idx.get(k)
      if (!at) idx.set(k, [lead])
      else if (!at.some((l) => l.name === lead.name)) at.push(lead)
    }
  }
  return idx
}

// codes: the sheet's doctor codes, however they were spelled.
// → { rows, missing, counts }. `rows` is one entry per matched LEAD (a code with
// both a clean and a padded Lead yields two), `missing` the codes with no Lead.
export function matchSheetCodes(idx, codes) {
  const rows = []
  const missing = []
  const seen = new Set()   // Lead names already emitted (two codes can share one)
  const matched = new Set() // sheet keys that hit something
  for (const raw of codes || []) {
    const key = strip(raw)
    if (!key) continue
    const hits = idx.get(key)
    if (!hits || hits.length === 0) { missing.push(String(raw).trim()); continue }
    matched.add(key)
    for (const l of hits) {
      if (seen.has(l.name)) continue
      seen.add(l.name)
      rows.push({
        sheetCode: String(raw).trim(),
        code: key,
        name: l.name,
        padded: l.padded,
        status: l.status,
        alreadyInactive: l.inactive,
      })
    }
  }
  rows.sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name))
  return {
    rows,
    missing,
    counts: {
      sheetCodes: matched.size + missing.length,
      matchedCodes: matched.size,
      leads: rows.length,
      padded: rows.filter((r) => r.padded).length,
      alreadyInactive: rows.filter((r) => r.alreadyInactive).length,
      missing: missing.length,
    },
  }
}
