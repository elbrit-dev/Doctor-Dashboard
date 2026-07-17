import { useEffect, useState } from 'react'
import { loadDoctors } from './data/source.js'
import { IconShield } from './components/icons.jsx'
import TriageView from './components/TriageView.jsx'

export default function App() {
  // Lightweight connection probe — drives the Live/Snapshot badge and gates the
  // views that need the live ERPNext connection.
  const [conn, setConn] = useState({ mode: 'loading', fetchedAt: null, source: null })
  useEffect(() => {
    loadDoctors().then((f) => setConn({ mode: f.mode, fetchedAt: f.fetchedAt, source: f.source })).catch(() => setConn({ mode: 'snapshot' }))
  }, [])

  const live = conn.mode === 'live'

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <div className="logo"><IconShield width={24} height={24} /></div>
          <div>
            <h1>Doctor Data Validation</h1>
            <p className="header__sub">Pre-handoff quality review for the CRM team</p>
          </div>
        </div>
        <div className="header__meta">
          <ModeBadge mode={conn.mode} fetchedAt={conn.fetchedAt} source={conn.source} />
        </div>
      </header>

      <TriageView live={live} />
    </div>
  )
}

// Pull the host out of the source string ("ERPNext · https://uat.elbrit.org")
// so the badge names the site the app is actually connected to — never a guess.
function siteLabel(source) {
  const url = String(source || '').split('·').pop().trim()
  try { return new URL(url).host } catch { return url || 'ERPNext' }
}

function ModeBadge({ mode, fetchedAt, source }) {
  if (mode === 'live') {
    return <span className="env-badge"><span className="dot" />Live · {siteLabel(source)}</span>
  }
  if (mode === 'snapshot') {
    return <span className="env-badge"><span className="dot dot--amber" />Snapshot {fetchedAt || ''}</span>
  }
  return <span className="env-badge"><span className="dot dot--muted" />Connecting…</span>
}
