import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { parseSheet } from '../lib/parseSheet.js'
import { reconcileSheet, processBatch } from '../data/source.js'
import { IconDownload } from './icons.jsx'
import ReconcileView from './ReconcileView.jsx'
import DuplicatesPanel from './DuplicatesPanel.jsx'

const nc = (c) => String(c ?? '').replace(/\D/g, '').replace(/^0+/, '')

const CAP = 300 // max rows rendered per block; full data is in the export

// Persist the triage across page refreshes so a reload never forces a re-upload.
// Heavy payload (sheet + reconcile result) is stored separately from the light
// UI state (selection / run report) so toggling a checkbox doesn't re-serialize
// the whole sheet.
const STORE_DATA = 'dvd-triage-data-v1'
const STORE_UI = 'dvd-triage-ui-v1'
const readJSON = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null } catch { return null } }
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch { return false } }
const dropJSON = (k) => { try { localStorage.removeItem(k) } catch { /* ignore */ } }

export default function TriageView({ live }) {
  const fileRef = useRef(null)
  // Rehydrate once from localStorage (lazy initializers run a single time).
  const [bootData] = useState(() => readJSON(STORE_DATA)) // { fileName, data, parsedRows }
  const [bootUI] = useState(() => readJSON(STORE_UI))     // { selected, runReport, showValidate }

  const [phase, setPhase] = useState(bootData?.data ? 'done' : 'idle')
  const [fileName, setFileName] = useState(bootData?.fileName || '')
  const [error, setError] = useState(null)
  const [data, setData] = useState(bootData?.data || null)
  const [parsedRows, setParsedRows] = useState(bootData?.parsedRows || null) // [{ code, raw }]

  // Create run state (drives the batched /api/process loop).
  const [running, setRunning] = useState(false)
  const [runProg, setRunProg] = useState(null) // { processed, total } — not persisted
  const [runReport, setRunReport] = useState(bootUI?.runReport || null) // { counts, results, exceptions }
  const [runError, setRunError] = useState(null)
  const [selected, setSelected] = useState(() => new Set(bootUI?.selected || [])) // normalized codes chosen to create
  const [updateSelected, setUpdateSelected] = useState(() => new Set(bootUI?.updateSelected || [])) // codes chosen to update
  const [showValidate, setShowValidate] = useState(bootUI?.showValidate || false)
  const [storeWarn, setStoreWarn] = useState(false)

  // Save heavy payload only when the sheet/result changes (i.e. on upload/clear).
  useEffect(() => {
    if (data && parsedRows) {
      if (!writeJSON(STORE_DATA, { fileName, data, parsedRows })) setStoreWarn(true)
    } else {
      dropJSON(STORE_DATA)
    }
  }, [fileName, data, parsedRows])

  // Save light UI state (selection, run report, validate toggle) on every change.
  useEffect(() => {
    writeJSON(STORE_UI, { selected: [...selected], updateSelected: [...updateSelected], runReport, showValidate })
  }, [selected, updateSelected, runReport, showValidate])

  const clearAll = () => {
    setData(null); setParsedRows(null); setFileName(''); setPhase('idle'); setError(null)
    setSelected(new Set()); setUpdateSelected(new Set()); setRunReport(null); setShowValidate(false); setRunProg(null); setRunError(null)
    setStoreWarn(false)
    dropJSON(STORE_DATA); dropJSON(STORE_UI)
  }

  // Update action — the write logic will be supplied later; for now the button
  // just surfaces the selected count so the flow/UX is in place.
  const runUpdate = (codes) => {
    window.alert(`Update ${codes.length} selected doctor(s) in UAT — update logic pending (to be provided).`)
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setError(null); setPhase('working'); setData(null); setParsedRows(null)
    setRunReport(null); setRunError(null); setRunProg(null); setSelected(new Set()); setUpdateSelected(new Set()); setShowValidate(false); setStoreWarn(false)
    try {
      const { rows } = await parseSheet(file)
      const out = await reconcileSheet(rows.map((r) => r.raw))
      // Pre-select every "to create" / "to update" code so the default is "all".
      setParsedRows(rows); setData(out); setPhase('done')
      setSelected(new Set(out.create.map((c) => c.code)))
      setUpdateSelected(new Set(out.update.map((u) => u.code)))
    } catch (err) {
      setError(err.message); setPhase('error')
    }
  }

  // Loop /api/process batch-by-batch (the server is stateless; we own the offset)
  // until it reports done, accumulating counts + per-row results + exceptions.
  const runCreate = async () => {
    if (!parsedRows || running || selected.size === 0) return
    // Only the selected "to create" codes are sent to ERPNext.
    const fullRows = parsedRows.filter((r) => selected.has(nc(r.code))).map((r) => r.raw)
    if (fullRows.length === 0) return
    if (!window.confirm(
      `CREATE ${selected.size} selected doctor(s) in ERPNext UAT?\n\n` +
      `This writes live to ERPNext (new Leads + addresses). Codes already in UAT are skipped, ` +
      `so re-running is safe.`,
    )) return

    setShowValidate(false)
    const total = fullRows.length
    const counts = { created: 0, skipped: 0, exceptions: 0, errors: 0 }
    const results = []
    const exceptions = []
    setRunning(true); setRunError(null); setRunProg({ processed: 0, total })
    setRunReport({ counts: { ...counts }, results, exceptions })

    try {
      let offset = 0
      let processed = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const out = await processBatch({ rows: fullRows, offset, batchSize: 50 })
        for (const k in counts) counts[k] += out.counts?.[k] || 0
        results.push(...(out.results || []))
        exceptions.push(...(out.exceptions || []))
        processed += out.processed || 0
        setRunProg({ processed, total: out.total ?? total })
        setRunReport({ counts: { ...counts }, results: [...results], exceptions: [...exceptions] })
        if (out.done || out.nextOffset == null) break
        offset = out.nextOffset
      }
    } catch (err) {
      setRunError(err.message)
    } finally {
      setRunning(false)
    }
  }

  // Parsed rows whose code already exists in UAT — fed to the embedded
  // field-comparison so the "update" doctors get the full diff + filters.
  const updateRows = useMemo(() => {
    if (!data || !parsedRows) return []
    const set = new Set(data.update.map((u) => u.code))
    return parsedRows.filter((r) => set.has(nc(r.code)))
  }, [data, parsedRows])

  // Rows whose Lead was successfully created this run — fed to the Validate
  // field-comparison so you can confirm each created doctor landed in UAT with
  // the right fields (and spot anything missing).
  const validateRows = useMemo(() => {
    if (!parsedRows || !runReport) return []
    const created = new Set(runReport.results.filter((r) => r.op === 'create_lead' && r.ok).map((r) => r.code))
    return parsedRows.filter((r) => created.has(nc(r.code)))
  }, [parsedRows, runReport])

  if (!live) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p className="card__hint" style={{ margin: 0 }}>
          Create/Update triage needs the live ERPNext connection. Start the proxy
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
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Create vs Update</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Upload a division sheet. Each row is matched by <b>Dr. Code</b> against UAT: codes not in UAT are
              <b> to create</b>, codes already in UAT are <b>to update</b>. Duplicate IDs (same code stored as more
              than one Lead, e.g. <code>DR-4444</code> + <code>DR-00004444</code>) are listed separately.
            </p>
          </div>
          <button className="export-btn" onClick={() => fileRef.current?.click()} disabled={phase === 'working'}>
            {phase === 'working' ? 'Checking…' : 'Upload sheet'}
          </button>
          {data && (
            <button className="export-btn" onClick={clearAll} disabled={running || phase === 'working'} title="Clear the saved sheet and result">
              Clear
            </button>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} />
        </div>
        {fileName && <p className="rc-filename">{fileName}{phase === 'working' ? ' · matching against UAT…' : (data ? ' · saved — survives refresh' : '')}</p>}
        {storeWarn && <p className="card__hint" style={{ marginTop: 8 }}>⚠️ This sheet is too large to save in the browser, so a refresh will need a re-upload.</p>}
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      {data && (
        <>
          <div className="rc-kpis">
            <Kpi n={data.counts.sheetRows} label="Rows in sheet" />
            <Kpi n={data.counts.create} label="To create (new)" tone="ok" />
            <Kpi n={data.counts.update} label="To update (exists)" tone="warning" />
            <Kpi n={data.counts.duplicates} label="Duplicate IDs" tone="error" />
          </div>

          <CreateBlock
            rows={data.create}
            selected={selected}
            setSelected={setSelected}
            disabled={running}
            onExport={() => exportRows(data.create, 'to-create')}
          />

          <ActionPanel
            selectedCount={selected.size}
            running={running}
            runProg={runProg}
            runReport={runReport}
            runError={runError}
            onRun={runCreate}
            canValidate={validateRows.length > 0}
            showValidate={showValidate}
            onValidate={() => setShowValidate((v) => !v)}
          />

          {showValidate && validateRows.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="section-label" style={{ marginBottom: 0 }}>
                Validation — {validateRows.length} created doctor(s) compared field-by-field against UAT
              </div>
              <ReconcileView live={live} embedded rows={validateRows} />
            </div>
          )}

          <DuplicatesPanel duplicates={data.duplicates} onExport={() => exportDupes(data.duplicates)} />

          <UpdateBlock
            rows={data.update}
            selected={updateSelected}
            setSelected={setUpdateSelected}
            disabled={running}
            onUpdate={runUpdate}
          />

          <div className="stack" style={{ gap: 10 }}>
            <div className="section-label" style={{ marginBottom: 0 }}>
              To update — already in UAT ({data.counts.update}) · compared field-by-field below
            </div>
            {updateRows.length > 0 ? (
              <ReconcileView live={live} embedded rows={updateRows} />
            ) : (
              <div className="card"><p className="card__hint" style={{ padding: '4px 4px 8px' }}>None to update.</p></div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// "To create" table with row checkboxes + select-all, so only the chosen codes
// are sent to ERPNext. Select-all covers every code, even rows beyond the render
// cap; individual checkboxes show for the rendered rows.
function CreateBlock({ rows, selected, setSelected, disabled, onExport }) {
  const allCodes = rows.map((r) => r.code)
  const allOn = allCodes.length > 0 && allCodes.every((c) => selected.has(c))
  const toggleAll = () => setSelected(() => (allOn ? new Set() : new Set(allCodes)))
  const toggle = (code) => setSelected((prev) => {
    const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n
  })
  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          To create — not in UAT ({rows.length}) · <b>{selected.size} selected</b>
        </span>
        <div className="filterbar__spacer" />
        {rows.length > 0 && (
          <button className="export-btn" onClick={onExport}><IconDownload width={15} height={15} /> Export</button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>None.</p>
      ) : (
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allOn} disabled={disabled} onChange={toggleAll} title="Select all" />
                </th>
                <th>Dr Code</th><th>Doctor</th><th>Emp Code</th><th>HQ</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, CAP).map((r, i) => (
                <tr key={r.code + i} className={selected.has(r.code) ? 'is-selected' : ''}>
                  <td><input type="checkbox" checked={selected.has(r.code)} disabled={disabled} onChange={() => toggle(r.code)} /></td>
                  <td className="code">{r.code}</td>
                  <td>{r.name || '—'}</td>
                  <td>{r.empCode || '—'}</td>
                  <td>{r.hq || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > CAP && (
            <p className="card__hint" style={{ padding: 8 }}>
              Showing first {CAP} of {rows.length}. "Select all" still selects every code.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// "To update" table — the codes already in UAT. Same layout as CreateBlock but
// PAGINATED (20 per page, for the ~thousands of update rows) with a select-all
// (covers every code across pages) and an Update button (write logic supplied
// later). The field-by-field comparison below is a separate, untouched section.
const UPDATE_PAGE = 20
function UpdateBlock({ rows, selected, setSelected, disabled, onUpdate }) {
  const [page, setPage] = useState(0)
  const allCodes = rows.map((r) => r.code)
  const allOn = allCodes.length > 0 && allCodes.every((c) => selected.has(c))
  const toggleAll = () => setSelected(() => (allOn ? new Set() : new Set(allCodes)))
  const toggle = (code) => setSelected((prev) => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n })
  const pages = Math.max(1, Math.ceil(rows.length / UPDATE_PAGE))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * UPDATE_PAGE, p * UPDATE_PAGE + UPDATE_PAGE)
  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          To update — already in UAT ({rows.length}) · <b>{selected.size} selected</b>
        </span>
        <div className="filterbar__spacer" />
        <button className="btn btn--ready" disabled={disabled || selected.size === 0} onClick={() => onUpdate([...selected])}>
          Update selected · {selected.size}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>None already in UAT.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={allOn} disabled={disabled} onChange={toggleAll} title="Select all" />
                  </th>
                  <th>Dr Code</th><th>Doctor</th><th>Emp Code</th><th>HQ</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => (
                  <tr key={r.code + i} className={selected.has(r.code) ? 'is-selected' : ''}>
                    <td><input type="checkbox" checked={selected.has(r.code)} disabled={disabled} onChange={() => toggle(r.code)} /></td>
                    <td className="code">{r.code}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.empCode || '—'}</td>
                    <td>{r.hq || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="rc-pager">
              <button disabled={p === 0} onClick={() => setPage(p - 1)}>← Prev</button>
              <span>Page {p + 1} of {pages} · {rows.length} rows · {UPDATE_PAGE}/page</span>
              <button disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Create the "not in UAT" Leads (+ addresses) in ERPNext. Drives the batched
// /api/process loop above. Codes already in UAT are skipped server-side.
function ActionPanel({ selectedCount, running, runProg, runReport, runError, onRun, canValidate, showValidate, onValidate }) {
  const pct = runProg && runProg.total ? Math.round((runProg.processed / runProg.total) * 100) : 0
  const c = runReport?.counts
  const errs = runReport ? runReport.results.filter((r) => !r.ok) : []
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="rc-upload" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Create in ERPNext (UAT)</h3>
          <p className="card__hint" style={{ margin: 0 }}>
            Posts new Leads (+ addresses) for the <b>selected</b> codes (check the rows above). The Lead ID is
            <code> DR-&lt;code&gt;</code> with leading zeros stripped. Runs in batches of 50; re-running is safe — codes
            already in UAT are skipped, rows with no matching employee / role profile are listed as exceptions.
            After a run, hit <b>Validate</b> to confirm each created doctor against UAT field-by-field.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn--ready" disabled={running || selectedCount === 0} onClick={onRun}>
            {running ? 'Creating…' : `Create selected · ${selectedCount}`}
          </button>
          {canValidate && (
            <button className="export-btn" disabled={running} onClick={onValidate}>
              {showValidate ? 'Hide validation' : `Validate created (${c?.created || 0})`}
            </button>
          )}
        </div>
      </div>

      {runProg && (
        <div style={{ marginTop: 14 }}>
          <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,0.25)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
          </div>
          <p className="card__hint" style={{ margin: '6px 0 0' }}>
            {running ? 'Processing' : 'Done'} — {runProg.processed}/{runProg.total} rows ({pct}%)
          </p>
        </div>
      )}

      {runError && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {runError}</p>}

      {c && (
        <div className="rc-kpis" style={{ marginTop: 14 }}>
          <Kpi n={c.created} label="Created" tone="ok" />
          <Kpi n={c.skipped} label="Skipped (in UAT)" />
          <Kpi n={c.exceptions} label="Exceptions" tone="warning" />
          <Kpi n={c.errors} label="Errors" tone={c.errors ? 'error' : ''} />
        </div>
      )}

      {runReport && runReport.exceptions.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <div className="section-label">Exceptions — fix &amp; re-run ({runReport.exceptions.length})</div>
          <table className="dt">
            <thead><tr><th>Dr Code</th><th>Doctor</th><th>Emp Code</th><th>HQ</th><th>Reason</th></tr></thead>
            <tbody>
              {runReport.exceptions.slice(0, CAP).map((e, i) => (
                <tr key={e.code + i}>
                  <td className="code">{e.code}</td><td>{e.dr || '—'}</td><td>{e.empcode || '—'}</td>
                  <td>{e.hq || '—'}</td><td><span className="sev-error">{e.reason}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {runReport.exceptions.length > CAP && <p className="card__hint" style={{ padding: 8 }}>Showing first {CAP} of {runReport.exceptions.length}.</p>}
        </div>
      )}

      {errs.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <div className="section-label">ERPNext errors ({errs.length})</div>
          <table className="dt">
            <thead><tr><th>Dr Code</th><th>Operation</th><th>HTTP</th><th>Detail</th></tr></thead>
            <tbody>
              {errs.slice(0, CAP).map((r, i) => (
                <tr key={r.code + r.op + i}>
                  <td className="code">{r.code}</td><td>{r.op}</td><td>{r.status || '—'}</td>
                  <td style={{ maxWidth: 460, whiteSpace: 'normal' }}>{r.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {errs.length > CAP && <p className="card__hint" style={{ padding: 8 }}>Showing first {CAP} of {errs.length}.</p>}
        </div>
      )}
    </div>
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

function exportRows(rows, name) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'None' }]), name)
  XLSX.writeFile(wb, `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

function exportDupes(dupes) {
  const rows = dupes.map((d) => ({ 'Dr Code': d.code, Keep: d.keep, Remove: d.remove.join(', '), Kind: d.kind, 'All Leads': d.all.join(', ') }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Duplicates')
  XLSX.writeFile(wb, `duplicate-ids-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
