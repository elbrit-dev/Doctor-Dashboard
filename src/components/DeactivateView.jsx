import { Fragment, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { fetchLeadIndex, deactivateBatch } from '../data/source.js'
import { listFolderFiles, downloadFromDrive } from '../lib/googleDrive.js'
import { parseSheet } from '../lib/parseSheet.js'
import { buildLeadIndex, matchSheetCodes, strip } from '../lib/matchCodes.js'
import { IconDownload } from './icons.jsx'

const PAGE = 40          // rows per page
const BATCH = 40         // Leads per server call — one PUT each, so this stays
                         // well inside the serverless time limit
const RUN_SIZES = [200, 500, 1000] // how many one "Deactivate next N" click does
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A tab for retiring doctors: load the sheet that lists them (it lives in a
// sub-folder of the same shared Drive folder), match every "Doctor Code" to the
// Lead it belongs to — with and without the zero padding, on both the DR-<code>
// name and custom_doctor_code — then flip Status from Active to Inactive.
// Matching happens in the browser against one compact Lead index, because these
// sheets carry tens of thousands of codes. Nothing is written until the matches
// are on screen and you press a button.
export default function DeactivateView({ live }) {
  // ── ERP lead index (fetched once, reused for every sheet) ─────────────────
  const [idxState, setIdxState] = useState('idle') // idle | loading | ready | error
  const [idx, setIdx] = useState(null)
  const [idxMeta, setIdxMeta] = useState(null) // { count, fetchedAt }
  const [idxError, setIdxError] = useState(null)

  // ── file source ───────────────────────────────────────────────────────────
  const [driveState, setDriveState] = useState('idle') // idle | loading | ready | not-configured | error
  const [driveFiles, setDriveFiles] = useState([])
  const [driveError, setDriveError] = useState(null)
  const [openingId, setOpeningId] = useState(null)
  const [listCollapsed, setListCollapsed] = useState(false)

  // ── loaded sheet + match ──────────────────────────────────────────────────
  const [sheet, setSheet] = useState(null)   // { label, rows, total, codeKey }
  const [phase, setPhase] = useState('idle') // idle | matching | ready | error
  const [error, setError] = useState(null)
  const [match, setMatch] = useState(null)   // { rows, missing, counts }

  // ── run state ─────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false)
  const [prog, setProg] = useState(null)     // { processed, total }
  const [report, setReport] = useState(null) // { counts }
  const [okMap, setOkMap] = useState(() => new Map())     // lead name -> result
  const [failMap, setFailMap] = useState(() => new Map()) // lead name -> result
  const [selected, setSelected] = useState(() => new Set())
  const [runSize, setRunSize] = useState(RUN_SIZES[0])

  // ── table controls ────────────────────────────────────────────────────────
  const [view, setView] = useState('todo')   // todo | inactive | missing | all
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  // Returns the built index as well as storing it — loadSheet needs it in the
  // same tick, before React has re-rendered with the new state.
  const loadIndex = async () => {
    setIdxState('loading'); setIdxError(null)
    try {
      const { leads, fetchedAt } = await fetchLeadIndex()
      const built = buildLeadIndex(leads)
      setIdx(built)
      setIdxMeta({ count: leads.length, fetchedAt })
      setIdxState('ready')
      return built
    } catch (err) {
      setIdxError(err.message); setIdxState('error')
      return null
    }
  }

  const loadDriveList = async () => {
    setDriveState('loading'); setDriveError(null)
    try {
      // deep: the sheet for this run sits in a sub-folder, not the folder root.
      const { configured, files, detail } = await listFolderFiles({ deep: true })
      if (!configured) { setDriveError(detail || 'Drive folder not configured on the server.'); setDriveState('not-configured'); return }
      setDriveFiles(files); setDriveState('ready')
    } catch (err) {
      setDriveError(err.message); setDriveState('error')
    }
  }

  useEffect(() => {
    if (!live) return
    if (driveState === 'idle') loadDriveList()
    if (idxState === 'idle') loadIndex()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  // Parse a sheet (Drive or local upload) and resolve its codes against the
  // index. Read-only — this only builds the review list.
  const loadSheet = async (file, label) => {
    setPhase('matching'); setError(null); setMatch(null); setReport(null); setProg(null)
    setOkMap(new Map()); setFailMap(new Map()); setSelected(new Set()); setPage(0); setView('todo')
    try {
      const useIdx = idx || await loadIndex()
      if (!useIdx) throw new Error('Could not load the ERP lead index — press Reload index, then re-open the sheet')
      const parsed = await parseSheet(file)
      setSheet({ label, rows: parsed.rows, total: parsed.total, codeKey: parsed.codeKey })
      // One entry per distinct code, keeping the sheet's own spelling (00075529)
      // for display — matchSheetCodes strips before joining.
      const codes = []
      const seenCode = new Set()
      for (const r of parsed.rows) {
        const k = strip(r.code)
        if (k && !seenCode.has(k)) { seenCode.add(k); codes.push(r.code) }
      }
      if (codes.length === 0) throw new Error('No doctor codes in the sheet')
      setMatch(matchSheetCodes(useIdx, codes))
      setPhase('ready'); setListCollapsed(true)
    } catch (err) {
      setError(err.message); setPhase('error')
    }
  }

  const openDriveFile = async (f) => {
    if (running) return
    setOpeningId(f.id)
    try {
      const file = await downloadFromDrive(f)
      await loadSheet(file, f.folder ? `${f.folder} / ${f.name}` : f.name)
    } catch (err) {
      setError(err.message); setPhase('error')
    } finally {
      setOpeningId(null)
    }
  }

  const onUpload = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) await loadSheet(f, f.name)
  }

  // Sheet row per code, so the table can show the doctor/HQ the sheet names —
  // the ERP index deliberately carries only name + code + status.
  const sheetByCode = useMemo(() => {
    const m = new Map()
    for (const r of sheet?.rows || []) { const k = strip(r.code); if (k && !m.has(k)) m.set(k, r.raw) }
    return m
  }, [sheet])

  const sheetField = (code, re) => {
    const raw = sheetByCode.get(strip(code)) || {}
    const key = Object.keys(raw).find((k) => re.test(k))
    return key ? String(raw[key] ?? '').trim() : ''
  }
  const doctorFor = (code) => sheetField(code, /doctor\s*name|^dr\.?\s*name$/i)
  const hqFor = (code) => sheetField(code, /^hq$|territory/i)
  const cityFor = (code) => sheetField(code, /^city$/i)

  const all = match?.rows || []
  const todoAll = useMemo(() => all.filter((r) => !r.alreadyInactive && !okMap.has(r.name)), [all, okMap])
  const inactiveAll = useMemo(() => all.filter((r) => r.alreadyInactive || okMap.has(r.name)), [all, okMap])
  const missing = match?.missing || []

  const rows = useMemo(() => {
    const src = view === 'todo' ? todoAll : view === 'inactive' ? inactiveAll : all
    const needle = q.trim().toLowerCase()
    if (!needle) return src
    return src.filter((r) =>
      r.name.toLowerCase().includes(needle) ||
      String(r.sheetCode).toLowerCase().includes(needle) ||
      doctorFor(r.code).toLowerCase().includes(needle))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, q, all, todoAll, inactiveAll, sheetByCode])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * PAGE, p * PAGE + PAGE)

  const selectable = (r) => !r.alreadyInactive && !okMap.has(r.name)
  const selCount = [...selected].filter((n) => !okMap.has(n)).length
  const pageSelectable = pageRows.filter(selectable).map((r) => r.name)
  const pageAllOn = pageSelectable.length > 0 && pageSelectable.every((n) => selected.has(n))
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev)
    if (pageAllOn) pageSelectable.forEach((x) => n.delete(x))
    else pageSelectable.forEach((x) => n.add(x))
    return n
  })
  const viewSelectable = rows.filter(selectable).map((r) => r.name)
  const allOn = viewSelectable.length > 0 && viewSelectable.every((n) => selected.has(n))
  const toggleAll = () => setSelected(() => (allOn ? new Set() : new Set(viewSelectable)))
  const toggle = (name) => setSelected((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })

  // Drive the offset loop over `names`, folding each batch's results into state as
  // it lands so the table updates while the run is still going.
  const runDeactivate = async (names) => {
    if (running || names.length === 0) return
    const total = names.length
    const counts = { deactivated: 0, notFound: 0, unverified: 0, errors: 0 }
    const ok = new Map(okMap)
    const bad = new Map(failMap)
    setRunning(true); setError(null); setProg({ processed: 0, total }); setReport({ counts: { ...counts } })

    let offset = 0
    while (offset < total) {
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await deactivateBatch({ names, offset, batchSize: BATCH })
        } catch (e) {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1)); else setError(e.message)
        }
      }
      if (!out) { // batch failed after retries — skip it, keep going
        offset += BATCH; setProg({ processed: Math.min(offset, total), total }); continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      for (const r of (out.results || [])) {
        if (r.ok) { ok.set(r.name, r); bad.delete(r.name) }
        else bad.set(r.name, r)
      }
      setOkMap(new Map(ok)); setFailMap(new Map(bad))
      setSelected((prev) => { const n = new Set(prev); for (const k of ok.keys()) n.delete(k); return n })
      setProg({ processed: Math.min(offset + BATCH, total), total })
      setReport({ counts: { ...counts } })
      offset = out.nextOffset == null ? total : out.nextOffset
    }
    setRunning(false)
  }

  const confirmText = (n, one) =>
    `Set ${one ? one.name : `${n} Lead(s)`} to STATUS = INACTIVE?\n\n` +
    `${one ? `Doctor code ${one.sheetCode} → ${one.name}${doctorFor(one.code) ? ` (${doctorFor(one.code)})` : ''}\n\n` : ''}` +
    `Nothing else on the Lead is touched — no delete, no other field. This is a live write ` +
    `to the connected CRM; reverting means setting Status back to Active.`

  const deactivateOne = async (r) => {
    if (running) return
    if (!window.confirm(confirmText(1, r))) return
    await runDeactivate([r.name])
  }

  const deactivateSelected = async () => {
    const names = rows.filter((r) => selected.has(r.name) && selectable(r)).map((r) => r.name)
    if (names.length === 0) return
    if (!window.confirm(confirmText(names.length))) return
    await runDeactivate(names)
  }

  // One click processes the next `runSize` pending Leads (ignoring the view/search
  // filter); runDeactivate loops them to the server in BATCH-sized calls.
  const deactivateNext = async () => {
    const names = todoAll.slice(0, runSize).map((r) => r.name)
    if (names.length === 0) return
    if (!window.confirm(confirmText(names.length))) return
    await runDeactivate(names)
  }

  const exportList = () => {
    const wb = XLSX.utils.book_new()
    const matched = all.map((r) => {
      const ok = okMap.get(r.name); const bad = failMap.get(r.name)
      return {
        'Sheet Code': r.sheetCode, 'Lead ID': r.name, Doctor: doctorFor(r.code),
        HQ: hqFor(r.code), City: cityFor(r.code), 'Status before': r.status,
        Result: ok ? 'Set Inactive' : bad ? `Failed: ${bad.error}` : r.alreadyInactive ? 'Already Inactive' : 'Pending',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(matched.length ? matched : [{ Note: 'None' }]), 'Matched')
    const none = missing.map((c) => ({ 'Sheet Code': c, Doctor: doctorFor(c), Note: 'No Lead in ERP for this code' }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(none.length ? none : [{ Note: 'None' }]), 'Not in ERP')
    XLSX.writeFile(wb, `deactivate-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  if (!live) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p className="card__hint" style={{ margin: 0 }}>
          This needs the live ERPNext connection. Start the proxy (<code>npm run dev:all</code>) or set the
          Netlify environment variables, then reload.
        </p>
      </div>
    )
  }

  const c = report?.counts
  const mc = match?.counts
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0
  const failures = [...failMap.values()]

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="rc-upload" style={{ alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Deactivate doctors</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Load the sheet listing the doctors to retire — it can sit in a sub-folder of the shared Drive
              folder. Each <b>Doctor Code</b> is matched to its Lead <b>with and without the zero padding</b>
              {' '}(<code>00075529</code> → <code>DR-75529</code> or <code>DR-00075529</code>, and both ways on{' '}
              <code>custom_doctor_code</code>). Every match is listed for review first; a button then sets
              {' '}<b>Status → Inactive</b> and nothing else. <b>Deactivate next N</b> processes N at a time,
              looped to the server in batches of {BATCH}.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <label className="export-btn" style={{ cursor: running ? 'default' : 'pointer' }}>
              Upload sheet
              <input type="file" accept=".xlsx,.xls,.csv" onChange={onUpload} disabled={running || phase === 'matching'} style={{ display: 'none' }} />
            </label>
            <button className="export-btn" onClick={loadIndex} disabled={running || idxState === 'loading'}>
              {idxState === 'loading' ? 'Loading index…' : 'Reload index'}
            </button>
          </div>
        </div>

        <p className="card__hint" style={{ margin: '10px 0 0' }}>
          {idxState === 'ready' && idxMeta
            ? <>ERP index: <b>{idxMeta.count.toLocaleString()}</b> doctor Lead(s) loaded.</>
            : idxState === 'loading' ? 'Loading the ERP lead index…'
              : idxState === 'error' ? <span className="sev-error">ERP index failed: {idxError}</span>
                : 'ERP index not loaded yet.'}
        </p>

        {sheet && (
          <p className="card__hint" style={{ margin: '6px 0 0' }}>
            Sheet <b>{sheet.label}</b> — {sheet.rows.length.toLocaleString()} row(s) with a code
            (of {sheet.total.toLocaleString()}), read from column <code>{sheet.codeKey}</code>.
            {mc && <> Matched <b>{mc.matchedCodes.toLocaleString()}</b>/{mc.sheetCodes.toLocaleString()} code(s)
              to <b>{mc.leads.toLocaleString()}</b> Lead(s)
              {mc.padded ? <> · {mc.padded} still padded</> : ''}
              {mc.alreadyInactive ? <> · {mc.alreadyInactive} already Inactive</> : ''}
              {mc.missing ? <> · <span className="sev-error">{mc.missing.toLocaleString()} not in ERP</span></> : ''}.</>}
          </p>
        )}
        {phase === 'matching' && <p className="card__hint" style={{ margin: '6px 0 0' }}>Reading the sheet and matching codes…</p>}
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      <FilePicker
        state={driveState}
        files={driveFiles}
        error={driveError}
        openingId={openingId}
        busy={running || phase === 'matching'}
        collapsed={listCollapsed}
        onToggle={() => setListCollapsed((v) => !v)}
        onRefresh={loadDriveList}
        onOpen={openDriveFile}
      />

      {phase === 'ready' && (
        <div className="card">
          <div className="toolbar">
            <div className="segmented" style={{ margin: 0 }}>
              <button className={view === 'todo' ? 'active' : ''} onClick={() => { setView('todo'); setPage(0) }}>
                To deactivate ({todoAll.length.toLocaleString()})
              </button>
              <button className={view === 'inactive' ? 'active' : ''} onClick={() => { setView('inactive'); setPage(0) }}>
                Already inactive ({inactiveAll.length.toLocaleString()})
              </button>
              <button className={view === 'missing' ? 'active' : ''} onClick={() => { setView('missing'); setPage(0) }}>
                Not in ERP ({missing.length.toLocaleString()})
              </button>
              <button className={view === 'all' ? 'active' : ''} onClick={() => { setView('all'); setPage(0) }}>
                All matches ({all.length.toLocaleString()})
              </button>
            </div>
            <input
              placeholder="Search code, id or doctor…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0) }}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(148,163,184,.4)', background: 'transparent', color: 'inherit', font: 'inherit', minWidth: 190 }}
            />
            <div className="filterbar__spacer" />
            <button className="export-btn" onClick={exportList}><IconDownload width={15} height={15} /> Export list</button>
            <button className="btn" disabled={running || selCount === 0} onClick={deactivateSelected}>
              {running ? 'Working…' : `Set Inactive · ${selCount}`}
            </button>
            <select
              value={runSize}
              disabled={running}
              onChange={(e) => setRunSize(Number(e.target.value))}
              title="How many Leads one click processes"
              style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(148,163,184,.4)', background: 'transparent', color: 'inherit', font: 'inherit' }}
            >
              {RUN_SIZES.map((n) => <option key={n} value={n}>{n} / run</option>)}
            </select>
            <button className="btn btn--ready" disabled={running || todoAll.length === 0} onClick={deactivateNext} title={`Set the next ${runSize} matched Leads to Inactive`}>
              {running ? 'Working…' : `Deactivate next ${Math.min(runSize, todoAll.length)}`}
            </button>
          </div>

          {prog && (
            <div style={{ padding: '0 8px 8px' }}>
              <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,.25)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
              </div>
              <p className="card__hint" style={{ margin: '6px 0 0' }}>
                {running ? 'Deactivating' : 'Done'} — {prog.processed}/{prog.total} ({pct}%)
              </p>
            </div>
          )}

          {c && (
            <p className="card__hint" style={{ padding: '0 8px 8px' }}>
              Set <b>{c.deactivated}</b> Lead(s) to Inactive
              {c.unverified ? <> · <span className="sev-error">{c.unverified} did not read back as Inactive</span></> : ''}
              {c.notFound ? <> · <span className="sev-error">{c.notFound} no longer exist</span></> : ''}
              {c.errors ? <> · <span className="sev-error">{c.errors} failed</span></> : ''}.
            </p>
          )}

          {view === 'missing' ? (
            missing.length === 0 ? (
              <p className="card__hint" style={{ padding: '4px 8px 10px' }}>Every code in the sheet matched a Lead. ✅</p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="dt">
                    <thead><tr><th style={{ width: 160 }}>Sheet code</th><th>Doctor (from sheet)</th><th>Why</th></tr></thead>
                    <tbody>
                      {missing.slice(p * PAGE, p * PAGE + PAGE).map((code) => (
                        <tr key={code}>
                          <td className="code">{code}</td>
                          <td>{doctorFor(code) || '—'}</td>
                          <td style={{ opacity: 0.7 }}>No Lead with this code, padded or clean — nothing to deactivate</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={p} pages={Math.max(1, Math.ceil(missing.length / PAGE))} total={missing.length} running={running} setPage={setPage} />
              </>
            )
          ) : rows.length === 0 ? (
            <p className="card__hint" style={{ padding: '4px 8px 10px' }}>
              {view === 'todo' ? 'Nothing left to deactivate from this sheet. ✅' : 'Nothing here.'}
            </p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>
                        <input type="checkbox" checked={pageAllOn} disabled={running || pageSelectable.length === 0} onChange={togglePage} title="Select this page" />
                      </th>
                      <th>Sheet code</th><th>Lead ID</th><th>Doctor</th><th>HQ</th><th>City</th>
                      <th>Status now</th><th>Result</th><th style={{ width: 110 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const ok = okMap.get(r.name)
                      const bad = failMap.get(r.name)
                      return (
                        <tr key={r.name} className={selected.has(r.name) && !ok ? 'is-selected' : ''} style={ok ? { opacity: 0.55 } : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(r.name) && !ok}
                              disabled={running || !selectable(r)}
                              onChange={() => toggle(r.name)}
                            />
                          </td>
                          <td className="code">{r.sheetCode}</td>
                          <td className="code">
                            {r.name}
                            {r.padded && <span className="review-chip error" style={{ marginLeft: 6 }}>padded</span>}
                          </td>
                          <td>{doctorFor(r.code) || '—'}</td>
                          <td>{hqFor(r.code) || '—'}</td>
                          <td>{cityFor(r.code) || '—'}</td>
                          <td>{r.status || '—'}</td>
                          <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                            {ok ? (
                              <span style={{ color: 'var(--ok)' }}>
                                ✓ Inactive{ok.verified === false ? ` · read back as ${ok.saved || '?'}` : ''}
                              </span>
                            ) : bad ? (
                              <span className="sev-error">✕ {bad.error}</span>
                            ) : r.alreadyInactive ? (
                              <span style={{ opacity: 0.65 }}>Already Inactive — skipped</span>
                            ) : (
                              <span style={{ opacity: 0.65 }}>Pending</span>
                            )}
                          </td>
                          <td>
                            {!ok && !r.alreadyInactive && (
                              <button className="export-btn" disabled={running} onClick={() => deactivateOne(r)} style={{ padding: '4px 10px' }}>
                                {bad ? 'Retry' : 'Set Inactive'}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <Pager
                page={p} pages={pages} total={rows.length} running={running} setPage={setPage}
                extra={viewSelectable.length > 0 && (
                  <>
                    {' · '}
                    <button
                      disabled={running}
                      onClick={toggleAll}
                      style={{ background: 'none', border: 'none', color: 'var(--accent, #2563eb)', cursor: running ? 'default' : 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline' }}
                    >
                      {allOn ? 'Clear all' : `Select all ${viewSelectable.length.toLocaleString()}`}
                    </button>
                  </>
                )}
              />
            </>
          )}

          {failures.length > 0 && (
            <div className="table-wrap" style={{ margin: '0 4px 12px' }}>
              <div className="section-label" style={{ margin: '8px 0' }}>Could not deactivate ({failures.length})</div>
              <table className="dt">
                <thead><tr><th>Lead ID</th><th>HTTP</th><th>Detail</th></tr></thead>
                <tbody>
                  {failures.slice(0, 300).map((r, i) => (
                    <tr key={r.name + i}>
                      <td className="code">{r.name}</td>
                      <td>{r.status || '—'}</td>
                      <td style={{ maxWidth: 520, whiteSpace: 'normal' }}>{r.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Pager({ page, pages, total, running, setPage, extra }) {
  return (
    <div className="rc-pager">
      <button disabled={page === 0 || running} onClick={() => setPage(page - 1)}>← Prev</button>
      <span>
        Page {page + 1} of {pages.toLocaleString()} · {total.toLocaleString()} row(s) · {PAGE}/page
        {extra}
      </span>
      <button disabled={page >= pages - 1 || running} onClick={() => setPage(page + 1)}>Next →</button>
    </div>
  )
}

// The shared Drive folder AND its sub-folders, so a sheet dropped in a new
// sub-folder shows up without any config change. Grouped by folder.
function FilePicker({ state, files, error, openingId, busy, collapsed, onToggle, onRefresh, onOpen }) {
  const groups = useMemo(() => {
    const m = new Map()
    for (const f of files || []) {
      const k = f.folder || ''
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(f)
    }
    // Sub-folders first (that's where new work lands), root files last.
    return [...m.entries()].sort((a, b) => (a[0] ? (b[0] ? a[0].localeCompare(b[0]) : -1) : 1))
  }, [files])
  const canCollapse = state === 'ready' && (files || []).length > 0

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
            Sheets — Drive folder + sub-folders{state === 'ready' ? ` (${(files || []).length})` : ''}
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

      {!collapsed && (state === 'idle' || state === 'loading') && (
        <p className="card__hint" style={{ padding: '4px 8px 10px' }}>Loading files…</p>
      )}

      {!collapsed && state === 'not-configured' && (
        <p className="card__hint" style={{ padding: '4px 8px 12px' }}>
          Google Drive isn't set up on the server yet. {error} — you can still use <b>Upload sheet</b>.
        </p>
      )}

      {!collapsed && state === 'error' && (
        <p className="reviewbox__msg err" style={{ margin: '0 8px 10px' }}>
          Error: {error} <button className="export-btn" style={{ marginLeft: 8 }} onClick={onRefresh}>Retry</button>
        </p>
      )}

      {!collapsed && state === 'ready' && (
        (files || []).length === 0 ? (
          <p className="card__hint" style={{ padding: '4px 8px 10px' }}>
            No sheets in the folder — or it isn't shared with this Google account.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr><th>Sheet</th><th style={{ width: 130 }}>Modified</th><th style={{ width: 110 }} /></tr>
              </thead>
              <tbody>
                {groups.map(([folder, list]) => (
                  <Fragment key={folder || '(root)'}>
                    <tr>
                      <td colSpan={3} className="section-label" style={{ paddingTop: 10 }}>
                        {folder ? `📁 ${folder}` : 'Folder root'} ({list.length})
                      </td>
                    </tr>
                    {list.map((f) => (
                      <tr key={f.id}>
                        <td>{f.name}</td>
                        <td>{(f.modifiedTime || '').slice(0, 10)}</td>
                        <td>
                          <button
                            className="btn btn--ready"
                            style={{ padding: '2px 10px', fontSize: 12 }}
                            disabled={busy || openingId === f.id}
                            onClick={() => onOpen(f)}
                          >
                            {openingId === f.id ? 'Loading…' : 'Load'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
