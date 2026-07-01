import { useState } from 'react'
import { mergeDuplicatesBatch } from '../data/source.js'
import { IconDownload } from './icons.jsx'

const CAP = 300

// Duplicate IDs (same code stored as clean DR-<code> + padded DR-000<code>).
// Merge each padded Lead's addresses onto the clean one, then delete the padded
// Lead. Bulk "Merge & delete" drives the batched /api/merge-duplicates loop; a
// per-row button does a single set. Re-running is safe (already-gone = skipped).
export default function DuplicatesPanel({ duplicates, onExport }) {
  const [running, setRunning] = useState(null) // null | 'all' | '<code>'
  const [prog, setProg] = useState(null) // { processed, total }
  const [report, setReport] = useState(null) // { counts }
  const [error, setError] = useState(null)
  const [done, setDone] = useState(() => new Set()) // codes fully merged

  const pending = duplicates.filter((d) => !done.has(d.code))

  const applyResults = (results, acc) => {
    const nextDone = []
    for (const r of results) {
      if (r && r.ok && (!r.errors || r.errors.length === 0)) nextDone.push(r.code)
    }
    if (nextDone.length) setDone((s) => new Set([...s, ...nextDone]))
    return acc
  }

  const mergeAll = async () => {
    if (running || pending.length === 0) return
    if (!window.confirm(
      `Merge & delete ${pending.length} duplicate set(s)?\n\n` +
      `For each: the padded DR-000… Lead's addresses are moved onto the clean ` +
      `DR-<code> Lead, then the padded Lead is DELETED in ERPNext. This is live and ` +
      `not easily undone. Re-running is safe (already-merged sets are skipped).`,
    )) return

    setError(null); setRunning('all'); setReport(null)
    const total = pending.length
    setProg({ processed: 0, total })
    const counts = { sets: 0, removedLeads: 0, movedAddresses: 0, deletedAddresses: 0, errors: 0 }
    try {
      let offset = 0, processed = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        // Deletes are slow server-side (~15-25s each), so keep batches tiny to
        // stay under the serverless timeout; the loop just makes more calls.
        const out = await mergeDuplicatesBatch({ duplicates: pending, offset, batchSize: 2 })
        for (const k in counts) counts[k] += out.counts?.[k] || 0
        applyResults(out.results || [])
        processed += out.processed || 0
        setProg({ processed, total: out.total ?? total })
        setReport({ counts: { ...counts } })
        if (out.done || out.nextOffset == null) break
        offset = out.nextOffset
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(null)
    }
  }

  const mergeOne = async (d) => {
    if (running) return
    if (!window.confirm(`Merge & delete duplicate ${d.code}?\n\nMove addresses onto ${d.keep}, then delete ${d.remove.join(', ')} in ERPNext.`)) return
    setError(null); setRunning(d.code)
    try {
      const out = await mergeDuplicatesBatch({ duplicates: [d], batchSize: 1 })
      applyResults(out.results || [])
      const r = (out.results || [])[0]
      if (r && (!r.ok || r.errors?.length)) setError(`${d.code}: ${r.errors.join('; ')}`)
    } catch (err) {
      setError(`${d.code}: ${err.message}`)
    } finally {
      setRunning(null)
    }
  }

  const c = report?.counts
  const pct = prog && prog.total ? Math.round((prog.processed / prog.total) * 100) : 0

  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>
          Duplicate IDs in UAT ({duplicates.length}){done.size > 0 && ` · ${done.size} merged`}
        </span>
        <div className="filterbar__spacer" />
        {duplicates.length > 0 && (
          <>
            <button className="export-btn" onClick={onExport}><IconDownload width={15} height={15} /> Export duplicates</button>
            <button className="btn btn--error" onClick={mergeAll} disabled={running != null || pending.length === 0}>
              {running === 'all' ? 'Merging…' : `Merge & delete 0-series (${pending.length})`}
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
            {running ? 'Merging' : 'Done'} — {prog.processed}/{prog.total} sets ({pct}%)
          </p>
        </div>
      )}

      {c && (
        <p className="card__hint" style={{ padding: '0 8px 8px' }}>
          Deleted <b>{c.removedLeads}</b> padded Lead(s) · moved <b>{c.movedAddresses}</b> address(es) ·
          removed <b>{c.deletedAddresses}</b> redundant address(es){c.errors ? <> · <span className="sev-error">{c.errors} error(s)</span></> : ''}.
        </p>
      )}
      {error && <p className="reviewbox__msg err" style={{ margin: '0 8px 8px' }}>Error: {error}</p>}

      {duplicates.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>No duplicate IDs among this sheet's codes. ✅</p>
      ) : (
        <div className="dup-list">
          {duplicates.slice(0, CAP).map((d) => {
            const isDone = done.has(d.code)
            return (
              <div className="dup-item" key={d.code} style={isDone ? { opacity: 0.55 } : undefined}>
                <span className="code">{d.code}</span>
                <span className="dup-keep">keep <b>{d.keep}</b></span>
                <span className="dup-remove">remove {d.remove.map((n) => <code key={n}>{n}</code>)}</span>
                <span className={`review-chip ${d.kind === 'has_clean_form' ? 'ready' : 'error'}`}>{d.kind === 'has_clean_form' ? 'padded duplicate' : 'no clean form'}</span>
                <div className="filterbar__spacer" />
                {isDone ? (
                  <span className="review-chip ready">✓ merged</span>
                ) : (
                  <button
                    className="btn btn--error"
                    style={{ padding: '2px 10px', fontSize: 12 }}
                    disabled={running != null || d.kind !== 'has_clean_form'}
                    title={d.kind !== 'has_clean_form' ? 'No clean DR-<code> form to keep — resolve manually' : `Move addresses to ${d.keep} and delete ${d.remove.join(', ')}`}
                    onClick={() => mergeOne(d)}
                  >
                    {running === d.code ? '…' : 'Merge & delete'}
                  </button>
                )}
              </div>
            )
          })}
          {duplicates.length > CAP && <p className="card__hint">Showing first {CAP} of {duplicates.length}. "Merge &amp; delete 0-series" processes every set.</p>}
        </div>
      )}
    </div>
  )
}
