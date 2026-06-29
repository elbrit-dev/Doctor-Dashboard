import { IconClose } from './icons.jsx'
import { RULES } from '../validation/rules.js'
import { StatusPill } from './DoctorTable.jsx'
import ScoreRing from './ScoreRing.jsx'

// Slide-in panel: every check's pass/fail result + the FULL ERPNext field set.
export default function DoctorDrawer({ doctor, onClose }) {
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
            <Row k="Naming series" v={doctor.namingSeries} />
            <Row k="Doctor code" v={doctor.code} bad={!doctor.code} />
            <Row k="Salutation" v={doctor.salutation} />
            <Row k="First name" v={doctor.firstName} bad={!String(doctor.firstName).trim()} />
            <Row k="Lead name" v={doctor.leadName} bad={!String(doctor.leadName).trim()} />
            <Row k="Title" v={doctor.leadName.trim()} />
          </Group>

          <Group title="Classification">
            <Row k="Speciality" v={doctor.specialty} bad={!doctor.specialty} />
            <Row k="Legacy speciality" v={doctor.specialityLegacy} />
            <Row k="Qualification" v={doctor.qualification} bad={!doctor.qualification} />
            <Row k="Category" v={doctor.category} bad={!doctor.category} badText="not set" />
            <Row k="Status" v={doctor.status} />
            <Row k="Qualification status" v={doctor.qualificationStatus} />
            <Row k="Lead type" v={doctor.leadType || '—'} />
            <Row k="Request type" v={doctor.requestType || '—'} />
            <Row k="No. of employees" v={doctor.noOfEmployees} />
            <Row k="Annual revenue" v={doctor.annualRevenue} />
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

          <Group title={`Role profiles (${doctor.roleProfiles.length})`}>
            {doctor.roleProfiles.map((rp, i) => (
              <div key={i} className="rolecard">
                <div className="rolecard__role code">{rp.role}</div>
                <div className="rolecard__meta">
                  {rp.department}
                  <span className="muted">{' · '}{rp.hq}</span>
                </div>
              </div>
            ))}
          </Group>

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
