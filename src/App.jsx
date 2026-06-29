import { useMemo, useState } from 'react'
import { doctors as rawDoctors, DEFAULTS, SNAPSHOT_DATE, SOURCE } from './data/doctors.js'
import { validate } from './validation/rules.js'
import { IconShield, IconRefresh } from './components/icons.jsx'
import KpiCards from './components/KpiCards.jsx'
import { SeveritySplit, Distribution } from './components/Charts.jsx'
import IssuesPanel from './components/IssuesPanel.jsx'
import DoctorTable from './components/DoctorTable.jsx'
import DoctorDrawer from './components/DoctorDrawer.jsx'

// Merge the batch-constant fields into every record so the full doctype field
// set is available to the UI. Validation is unaffected (rules read named fields).
const enriched = rawDoctors.map((d) => ({ ...DEFAULTS, ...d }))

const EMPTY_FILTERS = { specialty: '', category: '', territory: '', check: '' }

export default function App() {
  const result = useMemo(() => validate(enriched), [])
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
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <div className="logo"><IconShield width={24} height={24} /></div>
          <div>
            <h1>Doctor Data Validation</h1>
            <p className="header__sub">Pre-handoff quality review for the CRM team</p>
          </div>
        </div>
        <div className="header__meta">
          <span className="env-badge"><span className="dot" />ERPNext UAT</span>
          <span className="env-badge"><IconRefresh width={14} height={14} />Snapshot {SNAPSHOT_DATE}</span>
        </div>
      </header>

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
        />
      </div>

      <p className="footer-note">
        Validating <code>{records.length}</code> doctor records · source: {SOURCE}.<br />
        Checks run live in the browser against the snapshot. Replace <code>src/data/doctors.js</code> with a
        live fetch to validate straight from ERPNext.
      </p>

      {selectedDoctor && <DoctorDrawer doctor={selectedDoctor} onClose={() => setSelected(null)} />}
    </div>
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
