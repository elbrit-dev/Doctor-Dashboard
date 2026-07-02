// ─────────────────────────────────────────────────────────────────────────────
// Verbatim port of the n8n "Transform Rows" Code node.
// Field names and regexes are copied EXACTLY — ERPNext's `fetch_from`
// (department/HQ auto-fill from the role profile) and the duplicate/skip logic
// depend on them, so do not "tidy" them.
//
// NOTE on `strip`: this is the verbatim n8n helper — it only removes leading
// zeros (and maps "" → "0"). It does NOT strip "DR-" or non-digits, because the
// values it's applied to (sheet `Dr. Code`, Lead `custom_doctor_code`) are
// already plain numeric codes. Both sides are normalized with the SAME function,
// so the create/skip comparison is sound.
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  ROLE_SRC: 'custom_role_profile',
  SKIP_NAME_AS_ADDR: true,
  LEAD_OWNER: 'support@klyonix.com',
  COMPANY: 'Elbrit Lifesciences Private Limited',
  COUNTRY: 'India',
}

// A real street address (vs. a bare clinic/doctor or locality name) is detected
// by a door/house NUMBER in Address Info 1. Names and bare localities have none
// → Doctor:  "SIMS", "K M HOSP.", "Madha Medical College & Hospital",
//            "Chinmaya Nagar", "Radha Krishnan Salai".
// A number means a real address → Clinic: "NO 174, NSK VADAPALANI", "100 Feet Road".
const NUM_RE = /\d/

export const strip = (c) => (String(c || '').replace(/^0+/, '') || '0')

// A "vacant" Emp Code (e.g. V01869) has no Employee record, but the covering
// employee's real id is embedded in the Emp Name, e.g.
// "Vacant_Nandha Kumar C (E01198)" → E01198. Pull out the last parenthesized
// employee id so we can fall back to it when the Emp Code itself isn't found.
export const extractEmpId = (empName) => {
  const all = [...String(empName || '').matchAll(/\(\s*([A-Za-z]{0,3}\d{3,})\s*\)/g)]
  return all.length ? all[all.length - 1][1].trim() : ''
}

// Resolve a sheet row's Employee: prefer the Emp Code; if that has no Employee
// record (vacant position), fall back to the id embedded in the Emp Name.
export const resolveEmp = (r, empMap) => {
  const ec = g(r, 'Emp Code')
  if (empMap[ec]) return empMap[ec]
  const alt = extractEmpId(g(r, 'Emp Name'))
  return alt ? empMap[alt] : undefined
}

