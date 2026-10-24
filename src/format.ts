// Deterministic formatting — no locale-dependent Intl output, so column widths
// and test expectations are stable across machines.

/** 1234 → "1,234"; negatives and non-finite values pass through defensively. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(Math.round(value))
  let out = ""
  let s = String(abs)
  while (s.length > 3) {
    out = "," + s.slice(-3) + out
    s = s.slice(0, -3)
  }
  return sign + s + out
}

/** 1234 → "1.2k"; 0 → "0"; keeps 3 significant digits. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  if (abs < 1000) return sign + String(Math.round(abs))
  if (abs < 1_000_000) {
    const n = abs / 1000
    return sign + trimZeroes(n.toFixed(n >= 100 ? 0 : 1)) + "k"
  }
  if (abs < 1_000_000_000) {
    const n = abs / 1_000_000
    return sign + trimZeroes(n.toFixed(n >= 100 ? 0 : 1)) + "M"
  }
  const n = abs / 1_000_000_000
  return sign + trimZeroes(n.toFixed(n >= 100 ? 0 : 1)) + "B"
}

function trimZeroes(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

/**
 * Cost formatting that never fabricates precision:
 * - 0 renders as "$0" (genuinely free or genuinely zero)
 * - < $0.01 renders with 4 decimals ("$0.0012")
 * - otherwise 2–4 decimals, trailing zeroes trimmed
 * - non-finite → "—" (unknown)
 */
export function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  if (abs < 0.01) return sign + "$" + abs.toFixed(4)
  if (abs >= 100) return sign + "$" + abs.toFixed(0)
  const s = abs.toPrecision(4)
  return sign + "$" + trimZeroes(s.includes(".") ? s : s + ".0")
}

/** 82000 → "82.0k" tokens with compact formatting. */
export function formatTokens(value: number): string {
  return formatCompact(value)
}

/** HH:MM in local time for step rows. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  return `${h}:${m}`
}

export function formatRelative(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms)
  const min = Math.floor(delta / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/** "last 7 days" style label for the project-stats range. */
export function formatRange(from: number, to: number): string {
  const days = Math.round((to - from) / 86_400_000)
  if (days <= 1) return "today"
  if (days <= 2) return "last 2 days"
  if (days < 30) return `last ${days} days`
  if (days < 365) return `last ${Math.round(days / 30)} months`
  return `last ${Math.round(days / 365)} year${days >= 730 ? "s" : ""}`
}

/** Truncate in the middle so long model IDs keep both ends. */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  if (max < 5) return value.slice(0, max)
  const keep = max - 1 // 1 char for the ellipsis
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return value.slice(0, head) + "…" + value.slice(value.length - tail)
}
