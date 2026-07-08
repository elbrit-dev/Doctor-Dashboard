import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { parseSheet } from '../lib/parseSheet.js'
import { reconcileSheet, processBatch, updateBatch, auditRolesBatch, getCompleted, markCompleted } from '../data/source.js'
import { listFolderFiles, downloadFromDrive } from '../lib/googleDrive.js'
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
const STORE_DONE = 'dvd-drive-done-v1' // Drive file ids marked completed (survives Clear)
const STORE_UPD = 'dvd-upd-done-v1'    // per-sheet: codes already updated OK (so re-runs skip them)
const readJSON = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null } catch { return null } }
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch { return false } }
const dropJSON = (k) => { try { localStorage.removeItem(k) } catch { /* ignore */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default function TriageView({ live }) {
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
  const [showFullValidate, setShowFullValidate] = useState(false) // full-file field comparison, gated behind a button
  const [storeWarn, setStoreWarn] = useState(false)

  // Update run state (drives the batched /api/update loop) — not persisted.
  const [updRunning, setUpdRunning] = useState(false)
  const [updProg, setUpdProg] = useState(null) // { processed, total }
  const [updReport, setUpdReport] = useState(null) // { counts, results }
  const [updError, setUpdError] = useState(null)
  const [mergedCount, setMergedCount] = useState(0) // duplicate sets merged (reported up by DuplicatesPanel)

  // Duplicate-department audit state (read-only scan of the "to update" Leads) —
  // not persisted; re-run any time.
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditProg, setAuditProg] = useState(null) // { processed, total }
  const [auditReport, setAuditReport] = useState(null) // { counts, flagged }
  const [auditError, setAuditError] = useState(null)

  // Google Drive folder browser (inline file list; server-side, no login).
  const [driveState, setDriveState] = useState('idle') // idle | loading | ready | not-configured | error
  const [driveFiles, setDriveFiles] = useState(null)
  const [driveError, setDriveError] = useState(null)
  const [loadingFileId, setLoadingFileId] = useState(null)
  const [completed, setCompleted] = useState(() => new Set(readJSON(STORE_DONE) || [])) // Drive file ids finished
  const [activeFileId, setActiveFileId] = useState(bootUI?.activeFileId || null)
  // Collapse the (long) folder list once a sheet is loaded, to keep the focus on
  // the create/update work. Starts collapsed if a sheet was already open.
  const [driveCollapsed, setDriveCollapsed] = useState(!!bootUI?.activeFileId)

  // Codes already updated OK for the current sheet — persisted so a re-run (after
  // errors, or after a refresh) only re-processes the ones still pending, instead
  // of grinding through all thousands again.
  const sheetKey = activeFileId || fileName || ''
  const [updDone, setUpdDone] = useState(() => new Set())
  useEffect(() => {
    setUpdDone(new Set((readJSON(STORE_UPD) || {})[sheetKey] || []))
  }, [sheetKey])
  const persistUpdDone = (set) => {
    if (!sheetKey) return
    const all = readJSON(STORE_UPD) || {}
    all[sheetKey] = [...set]
    writeJSON(STORE_UPD, all)
  }
  // Clear the "already updated" marks so EVERY update row can be re-processed
  // (for a forced full re-run, e.g. after the sheet changed).
  const resetUpdDone = () => {
    const empty = new Set()
    setUpdDone(empty); persistUpdDone(empty)
    if (data?.update) setUpdateSelected(new Set(data.update.map((u) => u.code)))
  }

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
    writeJSON(STORE_UI, { selected: [...selected], updateSelected: [...updateSelected], runReport, showValidate, activeFileId })
  }, [selected, updateSelected, runReport, showValidate, activeFileId])

  // Completed-file marks persist on their own key (survive Clear / new uploads).
  useEffect(() => { writeJSON(STORE_DONE, [...completed]) }, [completed])

  // Merge the SHARED completed list (set by any user) so this browser shows the
  // same ✓ Completed marks even for sheets someone else finished.
  useEffect(() => {
    if (!live) return
    getCompleted().then((ids) => { if (ids.length) setCompleted((prev) => new Set([...prev, ...ids])) })
  }, [live])

  // Mark a Drive file Completed locally AND share it with every other user.
  const markFileCompleted = (id) => {
    if (!id) return
    setCompleted((prev) => (prev.has(id) ? prev : new Set([...prev, id])))
    markCompleted(id, true)
  }

  const clearAll = () => {
    setData(null); setParsedRows(null); setFileName(''); setPhase('idle'); setError(null)
    setSelected(new Set()); setUpdateSelected(new Set()); setRunReport(null); setShowValidate(false); setRunProg(null); setRunError(null)
    setUpdReport(null); setUpdProg(null); setUpdError(null); setShowFullValidate(false); setMergedCount(0); setActiveFileId(null)
    setAuditRunning(false); setAuditProg(null); setAuditReport(null); setAuditError(null)
    setStoreWarn(false)
    dropJSON(STORE_DATA); dropJSON(STORE_UI) // completed marks (STORE_DONE) are kept on purpose
  }

  // List the sheets in the shared Drive folder — the server reads the folder, so
  // there is no login/popup here. Fetched automatically on load.
  const loadDriveList = async () => {
    setDriveState('loading'); setDriveError(null)
    try {
      const { configured, files, detail } = await listFolderFiles()
      if (!configured) { setDriveError(detail || 'Drive folder not configured on the server.'); setDriveState('not-configured'); return }
      setDriveFiles(files); setDriveState('ready')
    } catch (err) {
      setDriveError(err.message); setDriveState('error')
    }
  }

  // Open one folder file: download it (via the server), then run the same parse
  // + triage path used by a local upload.
  const openDriveFile = async (f) => {
    if (phase === 'working' || loadingFileId) return
    setLoadingFileId(f.id)
    setError(null)
    try {
      const file = await downloadFromDrive(f)
      setActiveFileId(f.id)
      await processFile(file)
      setDriveCollapsed(true) // minimize the list once the sheet is loaded
    } catch (err) {
      setError(err.message); setPhase(data ? 'done' : 'error')
    } finally {
      setLoadingFileId(null)
    }
  }

  // List the folder as soon as the live connection is up (no user action needed).
  useEffect(() => {
    if (live && driveState === 'idle') loadDriveList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  // Loop /api/update batch-by-batch (stateless server; we own the offset) for the
  // selected "already in UAT" codes: scalar backfill on change, append the
  // employee's role profile if missing, append the sheet's address if new. Never
  // creates a Lead — re-running is safe (unchanged rows are no-ops).
  const runUpdate = async (codes) => {
    if (!parsedRows || updRunning || codes.length === 0) return
    // Re-run only what's still pending: skip codes already updated OK in a prior
    // run (persisted per sheet), the same way Create skips codes already in UAT.
    const pending = codes.filter((c) => !updDone.has(c))
    const alreadyDone = codes.length - pending.length
    if (pending.length === 0) { window.alert('All selected doctors are already updated. Nothing left to do.'); return }
    const wanted = new Set(pending)
    const fullRows = parsedRows.filter((r) => wanted.has(nc(r.code))).map((r) => r.raw)
    if (fullRows.length === 0) return
    if (!window.confirm(
      `UPDATE ${pending.length} doctor(s) already in ERPNext UAT?` +
      (alreadyDone ? `\n\n(${alreadyDone} already updated in a previous run are skipped.)` : '') +
      `\n\nWrites live: changed fields are updated, the employee's role profile is set for their department ` +
      `(replacing an old or duplicated role profile for that same department), ` +
      `and a new address is added only when the sheet's address isn't already on the Lead. ` +
      `Other departments' role profiles and existing addresses are never removed. A failed batch is retried and, ` +
      `if it still fails, marked as an error and skipped — the run continues to the end.`,
    )) return

    const total = fullRows.length
    const counts = { updated: 0, unchanged: 0, addressAdded: 0, roleAdded: 0, roleDeduped: 0, notFound: 0, errors: 0 }
    const results = []
    const doneCodes = new Set(updDone)
    setUpdRunning(true); setUpdError(null); setUpdProg({ processed: 0, total })
    setUpdReport({ counts: { ...counts }, results })

    const BATCH = 40
    let offset = 0
    let processed = 0
    // Send only THIS batch's slice each call — never the whole sheet — so the
    // request body stays tiny (a 7k-row sheet would otherwise be a ~7MB body and
    // blow past the serverless request limit, failing every batch).
    while (offset < fullRows.length) {
      const slice = fullRows.slice(offset, offset + BATCH)
      // Retry a failing batch a few times; if it still fails, record its rows as
      // errors and CARRY ON (a single bad/slow batch never kills the whole run).
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await updateBatch({ rows: slice, offset: 0, batchSize: BATCH })
        } catch {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1))
        }
      }
      if (!out) {
        counts.errors += slice.length
        results.push(...slice.map((r) => ({ code: nc(r['Dr. Code']), name: r['Dr. Name'] || '', ok: false, error: 'server error after retries — re-run to retry this row' })))
        processed += slice.length
        setUpdProg({ processed, total }); setUpdReport({ counts: { ...counts }, results: [...results] })
        offset += BATCH
        continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      const rs = out.results || []
      results.push(...rs)
      for (const r of rs) if (r.ok) doneCodes.add(nc(r.code)) // success → skip on re-run
      processed += slice.length
      setUpdProg({ processed, total })
      setUpdReport({ counts: { ...counts }, results: [...results] })
      setUpdDone(new Set(doneCodes)); persistUpdDone(doneCodes)
      offset += BATCH
    }
    setUpdRunning(false)
  }

  // Scan every "already in UAT" Lead for a duplicated department in its Sales
  // Team (Role Profile) child table — read-only, no writes. Loops /api/audit-roles
  // batch-by-batch (stateless; we own the offset), accumulating flagged doctors.
  const runAudit = async () => {
    if (!data?.update || auditRunning) return
    const items = data.update.map((u) => ({ code: u.code, name: u.name, hq: u.hq, leadName: u.uatId }))
    if (items.length === 0) { window.alert('No doctors already in UAT to scan.'); return }

    const total = items.length
    const counts = { scanned: 0, flagged: 0, errors: 0 }
    const flagged = []
    setAuditRunning(true); setAuditError(null); setAuditProg({ processed: 0, total })
    setAuditReport({ counts: { ...counts }, flagged })

    const BATCH = 60
    let offset = 0
    while (offset < items.length) {
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await auditRolesBatch({ items, offset, batchSize: BATCH })
        } catch (e) {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1))
          else { setAuditError(e.message) }
        }
      }
      if (!out) {
        // Skip this batch's rows and carry on, so one bad batch never kills the scan.
        counts.errors += Math.min(BATCH, items.length - offset)
        setAuditProg({ processed: Math.min(offset + BATCH, total), total })
        setAuditReport({ counts: { ...counts }, flagged: [...flagged] })
        offset += BATCH
        continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      flagged.push(...(out.flagged || []))
      offset += BATCH
      setAuditProg({ processed: Math.min(offset, total), total })
      setAuditReport({ counts: { ...counts }, flagged: [...flagged] })
    }
    setAuditRunning(false)
  }

  // Parse + triage a chosen sheet (local upload or Google Drive), shared by both
  // entry points so the two behave identically from here on.
  const processFile = async (file) => {
    setFileName(file.name); setError(null); setPhase('working'); setData(null); setParsedRows(null)
    setRunReport(null); setRunError(null); setRunProg(null); setSelected(new Set()); setUpdateSelected(new Set())
    setShowValidate(false); setShowFullValidate(false); setUpdReport(null); setUpdProg(null); setUpdError(null); setMergedCount(0); setStoreWarn(false)
    setAuditRunning(false); setAuditProg(null); setAuditReport(null); setAuditError(null)
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

    const BATCH = 50
    let offset = 0
    let processed = 0
    // Send only this batch's slice (not the whole selection) so large creates
    // never exceed the serverless request-body limit; retry + carry on per batch.
    while (offset < fullRows.length) {
      const slice = fullRows.slice(offset, offset + BATCH)
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await processBatch({ rows: slice, offset: 0, batchSize: BATCH })
        } catch {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1))
        }
      }
      if (!out) {
        counts.errors += slice.length
        results.push(...slice.map((r) => ({ code: nc(r['Dr. Code']), op: 'create_lead', ok: false, error: 'server error after retries — re-run to retry this row' })))
        processed += slice.length
        setRunProg({ processed, total }); setRunReport({ counts: { ...counts }, results: [...results], exceptions: [...exceptions] })
        offset += BATCH
        continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      results.push(...(out.results || []))
      exceptions.push(...(out.exceptions || []))
      processed += slice.length
      setRunProg({ processed, total })
      setRunReport({ counts: { ...counts }, results: [...results], exceptions: [...exceptions] })
      offset += BATCH
    }
    setRunning(false)
  }

  // Rows whose Lead was successfully created this run — fed to the Validate
  // field-comparison so you can confirm each created doctor landed in UAT with
  // the right fields (and spot anything missing).
  const validateRows = useMemo(() => {
    if (!parsedRows || !runReport) return []
    const created = new Set(runReport.results.filter((r) => r.op === 'create_lead' && r.ok).map((r) => r.code))
    return parsedRows.filter((r) => created.has(nc(r.code)))
  }, [parsedRows, runReport])

  // Live KPI counts: start from the triage totals and subtract what's been
  // handled so far — created/skipped shrink "to create", updated/unchanged shrink
  // "to update", merged sets shrink "duplicate IDs".
  const remaining = useMemo(() => {
    const base = data?.counts || { create: 0, update: 0, duplicates: 0 }
    const rc = runReport?.counts
    const uc = updReport?.counts
    const createDone = rc ? (rc.created || 0) + (rc.skipped || 0) : 0
    const updateDone = uc ? (uc.updated || 0) + (uc.unchanged || 0) : 0
    return {
      create: Math.max(0, base.create - createDone),
      update: Math.max(0, base.update - updateDone),
      duplicates: Math.max(0, base.duplicates - mergedCount),
    }
  }, [data, runReport, updReport, mergedCount])

  // A Drive file is "completed" once its create/update/duplicate work is all
  // done (nothing left to process) — mark it so the folder list shows a tick.
  useEffect(() => {
    if (!activeFileId || !data) return
    if (remaining.create === 0 && remaining.update === 0 && remaining.duplicates === 0) {
      markFileCompleted(activeFileId)
    }
  }, [activeFileId, data, remaining])

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
              Pick a division sheet from the shared Google Drive folder below. Each row is matched by <b>Dr. Code</b>
              against UAT: codes not in UAT are <b>to create</b>, codes already in UAT are <b>to update</b>. Duplicate
              IDs (same code stored as more than one Lead, e.g. <code>DR-4444</code> + <code>DR-00004444</code>) are
              listed separately. A sheet is marked <b>✓ Completed</b> once its create / update / duplicate work is done.
            </p>
          </div>
          {data && (
            <button className="export-btn" onClick={clearAll} disabled={running || updRunning || phase === 'working'} title="Unload the current sheet">
              Clear
            </button>
          )}
        </div>
        {fileName && <p className="rc-filename">{fileName}{phase === 'working' ? ' · matching against UAT…' : (data ? ' · saved — survives refresh' : '')}</p>}
        {storeWarn && <p className="card__hint" style={{ marginTop: 8 }}>⚠️ This sheet is too large to save in the browser, so a refresh will need a re-upload.</p>}
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      <DriveBrowser
        state={driveState}
        files={driveFiles}
        error={driveError}
        completed={completed}
        activeFileId={activeFileId}
        loadingFileId={loadingFileId}
        busy={phase === 'working' || running || updRunning}
        collapsed={driveCollapsed}
        onToggle={() => setDriveCollapsed((v) => !v)}
        onRefresh={loadDriveList}
        onOpen={openDriveFile}
      />

      {data && (
        <>
          <div className="rc-kpis">
            <Kpi n={data.counts.sheetRows} label="Rows in sheet" />
            <Kpi n={remaining.create} label="To create (new)" tone="ok" />
            <Kpi n={remaining.update} label="To update (exists)" tone="warning" />
            <Kpi n={remaining.duplicates} label="Duplicate IDs" tone="error" />
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

          <DuplicatesPanel duplicates={data.duplicates} onExport={() => exportDupes(data.duplicates)} onMergedChange={setMergedCount} />

          <UpdateBlock
            rows={data.update}
            selected={updateSelected}
            setSelected={setUpdateSelected}
            disabled={running || updRunning}
            running={updRunning}
            prog={updProg}
            report={updReport}
            error={updError}
            onUpdate={runUpdate}
            done={updDone}
            onReset={resetUpdDone}
          />

          <RoleAuditPanel
            total={data.update.length}
            running={auditRunning}
            prog={auditProg}
            report={auditReport}
            error={auditError}
            onRun={runAudit}
          />

          <div className="card" style={{ padding: 18 }}>
            <div className="rc-upload" style={{ alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Validate fully against UAT</h3>
                <p className="card__hint" style={{ margin: 0 }}>
                  Run this <b>after</b> Create, Duplicate merge and Update. It compares the entire uploaded
                  sheet ({parsedRows ? parsedRows.length : 0} rows) field-by-field against UAT and shows the
                  mismatches, so you can confirm every doctor landed correctly.
                </p>
              </div>
              <button
                className="btn btn--ready"
                style={{ flexShrink: 0 }}
                disabled={running || updRunning || !parsedRows || parsedRows.length === 0}
                onClick={() => {
                  const next = !showFullValidate
                  setShowFullValidate(next)
                  // "Validate fully" is the last step in the workflow — running it
                  // marks this Drive sheet ✓ Completed for every user of the link.
                  if (next) markFileCompleted(activeFileId)
                }}
              >
                {showFullValidate ? 'Hide validation' : 'Validate fully'}
              </button>
            </div>
          </div>

          {showFullValidate && parsedRows && parsedRows.length > 0 && (
            <ReconcileView live={live} embedded rows={parsedRows} />
          )}
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
function UpdateBlock({ rows, selected, setSelected, disabled, running, prog, report, error, onUpdate, done = new Set(), onReset }) {
  const [page, setPage] = useState(0)
  // Already-updated codes are shown blurred (✓ updated) and excluded from
  // select-all / the pending count — only the rest are (re-)updatable.
  const pendingCodes = rows.filter((r) => !done.has(r.code)).map((r) => r.code)
  const doneCount = rows.length - pendingCodes.length
  const allOn = pendingCodes.length > 0 && pendingCodes.every((c) => selected.has(c))
  const toggleAll = () => setSelected((prev) => {
    const n = new Set(prev)
    if (allOn) pendingCodes.forEach((c) => n.delete(c))
    else pendingCodes.forEach((c) => n.add(c))
    return n
  })
  const toggle = (code) => setSelected((prev) => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n })
  const selPending = [...selected].filter((c) => !done.has(c)).length
  const pages = Math.max(1, Math.ceil(rows.length / UPDATE_PAGE))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * UPDATE_PAGE, p * UPDATE_PAGE + UPDATE_PAGE)
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0
  const c = report?.counts
  const errs = report ? report.results.filter((r) => !r.ok) : []
  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          To update — already in UAT ({rows.length}) · <b>{selPending} selected</b>{doneCount > 0 ? ` · ${doneCount} updated` : ''}
        </span>
        <div className="filterbar__spacer" />
        {doneCount > 0 && onReset && (
          <button
            className="export-btn"
            disabled={disabled}
            title="Clear the ✓ updated marks and re-enable every row for a full re-update"
            onClick={() => { if (window.confirm(`Re-enable all ${rows.length} rows for updating (including the ${doneCount} already updated) and run them all again?`)) onReset() }}
          >
            ↻ Update all again
          </button>
        )}
        <button className="btn btn--ready" disabled={disabled || selPending === 0} onClick={() => onUpdate([...selected])}>
          {running ? 'Updating…' : `Update selected · ${selPending}`}
        </button>
      </div>
      <p className="card__hint" style={{ padding: '0 4px 8px', margin: 0 }}>
        Updates changed fields, sets the employee's role profile for their department — replacing an old or
        duplicated role profile for that same department — and adds the sheet's address only when it isn't
        already on the Lead (matched on address + city). Other departments' role profiles and existing
        addresses are never removed. Runs in batches; re-running is safe.
      </p>

      {prog && (
        <div style={{ padding: '0 4px 8px' }}>
          <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,0.25)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
          </div>
          <p className="card__hint" style={{ margin: '6px 0 0' }}>
            {running ? 'Updating' : 'Done'} — {prog.processed}/{prog.total} rows ({pct}%)
          </p>
        </div>
      )}

      {error && <p className="reviewbox__msg err" style={{ margin: '0 4px 10px' }}>Error: {error}</p>}

      {c && (
        <div className="rc-kpis" style={{ margin: '0 4px 12px' }}>
          <Kpi n={c.updated} label="Updated" tone="ok" />
          <Kpi n={c.unchanged} label="Unchanged" />
          <Kpi n={c.addressAdded} label="Addresses added" />
          <Kpi n={c.roleAdded} label="Role profiles added" />
          <Kpi n={c.roleDeduped} label="Dept duplicates fixed" tone={c.roleDeduped ? 'warning' : ''} />
          <Kpi n={c.errors + c.notFound} label="Errors" tone={c.errors + c.notFound ? 'error' : ''} />
        </div>
      )}

      {errs.length > 0 && (
        <div className="table-wrap" style={{ margin: '0 4px 12px' }}>
          <div className="toolbar" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <div className="section-label" style={{ margin: 0 }}>Update errors ({errs.length})</div>
            <div className="filterbar__spacer" />
            <button className="export-btn" onClick={() => exportUpdateErrors(errs)}><IconDownload width={15} height={15} /> Export</button>
          </div>
          <table className="dt">
            <thead><tr><th>Dr Code</th><th>Lead</th><th>Detail</th></tr></thead>
            <tbody>
              {errs.slice(0, CAP).map((r, i) => (
                <tr key={r.code + i}>
                  <td className="code">{r.code}</td><td>{r.name || '—'}</td>
                  <td style={{ maxWidth: 460, whiteSpace: 'normal' }}>{r.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {errs.length > CAP && <p className="card__hint" style={{ padding: 8 }}>Showing first {CAP} of {errs.length}.</p>}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>None already in UAT.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 96 }}>
                    <input type="checkbox" checked={allOn} disabled={disabled} onChange={toggleAll} title="Select all not-yet-updated" />
                  </th>
                  <th>Dr Code</th><th>Doctor</th><th>Emp Code</th><th>HQ</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const isDone = done.has(r.code)
                  return (
                    <tr key={r.code + i} className={!isDone && selected.has(r.code) ? 'is-selected' : ''} style={isDone ? { opacity: 0.5 } : undefined}>
                      <td>
                        {isDone
                          ? <span className="review-chip ready" title="Already updated in a previous run">✓ updated</span>
                          : <input type="checkbox" checked={selected.has(r.code)} disabled={disabled} onChange={() => toggle(r.code)} />}
                      </td>
                      <td className="code">{r.code}</td>
                      <td>{r.name || '—'}</td>
                      <td>{r.empCode || '—'}</td>
                      <td>{r.hq || '—'}</td>
                    </tr>
                  )
                })}
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

// Read-only "duplicate department" scan of the "already in UAT" Leads. Flags a
// doctor whose Sales Team (Role Profile) child table lists the same department
// on more than one row — e.g. two rows both "CND Coimbatore - ELPL". Nothing is
// written; this only surfaces the leads to clean up by hand.
function RoleAuditPanel({ total, running, prog, report, error, onRun }) {
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0
  const c = report?.counts
  const flagged = report?.flagged || []
  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          Duplicate department in Sales Team{c ? ` · ${c.flagged} found` : ''}
        </span>
        <div className="filterbar__spacer" />
        {flagged.length > 0 && (
          <button className="export-btn" onClick={() => exportRoleAudit(flagged)}><IconDownload width={15} height={15} /> Export</button>
        )}
        <button className="btn btn--ready" disabled={running || total === 0} onClick={onRun}>
          {running ? 'Scanning…' : report ? 'Re-scan' : `Scan ${total} doctors`}
        </button>
      </div>
      <p className="card__hint" style={{ padding: '0 4px 8px', margin: 0 }}>
        Checks each doctor already in UAT and lists the ones whose <b>Sales Team → Role Profile</b> table has the
        same <b>Department</b> on more than one row. Read-only — nothing is changed; fix the duplicates in ERPNext.
      </p>

      {prog && (
        <div style={{ padding: '0 4px 8px' }}>
          <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,0.25)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
          </div>
          <p className="card__hint" style={{ margin: '6px 0 0' }}>
            {running ? 'Scanning' : 'Done'} — {prog.processed}/{prog.total} doctors ({pct}%)
          </p>
        </div>
      )}

      {error && <p className="reviewbox__msg err" style={{ margin: '0 4px 10px' }}>Error: {error}</p>}

      {c && (
        <div className="rc-kpis" style={{ margin: '0 4px 12px' }}>
          <Kpi n={c.scanned} label="Scanned" />
          <Kpi n={c.flagged} label="Duplicate dept" tone={c.flagged ? 'warning' : 'ok'} />
          <Kpi n={c.errors} label="Errors" tone={c.errors ? 'error' : ''} />
        </div>
      )}

      {report && !running && flagged.length === 0 && (
        <p className="card__hint" style={{ padding: '0 4px 10px' }}>No doctor has the same department twice. 🎉</p>
      )}

      {flagged.length > 0 && (
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr><th>Dr Code</th><th>Doctor</th><th>HQ</th><th>Duplicated department(s)</th></tr>
            </thead>
            <tbody>
              {flagged.slice(0, CAP).map((f, i) => (
                <tr key={f.code + i}>
                  <td className="code">{f.code}</td>
                  <td>{f.name || '—'}</td>
                  <td>{f.hq || '—'}</td>
                  <td style={{ maxWidth: 520, whiteSpace: 'normal' }}>
                    {f.duplicates.map((d, j) => (
                      <div key={j}>
                        <b>{d.department}</b> ×{d.count}
                        {d.roleProfiles.filter(Boolean).length > 0 && (
                          <span className="card__hint"> — {d.roleProfiles.filter(Boolean).join(', ')}</span>
                        )}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {flagged.length > CAP && <p className="card__hint" style={{ padding: 8 }}>Showing first {CAP} of {flagged.length}. Export for the full list.</p>}
        </div>
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
          <div className="toolbar" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <div className="section-label" style={{ margin: 0 }}>Exceptions — fix &amp; re-run ({runReport.exceptions.length})</div>
            <div className="filterbar__spacer" />
            <button className="export-btn" onClick={() => exportExceptions(runReport.exceptions)}><IconDownload width={15} height={15} /> Export</button>
          </div>
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
          <div className="toolbar" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <div className="section-label" style={{ margin: 0 }}>ERPNext errors ({errs.length})</div>
            <div className="filterbar__spacer" />
            <button className="export-btn" onClick={() => exportCreateErrors(errs)}><IconDownload width={15} height={15} /> Export</button>
          </div>
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

// Inline listing of the shared Drive folder's sheets — served by the backend, so
// no login is needed. Click a row to load that sheet; a finished sheet shows a
// ✓ Completed tick.
function DriveBrowser({ state, files, error, completed, activeFileId, loadingFileId, busy, collapsed, onToggle, onRefresh, onOpen }) {
  const doneCount = state === 'ready' && files ? files.filter((f) => completed.has(f.id)).length : 0
  const canCollapse = state === 'ready' && files && files.length > 0
  return (
    <div className="card">
      <div className="toolbar">
        <button
          type="button"
          onClick={canCollapse ? onToggle : undefined}
          disabled={!canCollapse}
          title={collapsed ? 'Show all sheets' : 'Hide the sheet list'}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: canCollapse ? 'pointer' : 'default', font: 'inherit' }}
        >
          {canCollapse && (
            <span style={{ transition: 'transform .15s ease', transform: collapsed ? 'rotate(180deg)' : 'none', fontSize: 12, color: 'var(--muted, #64748b)' }}>▲</span>
          )}
          <span className="section-label" style={{ margin: 0 }}>
            Doctor sheets — Google Drive{state === 'ready' && files ? ` (${files.length})` : ''}
            {collapsed && doneCount > 0 ? ` · ${doneCount} completed` : ''}
          </span>
        </button>
        <div className="filterbar__spacer" />
        {state === 'ready' && <button className="export-btn" onClick={onRefresh} disabled={busy}>Refresh</button>}
      </div>

      {collapsed && canCollapse && (
        <p className="card__hint" style={{ padding: '4px 8px 10px', margin: 0 }}>
          List hidden — click the title to choose another sheet.
        </p>
      )}

      {!collapsed && (state === 'idle' || state === 'loading') ? (
        <p className="card__hint" style={{ padding: '4px 8px 10px' }}>Loading files…</p>
      ) : null}

      {!collapsed && state === 'not-configured' && (
        <p className="card__hint" style={{ padding: '4px 8px 12px' }}>
          Google Drive isn't set up on the server yet. {error}
        </p>
      )}

      {!collapsed && state === 'error' && (
        <p className="reviewbox__msg err" style={{ margin: '0 8px 10px' }}>
          Error: {error} <button className="export-btn" style={{ marginLeft: 8 }} onClick={onRefresh}>Retry</button>
        </p>
      )}

      {!collapsed && state === 'ready' && (
        files.length === 0 ? (
          <p className="card__hint" style={{ padding: '4px 8px 10px' }}>
            No sheets in the folder — or it isn't shared with this Google account.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr><th>Sheet</th><th style={{ width: 120 }}>Modified</th><th style={{ width: 140 }}>Status</th><th style={{ width: 110 }}></th></tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const done = completed.has(f.id)
                  const active = activeFileId === f.id
                  return (
                    <tr key={f.id} className={active ? 'is-selected' : ''}>
                      <td>{f.name}</td>
                      <td>{(f.modifiedTime || '').slice(0, 10)}</td>
                      <td>
                        {done ? <span className="review-chip ready">✓ Completed</span>
                          : active ? <span className="review-chip">Loaded</span>
                            : <span className="card__hint">—</span>}
                      </td>
                      <td>
                        <button
                          className="btn btn--ready"
                          style={{ padding: '2px 10px', fontSize: 12 }}
                          disabled={busy || loadingFileId === f.id}
                          onClick={() => onOpen(f)}
                        >
                          {loadingFileId === f.id ? 'Loading…' : (done || active) ? 'Re-open' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
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

// Generic error/exception exporter — writes the given plain-object rows to xlsx.
function exportTable(rows, name) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'None' }]), name.slice(0, 31))
  XLSX.writeFile(wb, `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

const exportCreateErrors = (errs) => exportTable(
  errs.map((r) => ({ 'Dr Code': r.code, Operation: r.op, HTTP: r.status || '', Detail: r.error || '' })),
  'create-errors',
)
const exportExceptions = (exs) => exportTable(
  exs.map((e) => ({ 'Dr Code': e.code, Doctor: e.dr || '', 'Emp Code': e.empcode || '', HQ: e.hq || '', Reason: e.reason || '' })),
  'create-exceptions',
)
const exportUpdateErrors = (errs) => exportTable(
  errs.map((r) => ({ 'Dr Code': r.code, Lead: r.name || '', Detail: r.error || '' })),
  'update-errors',
)
// One row per duplicated department (a doctor with two clashing departments
// yields two rows), so the CRM can work the list line-by-line.
const exportRoleAudit = (flagged) => exportTable(
  flagged.flatMap((f) => f.duplicates.map((d) => ({
    'Dr Code': f.code,
    Doctor: f.name || '',
    HQ: f.hq || '',
    Lead: f.leadName || '',
    Department: d.department,
    Count: d.count,
    'Role Profiles': d.roleProfiles.filter(Boolean).join(', '),
  }))),
  'duplicate-departments',
)
