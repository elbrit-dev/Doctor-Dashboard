// Circular data-quality score gauge (pure SVG).
export default function ScoreRing({ value, size = 92, stroke = 9 }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, value))
  const dash = (pct / 100) * circ
  const color = pct >= 80 ? 'var(--ok)' : pct >= 55 ? 'var(--warning)' : 'var(--error)'
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${dash} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 0.6s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="ring__num" style={{ color }}>{pct}</div>
    </div>
  )
}
