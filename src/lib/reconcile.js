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

// Shared with the server-side writer so the validation agrees with what gets
// written: "Nellur" (sheet) and "HQ-Nellore" (ERPNext) are the SAME HQ. lev +
// soundex also power spelling-tolerant address-word matching below.
import { sameHq, sameToken, lev, soundex } from '../../server/hqMatch.js'

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
  // Qualification is written verbatim (DGO ≠ MD.DGO ≠ MBBS.DGO) → compare exactly.
  { key: 'qualification', label: 'Qualification', sheet: 'Qualification', erp: (d) => d.qualification, norm: text },
  // Speciality is matched to a controlled list (GYNAEC → GYNAE) → tolerant compare.
  { key: 'specialty', label: 'Speciality', sheet: 'Speciality', erp: (d) => d.specialty, norm: text, eq: sameToken },
  { key: 'category', label: 'Category', sheet: 'Category', erp: (d) => d.category, norm: text },
  { key: 'category1', label: 'Category 1', sheet: 'Category 1', erp: (d) => d.category1, norm: text },
  { key: 'category2', label: 'Category 2', sheet: 'Category 2', erp: (d) => d.category2, norm: text },
  { key: 'category3', label: 'Category 3', sheet: 'Category 3', erp: (d) => d.category3, norm: text },
  { key: 'territory', label: 'HQ → Territory', sheet: 'HQ', erp: (d) => d.territory, norm: hq, eq: sameHq },
  { key: 'state', label: 'State', sheet: 'State', erp: (d) => d.state, norm: state },
  { key: 'city', label: 'City', sheet: 'Dr. City (Clinic)', erp: (d) => d.city, norm: text },
  { key: 'mobile', label: 'Mobile', sheet: 'Mobile No.', erp: (d) => d.mobile, norm: phone },
  { key: 'latitude', label: 'Latitude', sheet: 'Standardize Latitude 1', erp: (d) => d.latitude, norm: 'num' },
  { key: 'longitude', label: 'Longitude', sheet: 'Standardize Longitude 1', erp: (d) => d.longitude, norm: 'num' },

  // ---- address (haystack match against ALL of the doctor's addresses) ----
  // The sheet splits one address across 3 lines; ERPNext's Address doctype has
  // only 2 lines (line1 + line2, no line3). Comparing line-by-line therefore
  // false-flags the 3rd fragment, so we check the WHOLE clinic/residence address
  // as one value (word-overlap ≥ 60%) against all of the doctor's address text.
  // Extra ERPNext addresses (e.g. a separate "Doctor" address) only add to the
  // pool a sheet value can match against; they never cause a flag.
  { key: 'caddr', label: 'Clinic Address', sheet: ['Clinic Info - Address 1', 'Clinic Info - Address 2', 'Clinic Info - Address 3'], kind: 'address', pool: 'text', norm: text },
  { key: 'cpin', label: 'Clinic Pincode', sheet: 'Clinic Info - Pincode', kind: 'address', pool: 'pincode', norm: pincode },
  { key: 'raddr', label: 'Resi. Address', sheet: ['Residence Info - Address 1', 'Residence Info - Address 2', 'Residence Info - Address 3'], kind: 'address', pool: 'text', norm: text },
  { key: 'rcity', label: 'Resi. City', sheet: 'Residence Info - City', kind: 'address', pool: 'city', norm: text },
  // Residential pincode is intentionally NOT validated (per CRM: too noisy).
]

// Read a field's sheet value, joining multiple columns (e.g. the 3 address lines)
// into one when `sheet` is an array.
const sheetValue = (raw, key) => Array.isArray(key)
  ? key.map((k) => raw[k]).filter((v) => v != null && String(v).trim() !== '').join(' ')
  : raw[key]

// Lat/long: ~1e-3 ≈ 100 m — treat near-identical coordinates (precision/rounding
// differences like 77.58327 vs 77.5829452) as a match, not a mismatch.
const NUM_TOL = 1e-3

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
  // A field can supply a smarter equality (e.g. HQ phonetic/alias match) that
  // treats formatting-only or same-place differences as equal.
  const equal = field.eq ? field.eq(sheetRaw, erpRaw) : a === b
  return { status: equal ? 'match' : 'mismatch', sheet: sheetRaw, erp: erpRaw }
}

const WORD_OVERLAP = 0.6 // sheet address words found in ERPNext to count as a match
const words = (s) => text(s).split(/\s+/).filter((w) => w.length > 1)

