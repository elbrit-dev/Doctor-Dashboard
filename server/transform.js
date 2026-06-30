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

// State is taken straight from the sheet — no canonical map. Use the Clinic
// State, falling back to the Lead State, exactly as written.
function pickState(clinicState, leadState) {
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

function buildAddress(r, name, dr) {
  const a = classify(g(r, 'Clinic Info - Address 1'), g(r, 'Clinic Info - Address 2'), g(r, 'Clinic Info - Address 3'), dr)
  if (!a) return null
  return {
    address_title: a.title, address_type: a.type, address_line1: a.line1, address_line2: a.line2, address_line3: a.line3,
    city: g(r, 'Dr. City (Clinic)'), state: pickState(g(r, 'Clinic State'), g(r, 'State')), pincode: g(r, 'Clinic Info - Pincode'),
    country: CFG.COUNTRY, links: [{ link_doctype: 'Lead', link_name: name }],
  }
}

// The full create-Lead body, verbatim from the node (custom_address_created is
// set by the caller once the address is known).
function buildLead(r, code, name, dr, rp) {
  const mob = String(g(r, 'Mobile No.') || '').replace(/\D/g, '')
  const lead = {
    name, salutation: 'Dr', first_name: dr, custom_doctor_code: code,
    custom_specialty: g(r, 'Speciality'), custom_qualification: g(r, 'Qualification'), custom_category: (g(r, 'Category') || undefined),
    mobile_no: (mob || undefined),
    territory: 'HQ-' + g(r, 'HQ'), state: g(r, 'State'), city: g(r, 'Dr. City (Clinic)'), country: CFG.COUNTRY,
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
export function transformRow(r, empMap, existing) {
  const code = strip(g(r, 'Dr. Code')); const name = 'DR-' + code; const dr = g(r, 'Dr. Name'); const ec = g(r, 'Emp Code')
  const address = buildAddress(r, name, dr)

  if (existing.has(code)) {
    return { kind: 'skip', code, name, dr, reason: 'already_in_uat', hasAddress: !!address, address }
  }
  const e = empMap[ec]
  if (!e) return { kind: 'exception', code, dr, empcode: ec, empname: g(r, 'Emp Name'), hq: g(r, 'HQ'), reason: 'employee_not_found' }
  const rp = (e.role_id || e.custom_role_profile || '').trim()
  if (!rp) return { kind: 'exception', code, dr, empcode: ec, empname: g(r, 'Emp Name'), hq: g(r, 'HQ'), reason: 'no_role_profile' }

  const lead = buildLead(r, code, name, dr, rp)
  lead.custom_address_created = address ? 1 : 0
  return { kind: 'create', code, name, hasAddress: !!address, lead, address }
}
