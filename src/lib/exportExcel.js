import * as XLSX from 'xlsx'

// Empty values become "-" so every cell in the export is filled, per request.
const dash = (v) => {
  if (v === null || v === undefined) return '-'
  const s = String(v).trim()
  return s === '' ? '-' : s
}
const realPhone = (v) => (v && String(v).replace(/\D/g, '').length >= 10 ? v : '-')

// Builds a 2-sheet workbook (Doctors + Sales Team) and triggers a download.
export function exportDoctorsExcel(records, stamp) {
  const doctors = records.map((r) => ({
    'Doctor ID': r.name,
    'Doctor Code': dash(r.code),
    Salutation: dash(r.salutation),
    'First Name': dash(r.firstName),
    'Lead Name': dash(r.leadName && r.leadName.trim()),
    Speciality: dash(r.specialty),
    'Legacy Speciality': dash(r.specialityLegacy),
    Qualification: dash(r.qualification),
    Category: dash(r.category),
    Category1: dash(r.category1),
    Category2: dash(r.category2),
    Category3: dash(r.category3),
    Status: dash(r.status),
    'Qualification Status': dash(r.qualificationStatus),
    Mobile: realPhone(r.mobile),
    Phone: realPhone(r.phone),
    WhatsApp: realPhone(r.whatsapp),
    Territory: dash(r.territory),
    City: dash(r.city),
    State: dash(r.state),
    Country: dash(r.country),
    Latitude: r.latitude && Number(r.latitude) !== 0 ? r.latitude : '-',
    Longitude: r.longitude && Number(r.longitude) !== 0 ? r.longitude : '-',
    'Address Created': Number(r.addressCreated) === 1 ? 'Yes' : 'No',
    'Address Title': dash(r.addressTitle),
    'Address Line 1': dash(r.addressLine1),
    'Address Line 2': dash(r.addressLine2),
    'Address City': dash(r.addressCity),
    County: dash(r.county),
    'Address State': dash(r.addressState),
    Pincode: dash(r.pincode),
    'Address Country': dash(r.addressCountry),
    GSTIN: dash(r.gstin),
    'GST State': dash(r.gstState),
    'GST State No': dash(r.gstStateNumber),
    'Role Profiles': r.roleProfiles?.length ? r.roleProfiles.map((p) => p.role).join(', ') : '-',
    'Validation Status': r.status === 'ready' ? 'Ready' : r.status === 'error' ? 'Has errors' : 'Review',
    Errors: r.counts?.error ?? 0,
    Warnings: r.counts?.warning ?? 0,
    'Quality Score': r.score ?? '-',
    'Issues Found': r.issues?.length ? r.issues.map((i) => i.label).join('; ') : '-',
    Owner: dash(r.owner),
    'Modified By': dash(r.modifiedBy),
    Created: dash(r.creation),
    'Last Modified': dash(r.modified),
  }))

  // One row per role profile (the Sales Team table), keeping doctors with none.
  const salesTeam = []
  records.forEach((r) => {
    if (r.roleProfiles?.length) {
      r.roleProfiles.forEach((p, i) =>
        salesTeam.push({
          'Doctor ID': r.name,
          'Doctor Name': dash(r.leadName && r.leadName.trim()),
          '#': i + 1,
          'Role Profile List': dash(p.role),
          Department: dash(p.department),
          HQ: dash(p.hq),
        }),
      )
    } else {
      salesTeam.push({ 'Doctor ID': r.name, 'Doctor Name': dash(r.leadName && r.leadName.trim()), '#': '-', 'Role Profile List': '-', Department: '-', HQ: '-' })
    }
  })

  const wb = XLSX.utils.book_new()
  const wsDoctors = XLSX.utils.json_to_sheet(doctors)
  const wsSales = XLSX.utils.json_to_sheet(salesTeam)
  wsDoctors['!cols'] = autoWidth(doctors)
  wsSales['!cols'] = autoWidth(salesTeam)
  XLSX.utils.book_append_sheet(wb, wsDoctors, 'Doctors')
  XLSX.utils.book_append_sheet(wb, wsSales, 'Sales Team')
  XLSX.writeFile(wb, `doctor-validation-${stamp || 'export'}.xlsx`)
}

function autoWidth(rows) {
  if (!rows.length) return []
  return Object.keys(rows[0]).map((k) => {
    const max = Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length))
    return { wch: Math.min(Math.max(max + 2, 8), 50) }
  })
}
