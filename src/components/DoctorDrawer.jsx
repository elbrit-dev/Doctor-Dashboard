import { useState } from 'react'
import { IconClose } from './icons.jsx'
import { RULES } from '../validation/rules.js'
import { StatusPill } from './DoctorTable.jsx'
import ScoreRing from './ScoreRing.jsx'

// Slide-in panel: every check's pass/fail result + the FULL ERPNext field set.
export default function DoctorDrawer({ doctor, onClose, onReview }) {
  if (!doctor) return null
  const failedIds = new Set(doctor.issues.map((i) => i.ruleId))
  const failed = RULES.filter((r) => failedIds.has(r.id))
  const passed = RULES.filter((r) => !failedIds.has(r.id))
  const geoOk = hasGeo(doctor)
  const latLngJson = geoOk ? `{"x":${doctor.latitude},"y":${doctor.longitude}}` : (doctor.hasGeoJson ? '(set)' : null)

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Details for ${doctor.leadName}`}>
        <div className="drawer__head">
          <ScoreRing value={doctor.score} size={56} stroke={6} />
          <div style={{ flex: 1 }}>
            <h2 className="drawer__title">{doctor.leadName.trim()}</h2>
            <p className="drawer__sub">{doctor.name} · {doctor.specialty} · {doctor.qualification}</p>
            <div style={{ marginTop: 8 }}><StatusPill status={doctor.status} /></div>
          </div>
          <button className="drawer__close" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>

        <div className="drawer__body">
          {/* ---- CRM review (writes back to ERPNext) ---- */}
          {onReview && <ReviewBox doctor={doctor} onReview={onReview} />}

          {/* ---- checks needing attention ---- */}
          <div className="section-label">
            {failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} need attention` : 'All checks passed'}
          </div>
          {failed.map((r) => (
            <div className="check" key={r.id}>
              <span className={`check__icon ${r.severity}`}>{r.severity === 'error' ? '!' : r.severity === 'warning' ? '▲' : 'i'}</span>
              <div>
                <div className="check__label">{r.label}</div>
                <div className="check__fix">{r.fix}</div>
              </div>
            </div>
          ))}

          {/* ---- full field set ---- */}
          <Group title="Identity">
            <Row k="ID (name)" v={doctor.name} mono />
            <Row k="Doctor code" v={doctor.code} bad={!doctor.code} />
            <Row k="Salutation" v={doctor.salutation} />
            <Row k="First name" v={doctor.firstName} bad={!String(doctor.firstName).trim()} />
            <Row k="Lead name" v={doctor.leadName} bad={!String(doctor.leadName).trim()} />
            <Row k="Title" v={doctor.leadName.trim()} />
          </Group>

          <Group title="Classification">
            <Row k="Speciality" v={doctor.specialty} bad={!doctor.specialty} />
            <Row k="Qualification" v={doctor.qualification} bad={!doctor.qualification} />
            <Row k="Category" v={doctor.category} bad={!doctor.category} badText="not set" />
            <Row k="Category 1" v={doctor.category1} />
            <Row k="Category 2" v={doctor.category2} />
            <Row k="Category 3" v={doctor.category3} />
          </Group>

          <Group title="Location & geo">
            <Row k="Territory" v={doctor.territory} bad={!doctor.territory} badText="missing" />
            <Row k="City" v={doctor.city} bad={!doctor.city} />
            <Row k="State" v={doctor.state} bad={!doctor.state} />
            <Row k="Country" v={doctor.country} />
            <Row k="Latitude" v={doctor.latitude} bad={!geoOk} />
            <Row k="Longitude" v={doctor.longitude} bad={!geoOk} />
            <Row k="Lat/long JSON" v={latLngJson} bad={!latLngJson} badText="missing" mono />
            <Row k="Address created" v={Number(doctor.addressCreated) === 1 ? 'Yes' : 'No'} warn={Number(doctor.addressCreated) !== 1} />
          </Group>

          <Group title="Contact">
            <Row k="Mobile" v={fmtPhone(doctor.mobile)} bad={!isRealPhone(doctor.mobile)} />
            <Row k="Phone" v={fmtPhone(doctor.phone)} bad={!isRealPhone(doctor.phone)} />
            <Row k="WhatsApp" v={fmtPhone(doctor.whatsapp)} bad={!isRealPhone(doctor.whatsapp)} />
          </Group>

          {(() => {
            const addresses = doctor.addresses && doctor.addresses.length
              ? doctor.addresses
              : doctor.addressName
                ? [{ name: doctor.addressName, title: doctor.addressTitle, type: doctor.addressType, line1: doctor.addressLine1, line2: doctor.addressLine2, city: doctor.addressCity, county: doctor.county, state: doctor.addressState, pincode: doctor.pincode, country: doctor.addressCountry, gstin: doctor.gstin, gstState: doctor.gstState, gstStateNumber: doctor.gstStateNumber }]
                : []
            if (addresses.length === 0) {
              return (
                <Group title="Address">
                  <Row k="Address" v={null} badText="no address record" warn />
                </Group>
              )
            }
            return addresses.map((a, i) => (
              <Group key={a.name || i} title={`Address ${i + 1}${a.type ? ` · ${a.type}` : ''}${addresses.length > 1 ? ` (of ${addresses.length})` : ''}`}>
                {a.title && <Row k="Title" v={a.title} />}
                <Row k="Address line 1" v={a.line1} />
                <Row k="Address line 2" v={a.line2} />
                <Row k="City" v={a.city} />
                <Row k="County" v={a.county} />
                <Row k="State" v={a.state} />
                <Row k="Pincode" v={a.pincode} />
                <Row k="Country" v={a.country} />
                <Row k="GSTIN" v={a.gstin} />
                <Row k="GST state" v={a.gstState ? `${a.gstState}${a.gstStateNumber ? ` (${a.gstStateNumber})` : ''}` : null} />
              </Group>
            ))
          })()}

          {/* Sales Team — the role-profile table from ERPNext */}
          <div className="section-label">Sales team · role profiles ({doctor.roleProfiles.length})</div>
          {doctor.roleProfiles.length === 0 ? (
            <p className="card__hint" style={{ margin: '0 0 4px' }}>No role profiles assigned.</p>
          ) : (
            <div className="rp-table">
              <div className="rp-table__head">
                <span>Role Profile</span><span>Department</span><span>HQ</span>
              </div>
              {doctor.roleProfiles.map((rp, i) => (
                <div className="rp-table__row" key={i}>
                  <span className="code">{rp.role || '—'}</span>
                  <span>{rp.department || '—'}</span>
                  <span>{rp.hq || '—'}</span>
                </div>
              ))}
            </div>
          )}

          <Group title="Company & audit">
            <Row k="Company" v={doctor.company} />
            <Row k="Language" v={doctor.language} />
            <Row k="Owner" v={doctor.owner} mono />
            <Row k="Modified by" v={doctor.modifiedBy} mono />
            <Row k="Created" v={doctor.creation} mono />
            <Row k="Last modified" v={doctor.modified} mono />
            <Row k="Doc status" v={doctor.docstatus === 0 ? 'Draft (0)' : doctor.docstatus} />
          </Group>

          {passed.length > 0 && (
            <>
              <div className="section-label">Passed checks ({passed.length})</div>
              {passed.map((r) => (
                <div className="check" key={r.id}>
                  <span className="check__icon pass">✓</span>
                  <div className="check__label">{r.label}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  )
}

// CRM review panel: mark Ready, or report Error with the dashboard's
// auto-detected issues (pre-ticked) plus an optional note. Submitting writes
// a comment onto the Lead's timeline in ERPNext.
function ReviewBox({ doctor, onReview }) {
  const detected = doctor.issues.map((i) => i.label)
  const [mode, setMode] = useState(null) // null | 'error'
  const [checked, setChecked] = useState(() => new Set(detected))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const review = doctor.review
  const toggle = (label) => setChecked((s) => {
    const n = new Set(s)
    n.has(label) ? n.delete(label) : n.add(label)
    return n
  })

  const submit = async (decision) => {
    setBusy(true); setMsg(null)
    try {
      await onReview({
        id: doctor.name,
        decision,
        issues: decision === 'error' ? [...checked] : [],
        note: note.trim(),
      })
      setMsg({ ok: true, text: decision === 'ready' ? 'Marked Ready in ERPNext ✓' : 'Error reported in ERPNext ✓' })
      setMode(null); setNote('')
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="reviewbox">
      <div className="reviewbox__head">
        <span className="section-label" style={{ margin: 0 }}>CRM review</span>
        {review?.decision && (
          <span className={`review-chip ${review.decision}`}>
            {review.decision === 'ready' ? '✅ Ready' : '⚠️ Error'}
            {review.at ? ` · ${review.at.slice(0, 16)}` : ''}
          </span>
        )}
      </div>
      {review?.text && <p className="reviewbox__last">Last: {review.text}</p>}

      {mode !== 'error' ? (
        <div className="reviewbox__actions">
          <button className="btn btn--ready" disabled={busy} onClick={() => submit('ready')}>
            {busy ? 'Saving…' : '✅ Mark Ready'}
          </button>
          <button className="btn btn--error" disabled={busy} onClick={() => setMode('error')}>
            ⚠️ Report Error
          </button>
        </div>
      ) : (
        <div className="reviewbox__form">
          <div className="reviewbox__hint">Select the issues (auto-detected from the dashboard):</div>
          {detected.length === 0 && <div className="reviewbox__hint">No issues auto-detected — add a note below.</div>}
          {detected.map((label) => (
            <label key={label} className="reviewbox__check">
              <input type="checkbox" checked={checked.has(label)} onChange={() => toggle(label)} />
              <span>{label}</span>
            </label>
          ))}
          <textarea
            className="reviewbox__note"
            placeholder="Short note for the CRM team (optional)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <div className="reviewbox__actions">
            <button className="btn btn--error" disabled={busy} onClick={() => submit('error')}>
              {busy ? 'Saving…' : 'Submit error to ERPNext'}
            </button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => { setMode(null); setMsg(null) }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`reviewbox__msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </div>
  )
}

function Group({ title, children }) {
  return (
    <>
      <div className="section-label">{title}</div>
      <dl className="kv">{children}</dl>
    </>
  )
}

function Row({ k, v, mono, bad, warn, badText, flag }) {
  const empty = v === null || v === undefined || v === ''
  const cls = bad ? 'sev-error' : warn ? 'sev-warning' : ''
  return (
    <>
      <dt>{k}</dt>
      <dd className={`${mono ? 'code' : ''} ${cls}`} style={cls ? { fontWeight: 600 } : undefined}>
        {empty ? (badText || '—') : String(v)}{flag}
      </dd>
    </>
  )
}

const hasGeo = (r) => r.latitude && r.longitude && Number(r.latitude) !== 0 && Number(r.longitude) !== 0
const isRealPhone = (v) => v && String(v).replace(/\D/g, '').length >= 10
const fmtPhone = (v) => (v == null ? null : isRealPhone(v) ? v : `"${v}" (placeholder)`)
