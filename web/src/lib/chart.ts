// Shared chart palette (recharts does not read CSS vars — pass these explicitly).
// Mirrors the index.css --chart-* tokens (green-accented).
export const CHART_COLORS = [
  'oklch(0.72 0.15 158)',
  'oklch(0.6 0.13 158)',
  'oklch(0.769 0.188 70.08)',
  'oklch(0.623 0.214 259.815)',
  'oklch(0.645 0.246 16.439)',
  'oklch(0.55 0.2 300)',
];

export function chartColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}
