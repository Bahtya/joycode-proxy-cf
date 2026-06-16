// Global timezone context. The backend stores UTC; the dashboard's configured
// `tz_offset` setting (default UTC+8) drives all local display. TzProvider
// fetches the setting once (mounted in the authenticated MainLayout) and exposes
// `off` (hours) + `formatTz(utcStr)` so every timestamp renders in the
// configured TZ instead of the browser's local TZ.

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api } from '@/api';

interface TzCtx {
  off: number; // UTC offset in hours (default 8)
  formatTz: (utcStr: string | null | undefined) => string;
}

const pad = (n: number) => String(n).padStart(2, '0');

const Ctx = createContext<TzCtx>({
  off: 8,
  formatTz: (t) => t ?? '-',
});

export function TzProvider({ children }: { children: ReactNode }) {
  const [off, setOff] = useState(8);
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const n = Number(s.tz_offset);
        if (Number.isFinite(n)) setOff(n);
      })
      .catch(() => {
        /* best-effort; fall back to default 8 */
      });
  }, []);

  const formatTz = useCallback(
    (t: string | null | undefined) => {
      if (!t) return '-';
      // Treat bare "YYYY-MM-DD HH:MM:SS" as UTC; leave ISO/Z/+ forms as-is.
      const d = new Date(t.includes('T') || t.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z');
      if (isNaN(d.getTime())) return t;
      const ld = new Date(d.getTime() + off * 3600000); // shift to configured TZ
      return `${ld.getUTCFullYear()}-${pad(ld.getUTCMonth() + 1)}-${pad(ld.getUTCDate())} ${pad(ld.getUTCHours())}:${pad(ld.getUTCMinutes())}:${pad(ld.getUTCSeconds())}`;
    },
    [off],
  );

  return <Ctx.Provider value={{ off, formatTz }}>{children}</Ctx.Provider>;
}

export function useTz(): TzCtx {
  return useContext(Ctx);
}
