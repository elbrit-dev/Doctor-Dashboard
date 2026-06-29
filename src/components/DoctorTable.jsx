import { IconSearch, IconDownload } from './icons.jsx'

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'error', label: 'Errors', cls: 'error' },
  { key: 'warning', label: 'Warnings', cls: 'warning' },
  { key: 'ready', label: 'Ready', cls: 'ready' },
]

export default function DoctorTable({
  records, totalCount, totals, query, setQuery, status, setStatus,
  filters, setFilter, options, activeFilterCount, resetAll, selected, onSelect, onExport,
}) {
  const counts = {
    all: totals.doctors,
    error: totals.withErrors,
    warning: totals.withWarnings,
    ready: totals.ready,
  }
  return (
    <div className="card">
      {/* Row 1 — search + status segmented control */}
      <div className="toolbar">
        <label className="search">
          <IconSearch />
          <input
            placeholder="Search name, code, speciality, territory, qualification…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="segmented">
          {STATUS_TABS.map((f) => (
            <button key={f.key} className={status === f.key ? 'active ' + (f.cls || '') : ''} onClick={() => setStatus(f.key)}>
              {f.label}<span className="pill">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 2 — field filters */}
      <div className="toolbar filterbar">
        <Select label="Speciality" value={filters.specialty} onChange={(v) => setFilter('specialty', v)} options={options.specialty} />
        <Select label="Category" value={filters.category} onChange={(v) => setFilter('category', v)} options={options.category} />
        <Select label="Territory" value={filters.territory} onChange={(v) => setFilter('territory', v)} options={options.territory} />
        <Select label="Check failed" value={filters.check} onChange={(v) => setFilter('check', v)} options={options.check} wide />
        <div className="filterbar__spacer" />
        <span className="result-count">
          {records.length} of {totalCount}
        </span>
        {activeFilterCount > 0 && (
          <button className="reset-btn" onClick={resetAll}>Reset{activeFilterCount > 1 ? ` (${activeFilterCount})` : ''} ✕</button>
        )}
        <button className="export-btn" onClick={onExport} title={`Download all ${totalCount} doctors as Excel`}>
          <IconDownload width={15} height={15} /> Export Excel
        </button>
      </div>

      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Doctor</th>
              <th>Speciality</th>
              <th>Qual.</th>
              <th>Cat.</th>
              <th>Territory</th>
              <th className="num">Geo</th>
              <th className="num">Contact</th>
              <th>Issues</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.name} className={selected === r.name ? 'selected' : ''} onClick={() => onSelect(r.name)}>
                <td>
                  <div className="docname">{r.leadName.trim() || '—'}</div>
                  <div className="code">{r.name}</div>
                </td>
                <td><span className="tag">{r.specialty || '—'}</span></td>
                <td className="muted">{r.qualification || '—'}</td>
                <td>{r.category ? <span className="tag">{r.category}</span> : <span className="muted">—</span>}</td>
                <td>{r.territory || <span className="sev-error" style={{ fontWeight: 600 }}>missing</span>}</td>
                <td className="num"><Flag ok={hasGeo(r)} /></td>
                <td className="num"><Flag ok={hasContact(r)} /></td>
                <td><MiniCounts counts={r.counts} /></td>
                <td><StatusPill status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty">No doctors match these filters. <button className="linklike" onClick={resetAll}>Reset</button></div>}
      </div>
    </div>
  )
}

function Select({ label, value, onChange, options, wide }) {
  return (
    <label className={`fselect ${wide ? 'fselect--wide' : ''} ${value ? 'active' : ''}`}>
      <span className="fselect__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          typeof o === 'string'
            ? <option key={o} value={o}>{o}</option>
            : <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

const hasGeo = (r) => r.latitude && r.longitude && Number(r.latitude) !== 0 && Number(r.longitude) !== 0
const hasContact = (r) => [r.mobile, r.phone, r.whatsapp].some((v) => v && String(v).replace(/\D/g, '').length >= 10)

function Flag({ ok }) {
  return <span className={`flag ${ok ? 'yes' : 'no'}`}>{ok ? '✓' : '✕'}</span>
}

function MiniCounts({ counts }) {
  const parts = []
  if (counts.error) parts.push(<span className="c sev-error" key="e">●{counts.error}</span>)
  if (counts.warning) parts.push(<span className="c sev-warning" key="w">●{counts.warning}</span>)
  if (counts.info) parts.push(<span className="c sev-info" key="i">●{counts.info}</span>)
  if (parts.length === 0) return <span className="muted">—</span>
  return <span className="minicount">{parts}</span>
}

export function StatusPill({ status }) {
  const label = status === 'ready' ? 'Ready' : status === 'error' ? 'Has errors' : 'Review'
  return <span className={`status-pill ${status}`}><span className="d" />{label}</span>
}
