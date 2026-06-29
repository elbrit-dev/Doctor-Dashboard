// Bulk reconciliation engine: compare a source sheet row against the ERPNext
// (live) record for the same doctor, field by field, with normalization so that
// formatting-only differences don't show up as false mismatches.
//
// Per-field status:
//   match        sheet value === erp value (after normalize)
//   mismatch     both present but differ            ← the real problem
//   missing_erp  sheet has a value, erp is blank    ← "not fetched / not written"
//   sheet_blank  erp has a value, sheet is blank    ← usually fine (extra in erp)
//   blank        both blank                          ← nothing to check

// ---- normalizers ------------------------------------------------------------
const text = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' ').toLowerCase())
// name: drop leading salutation so "Dr Srinivasan" == "Srinivasan"
const name = (v) => text(v).replace(/^(dr|dr\.|mr|mr\.|mrs|mrs\.|ms|ms\.|prof|prof\.)\s+/i, '')
// HQ/territory: "Chennai" (sheet) vs "HQ-Chennai" (erp) -> strip leading "hq-"
const hq = (v) => text(v).replace(/^hq[-\s]*/i, '')
// state: ignore case + punctuation/spaces -> "TAMILNADU" == "Tamil Nadu", "Tn-Chennai" stays distinct
const state = (v) => text(v).replace(/[^a-z0-9]/g, '')
// phone: digits only, last 10 (handles +91, spaces, placeholder "0")
const phone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : ''
}
// pincode: digits only
const pincode = (v) => String(v ?? '').replace(/\D/g, '')
// code: strip leading zeros
const code = (v) => String(v ?? '').trim().replace(/^0+/, '')

const isBlank = (s) => s === '' || s == null

// ---- field map: sheet column -> erp record field ----------------------------
// `erp` reads from the mapped doctor object returned by the proxy.
export const FIELDS = [
  { key: 'name', label: 'Name', sheet: 'Dr. Name', erp: (d) => d.firstName || d.leadName, norm: name },
  { key: 'qualification', label: 'Qualification', sheet: 'Qualification', erp: (d) => d.qualification, norm: text },
  { key: 'specialty', label: 'Speciality', sheet: 'Speciality', erp: (d) => d.specialty, norm: text },
  { key: 'category', label: 'Category', sheet: 'Category', erp: (d) => d.category, norm: text },
  { key: 'category1', label: 'Category 1', sheet: 'Category 1', erp: (d) => d.category1, norm: text },
  { key: 'category2', label: 'Category 2', sheet: 'Category 2', erp: (d) => d.category2, norm: text },
  { key: 'category3', label: 'Category 3', sheet: 'Category 3', erp: (d) => d.category3, norm: text },
  { key: 'territory', label: 'HQ → Territory', sheet: 'HQ', erp: (d) => d.territory, norm: hq },
  { key: 'state', label: 'State', sheet: 'State', erp: (d) => d.state, norm: state },
  { key: 'city', label: 'City', sheet: 'Dr. City (Clinic)', erp: (d) => d.city, norm: text },
  { key: 'mobile', label: 'Mobile', sheet: 'Mobile No.', erp: (d) => d.mobile, norm: phone },
  { key: 'latitude', label: 'Latitude', sheet: 'Standardize Latitude 1', erp: (d) => d.latitude, norm: 'num' },
  { key: 'longitude', label: 'Longitude', sheet: 'Standardize Longitude 1', erp: (d) => d.longitude, norm: 'num' },

  // ---- address lines (haystack match against ALL of the doctor's addresses) ----
  // Extra ERPNext addresses (e.g. a separate "Doctor" address) never cause a flag;
  // they just add to the pool a sheet value can match against.
  { key: 'caddr1', label: 'Clinic Addr 1', sheet: 'Clinic Info - Address 1', kind: 'address', pool: 'text', norm: text },
  { key: 'caddr2', label: 'Clinic Addr 2', sheet: 'Clinic Info - Address 2', kind: 'address', pool: 'text', norm: text },
  { key: 'caddr3', label: 'Clinic Addr 3', sheet: 'Clinic Info - Address 3', kind: 'address', pool: 'text', norm: text },
  { key: 'cstate', label: 'Clinic State', sheet: 'Clinic State', kind: 'address', pool: 'state', norm: state },
  { key: 'cpin', label: 'Clinic Pincode', sheet: 'Clinic Info - Pincode', kind: 'address', pool: 'pincode', norm: pincode },
  { key: 'raddr1', label: 'Resi. Addr 1', sheet: 'Residence Info - Address 1', kind: 'address', pool: 'text', norm: text },
  { key: 'rcity', label: 'Resi. City', sheet: 'Residence Info - City', kind: 'address', pool: 'city', norm: text },
  { key: 'rstate', label: 'Resi. State', sheet: 'Residence Info - State', kind: 'address', pool: 'state', norm: state },
  { key: 'rpin', label: 'Resi. Pincode', sheet: 'Residence Info - Pincode', kind: 'address', pool: 'pincode', norm: pincode },
]

