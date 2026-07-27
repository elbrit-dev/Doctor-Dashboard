import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { fetchPaddedPairs, mergePaddedBatch } from '../data/source.js'
import { IconDownload } from './icons.jsx'

const PAGE = 40      // rows per page
const BATCH = 20     // pairs per server call
const RUN_CAP = 200  // how many mergeable Leads one "Merge next N" click processes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A tab that puts each zero-padded Lead NEXT TO the clean twin it belongs to and
// merges the pair instead of deleting it — Frappe's native rename+merge, the same
// thing the desk "Rename → Merge with existing" dialog does. Merge one row at a
// time with its own button, or tick several and merge them in batches of 20.
export default function MergePaddedView({ live }) {
  const [phase, setPhase] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [pairs, setPairs] = useState([])              // [{padded, clean, hasClean, ...}]
  const [done, setDone] = useState(() => new Map())   // padded -> result (merged OK)
  const [failed, setFailed] = useState(() => new Map()) // padded -> result (last failure)
  const [selected, setSelected] = useState(() => new Set())
  const [page, setPage] = useState(0)
  const [view, setView] = useState('mergeable')       // mergeable | orphan | all
  const [q, setQ] = useState('')
  const [backfill, setBackfill] = useState(true)

  const [running, setRunning] = useState(false)
  const [prog, setProg] = useState(null)   // { processed, total }
  const [report, setReport] = useState(null) // { counts }

  const load = async () => {
    setPhase('loading'); setError(null)
    try {
      const list = await fetchPaddedPairs()
      setPairs(list)
      setDone(new Map()); setFailed(new Map()); setSelected(new Set())
      setPage(0); setReport(null); setProg(null); setPhase('ready')
    } catch (err) {
      setError(err.message); setPhase('error')
    }
  }

  useEffect(() => { if (live && phase === 'idle') load() /* eslint-disable-next-line */ }, [live])

  const mergeableAll = useMemo(() => pairs.filter((p) => p.hasClean), [pairs])
  const orphanAll = useMemo(() => pairs.filter((p) => !p.hasClean), [pairs])

  // Rows for the current view + search. Merged rows stay visible (greyed, with a
  // ✓) so you can see what the run actually did.
  const rows = useMemo(() => {
    const src = view === 'mergeable' ? mergeableAll : view === 'orphan' ? orphanAll : pairs
    const needle = q.trim().toLowerCase()
    if (!needle) return src
    return src.filter((p) =>
      p.padded.toLowerCase().includes(needle) ||
      p.clean.toLowerCase().includes(needle) ||
      (p.paddedDoctor || '').toLowerCase().includes(needle) ||
      (p.cleanDoctor || '').toLowerCase().includes(needle))
  }, [view, q, pairs, mergeableAll, orphanAll])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * PAGE, p * PAGE + PAGE)

  // Only un-merged rows that actually have a twin can be selected.
  const selectable = (x) => x.hasClean && !done.has(x.padded)
  const selCount = [...selected].filter((n) => !done.has(n)).length
  const pageSelectable = pageRows.filter(selectable).map((x) => x.padded)
  const pageAllOn = pageSelectable.length > 0 && pageSelectable.every((n) => selected.has(n))
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev)
    if (pageAllOn) pageSelectable.forEach((x) => n.delete(x))
    else pageSelectable.forEach((x) => n.add(x))
    return n
  })
  const viewSelectable = rows.filter(selectable).map((x) => x.padded)
  const allOn = viewSelectable.length > 0 && viewSelectable.every((n) => selected.has(n))
  const toggleAll = () => setSelected(() => (allOn ? new Set() : new Set(viewSelectable)))
  const toggle = (name) => setSelected((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })

  // Drive the offset loop over `list`, folding each batch's results into state as
  // it lands so the table updates while the run is still going.
  const runMerge = async (list) => {
    if (running || list.length === 0) return
    const total = list.length
    const counts = { merged: 0, errors: 0, fieldsFilled: 0, rolesAdded: 0, unverified: 0 }
    const ok = new Map(done)
    const bad = new Map(failed)
    setRunning(true); setError(null); setProg({ processed: 0, total }); setReport({ counts: { ...counts } })

    let offset = 0
    while (offset < total) {
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await mergePaddedBatch({ pairs: list, offset, batchSize: BATCH, backfill })
        } catch (e) {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1)); else setError(e.message)
        }
      }
      if (!out) { // batch failed after retries — skip it, keep going
        setProg({ processed: Math.min(offset + BATCH, total), total }); offset += BATCH; continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      for (const r of (out.results || [])) {
        if (r.ok) { ok.set(r.padded, r); bad.delete(r.padded) }
        else bad.set(r.padded, r)
      }
      setDone(new Map(ok)); setFailed(new Map(bad))
      setSelected((prev) => { const n = new Set(prev); for (const k of ok.keys()) n.delete(k); return n })
      setProg({ processed: Math.min(offset + BATCH, total), total })
      setReport({ counts: { ...counts } })
      offset = out.nextOffset == null ? total : out.nextOffset
    }
    setRunning(false)
  }

  const confirmText = (n, one) =>
    `MERGE ${one ? `${one.padded} → ${one.clean}` : `${n} padded Lead(s) into their clean twin`}?\n\n` +
    `${backfill ? 'The clean Lead is first backfilled from the padded one (blank fields + missing role profiles only — nothing it already has is overwritten).\n\n' : 'Backfill is OFF — field values on the padded Lead will NOT be copied over.\n\n'}` +
    `Then ERPNext runs its native rename-with-merge: every Contact, Address, Comment and link pointing at the padded id is re-pointed at the clean id, and the padded id stops existing.\n\n` +
    `This is a live, irreversible write to the connected CRM.`

  const mergeOne = async (pair) => {
    if (running) return
    if (!window.confirm(confirmText(1, pair))) return
    await runMerge([{ padded: pair.padded, clean: pair.clean }])
  }

  const mergeSelected = async () => {
    const list = rows.filter((x) => selected.has(x.padded) && selectable(x)).map((x) => ({ padded: x.padded, clean: x.clean }))
    if (list.length === 0) return
    if (!window.confirm(confirmText(list.length))) return
    await runMerge(list)
  }

  // Every mergeable Lead still waiting (has a clean twin, not yet merged) — the
  // pool the "Merge next N" button draws from, ignoring the view/search filter.
  const pendingAll = useMemo(() => mergeableAll.filter((x) => !done.has(x.padded)), [mergeableAll, done])

  // One click merges the next RUN_CAP (200) pending Leads; runMerge then loops
  // them to the server in small BATCH-sized calls, so no single call can time out.
  const mergeNext = async () => {
    const chunk = pendingAll.slice(0, RUN_CAP)
    const list = chunk.map((x) => ({ padded: x.padded, clean: x.clean }))
    if (list.length === 0) return
    if (!window.confirm(confirmText(list.length))) return
    await runMerge(list)
  }

  const exportList = () => {
    const wb = XLSX.utils.book_new()
    const data = rows.map((x) => {
      const r = done.get(x.padded); const f = failed.get(x.padded)
      return {
        'Padded ID': x.padded, 'Padded Doctor': x.paddedDoctor, 'Padded HQ': x.paddedTerritory,
        'Clean ID': x.hasClean ? x.clean : '(none)', 'Clean Doctor': x.cleanDoctor, 'Clean HQ': x.cleanTerritory,
        'Doctor Code': x.code,
        Status: r ? 'Merged' : f ? 'Failed' : x.hasClean ? 'Pending' : 'No clean twin',
        Detail: r ? `filled: ${(r.filled || []).join(', ') || '—'}${r.rolesAdded ? ` · +${r.rolesAdded} role row(s)` : ''}` : (f?.error || ''),
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'None' }]), 'Padded vs clean')
    XLSX.writeFile(wb, `padded-merge-pairs-${new Date().toISOString().slice(0, 10)}.xlsx`)
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
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0
  const failures = [...failed.values()]

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="rc-upload" style={{ alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Zero-padded IDs</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Every zero-padded Lead (<code>DR-00002159</code>) shown next to the clean twin it belongs to
              (<code>DR-2159</code>). <b>Merge</b> runs ERPNext's own rename-with-merge — the same as the desk
              <em> Rename → “Merge with existing” ✓</em> dialog: the padded Lead's Contacts, Addresses,
              Comments and every link move onto the clean id, then the padded id is gone. Nothing is deleted.
              <b> Merge next {RUN_CAP}</b> processes {RUN_CAP} at a time, looped to the server in batches of {BATCH}.
            </p>
          </div>
          <button className="export-btn" onClick={load} disabled={phase === 'loading' || running} style={{ flexShrink: 0 }}>
            {phase === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <label className="card__hint" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: running ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={backfill} disabled={running} onChange={(e) => setBackfill(e.target.checked)} />
          <span>
            <b>Copy the padded Lead's data across before merging</b> — fills only fields the clean Lead leaves
            blank and adds role profiles it doesn't have. Never overwrites an existing value. Frappe's merge
            alone moves links, not field values, so leaving this off can lose data the padded record holds.
          </span>
        </label>
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      {phase === 'ready' && (
        <div className="card">
          <div className="toolbar">
            <div className="segmented" style={{ margin: 0 }}>
              <button className={view === 'mergeable' ? 'active' : ''} onClick={() => { setView('mergeable'); setPage(0) }}>
                Mergeable ({mergeableAll.length})
              </button>
              <button className={view === 'orphan' ? 'active' : ''} onClick={() => { setView('orphan'); setPage(0) }}>
                No clean twin ({orphanAll.length})
              </button>
              <button className={view === 'all' ? 'active' : ''} onClick={() => { setView('all'); setPage(0) }}>
                All ({pairs.length})
              </button>
            </div>
            <input
              placeholder="Search id or doctor…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0) }}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(148,163,184,.4)', background: 'transparent', color: 'inherit', font: 'inherit', minWidth: 180 }}
            />
            <div className="filterbar__spacer" />
            {rows.length > 0 && <button className="export-btn" onClick={exportList}><IconDownload width={15} height={15} /> Export list</button>}
            <button className="btn" disabled={running || selCount === 0} onClick={mergeSelected}>
              {running ? 'Merging…' : `Merge selected · ${selCount}`}
            </button>
            <button className="btn" disabled={running || pendingAll.length === 0} onClick={mergeNext} title={`Merge the next ${RUN_CAP} zero-padded Leads that have a clean twin`}>
              {running ? 'Merging…' : `Merge next ${Math.min(RUN_CAP, pendingAll.length)}`}
            </button>
          </div>

          {prog && (
            <div style={{ padding: '0 8px 8px' }}>
              <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,.25)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
              </div>
              <p className="card__hint" style={{ margin: '6px 0 0' }}>
                {running ? 'Merging' : 'Done'} — {prog.processed}/{prog.total} ({pct}%)
              </p>
            </div>
          )}

          {c && (
            <p className="card__hint" style={{ padding: '0 8px 8px' }}>
              Merged <b>{c.merged}</b> Lead(s) · {c.fieldsFilled} field(s) backfilled · {c.rolesAdded} role row(s) added
              {c.unverified ? <> · <span className="sev-error">{c.unverified} still resolve under the padded id</span></> : ''}
              {c.errors ? <> · <span className="sev-error">{c.errors} failed</span></> : ''}.
            </p>
          )}

          {rows.length === 0 ? (
            <p className="card__hint" style={{ padding: '4px 8px 10px' }}>
              {view === 'mergeable' ? 'No padded Lead has a clean twin to merge into. ✅' : 'Nothing here.'}
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
                      <th>Zero-padded ID</th><th>Doctor</th><th>HQ</th>
                      <th style={{ width: 28, textAlign: 'center' }} />
                      <th>Clean ID</th><th>Doctor</th><th>HQ</th>
                      <th>Status</th><th style={{ width: 96 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((x) => {
                      const okr = done.get(x.padded)
                      const bad = failed.get(x.padded)
                      return (
                        <tr key={x.padded} className={selected.has(x.padded) && !okr ? 'is-selected' : ''} style={okr ? { opacity: 0.55 } : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(x.padded) && !okr}
                              disabled={running || !selectable(x)}
                              onChange={() => toggle(x.padded)}
                            />
                          </td>
                          <td className="code">{x.padded}</td>
                          <td>{x.paddedDoctor || '—'}</td>
                          <td>{x.paddedTerritory || '—'}</td>
                          <td style={{ textAlign: 'center', opacity: 0.6 }}>→</td>
                          <td className="code">{x.hasClean ? x.clean : <span style={{ opacity: 0.5 }}>—</span>}</td>
                          <td>{x.hasClean ? (x.cleanDoctor || '—') : '—'}</td>
                          <td>{x.hasClean ? (x.cleanTerritory || '—') : '—'}</td>
                          <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                            {okr ? (
                              <span style={{ color: 'var(--ok)' }} title={`via ${okr.via || 'rename'}`}>
                                ✓ Merged
                                {okr.filled?.length ? ` · ${okr.filled.length} field(s)` : ''}
                                {okr.rolesAdded ? ` · +${okr.rolesAdded} role` : ''}
                                {okr.verified === false ? ' · id still resolves' : ''}
                              </span>
                            ) : bad ? (
                              <span className="sev-error">✕ {bad.stage || 'merge'}: {bad.error}</span>
                            ) : x.hasClean ? (
                              <span style={{ opacity: 0.65 }}>Pending</span>
                            ) : (
                              <span style={{ opacity: 0.65 }}>No clean twin — nothing to merge into</span>
                            )}
                          </td>
                          <td>
                            {x.hasClean && !okr && (
                              <button className="export-btn" disabled={running} onClick={() => mergeOne(x)} style={{ padding: '4px 10px' }}>
                                {bad ? 'Retry' : 'Merge'}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="rc-pager">
                <button disabled={p === 0 || running} onClick={() => setPage(p - 1)}>← Prev</button>
                <span>
                  Page {p + 1} of {pages} · {rows.length} row(s) · {PAGE}/page
                  {viewSelectable.length > 0 && (
                    <>
                      {' · '}
                      <button
                        disabled={running}
                        onClick={toggleAll}
                        style={{ background: 'none', border: 'none', color: 'var(--accent, #2563eb)', cursor: running ? 'default' : 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline' }}
                      >
                        {allOn ? 'Clear all' : `Select all ${viewSelectable.length}`}
                      </button>
                    </>
                  )}
                </span>
                <button disabled={p >= pages - 1 || running} onClick={() => setPage(p + 1)}>Next →</button>
              </div>
            </>
          )}

          {failures.length > 0 && (
            <div className="table-wrap" style={{ margin: '0 4px 12px' }}>
              <div className="section-label" style={{ margin: '8px 0' }}>Could not merge ({failures.length})</div>
              <table className="dt">
                <thead><tr><th>Padded ID</th><th>Clean ID</th><th>Stage</th><th>HTTP</th><th>Detail</th></tr></thead>
                <tbody>
                  {failures.slice(0, 300).map((r, i) => (
                    <tr key={r.padded + i}>
                      <td className="code">{r.padded}</td>
                      <td className="code">{r.clean}</td>
                      <td>{r.stage || '—'}</td>
                      <td>{r.status || '—'}</td>
                      <td style={{ maxWidth: 460, whiteSpace: 'normal' }}>{r.error || '—'}</td>
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
