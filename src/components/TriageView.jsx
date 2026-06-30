import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { parseSheet } from '../lib/parseSheet.js'
import { reconcileSheet } from '../data/source.js'
import { IconDownload } from './icons.jsx'

const CAP = 300 // max rows rendered per block; full data is in the export

export default function TriageView({ live }) {
  const fileRef = useRef(null)
  const [phase, setPhase] = useState('idle')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setError(null); setPhase('working'); setData(null)
    try {
      const { rows } = await parseSheet(file)
      const out = await reconcileSheet(rows.map((r) => r.raw))
      setData(out); setPhase('done')
    } catch (err) {
      setError(err.message); setPhase('error')
    }
  }

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
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} />
        </div>
        {fileName && <p className="rc-filename">{fileName}{phase === 'working' ? ' · matching against UAT…' : ''}</p>}
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

          <Block
            title={`To create — not in UAT (${data.counts.create})`}
            rows={data.create}
            cols={[['code', 'Dr Code'], ['name', 'Doctor'], ['empCode', 'Emp Code'], ['hq', 'HQ']]}
            onExport={() => exportRows(data.create, 'to-create')}
          />
          <Block
            title={`To update — already in UAT (${data.counts.update})`}
            rows={data.update}
            cols={[['code', 'Dr Code'], ['name', 'Doctor'], ['uatId', 'UAT Lead']]}
            onExport={() => exportRows(data.update, 'to-update')}
          />

          <div className="card">
            <div className="toolbar">
              <span className="section-label" style={{ margin: 0 }}>Duplicate IDs in UAT ({data.duplicates.length})</span>
              <div className="filterbar__spacer" />
              {data.duplicates.length > 0 && (
                <button className="export-btn" onClick={() => exportDupes(data.duplicates)}>
                  <IconDownload width={15} height={15} /> Export duplicates
                </button>
              )}
            </div>
            {data.duplicates.length === 0 ? (
              <p className="card__hint" style={{ padding: '4px 4px 8px' }}>No duplicate IDs among this sheet's codes. ✅</p>
            ) : (
              <div className="dup-list">
                {data.duplicates.slice(0, CAP).map((d) => (
                  <div className="dup-item" key={d.code}>
                    <span className="code">{d.code}</span>
                    <span className="dup-keep">keep <b>{d.keep}</b></span>
                    <span className="dup-remove">remove {d.remove.map((n) => <code key={n}>{n}</code>)}</span>
                    <span className={`review-chip ${d.kind === 'has_clean_form' ? 'ready' : 'error'}`}>{d.kind === 'has_clean_form' ? 'padded duplicate' : 'no clean form'}</span>
                  </div>
                ))}
                {data.duplicates.length > CAP && <p className="card__hint">Showing first {CAP} of {data.duplicates.length} — export for the full list.</p>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Block({ title, rows, cols, onExport }) {
  return (
    <div className="card">
      <div className="toolbar">
        <span className="section-label" style={{ margin: 0 }}>{title}</span>
        <div className="filterbar__spacer" />
        {rows.length > 0 && <button className="export-btn" onClick={onExport}><IconDownload width={15} height={15} /> Export</button>}
      </div>
      {rows.length === 0 ? (
        <p className="card__hint" style={{ padding: '4px 4px 8px' }}>None.</p>
      ) : (
        <div className="table-wrap">
          <table className="dt">
            <thead><tr>{cols.map(([, label]) => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, CAP).map((r, i) => (
                <tr key={r.code + i}>{cols.map(([key]) => <td key={key} className={key === 'code' || key === 'uatId' ? 'code' : ''}>{r[key] || '—'}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {rows.length > CAP && <p className="card__hint" style={{ padding: 8 }}>Showing first {CAP} of {rows.length} — export for the full list.</p>}
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
