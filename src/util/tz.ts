// Timezone-offset helpers. The DB stores created_at as UTC; day/hour boundaries
// and buckets are computed in the configured local TZ by shifting by `off` hours
// (SQLite minute modifiers also handle half-hour offsets like 5.5). Storage
// itself is never shifted — only boundaries, buckets, and display.

/** SQLite minute modifier for an hour offset, e.g. tzMin(8) -> '+480 minutes'. */
export function tzMin(off: number): string {
  const m = Math.round(off * 60);
  return (m >= 0 ? '+' : '-') + Math.abs(m) + ' minutes';
}

const inv = (mod: string): string => (mod.startsWith('+') ? '-' + mod.slice(1) : '+' + mod.slice(1));

/**
 * SQL expression for local-midnight (00:00 in TZ `off`) as a UTC instant:
 * shift now to local, truncate to midnight, shift back to UTC.
 * todayStartExpr(8) -> datetime('now','+480 minutes','start of day','-480 minutes')
 */
export function todayStartExpr(off: number): string {
  const m = tzMin(off);
  return `datetime('now', '${m}', 'start of day', '${inv(m)}')`;
}
