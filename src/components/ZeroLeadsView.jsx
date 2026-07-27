import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { fetchZeroLeads, deleteLeadsBatch } from '../data/source.js'
import { IconDownload } from './icons.jsx'

const PAGE = 40 // display + delete batch size
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A tab that lists every zero-padded Lead (name starts with "DR-0") — the padded
// duplicates — and lets you delete them in batches of 40, page by page. Delete
// cascades: linked Contacts/Addresses are removed first, then the Lead.
export default function ZeroLeadsView({ live }) {
  const [phase, setPhase] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [leads, setLeads] = useState([])            // [{name, code, leadName, territory}]
  const [deleted, setDeleted] = useState(() => new Set()) // names removed OK
  const [selected, setSelected] = useState(() => new Set())
  const [page, setPage] = useState(0)

  const [running, setRunning] = useState(false)
  const [prog, setProg] = useState(null)   // { processed, total }
  const [report, setReport] = useState(null) // { counts, errors }

  const load = async () => {
    setPhase('loading'); setError(null)
    try {
      const list = await fetchZeroLeads()
      setLeads(list); setDeleted(new Set()); setSelected(new Set()); setPage(0); setReport(null); setPhase('ready')
    } catch (err) {
      setError(err.message); setPhase('error')
    }
  }

  useEffect(() => { if (live && phase === 'idle') load() /* eslint-disable-next-line */ }, [live])

  // Leads still present (not yet deleted this session).
  const rows = useMemo(() => leads.filter((l) => !deleted.has(l.name)), [leads, deleted])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * PAGE, p * PAGE + PAGE)

  const selCount = [...selected].filter((n) => !deleted.has(n)).length
  const allNames = rows.map((l) => l.name)
  const allOn = allNames.length > 0 && allNames.every((n) => selected.has(n))
  const toggleAll = () => setSelected(() => (allOn ? new Set() : new Set(allNames)))
  const pageNames = pageRows.map((l) => l.name)
  const pageAllOn = pageNames.length > 0 && pageNames.every((n) => selected.has(n))
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev)
    if (pageAllOn) pageNames.forEach((x) => n.delete(x))
    else pageNames.forEach((x) => n.add(x))
    return n
  })
  const toggle = (name) => setSelected((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })

  const runDelete = async () => {
    const names = [...selected].filter((n) => !deleted.has(n))
    if (running || names.length === 0) return
    if (!window.confirm(
      `PERMANENTLY DELETE ${names.length} Lead(s) from ERPNext?\n\n` +
      `For each Lead, its linked Contact(s) and Address(es) are deleted first, then the ` +
      `Lead itself. This is a live, irreversible write to the connected CRM. Runs in ` +
      `batches of ${PAGE}; a Lead that can't be deleted (still linked) is reported and skipped.`,
    )) return

    const total = names.length
    const counts = { deleted: 0, errors: 0, contacts: 0, addresses: 0 }
    const errors = []
    const gone = new Set(deleted)
    setRunning(true); setReport({ counts: { ...counts }, errors }); setProg({ processed: 0, total })

    let offset = 0, processed = 0
    while (offset < names.length) {
      let out = null
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await deleteLeadsBatch({ names, offset, batchSize: PAGE })
        } catch (e) {
          // eslint-disable-next-line no-await-in-loop
          if (attempt < 2) await sleep(1200 * (attempt + 1)); else setError(e.message)
        }
      }
      if (!out) { // batch failed after retries — skip it, keep going
        processed = Math.min(offset + PAGE, total)
        setProg({ processed, total }); offset += PAGE; continue
      }
      for (const k in counts) counts[k] += out.counts?.[k] || 0
      for (const r of (out.results || [])) {
        if (r.ok) gone.add(r.name)
        else errors.push(r)
      }
      processed = Math.min(offset + PAGE, total)
      setDeleted(new Set(gone))
      setSelected((prev) => { const n = new Set(prev); for (const g of gone) n.delete(g); return n })
      setProg({ processed, total })
      setReport({ counts: { ...counts }, errors: [...errors] })
      offset += PAGE
    }
    setRunning(false)
  }

  const exportList = () => {
    const wb = XLSX.utils.book_new()
    const data = rows.map((l) => ({ 'Lead ID': l.name, 'Doctor Code': l.code, Doctor: l.leadName, 'HQ / Territory': l.territory }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'None' }]), 'Zero-padded IDs')
    XLSX.writeFile(wb, `zero-padded-leads-${new Date().toISOString().slice(0, 10)}.xlsx`)
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

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="rc-upload" style={{ alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Zero-padded Lead IDs</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Every Lead whose ID starts with <code>DR-0</code> (e.g. <code>DR-00006612</code>) — the padded
              duplicates. Select the ones to remove and <b>Delete</b> them; deletion removes each Lead's linked
              Contact(s) and Address(es) first, then the Lead. Processed in batches of {PAGE}.
            </p>
          </div>
          <button className="export-btn" onClick={load} disabled={phase === 'loading' || running} style={{ flexShrink: 0 }}>
            {phase === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error && <p className="reviewbox__msg err" style={{ marginTop: 10 }}>Error: {error}</p>}
      </div>

      {phase === 'ready' && (
        <div className="card">
          <div className="toolbar">
            <span className="section-label" style={{ margin: 0 }}>
              Zero-padded IDs ({rows.length}) · <b>{selCount} selected</b>
              {deleted.size > 0 ? ` · ${deleted.size} deleted` : ''}
            </span>
            <div className="filterbar__spacer" />
            {rows.length > 0 && <button className="export-btn" onClick={exportList}><IconDownload width={15} height={15} /> Export</button>}
            <button className="btn btn--error" disabled={running || selCount === 0} onClick={runDelete}>
              {running ? 'Deleting…' : `Delete selected · ${selCount}`}
            </button>
          </div>

          {prog && (
            <div style={{ padding: '0 8px 8px' }}>
              <div style={{ height: 10, borderRadius: 6, background: 'rgba(148,163,184,.25)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #2563eb)', transition: 'width .25s ease' }} />
              </div>
              <p className="card__hint" style={{ margin: '6px 0 0' }}>
                {running ? 'Deleting' : 'Done'} — {prog.processed}/{prog.total} ({pct}%)
              </p>
            </div>
          )}

          {c && (
            <p className="card__hint" style={{ padding: '0 8px 8px' }}>
              Deleted <b>{c.deleted}</b> Lead(s) · {c.contacts} contact(s) · {c.addresses} address(es) removed
              {c.errors ? <> · <span className="sev-error">{c.errors} could not be deleted</span></> : ''}.
            </p>
          )}

          {rows.length === 0 ? (
            <p className="card__hint" style={{ padding: '4px 8px 10px' }}>No zero-padded Lead IDs. ✅</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="dt">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>
                        <input type="checkbox" checked={pageAllOn} disabled={running} onChange={togglePage} title="Select this page" />
                      </th>
                      <th>Lead ID</th><th>Doctor Code</th><th>Doctor</th><th>HQ / Territory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((l) => (
                      <tr key={l.name} className={selected.has(l.name) ? 'is-selected' : ''}>
                        <td><input type="checkbox" checked={selected.has(l.name)} disabled={running} onChange={() => toggle(l.name)} /></td>
                        <td className="code">{l.name}</td>
                        <td className="code">{l.code || '—'}</td>
                        <td>{l.leadName || '—'}</td>
                        <td>{l.territory || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="rc-pager">
                <button disabled={p === 0 || running} onClick={() => setPage(p - 1)}>← Prev</button>
                <span>
                  Page {p + 1} of {pages} · {rows.length} IDs · {PAGE}/page
                  {' · '}<button disabled={running} onClick={toggleAll} style={{ background: 'none', border: 'none', color: 'var(--accent, #2563eb)', cursor: running ? 'default' : 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline' }}>{allOn ? 'Clear all' : `Select all ${rows.length}`}</button>
                </span>
                <button disabled={p >= pages - 1 || running} onClick={() => setPage(p + 1)}>Next →</button>
              </div>
            </>
          )}

          {report && report.errors.length > 0 && (
            <div className="table-wrap" style={{ margin: '0 4px 12px' }}>
              <div className="section-label" style={{ margin: '8px 0' }}>Could not delete ({report.errors.length})</div>
              <table className="dt">
                <thead><tr><th>Lead ID</th><th>HTTP</th><th>Detail</th></tr></thead>
                <tbody>
                  {report.errors.slice(0, 300).map((r, i) => (
                    <tr key={r.name + i}>
                      <td className="code">{r.name}</td><td>{r.status || '—'}</td>
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
