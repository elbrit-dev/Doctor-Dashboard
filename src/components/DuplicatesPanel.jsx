import { useState, useEffect } from 'react'
import { mergePaddedBatch } from '../data/source.js'
import { IconDownload } from './icons.jsx'

const DUP_PAGE = 20 // same paginated 20/page layout as the "To update" table
const BATCH = 5     // padded Leads per server call — each merge hits ERP ~4×, so
                    // bigger batches blow the serverless time limit (502/504)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Merged duplicate codes persist across refreshes / re-scans, so a set that's
// been merged never shows the Merge button again.
const STORE_MERGED = 'dvd-dup-merged-v1'
const readMerged = () => { try { return JSON.parse(localStorage.getItem(STORE_MERGED) || '[]') } catch { return [] } }
const writeMerged = (arr) => { try { localStorage.setItem(STORE_MERGED, JSON.stringify(arr)) } catch { /* ignore */ } }

// Duplicate IDs (same code stored as clean DR-<code> + padded DR-000<code>).
// Merge runs ERPNext's NATIVE rename-with-merge — the desk "Rename → Merge with
// existing ✓" operation: the clean Lead is first backfilled from the padded one
// (blank fields + missing role profiles only), then every Contact, Address,
// Comment and link pointing at the padded id is re-pointed at the clean id and
// the padded id stops existing. Bulk "Merge" drives the batched
// /api/merge-padded loop; a per-row button does a single set. Re-running is safe
// (an already-gone padded id counts as merged, not as an error).
export default function DuplicatesPanel({ duplicates, onExport, onMergedChange }) {
  const [running, setRunning] = useState(null) // null | 'all' | '<code>'
  const [prog, setProg] = useState(null) // { processed, total } — padded Leads
  const [report, setReport] = useState(null) // { counts }
  const [error, setError] = useState(null)
  const [done, setDone] = useState(() => new Set(readMerged())) // codes fully merged (persisted)
  const [mergedIds, setMergedIds] = useState(() => new Set()) // padded ids merged this session
  const [failed, setFailed] = useState(() => new Map()) // padded id -> last failure
  const [page, setPage] = useState(0)

  const pending = duplicates.filter((d) => !done.has(d.code))

  // Report merged-set count (for THIS sheet) up so the parent's "Duplicate IDs"
  // KPI can shrink, and persist the merged codes so they never reappear.
  useEffect(() => {
    writeMerged([...done])
    onMergedChange?.(duplicates.filter((d) => done.has(d.code)).length)
  }, [done, duplicates]) // eslint-disable-line react-hooks/exhaustive-deps

  // The "✓ merged" marks live in the BROWSER (localStorage), not on the server, so
  // they survive refreshes — but they also go stale if the data/server changes
  // (e.g. duplicates re-appear, or a fresh backend). This clears them so every set
  // is offered for merging again; re-merging is safe (already-gone sets are skipped).
  const resetMerged = () => {
    if (done.size === 0) return
    if (!window.confirm(
      `Re-enable all ${duplicates.length} duplicate set(s) for merging again?\n\n` +
      `This only clears the "✓ merged" marks stored in this browser — it doesn't undo any ` +
      `merge. Use it when the sets are actually still duplicated on the server (e.g. a new server).`,
    )) return
    setDone(new Set()); setMergedIds(new Set()); setFailed(new Map())
    setReport(null); setError(null); setProg(null)
  }

  const confirmText = (sets, pairCount) =>
    `MERGE ${sets.length === 1
      ? `${sets[0].remove.join(', ')} → ${sets[0].keep}`
      : `${pairCount} padded Lead(s) across ${sets.length} duplicate set(s) into their clean twin`}?\n\n` +
    `The clean Lead is first backfilled from the padded one (blank fields + missing role ` +
    `profiles only — nothing it already has is overwritten).\n\n` +
    `Then ERPNext runs its native rename-with-merge: every Contact, Address, Comment and link ` +
    `pointing at the padded id is re-pointed at the clean id, and the padded id stops existing.\n\n` +
    `This is a live, irreversible write to the connected CRM.`

  // Flatten the picked sets to {padded, clean} pairs and drive the offset loop,
  // folding each batch's results into state as it lands so the list updates while
  // the run is still going. A set is only marked ✓ once EVERY padded id in it merged.
  const runMerge = async (sets) => {
    const pairs = sets.flatMap((d) => d.remove.map((padded) => ({ padded, clean: d.keep })))
    if (pairs.length === 0) return
    const total = pairs.length
    const counts = { merged: 0, alreadyGone: 0, errors: 0, fieldsFilled: 0, rolesAdded: 0, unverified: 0 }
    const ok = new Set(mergedIds)
    const bad = new Map(failed)
    setError(null); setProg({ processed: 0, total }); setReport({ counts: { ...counts } })

    let offset = 0
    while (offset < total) {
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await mergePaddedBatch({ pairs, offset, batchSize: BATCH, backfill: true })
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
        if (r.ok) { ok.add(r.padded); bad.delete(r.padded) }
        else bad.set(r.padded, r)
      }
      setMergedIds(new Set(ok)); setFailed(new Map(bad))
      const finished = sets.filter((d) => d.remove.every((n) => ok.has(n))).map((d) => d.code)
      if (finished.length) setDone((s) => new Set([...s, ...finished]))
      setProg({ processed: Math.min(offset + BATCH, total), total })
      setReport({ counts: { ...counts } })
      offset = out.nextOffset == null ? total : out.nextOffset
    }
  }

  const mergeAll = async () => {
    if (running || pending.length === 0) return
    const pairCount = pending.reduce((n, d) => n + d.remove.length, 0)
    if (!window.confirm(confirmText(pending, pairCount))) return
    setRunning('all'); setReport(null)
    try { await runMerge(pending) } finally { setRunning(null) }
  }

  const mergeOne = async (d) => {
    if (running) return
    if (!window.confirm(confirmText([d], d.remove.length))) return
    setRunning(d.code)
    try { await runMerge([d]) } finally { setRunning(null) }
  }

  const c = report?.counts
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0
  const pages = Math.max(1, Math.ceil(duplicates.length / DUP_PAGE))
  const p = Math.min(page, pages - 1)
  const pageDupes = duplicates.slice(p * DUP_PAGE, p * DUP_PAGE + DUP_PAGE)
  const failures = [...failed.values()]

  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          Duplicate IDs in UAT ({duplicates.length}){pending.length < duplicates.length && ` · ${duplicates.length - pending.length} merged`}
        </span>
        <div className="filterbar__spacer" />
        {duplicates.length > 0 && (
          <>
            <button className="export-btn" onClick={onExport}><IconDownload width={15} height={15} /> Export duplicates</button>
            {done.size > 0 && (
              <button
                className="export-btn"
                onClick={resetMerged}
                disabled={running != null}
                title="Clear the ✓ merged marks (stored in this browser) and re-enable every set for merging — e.g. after switching to a fresh server or if the duplicates re-appeared"
              >
                ↻ Merge all again
              </button>
            )}
            <button className="btn btn--ready" onClick={mergeAll} disabled={running != null || pending.length === 0}>
              {running === 'all' ? 'Merging…' : `Merge 0-series → clean (${pending.length})`}
            </button>
          </>
        )}
      </div>

      {prog && (
        <div style={{ padding: '0 8px 8px' }}>
          <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,.25)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
          </div>
          <p className="card__hint" style={{ margin: '6px 0 0' }}>
            {running ? 'Merging' : 'Done'} — {prog.processed}/{prog.total} padded Lead(s) ({pct}%)
          </p>
        </div>
      )}

      {c && (
        <p className="card__hint" style={{ padding: '0 8px 8px' }}>
          Merged <b>{c.merged}</b> padded Lead(s) into their clean twin · <b>{c.fieldsFilled}</b> field(s)
          backfilled · <b>{c.rolesAdded}</b> role row(s) added
          {c.alreadyGone ? <> · {c.alreadyGone} already merged (padded id gone)</> : ''}
          {c.unverified ? <> · <span className="sev-error">{c.unverified} still resolve under the padded id</span></> : ''}
          {c.errors ? <> · <span className="sev-error">{c.errors} failed</span></> : ''}.
          <br />The padded ids no longer exist — their Contacts, Addresses and links now hang off the clean Lead.
        </p>
      )}
      {error && <p className="reviewbox__msg err" style={{ margin: '0 8px 8px' }}>Error: {error}</p>}

      {duplicates.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>No duplicate IDs among this sheet's codes. ✅</p>
      ) : (
        <div className="dup-list">
          {pageDupes.map((d) => {
            const isDone = done.has(d.code)
            const bad = d.remove.map((n) => failed.get(n)).find(Boolean)
            return (
              <div className="dup-item" key={d.code} style={isDone ? { opacity: 0.55 } : undefined}>
                <span className="code">{d.code}</span>
                <span className="dup-keep">keep <b>{d.keep}</b></span>
                <span className="dup-remove">merge {d.remove.map((n) => <code key={n}>{n}</code>)}</span>
                <span className={`review-chip ${d.kind === 'has_clean_form' ? 'ready' : 'error'}`}>{d.kind === 'has_clean_form' ? 'padded duplicate' : 'no clean form'}</span>
                {bad && !isDone && <span className="sev-error">✕ {bad.stage || 'merge'}: {bad.error}</span>}
                <div className="filterbar__spacer" />
                {isDone ? (
                  <span className="review-chip ready">✓ merged</span>
                ) : (
                  <button
                    className="btn btn--ready"
                    style={{ padding: '2px 10px', fontSize: 12 }}
                    disabled={running != null || d.kind !== 'has_clean_form'}
                    title={d.kind !== 'has_clean_form' ? 'No clean DR-<code> form to keep — resolve manually' : `Rename+merge ${d.remove.join(', ')} into ${d.keep} — the padded id stops existing`}
                    onClick={() => mergeOne(d)}
                  >
                    {running === d.code ? '…' : bad ? 'Retry' : 'Merge'}
                  </button>
                )}
              </div>
            )
          })}
          {pages > 1 && (
            <div className="rc-pager">
              <button disabled={p === 0 || running != null} onClick={() => setPage(p - 1)}>← Prev</button>
              <span>Page {p + 1} of {pages} · {duplicates.length} sets · {DUP_PAGE}/page</span>
              <button disabled={p >= pages - 1 || running != null} onClick={() => setPage(p + 1)}>Next →</button>
            </div>
          )}
        </div>
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
  )
}