// A sheet address word "hits" ERPNext if it matches a word exactly, by near
// spelling (VADAPALNI ≈ Vadapalani), or by pronunciation (Purasivakkam ≈
// Purasaiwakkam). Only tokens of 4+ chars are fuzzy-matched, so short bits like
// "st"/"rd"/"no" never match loosely.
const FUZZY_MIN = 4
const wordHit = (w, erpWords, erpSx) => {
  if (erpWords.has(w)) return true
  if (w.length < FUZZY_MIN) return false
  if (erpSx.has(soundex(w))) return true
  const thr = Math.max(1, Math.floor(w.length * 0.2))
  for (const ew of erpWords) {
    if (ew.length >= FUZZY_MIN && Math.abs(ew.length - w.length) <= thr && lev(w, ew) <= thr) return true
  }
  return false
}

// Compare a sheet address line against ALL of the doctor's ERPNext addresses.
// status: blank / missing_erp / match / mismatch.
function compareAddress(field, sheetRaw, addresses, docName) {
  const a = field.norm(sheetRaw)
  if (isBlank(a)) return { status: 'blank', sheet: sheetRaw, erp: '' }

  // ----- exact-value pools: pincode, state, city -----
  if (field.pool !== 'text') {
    const raw = field.pool === 'pincode' ? addresses.map((x) => x.pincode)
      : field.pool === 'state' ? addresses.map((x) => x.state)
        : addresses.map((x) => x.city)
    const present = raw.filter((v) => !isBlank(field.norm(v)))
    const set = new Set(present.map((v) => field.norm(v)))
    const disp = [...new Set(present.map(String))].join(' | ')
    if (set.size === 0) return { status: 'missing_erp', sheet: sheetRaw, erp: '' }
    return { status: set.has(a) ? 'match' : 'mismatch', sheet: sheetRaw, erp: disp }
  }

  // ----- free-text address lines (word-overlap, formatting-insensitive) -----
  // If the cell is just the doctor's name (not a real address), skip it.
  if (name(a) === name(docName)) return { status: 'blank', sheet: sheetRaw, erp: '' }

  // All words across every ERPNext address field — the sheet may combine into
  // one cell what ERPNext splits across title/line1/line2/city.
  const erpVals = addresses.flatMap((x) => [x.title, x.line1, x.line2, x.city, x.county]).filter((v) => !isBlank(text(v)))
  const erpWords = new Set(erpVals.flatMap(words))
  const disp = [...new Set(erpVals.map((v) => String(v).trim()))].join(' | ')
  if (erpWords.size === 0) return { status: 'missing_erp', sheet: sheetRaw, erp: '' }

  const sheetWords = [...new Set(words(a))]
  if (sheetWords.length === 0) return { status: 'blank', sheet: sheetRaw, erp: disp }
  const erpSx = new Set([...erpWords].filter((w) => w.length >= FUZZY_MIN).map(soundex))
  const hit = sheetWords.filter((w) => wordHit(w, erpWords, erpSx)).length
  return { status: hit / sheetWords.length >= WORD_OVERLAP ? 'match' : 'mismatch', sheet: sheetRaw, erp: disp }
}

// A doctor's Sales Team (role profile) table must carry each department at most
// once. Group the doctor's role profiles by normalized department and return the
// departments that appear more than once (with the role profiles that collide) —
// this is a data-integrity error surfaced alongside the field mismatches.
function duplicateDepartments(roleProfiles) {
  const byDept = new Map()
  for (const rp of (roleProfiles || [])) {
    const dept = String(rp.department ?? '').trim()
    if (!dept) continue
    const g = byDept.get(text(dept)) || { department: dept, roleProfiles: [] }
    g.roleProfiles.push(String(rp.role ?? rp.role_profile_list ?? '').trim())
    byDept.set(text(dept), g)
  }
  return [...byDept.values()]
    .filter((g) => g.roleProfiles.length > 1)
    .map((g) => ({ department: g.department, count: g.roleProfiles.length, roleProfiles: g.roleProfiles }))
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
      const docName = row.raw['Dr. Name'] || erp.firstName || erp.leadName || ''
      for (const f of activeFields) {
        const sv = sheetValue(row.raw, f.sheet)
        const r = f.kind === 'address'
          ? compareAddress(f, sv, erp.addresses || [], docName)
          : compareField(f, sv, f.erp(erp))
        fields[f.key] = r
        if (r.status === 'mismatch') mismatch++
        if (r.status === 'missing_erp') missing++
      }
    }
    const dupDepartments = erp ? duplicateDepartments(erp.roleProfiles) : []
    return {
      code: c,
      sheetName: row.raw['Dr. Name'] || '',
      erpId: erp ? erp.name : null,
      found: !!erp,
      addressCreated: erp ? Number(erp.addressCreated) === 1 : null,
      fields,
      mismatch,
      missing,
      dupDepartments,
      hasIssue: !erp || mismatch > 0 || missing > 0 || dupDepartments.length > 0,
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
    dupDept: results.filter((r) => r.dupDepartments && r.dupDepartments.length > 0).length,
    perField,
    addressChecked: includeAddress,
    activeFields: activeFields.map((f) => f.key),
  }
  return { results, summary }
}
