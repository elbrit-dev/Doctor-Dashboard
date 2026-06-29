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

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== ''
const isRealPhone = (v) => hasValue(v) && /\d/.test(String(v)) && String(v).replace(/\D/g, '').length >= 10

// ---- Rule definitions -------------------------------------------------------
// Presence checks only: each rule answers "is this field filled or empty?".
// No formatting / standardization / consistency checks — test() -> true when
// the field is NOT filled.

export const RULES = [
  {
    id: 'name_missing',
    label: 'Missing doctor name',
    severity: 'error',
    category: 'Identity',
    description: 'First name / lead name is blank.',
    fix: 'Enter the doctor’s name.',
    test: (d) => !hasValue(d.firstName) || !hasValue(d.leadName),
  },
  {
    id: 'geo_missing',
    label: 'Missing geo-coordinates',
    severity: 'error',
    category: 'Geo',
    description: 'Latitude/longitude is blank or 0 — location not filled.',
    fix: 'Fill in the clinic latitude and longitude.',
    test: (d) => !hasValue(d.latitude) || !hasValue(d.longitude) || Number(d.latitude) === 0 || Number(d.longitude) === 0,
  },
  {
    id: 'territory_missing',
    label: 'Missing territory',
    severity: 'error',
    category: 'Org',
    description: 'No territory (HQ) is filled on the record.',
    fix: 'Fill in the territory.',
    test: (d) => !hasValue(d.territory),
  },
  {
    id: 'speciality_missing',
    label: 'Missing speciality',
    severity: 'warning',
    category: 'Classification',
    description: 'Speciality field is blank.',
    fix: 'Fill in the doctor’s speciality.',
    test: (d) => !hasValue(d.specialty),
  },
  {
    id: 'qualification_missing',
    label: 'Missing qualification',
    severity: 'warning',
    category: 'Classification',
    description: 'Qualification field is blank.',
    fix: 'Fill in the doctor’s qualification.',
    test: (d) => !hasValue(d.qualification),
  },
  {
    id: 'category_missing',
    label: 'Missing category',
    severity: 'warning',
    category: 'Classification',
    description: 'Category is blank.',
    fix: 'Fill in the doctor category.',
    test: (d) => !hasValue(d.category),
  },
  {
    id: 'contact_missing',
    label: 'Missing contact number',
    severity: 'warning',
    category: 'Contact',
    description: 'Mobile / phone / WhatsApp are all blank or placeholder "0".',
    fix: 'Fill in a valid contact number.',
    test: (d) => !(isRealPhone(d.mobile) || isRealPhone(d.phone) || isRealPhone(d.whatsapp)),
  },
  {
    id: 'city_missing',
    label: 'Missing city',
    severity: 'warning',
    category: 'Address',
    description: 'City field is blank.',
    fix: 'Fill in the city.',
    test: (d) => !hasValue(d.city),
  },
  {
    id: 'state_missing',
    label: 'Missing state',
    severity: 'warning',
    category: 'Address',
    description: 'State field is blank.',
    fix: 'Fill in the state.',
    test: (d) => !hasValue(d.state),
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))

// ---- Engine -----------------------------------------------------------------

export function validate(doctors) {
  const records = doctors.map((d) => {
    const issues = []
    for (const rule of RULES) {
      if (rule.test(d)) {
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
