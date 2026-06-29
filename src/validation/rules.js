// Validation engine for doctor (Lead) records.
// Each rule is a pure function over the full dataset that returns the set of
// record names (DR- ids) that FAIL the check, plus metadata. The engine then
// builds per-record and aggregate results. Adding a rule here automatically
// flows through the KPIs, charts, issues panel and per-doctor drilldown.

export const SEVERITY = {
  error: { key: 'error', label: 'Error', weight: 25, rank: 3 },
  warning: { key: 'warning', label: 'Warning', weight: 8, rank: 2 },
  info: { key: 'info', label: 'Info', weight: 2, rank: 1 },
}

const CANONICAL_STATES = new Set(['Tamil Nadu', 'Kerala', 'Karnataka', 'Andhra Pradesh', 'Telangana'])

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== ''
const isRealPhone = (v) => hasValue(v) && /\d/.test(String(v)) && String(v).replace(/\D/g, '').length >= 10

// ---- Rule definitions -------------------------------------------------------
// test(doctor, ctx) -> true when the record FAILS (i.e. has the problem).
// ctx carries cross-record info (e.g. duplicate name index).

export const RULES = [
  {
    id: 'geo_missing',
    label: 'Missing geo-coordinates',
    severity: 'error',
    category: 'Geo',
    description: 'Latitude/longitude is 0 or blank — the doctor cannot be placed on the map or routed.',
    fix: 'Capture the clinic location so latitude and longitude are populated.',
    test: (d) => !hasValue(d.latitude) || !hasValue(d.longitude) || Number(d.latitude) === 0 || Number(d.longitude) === 0,
  },
  {
    id: 'territory_missing',
    label: 'Missing territory',
    severity: 'error',
    category: 'Org',
    description: 'No territory (HQ) assigned on the lead — breaks territory-based reporting and ownership.',
    fix: 'Set the territory to match the doctor’s primary HQ.',
    test: (d) => !hasValue(d.territory),
  },
  {
    id: 'category_missing',
    label: 'Missing category',
    severity: 'warning',
    category: 'Classification',
    description: 'custom_category is blank — doctor is not graded (C / SC / E / K / P30 …).',
    fix: 'Assign the correct doctor category.',
    test: (d) => !hasValue(d.category),
  },
  {
    id: 'contact_missing',
    label: 'No usable contact number',
    severity: 'warning',
    category: 'Contact',
    description: 'Mobile / phone / WhatsApp are all blank or placeholder "0" — no way to reach the doctor.',
    fix: 'Add a valid 10-digit mobile number.',
    test: (d) => !(isRealPhone(d.mobile) || isRealPhone(d.phone) || isRealPhone(d.whatsapp)),
  },
  {
    id: 'name_whitespace',
    label: 'Name has stray whitespace',
    severity: 'warning',
    category: 'Naming',
    description: 'First name / lead name has leading or trailing spaces — causes duplicate-looking records and bad search.',
    fix: 'Trim the name fields.',
    test: (d) => d.firstName !== d.firstName.trim() || d.leadName !== d.leadName.trim(),
  },
  {
    id: 'duplicate_name',
    label: 'Possible duplicate name',
    severity: 'warning',
    category: 'Naming',
    description: 'Another record shares the same doctor name — may be a duplicate entry.',
    fix: 'Confirm whether the records are the same doctor and merge if so.',
    test: (d, ctx) => (ctx.nameCounts.get(d.leadName.trim().toLowerCase()) || 0) > 1,
  },
  {
    id: 'territory_hq_mismatch',
    label: 'Territory ≠ role-profile HQ',
    severity: 'warning',
    category: 'Org',
    description: 'The lead’s territory does not match the HQ on one or more of its role profiles.',
    fix: 'Align the lead territory with the role-profile HQ (or vice-versa).',
    test: (d) => hasValue(d.territory) && d.roleProfiles.length > 0 &&
      d.roleProfiles.some((r) => hasValue(r.hq) && r.hq !== d.territory),
  },
  {
    id: 'state_nonstandard',
    label: 'Non-standard state value',
    severity: 'warning',
    category: 'Address',
    description: 'State is stored as a code like "Tn-Chennai" instead of the canonical state name.',
    fix: 'Normalise the state to its official name (e.g. "Tamil Nadu").',
    test: (d) => hasValue(d.state) && !CANONICAL_STATES.has(d.state),
  },
  {
    id: 'address_not_created',
    label: 'Address record not created',
    severity: 'info',
    category: 'Address',
    description: 'custom_address_created is 0 — the linked Address document has not been generated yet.',
    fix: 'Generate the address record once coordinates and city are confirmed.',
    test: (d) => Number(d.addressCreated) !== 1,
  },
  {
    id: 'legacy_speciality_field',
    label: 'Legacy speciality field still set',
    severity: 'info',
    category: 'Hygiene',
    description: 'Both custom_speciality (legacy, misspelled) and custom_specialty are populated — clean up the old field.',
    fix: 'Remove the legacy custom_speciality value; keep custom_specialty.',
    test: (d) => hasValue(d.specialityLegacy),
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))

// ---- Engine -----------------------------------------------------------------

export function validate(doctors) {
  const nameCounts = new Map()
  for (const d of doctors) {
    const key = d.leadName.trim().toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1)
  }
  const ctx = { nameCounts }

  const records = doctors.map((d) => {
    const issues = []
    for (const rule of RULES) {
      if (rule.test(d, ctx)) {
        issues.push({ ruleId: rule.id, label: rule.label, severity: rule.severity, category: rule.category, fix: rule.fix })
      }
    }
    const counts = countBySeverity(issues)
    const score = scoreFor(issues)
    const status = counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'ready'
    return { ...d, issues, counts, score, status }
  })

  const totals = {
    doctors: records.length,
    ready: records.filter((r) => r.status === 'ready').length,
    withErrors: records.filter((r) => r.counts.error > 0).length,
    withWarnings: records.filter((r) => r.counts.warning > 0 && r.counts.error === 0).length,
    issues: records.reduce((s, r) => s + r.issues.length, 0),
    error: records.reduce((s, r) => s + r.counts.error, 0),
    warning: records.reduce((s, r) => s + r.counts.warning, 0),
    info: records.reduce((s, r) => s + r.counts.info, 0),
  }
  totals.score = Math.round(records.reduce((s, r) => s + r.score, 0) / (records.length || 1))

  // Per-rule rollup for the issues panel
  const byRule = RULES.map((rule) => {
    const affected = records.filter((r) => r.issues.some((i) => i.ruleId === rule.id))
    return { ...rule, count: affected.length, affected: affected.map((r) => r.name) }
  }).filter((r) => r.count > 0)
    .sort((a, b) => SEVERITY[b.severity].rank - SEVERITY[a.severity].rank || b.count - a.count)

  return { records, totals, byRule }
}

function countBySeverity(issues) {
  const c = { error: 0, warning: 0, info: 0 }
  for (const i of issues) c[i.severity]++
  return c
}

function scoreFor(issues) {
  const penalty = issues.reduce((s, i) => s + SEVERITY[i.severity].weight, 0)
  return Math.max(0, 100 - penalty)
}
