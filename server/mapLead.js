// Maps a raw ERPNext Lead document into the shape the dashboard/validation engine
// expects (identical to the objects in src/data/doctors.js). Keep this in sync
// with that file's field names so live and snapshot data are interchangeable.

export function mapLead(d) {
  return {
    name: d.name,
    code: d.custom_doctor_code ?? null,
    salutation: d.salutation ?? '',
    firstName: d.first_name ?? '',
    leadName: d.lead_name ?? '',
    specialityLegacy: emptyToNull(d.custom_speciality),
    specialty: d.custom_specialty ?? '',
    qualification: d.custom_qualification ?? '',
    category: emptyToNull(d.custom_category),
    latitude: numOr0(d.custom_latitude),
    longitude: numOr0(d.custom_longitude),
    hasGeoJson: !!(d.custom_latitude_and_longitude && String(d.custom_latitude_and_longitude).trim()),
    territory: emptyToNull(d.territory),
    city: d.city ?? '',
    state: d.state ?? '',
    country: d.country ?? '',
    status: d.status ?? '',
    qualificationStatus: d.qualification_status ?? '',
    addressCreated: Number(d.custom_address_created) || 0,
    mobile: emptyToNull(d.mobile_no),
    phone: emptyToNull(d.phone),
    whatsapp: emptyToNull(d.whatsapp_no),
    owner: d.owner ?? '',
    modifiedBy: d.modified_by ?? '',
    creation: trimSeconds(d.creation),
    modified: trimSeconds(d.modified),
    namingSeries: d.naming_series ?? '',
    company: d.company ?? '',
    language: d.language ?? '',
    noOfEmployees: d.no_of_employees ?? '',
    annualRevenue: d.annual_revenue ?? 0,
    leadType: d.type ?? '',
    requestType: d.request_type ?? '',
    disabled: Number(d.disabled) || 0,
    unsubscribed: Number(d.unsubscribed) || 0,
    docstatus: Number(d.docstatus) || 0,
    roleProfiles: (d.custom_role_profile ?? []).map((r) => ({
      role: r.role_profile_list ?? '',
      department: r.department ?? '',
      hq: r.hq ?? '',
    })),
  }
}

const emptyToNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : v)
const numOr0 = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v))
const trimSeconds = (v) => (v ? String(v).slice(0, 19) : '')