// ERPNext's Address doctype VALIDATES `state` against the country's official
// list — raw sheet values like "Tamilnadu" or "Tn-Chennai" are rejected
// (HTTP 417). So the Address state must be canonicalized. (The Lead's own
// `state` field is free text and keeps the raw sheet value.) Keys are
// despaced+lowercased; covers all 28 states + 8 UTs and common variants.
const STATE_CANON = {
  tamilnadu: 'Tamil Nadu', tn: 'Tamil Nadu',
  kerala: 'Kerala', kl: 'Kerala', ker: 'Kerala',
  karnataka: 'Karnataka', ka: 'Karnataka', kar: 'Karnataka',
  andhrapradesh: 'Andhra Pradesh', ap: 'Andhra Pradesh', andhra: 'Andhra Pradesh',
  telangana: 'Telangana', ts: 'Telangana', tg: 'Telangana', telengana: 'Telangana',
  puducherry: 'Puducherry', pondicherry: 'Puducherry', py: 'Puducherry', pondy: 'Puducherry',
  goa: 'Goa', ga: 'Goa',
  maharashtra: 'Maharashtra', mh: 'Maharashtra', maharastra: 'Maharashtra',
  gujarat: 'Gujarat', gj: 'Gujarat',
  rajasthan: 'Rajasthan', rj: 'Rajasthan',
  delhi: 'Delhi', newdelhi: 'Delhi', dl: 'Delhi',
  punjab: 'Punjab', pb: 'Punjab',
  haryana: 'Haryana', hr: 'Haryana',
  uttarpradesh: 'Uttar Pradesh', up: 'Uttar Pradesh',
  uttarakhand: 'Uttarakhand', uk: 'Uttarakhand', uttaranchal: 'Uttarakhand',
  himachalpradesh: 'Himachal Pradesh', hp: 'Himachal Pradesh',
  jammuandkashmir: 'Jammu and Kashmir', jammukashmir: 'Jammu and Kashmir', jk: 'Jammu and Kashmir',
  ladakh: 'Ladakh',
  chandigarh: 'Chandigarh', ch: 'Chandigarh',
  madhyapradesh: 'Madhya Pradesh', mp: 'Madhya Pradesh',
  chhattisgarh: 'Chhattisgarh', chattisgarh: 'Chhattisgarh', cg: 'Chhattisgarh',
  bihar: 'Bihar', br: 'Bihar',
  jharkhand: 'Jharkhand', jh: 'Jharkhand',
  westbengal: 'West Bengal', wb: 'West Bengal',
  odisha: 'Odisha', orissa: 'Odisha', od: 'Odisha',
  assam: 'Assam', as: 'Assam',
  arunachalpradesh: 'Arunachal Pradesh', ar: 'Arunachal Pradesh',
  manipur: 'Manipur', mn: 'Manipur',
  meghalaya: 'Meghalaya', ml: 'Meghalaya',
  mizoram: 'Mizoram', mz: 'Mizoram',
  nagaland: 'Nagaland', nl: 'Nagaland',
  tripura: 'Tripura', tr: 'Tripura',
  sikkim: 'Sikkim', sk: 'Sikkim',
  andamanandnicobarislands: 'Andaman and Nicobar Islands', andaman: 'Andaman and Nicobar Islands',
  lakshadweep: 'Lakshadweep',
  dadraandnagarhavelianddamananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
}

// Canonicalize a state for the Address. Tries Clinic State then Lead State; for
// each, matches the despaced form and the part before a "-" (so "Tn-Chennai" →
// "tn" → "Tamil Nadu"). Falls back to the raw value (which ERPNext may reject —
// surfaced as a per-row error) when nothing matches.
function canonState(clinicState, leadState) {
  for (const raw of [clinicState, leadState]) {
    const r = (raw || '').trim(); if (!r) continue
    const low = r.toLowerCase().replace(/\s+/g, ' ').trim()
    const variants = [low.replace(/[\s.]/g, '')]
    if (low.includes('-')) variants.push(low.split('-')[0].replace(/[\s.]/g, ''))
    for (const v of variants) { if (STATE_CANON[v]) return STATE_CANON[v] }
  }
  return (clinicState || leadState || '').trim()
}

const g = (r, k) => { const v = r[k]; return v == null ? '' : String(v).trim() }

function classify(a1, a2, a3, dr) {
  if (!a1) return null
  if (CFG.SKIP_NAME_AS_ADDR && a1.trim().toLowerCase() === dr.trim().toLowerCase()) return null
  // A number in Address Info 1 marks a real street address → Clinic, titled by
  // the address itself. A bare name/locality → Doctor, titled by the doctor.
  const isFullAddress = NUM_RE.test(a1)
  if (isFullAddress) {
    return { type: 'Clinic', title: a1, line1: a1, line2: a2, line3: a3 }
  }
  return { type: 'Doctor', title: dr, line1: a1, line2: a2, line3: a3 }
}

