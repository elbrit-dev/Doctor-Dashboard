import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { parseSheet, cleanCodes } from '../lib/parseSheet.js'
import { fetchLeadsByCode } from '../data/source.js'
import { reconcile, FIELDS } from '../lib/reconcile.js'
import { IconDownload, IconSearch } from './icons.jsx'

const PAGE = 50
const STATUS_META = {
  match: { sym: '✓', cls: 'rc-match', label: 'Match' },
  mismatch: { sym: '≠', cls: 'rc-mismatch', label: 'In dashboard but value wrong' },
  missing_erp: { sym: '∅', cls: 'rc-missing', label: 'In sheet, not in dashboard (null)' },
  sheet_blank: { sym: '·', cls: 'rc-sheetblank', label: 'Only in dashboard (not in sheet)' },
  blank: { sym: '—', cls: 'rc-blank', label: 'Both empty' },
}

export default function ReconcileView({ live }) {
  const fileRef = useRef(null)
  const [phase, setPhase] = useState('idle') // idle | working | done | error
  const [progress, setProgress] = useState(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState(null)
  const [data, setData] = useState(null) // { results, summary }
  const [view, setView] = useState('issues') // all | issues | notfound | clean
  const [fieldFilter, setFieldFilter] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(null)
  const [checkAddress, setCheckAddress] = useState(true)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setError(null); setPhase('working'); setData(null); setPage(0)
    try {
      const { rows, total } = await parseSheet(file)
      const codes = cleanCodes(rows)
      setProgress({ done: 0, total: codes.length })
      const { doctors } = await fetchLeadsByCode(codes, {
        addresses: checkAddress,
        onProgress: (done, t) => setProgress({ done, total: t }),
      })
      const out = reconcile(rows, doctors, { includeAddress: checkAddress })
      out.summary.sheetTotal = total
      setData(out); setPhase('done'); setProgress(null)
    } catch (err) {
      setError(err.message); setPhase('error'); setProgress(null)
    }
  }

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.results.filter((r) => {
      if (view === 'issues' && !r.hasIssue) return false
      if (view === 'notfound' && r.found) return false
      if (view === 'clean' && (!r.found || r.hasIssue)) return false
      if (fieldFilter && r.found) {
        const s = r.fields[fieldFilter]?.status
        if (s !== 'mismatch' && s !== 'missing_erp') return false
      } else if (fieldFilter && !r.found) return false
      if (q && !(`${r.code} ${r.sheetName}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [data, view, fieldFilter, query])

  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const pages = Math.ceil(filtered.length / PAGE)
  const cols = useMemo(
    () => (data ? FIELDS.filter((f) => data.summary.activeFields.includes(f.key)) : FIELDS),
    [data],
  )

  if (!live) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p className="card__hint" style={{ margin: 0 }}>
          Bulk reconciliation needs the live ERPNext connection. Start the proxy
          (<code>npm run dev:all</code>) or set the Netlify environment variables, then reload.
        </p>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="rc-upload">
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Bulk reconciliation</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Upload a division sheet (.xlsx). Each row is matched to ERPNext by <b>Dr. Code</b> and every
              field is compared. Formatting differences (HQ prefix, state case, leading zeros, phone format) are normalized.
            </p>
          </div>
          <label className="rc-addrtoggle" title="Address check fetches one request per doctor — slower on very large sheets">
            <input type="checkbox" checked={checkAddress} onChange={(e) => setCheckAddress(e.target.checked)} disabled={phase === 'working'} />
            Check addresses <span className="rc-addrtoggle__hint">(slower)</span>
          </label>
          <button className="export-btn" onClick={() => fileRef.current?.click()} disabled={phase === 'working'}>
            {phase === 'working' ? 'Checking…' : 'Upload sheet'}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} />
        </div>
        {fileName && (
          <p className="rc-filename">
            {fileName}
            {phase === 'working' && (progress
              ? ` · fetching ERPNext ${progress.done}/${progress.total}…`
              : ' · reading sheet…')}
          </p>
        )}
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      {data && (
        <>
          <div className="rc-kpis">
            <Kpi n={data.summary.rows} label="Rows in sheet" />
            <Kpi n={data.summary.clean} label="Clean (all match)" tone="ok" />
            <Kpi n={data.summary.withIssues} label="With issues" tone="warning" />
            <Kpi n={data.summary.notFound} label="Not found in ERPNext" tone="error" />
            <Kpi n={data.summary.mismatches} label="Field mismatches" tone="warning" />
            <Kpi n={data.summary.missing} label="Missing in ERPNext" tone="error" />
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="section-label" style={{ marginTop: 0 }}>Mismatches by field</div>
            <div className="rc-perfield">
              {cols.map((f) => {
                const pf = data.summary.perField[f.key]
                const total = pf.mismatch + pf.missing
                return (
                  <button
                    key={f.key}
                    className={`rc-fieldchip ${fieldFilter === f.key ? 'active' : ''} ${total ? '' : 'zero'}`}
                    onClick={() => { setFieldFilter(fieldFilter === f.key ? '' : f.key); setPage(0) }}
                  >
                    {f.label}
                    <span className="rc-fieldchip__n">{total}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="card">
            <div className="toolbar">
              <label className="search">
                <IconSearch />
                <input placeholder="Search code or name…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} />
              </label>
              <div className="segmented">
                {[
                  ['issues', `Issues (${data.summary.withIssues + data.summary.notFound})`],
                  ['notfound', `Not found (${data.summary.notFound})`],
                  ['clean', `Clean (${data.summary.clean})`],
                  ['all', `All (${data.summary.rows})`],
                ].map(([k, lbl]) => (
                  <button key={k} className={view === k ? 'active' : ''} onClick={() => { setView(k); setPage(0) }}>{lbl}</button>
                ))}
              </div>
              <div className="filterbar__spacer" />
              <button className="export-btn" onClick={() => exportIssues(data.results, cols)}>
                <IconDownload width={15} height={15} /> Export issues
              </button>
            </div>

            <div className="table-wrap">
              <table className="dt rc-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Doctor (sheet)</th>
                    {cols.map((f) => <th key={f.key} className="rc-th" title={f.label}>{f.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <Row key={r.code} r={r} fields={cols} expanded={expanded === r.code} onToggle={() => setExpanded(expanded === r.code ? null : r.code)} />
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <div className="empty">No rows match this filter.</div>}
            </div>

            {pages > 1 && (
              <div className="rc-pager">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
                <span>Page {page + 1} of {pages} · {filtered.length} rows</span>
                <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ r, fields, expanded, onToggle }) {
  if (!r.found) {
    return (
      <tr className="rc-notfound" onClick={onToggle}>
        <td className="code">{r.code}</td>
        <td>{r.sheetName || '—'}</td>
        <td colSpan={fields.length}><span className="sev-error" style={{ fontWeight: 600 }}>No matching record in ERPNext</span></td>
      </tr>
    )
  }
  return (
    <>
      <tr className={r.hasIssue ? 'rc-hasissue' : ''} onClick={onToggle}>
        <td className="code">{r.code}</td>
        <td><div className="docname">{r.sheetName || '—'}</div><div className="code">{r.erpId}</div></td>
        {fields.map((f) => {
          const cell = r.fields[f.key]
          const m = STATUS_META[cell.status]
          return (
            <td key={f.key} className="rc-cell" title={`${f.label}\nsheet: ${fmt(cell.sheet)}\nerp:   ${fmt(cell.erp)}`}>
              <span className={`rc-dot ${m.cls}`}>{m.sym}</span>
            </td>
          )
        })}
      </tr>
      {expanded && (
        <tr className="rc-detail-row">
          <td colSpan={fields.length + 2}>
            <div className="rc-detail">
              {fields.filter((f) => ['mismatch', 'missing_erp'].includes(r.fields[f.key].status)).map((f) => {
                const c = r.fields[f.key]
                return (
                  <div key={f.key} className="rc-detail__item">
                    <span className={`rc-tag ${STATUS_META[c.status].cls}`}>{f.label} · {STATUS_META[c.status].label}</span>
                    <div className="rc-detail__vals"><b>Sheet:</b> {fmt(c.sheet) || '—'} &nbsp;→&nbsp; <b>ERPNext:</b> {fmt(c.erp) || '—'}</div>
                  </div>
                )
              })}
              {r.mismatch + r.missing === 0 && <span className="card__hint">All fields match. Address record: {r.addressCreated ? 'created' : 'not created'}.</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Kpi({ n, label, tone }) {
  return (
    <div className="card kpi" style={{ padding: 14 }}>
      <div className={`kpi__value ${tone || ''}`} style={{ fontSize: 26 }}>{n}</div>
      <div className="kpi__label">{label}</div>
    </div>
  )
}

const fmt = (v) => (v == null ? '' : String(v))

function exportIssues(results, fields) {
  const rows = []
  for (const r of results) {
    if (!r.found) { rows.push({ Code: r.code, Doctor: r.sheetName, Field: '(record)', Status: 'Not found in ERPNext', 'Sheet value': '', 'ERPNext value': '' }); continue }
    for (const f of fields) {
      const c = r.fields[f.key]
      if (c.status === 'mismatch' || c.status === 'missing_erp') {
        rows.push({
          Code: r.code, Doctor: r.sheetName, 'ERPNext ID': r.erpId,
          Field: f.label, Status: STATUS_META[c.status].label,
          'Sheet value': fmt(c.sheet), 'ERPNext value': fmt(c.erp),
        })
      }
    }
  }
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No issues found' }])
  XLSX.utils.book_append_sheet(wb, ws, 'Issues')
  XLSX.writeFile(wb, `reconciliation-issues-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
