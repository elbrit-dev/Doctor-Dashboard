import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { parseSheet, cleanCodes } from '../lib/parseSheet.js'
import { fetchLeadsByCode, submitReview } from '../data/source.js'
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

// `rows` (optional): pre-parsed [{ code, raw }] to compare instead of a file
// upload — used to embed this comparison inside the Create/Update tab.
export default function ReconcileView({ live, rows: externalRows = null, embedded = false }) {
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
  const [reviewed, setReviewed] = useState({}) // code -> 'ready' | 'error'
  const [reviewBusy, setReviewBusy] = useState(null) // a code, or 'bulk'
  const [bulkProg, setBulkProg] = useState(null)
  const [selected, setSelected] = useState(() => new Set()) // codes ticked for bulk review

  const toggleSel = (code) => setSelected((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n })

  // Error detail posted to ERPNext: field + error TYPE + both values.
  const issueList = (r) => {
    if (!r.found) return ['Record not found in ERPNext']
    const out = cols.filter((f) => ['mismatch', 'missing_erp'].includes(r.fields[f.key]?.status))
      .map((f) => `${f.label} (${STATUS_META[r.fields[f.key].status].label}): sheet "${fmt(r.fields[f.key].sheet)}" / UAT "${fmt(r.fields[f.key].erp)}"`)
    for (const d of (r.dupDepartments || [])) {
      out.push(`Duplicate department: "${d.department}" appears ${d.count}× (${d.roleProfiles.filter(Boolean).join(', ')})`)
    }
    return out
  }

  const reviewRow = async (r, decision) => {
    if (!r.erpId) return
    setReviewBusy(r.code)
    try {
      await submitReview({ id: r.erpId, decision, issues: decision === 'error' ? issueList(r) : [], by: 'it@elbrit.org' })
      setReviewed((m) => ({ ...m, [r.code]: decision }))
    } catch (e) {
      window.alert('Review failed: ' + e.message)
    } finally {
      setReviewBusy(null)
    }
  }

  // Post a review comment to every SELECTED (ticked) doctor: "Completed" for
  // ready, or the error type list for error. The CRM team ticks the rows they've
  // checked and applies one decision to all of them.
  const bulkReview = async (decision) => {
    const rows = data.results.filter((r) => r.found && selected.has(r.code))
    if (rows.length === 0) return
    const label = decision === 'ready' ? 'Completed' : 'Error'
    if (!window.confirm(`Post a "${label}" comment to ${rows.length} selected doctor(s) in ERPNext UAT?`)) return
    setReviewBusy('bulk'); setBulkProg({ done: 0, total: rows.length })
    const CONC = 6
    for (let i = 0; i < rows.length; i += CONC) {
      const batch = rows.slice(i, i + CONC)
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(batch.map((r) =>
        submitReview({ id: r.erpId, decision, issues: decision === 'error' ? issueList(r) : [], by: 'it@elbrit.org' })
          .then(() => setReviewed((m) => ({ ...m, [r.code]: decision })))
          .catch(() => {})))
      setBulkProg({ done: Math.min(i + CONC, rows.length), total: rows.length })
    }
    setReviewBusy(null); setBulkProg(null); setSelected(new Set())
  }

  const runRows = async (rows) => {
    setError(null); setPhase('working'); setData(null); setPage(0)
    try {
      const codes = cleanCodes(rows)
      setProgress({ done: 0, total: codes.length })
      const { doctors } = await fetchLeadsByCode(codes, {
        addresses: checkAddress,
        onProgress: (done, t) => setProgress({ done, total: t }),
      })
      const out = reconcile(rows, doctors, { includeAddress: checkAddress })
      out.summary.sheetTotal = rows.length
      setData(out); setPhase('done'); setProgress(null)
    } catch (err) {
      setError(err.message); setPhase('error'); setProgress(null)
    }
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // allow re-picking the same file
    setFileName(file.name)
    const { rows } = await parseSheet(file).catch((err) => { setError(err.message); setPhase('error'); return { rows: null } })
    if (rows) runRows(rows)
  }

  // Embedded mode: compare the rows handed in (e.g. the "update" subset), and
  // re-run when those rows or the address toggle change.
  useEffect(() => {
    if (externalRows) runRows(externalRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRows, checkAddress])

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

  // Select-all covers every found row in the CURRENT filter (not just the page).
  const selectableCodes = filtered.filter((r) => r.found).map((r) => r.code)
  const allSelected = selectableCodes.length > 0 && selectableCodes.every((c) => selected.has(c))
  const toggleSelectAll = () => setSelected((s) => {
    const n = new Set(s)
    if (allSelected) selectableCodes.forEach((c) => n.delete(c))
    else selectableCodes.forEach((c) => n.add(c))
    return n
  })

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

  const progressText = phase === 'working'
    ? (progress ? `comparing against UAT ${progress.done}/${progress.total}…` : 'reading sheet…')
    : null

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: embedded ? 12 : 18 }}>
        <div className="rc-upload">
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>{embedded ? 'Field comparison — update rows (already in UAT)' : 'Validation check — sheet vs UAT'}</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              {embedded
                ? <>Each existing doctor is compared field by field against the sheet. Formatting differences (HQ prefix, state case, leading zeros, phone) are normalized.</>
                : <>Upload a division sheet (.xlsx). Each row is matched to ERPNext by <b>Dr. Code</b> and every field is compared. Formatting differences (HQ prefix, state case, leading zeros, phone format) are normalized.</>}
            </p>
          </div>
          <label className="rc-addrtoggle" title="Address check fetches one request per doctor — slower on very large sheets">
            <input type="checkbox" checked={checkAddress} onChange={(e) => setCheckAddress(e.target.checked)} disabled={phase === 'working'} />
            Check addresses <span className="rc-addrtoggle__hint">(slower)</span>
          </label>
          {!embedded && (
            <>
              <button className="export-btn" onClick={() => fileRef.current?.click()} disabled={phase === 'working'}>
                {phase === 'working' ? 'Checking…' : 'Upload sheet'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} />
            </>
          )}
        </div>
        {(fileName || progressText) && (
          <p className="rc-filename">{fileName}{progressText ? ` · ${progressText}` : ''}</p>
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
            <Kpi n={data.summary.dupDept} label="Duplicate dept" tone="error" />
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
              <button className="export-btn" onClick={() => exportIssues(data.results, cols)} title="Excel with two sheets: Issues only + Full comparison (Sheet vs UAT for every field)">
                <IconDownload width={15} height={15} /> Export (issues + UAT)
              </button>
              <button className="export-btn" onClick={() => exportUAT(data.results, cols)} title="Excel of the UAT values only, for the codes in this sheet">
                <IconDownload width={15} height={15} /> Export UAT
              </button>
              {reviewBusy === 'bulk' && bulkProg ? (
                <span className="card__hint" style={{ alignSelf: 'center' }}>Posting {bulkProg.done}/{bulkProg.total}…</span>
              ) : (
                <>
                  <button
                    className="btn btn--ready"
                    onClick={() => bulkReview('ready')}
                    disabled={reviewBusy != null || selected.size === 0}
                    title="Post a ✅ Completed comment in UAT for every ticked doctor"
                  >
                    ✅ Completed ({selected.size})
                  </button>
                  <button
                    className="btn btn--error"
                    onClick={() => bulkReview('error')}
                    disabled={reviewBusy != null || selected.size === 0}
                    title="Post a ⚠️ Error comment (with the error type) in UAT for every ticked doctor"
                  >
                    ⚠️ Error ({selected.size})
                  </button>
                </>
              )}
            </div>

            <div className="table-wrap">
              <table className="dt rc-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="Select all found rows in this filter" />
                    </th>
                    <th>Code</th>
                    <th>Doctor (sheet)</th>
                    {cols.map((f) => <th key={f.key} className="rc-th" title={f.label}>{f.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <Row
                      key={r.code} r={r} fields={cols}
                      expanded={expanded === r.code}
                      onToggle={() => setExpanded(expanded === r.code ? null : r.code)}
                      reviewedAs={reviewed[r.code]}
                      busy={reviewBusy === r.code}
                      onReview={reviewRow}
                      isSelected={selected.has(r.code)}
                      onToggleSel={toggleSel}
                    />
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

function Row({ r, fields, expanded, onToggle, reviewedAs, busy, onReview, isSelected, onToggleSel }) {
  if (!r.found) {
    return (
      <tr className="rc-notfound" onClick={onToggle}>
        <td />
        <td className="code">{r.code}</td>
        <td>{r.sheetName || '—'}</td>
        <td colSpan={fields.length}><span className="sev-error" style={{ fontWeight: 600 }}>No matching record in ERPNext</span></td>
      </tr>
    )
  }
  return (
    <>
      <tr className={r.hasIssue ? 'rc-hasissue' : ''} onClick={onToggle}>
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={!!isSelected} onChange={() => onToggleSel(r.code)} title="Select for bulk review" />
        </td>
        <td className="code">{r.code}</td>
        <td>
          <div className="docname">{r.sheetName || '—'}</div>
          <div className="code">{r.erpId}</div>
          {r.dupDepartments?.length > 0 && r.dupDepartments.map((d, i) => (
            <span key={i} className="sev-error" style={{ fontWeight: 600, display: 'block', marginTop: 4 }} title="Same department listed more than once in the Sales Team table">
              ⚠ dup dept: {d.department} ×{d.count}
            </span>
          ))}
          {reviewedAs && <span className={`review-chip ${reviewedAs}`} style={{ marginTop: 4 }}>{reviewedAs === 'ready' ? '✅ Ready' : '⚠️ Error'}</span>}
        </td>
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
          <td colSpan={fields.length + 3}>
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
              {r.dupDepartments?.length > 0 && r.dupDepartments.map((d, i) => (
                <div key={'dup' + i} className="rc-detail__item">
                  <span className="rc-tag rc-mismatch">Duplicate department</span>
                  <div className="rc-detail__vals"><b>{d.department}</b> appears ×{d.count} — {d.roleProfiles.filter(Boolean).join(', ') || '—'}</div>
                </div>
              ))}
              {r.mismatch + r.missing === 0 && (!r.dupDepartments || r.dupDepartments.length === 0) && <span className="card__hint">All fields match. Address record: {r.addressCreated ? 'created' : 'not created'}.</span>}
              <div className="reviewbox__actions" style={{ marginTop: 4 }}>
                <button className="btn btn--ready" disabled={busy} onClick={(e) => { e.stopPropagation(); onReview(r, 'ready') }}>
                  {busy ? 'Saving…' : '✅ Mark Ready'}
                </button>
                <button className="btn btn--error" disabled={busy} onClick={(e) => { e.stopPropagation(); onReview(r, 'error') }}>
                  ⚠️ Report Error{r.mismatch + r.missing + (r.dupDepartments?.length || 0) > 0 ? ` (${r.mismatch + r.missing + (r.dupDepartments?.length || 0)})` : ''}
                </button>
                {reviewedAs && <span className={`review-chip ${reviewedAs}`}>{reviewedAs === 'ready' ? '✅ Reviewed Ready' : '⚠️ Reviewed Error'}</span>}
              </div>
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
  // Sheet 1 — Issues only (mismatch / missing / not-found)
  const issues = []
  for (const r of results) {
    if (!r.found) { issues.push({ Code: r.code, Doctor: r.sheetName, Field: '(record)', Status: 'Not found in ERPNext', 'Sheet value': '', 'UAT value': '' }); continue }
    for (const f of fields) {
      const c = r.fields[f.key]
      if (c.status === 'mismatch' || c.status === 'missing_erp') {
        issues.push({
          Code: r.code, Doctor: r.sheetName, 'ERPNext ID': r.erpId,
          Field: f.label, Status: STATUS_META[c.status].label,
          'Sheet value': fmt(c.sheet), 'UAT value': fmt(c.erp),
        })
      }
    }
    for (const d of (r.dupDepartments || [])) {
      issues.push({
        Code: r.code, Doctor: r.sheetName, 'ERPNext ID': r.erpId,
        Field: 'Sales Team department', Status: `Duplicate department ×${d.count}`,
        'Sheet value': '', 'UAT value': `${d.department} — ${d.roleProfiles.filter(Boolean).join(', ')}`,
      })
    }
  }

  // Sheet 2 — Full comparison: every row, every field, Sheet vs UAT vs Status
  // (so the validation result itself can be audited against the raw UAT data).
  const full = results.map((r) => {
    const row = { Code: r.code, 'Doctor (sheet)': r.sheetName, 'ERPNext ID': r.erpId || '', 'Found in UAT': r.found ? 'Yes' : 'No' }
    if (r.found) {
      for (const f of fields) {
        const c = r.fields[f.key]
        row[`${f.label} · Sheet`] = fmt(c.sheet)
        row[`${f.label} · UAT`] = fmt(c.erp)
        row[`${f.label} · Status`] = STATUS_META[c.status].label
      }
    }
    return row
  })

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issues.length ? issues : [{ Note: 'No issues found' }]), 'Issues')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(full), 'Full comparison (Sheet vs UAT)')
  XLSX.writeFile(wb, `reconciliation-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

// UAT data only — the live ERPNext value of each field, for the sheet's codes.
function exportUAT(results, fields) {
  const rows = results.map((r) => {
    const row = { Code: r.code, 'Doctor (sheet)': r.sheetName, 'ERPNext ID': r.erpId || '', 'Found in UAT': r.found ? 'Yes' : 'No' }
    if (r.found) for (const f of fields) row[f.label] = fmt(r.fields[f.key].erp)
    return row
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'UAT data')
  XLSX.writeFile(wb, `uat-data-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
