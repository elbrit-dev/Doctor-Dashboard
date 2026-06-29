// Minimal inline SVG icon set (no external dependency).
const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }

export const IconSearch = (p) => (<svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>)
export const IconClose = (p) => (<svg {...base} {...p}><path d="M18 6L6 18M6 6l12 12" /></svg>)
export const IconCheck = (p) => (<svg {...base} {...p}><path d="M20 6L9 17l-5-5" /></svg>)
export const IconShield = (p) => (<svg {...base} {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>)
export const IconAlert = (p) => (<svg {...base} {...p}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>)
export const IconInfo = (p) => (<svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>)
export const IconUsers = (p) => (<svg {...base} {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" /></svg>)
export const IconPin = (p) => (<svg {...base} {...p}><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>)
export const IconChevron = (p) => (<svg {...base} {...p}><path d="M9 18l6-6-6-6" /></svg>)
export const IconRefresh = (p) => (<svg {...base} {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>)
