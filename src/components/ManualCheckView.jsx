import { useMemo, useRef, useState } from 'react'
import { fetchLeadsByCode, submitReview } from '../data/source.js'
import ValidationView from './ValidationView.jsx'

// Parse a free-text list of Dr codes / IDs: split on space, comma, newline,
// semicolon; strip a leading "DR-"; drop blanks. Keeps the raw entry too.
const parseCodes = (text) =>
  [...new Set(
    String(text || '')
      .split(/[\s,;]+/)
      .map((t) => t.trim().replace(/^dr-?/i, ''))
      .filter(Boolean),
  )]

const stripKey = (c) => String(c).replace(/\D/g, '').replace(/^0+/, '')

// Validate specific doctors against UAT WITHOUT a sheet — type in the Dr codes,
// pull them live from ERPNext, and run the same validation dashboard.
export default function ManualCheckView({ live }) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | working | done | error
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [doctors, setDoctors] = useState(null) // array of fetched, mapped doctors
  const [requested, setRequested] = useState([]) // the codes asked for (stripped)
  const lastCodesRef = useRef([])

  const run = async (codes) => {
    if (codes.length === 0) { setError('Enter at least one Dr code or ID.'); setPhase('error'); return }
    lastCodesRef.current = codes
    setError(null); setPhase('working'); setDoctors(null)
    setRequested(codes.map(stripKey))
    setProgress({ done: 0, total: codes.length })
    try {
      const { doctors: byCode } = await fetchLeadsByCode(codes, {
        addresses: true,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setDoctors(Object.values(byCode))
      setPhase('done'); setProgress(null)
    } catch (err) {
      setError(err.message); setPhase('error'); setProgress(null)
    }
  }

  const onCheck = () => run(parseCodes(text))

  // Codes we asked for but UAT returned nothing → not-found list.
  const notFound = useMemo(() => {
    if (!doctors) return []
    const found = new Set(doctors.map((d) => stripKey(d.code || d.name)))
    return requested.filter((c) => !found.has(c))
  }, [doctors, requested])

  // Review write-back, then re-fetch the same codes so the new status shows.
  const handleReview = async (payload) => {
    const out = await submitReview({ ...payload, by: 'it@elbrit.org' })
    await run(lastCodesRef.current)
    return out
  }

  if (!live) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p className="card__hint" style={{ margin: 0 }}>
          Validation check needs the live ERPNext connection. Start the proxy
          (<code>npm run dev:all</code>) or set the Netlify environment variables, then reload.
        </p>
      </div>
    )
  }

  const working = phase === 'working'

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Validate by Dr code — no sheet needed</h3>
            <p className="card__hint" style={{ margin: 0 }}>
              Enter one or more <b>Dr codes</b> or <b>IDs</b> (e.g. <code>78031</code>, <code>DR-78031</code>,
              <code> 00078031</code>) separated by spaces, commas, or new lines. They're fetched live from ERPNext UAT
              and run through every validation check.
            </p>
          </div>
          <textarea
            className="mc-input"
            rows={3}
            placeholder="78031, DR-78032, 78033 …"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onCheck() }}
            style={{ width: '100%', resize: 'vertical', font: 'inherit', padding: 10, borderRadius: 8, border: '1px solid rgba(148,163,184,.4)' }}
          />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn--ready" onClick={onCheck} disabled={working || !text.trim()}>
              {working ? (progress ? `Fetching ${progress.done}/${progress.total}…` : 'Fetching…') : 'Check against UAT'}
            </button>
            {text.trim() && !working && (
              <button className="export-btn" onClick={() => { setText(''); setDoctors(null); setError(null); setPhase('idle') }}>Clear</button>
            )}
            {doctors && <span className="card__hint">Found {doctors.length} of {requested.length} in UAT.</span>}
          </div>
          {error && <p className="reviewbox__msg err" style={{ margin: 0 }}>Error: {error}</p>}
          {notFound.length > 0 && (
            <p className="card__hint" style={{ margin: 0 }}>
              ⚠️ Not found in UAT ({notFound.length}): {notFound.map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}
            </p>
          )}
        </div>
      </div>

      {doctors && doctors.length > 0 && (
        <ValidationView doctors={doctors} live={live} onReview={handleReview} />
      )}
      {doctors && doctors.length === 0 && (
        <div className="card"><p className="card__hint" style={{ padding: 16 }}>None of those codes exist in UAT.</p></div>
      )}
    </div>
  )
}
