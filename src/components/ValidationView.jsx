import { useMemo, useState } from 'react'
import { DEFAULTS } from '../data/doctors.js'
import { validate } from '../validation/rules.js'
import { exportDoctorsExcel, exportIssuesExcel } from '../lib/exportExcel.js'
import KpiCards from './KpiCards.jsx'
import { SeveritySplit, Distribution } from './Charts.jsx'
import IssuesPanel from './IssuesPanel.jsx'
import DoctorTable from './DoctorTable.jsx'
import DoctorDrawer from './DoctorDrawer.jsx'

const EMPTY_FILTERS = { specialty: '', category: '', territory: '', check: '' }

// The validation dashboard (score, checks, per-doctor table + drilldown) for a
// given set of doctor records. Source-agnostic: the records can be a snapshot,
// a live fetch, or a manually entered set of codes.
export default function ValidationView({ doctors, live, onReview, footer }) {
  // Merge batch-constant defaults so the full field set is present, then validate.
  const result = useMemo(() => validate(doctors.map((d) => ({ ...DEFAULTS, ...d }))), [doctors])
  const { records, totals, byRule } = result

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [selected, setSelected] = useState(null)

  const options = useMemo(() => ({
    specialty: distinct(records, (r) => r.specialty),
    category: distinct(records, (r) => r.category || 'Not set'),
    territory: distinct(records, (r) => r.territory || 'Missing'),
    check: byRule.map((r) => ({ value: r.id, label: `${r.label} (${r.count})` })),
  }), [records, byRule])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => {
      if (status === 'error' && r.counts.error === 0) return false
      if (status === 'warning' && !(r.counts.warning > 0 && r.counts.error === 0)) return false
      if (status === 'ready' && r.status !== 'ready') return false
      if (filters.specialty && r.specialty !== filters.specialty) return false
      if (filters.category && (r.category || 'Not set') !== filters.category) return false
      if (filters.territory && (r.territory || 'Missing') !== filters.territory) return false
      if (filters.check && !r.issues.some((i) => i.ruleId === filters.check)) return false
      if (q) {
        const hay = `${r.leadName} ${r.name} ${r.specialty} ${r.territory} ${r.category} ${r.city} ${r.qualification}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [records, query, status, filters])

  const activeFilterCount =
    (status !== 'all' ? 1 : 0) + (query.trim() ? 1 : 0) +
    Object.values(filters).filter(Boolean).length

  const resetAll = () => { setStatus('all'); setQuery(''); setFilters(EMPTY_FILTERS) }
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }))

  const specialtyDist = useMemo(() => distribution(records, 'specialty'), [records])
  const categoryDist = useMemo(() => distribution(records, (r) => r.category || 'Not set'), [records])
  const selectedDoctor = records.find((r) => r.name === selected) || null

  return (
    <>
      <KpiCards totals={totals} />

      <div className="grid">
        <div className="stack">
          <IssuesPanel byRule={byRule} activeRule={filters.check} onSelectRule={(id) => setFilter('check', filters.check === id ? '' : id)} />
          <SeveritySplit totals={totals} />
          <Distribution title="By speciality" hint="Doctor count per speciality" data={specialtyDist} />
          <Distribution title="By category" hint="Doctor grade distribution" data={categoryDist} />
        </div>

        <DoctorTable
          records={filtered}
          totalCount={records.length}
          totals={totals}
          query={query} setQuery={setQuery}
          status={status} setStatus={setStatus}
          filters={filters} setFilter={setFilter}
          options={options}
          activeFilterCount={activeFilterCount}
          resetAll={resetAll}
          selected={selected} onSelect={setSelected}
          onExport={() => exportDoctorsExcel(records, new Date().toISOString().slice(0, 10))}
          onExportIssues={() => exportIssuesExcel(records, new Date().toISOString().slice(0, 10))}
          onExportIssuesUAT={() => exportDoctorsExcel(records.filter((r) => r.counts.error > 0 || r.counts.warning > 0), new Date().toISOString().slice(0, 10))}
        />
      </div>

      {footer}

      {selectedDoctor && (
        <DoctorDrawer doctor={selectedDoctor} onClose={() => setSelected(null)} onReview={live ? onReview : null} />
      )}
    </>
  )
}

function distinct(records, fn) {
  return [...new Set(records.map(fn).filter(Boolean))].sort()
}

function distribution(records, keyOrFn) {
  const fn = typeof keyOrFn === 'function' ? keyOrFn : (r) => r[keyOrFn]
  const map = new Map()
  for (const r of records) {
    const k = fn(r) || '—'
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}