export function buildAddress(r, name, dr) {
  const a = classify(g(r, 'Clinic Info - Address 1'), g(r, 'Clinic Info - Address 2'), g(r, 'Clinic Info - Address 3'), dr)
  if (!a) return null
  // ERPNext's Address doctype has only address_line1 + address_line2 (no line3).
  // The sheet carries 3 clinic address lines, so fold lines 2 & 3 into line2 —
  // otherwise the 3rd line (e.g. "ROAD" of "MAIN ROAD") is silently dropped.
  const line2 = [a.line2, a.line3].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
  return {
    address_title: a.title, address_type: a.type, address_line1: a.line1, address_line2: line2,
    city: g(r, 'Dr. City (Clinic)'), state: canonState(g(r, 'Clinic State'), g(r, 'State')), pincode: g(r, 'Clinic Info - Pincode'),
    country: CFG.COUNTRY, links: [{ link_doctype: 'Lead', link_name: name }],
  }
}

// The full create-Lead body, verbatim from the node (custom_address_created is
// set by the caller once the address is known). `territory` overrides the raw
// "HQ-<HQ>" when the caller has resolved the HQ to an existing UAT Territory
// (see server/territory.js) — this avoids the LinkValidationError a wrong/
// misspelled territory would otherwise trigger.
export function buildLead(r, code, name, dr, rp, territory) {
  const mob = String(g(r, 'Mobile No.') || '').replace(/\D/g, '')
  const lead = {
    name, salutation: 'Dr', first_name: dr, custom_doctor_code: code,
    custom_specialty: g(r, 'Speciality'), custom_qualification: g(r, 'Qualification'), custom_category: (g(r, 'Category') || undefined),
    custom_category1: (g(r, 'Category 1') || undefined), custom_category2: (g(r, 'Category 2') || undefined), custom_category3: (g(r, 'Category 3') || undefined),
    mobile_no: (mob || undefined),
    territory: territory || ('HQ-' + g(r, 'HQ')), state: g(r, 'State'), city: g(r, 'Dr. City (Clinic)'), country: CFG.COUNTRY,
    status: 'Active', lead_owner: CFG.LEAD_OWNER, company: CFG.COMPANY,
    custom_role_profile: [{ role_profile_list: rp }],
  }
  const latS = g(r, 'Standardize Latitude 1'), lonS = g(r, 'Standardize Longitude 1')
  const lat = parseFloat(latS), lon = parseFloat(lonS)
  if (latS !== '' && lonS !== '' && isFinite(lat) && isFinite(lon)) {
    lead.custom_latitude = lat; lead.custom_longitude = lon; lead.custom_latitude_and_longitude = JSON.stringify({ x: lat, y: lon })
  }
  return lead
}

// Classify one sheet row against UAT, exactly like the n8n node:
//   - code already in UAT       → kind 'skip'  (no action; reported only)
//   - employee/role missing     → kind 'exception'
//   - otherwise                 → kind 'create' (carries `lead` + `address`)
export function transformRow(r, empMap, existing, resolveTerritory) {
  const code = strip(g(r, 'Dr. Code')); const name = 'DR-' + code; const dr = g(r, 'Dr. Name'); const ec = g(r, 'Emp Code')
  const address = buildAddress(r, name, dr)

  if (existing.has(code)) {
    return { kind: 'skip', code, name, dr, reason: 'already_in_uat', hasAddress: !!address, address }
  }
  const e = resolveEmp(r, empMap) // Emp Code, or the id inside the Emp Name for vacant codes
  if (!e) return { kind: 'exception', code, dr, empcode: ec, empname: g(r, 'Emp Name'), hq: g(r, 'HQ'), reason: 'employee_not_found' }
  const rp = (e.role_id || e.custom_role_profile || '').trim()
  if (!rp) return { kind: 'exception', code, dr, empcode: ec, empname: g(r, 'Emp Name'), hq: g(r, 'HQ'), reason: 'no_role_profile' }

  // Map the sheet HQ onto an existing Territory (spelling/prefix tolerant).
  const territory = resolveTerritory ? resolveTerritory(g(r, 'HQ')) : null
  const lead = buildLead(r, code, name, dr, rp, territory)
  lead.custom_address_created = address ? 1 : 0
  return { kind: 'create', code, name, hasAddress: !!address, lead, address }
}