const NUM_TOL = 1e-4

function compareField(field, sheetRaw, erpRaw) {
  if (field.norm === 'num') {
    const a = parseFloat(sheetRaw), b = parseFloat(erpRaw)
    const aB = !Number.isFinite(a) || a === 0
    const bB = !Number.isFinite(b) || b === 0
    if (aB && bB) return { status: 'blank', sheet: sheetRaw, erp: erpRaw }
    if (aB) return { status: 'sheet_blank', sheet: sheetRaw, erp: erpRaw }
    if (bB) return { status: 'missing_erp', sheet: sheetRaw, erp: erpRaw }
    return { status: Math.abs(a - b) <= NUM_TOL ? 'match' : 'mismatch', sheet: sheetRaw, erp: erpRaw }
  }
  const a = field.norm(sheetRaw)
  const b = field.norm(erpRaw)
  if (isBlank(a) && isBlank(b)) return { status: 'blank', sheet: sheetRaw, erp: erpRaw }
  if (isBlank(a)) return { status: 'sheet_blank', sheet: sheetRaw, erp: erpRaw }
  if (isBlank(b)) return { status: 'missing_erp', sheet: sheetRaw, erp: erpRaw }
  return { status: a === b ? 'match' : 'mismatch', sheet: sheetRaw, erp: erpRaw }
}

// Compare a sheet address line against the pool of values across ALL the
// doctor's ERPNext addresses. status: blank / missing_erp / match / mismatch.
function compareAddress(field, sheetRaw, addresses) {
  const a = field.norm(sheetRaw)
  if (isBlank(a)) return { status: 'blank', sheet: sheetRaw, erp: '' }

  let raw
  if (field.pool === 'state') raw = addresses.map((x) => x.state)
  else if (field.pool === 'pincode') raw = addresses.map((x) => x.pincode)
  else if (field.pool === 'city') raw = addresses.map((x) => x.city)
  else raw = addresses.flatMap((x) => [x.title, x.line1, x.line2, x.city, x.county]) // 'text'

  const present = raw.filter((v) => !isBlank(field.norm(v)))
  const set = new Set(present.map((v) => field.norm(v)))
  const disp = [...new Set(present.map((v) => String(v)))].join(' | ')

  if (set.size === 0) return { status: 'missing_erp', sheet: sheetRaw, erp: '' } // nothing in dashboard
  if (set.has(a)) return { status: 'match', sheet: sheetRaw, erp: disp }
  return { status: 'mismatch', sheet: sheetRaw, erp: disp }
}

// sheetRows: [{ code, raw }]; erpByCode: { code -> mapped doctor }
export function reconcile(sheetRows, erpByCode, { includeAddress = true } = {}) {
  const activeFields = FIELDS.filter((f) => includeAddress || f.kind !== 'address')
  const results = sheetRows.map((row) => {
    const c = code(row.code)
    const erp = erpByCode[c] || null
    const fields = {}
    let mismatch = 0, missing = 0
    if (erp) {
      for (const f of activeFields) {
        const r = f.kind === 'address'
          ? compareAddress(f, row.raw[f.sheet], erp.addresses || [])
          : compareField(f, row.raw[f.sheet], f.erp(erp))
        fields[f.key] = r
        if (r.status === 'mismatch') mismatch++
        if (r.status === 'missing_erp') missing++
      }
    }
    return {
      code: c,
      sheetName: row.raw['Dr. Name'] || '',
      erpId: erp ? erp.name : null,
      found: !!erp,
      addressCreated: erp ? Number(erp.addressCreated) === 1 : null,
      fields,
      mismatch,
      missing,
      hasIssue: !erp || mismatch > 0 || missing > 0,
    }
  })

  const perField = {}
  for (const f of activeFields) perField[f.key] = { mismatch: 0, missing: 0 }
  for (const r of results) {
    if (!r.found) continue
    for (const f of activeFields) {
      const s = r.fields[f.key].status
      if (s === 'mismatch') perField[f.key].mismatch++
      if (s === 'missing_erp') perField[f.key].missing++
    }
  }

  const summary = {
    rows: results.length,
    found: results.filter((r) => r.found).length,
    notFound: results.filter((r) => !r.found).length,
    clean: results.filter((r) => r.found && !r.hasIssue).length,
    withIssues: results.filter((r) => r.found && r.hasIssue).length,
    mismatches: results.reduce((s, r) => s + r.mismatch, 0),
    missing: results.reduce((s, r) => s + r.missing, 0),
    perField,
    addressChecked: includeAddress,
    activeFields: activeFields.map((f) => f.key),
  }
  return { results, summary }
}
