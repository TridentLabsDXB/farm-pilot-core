import { useEffect, useState } from "react";
export const fmt = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "--" : v.toFixed(dp));
export const ago = (ts: number | null | undefined, now = Date.now()) => { if (!ts) return "--"; const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const dur = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} h` : sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);
// 24-hour clock everywhere, dates like "16 Nov 2026 01:39". Built by hand so the browser locale can never switch to AM/PM.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; const p2 = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ts: number) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const dateOnly = (ts: number) => { const d = new Date(ts); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
export const dt = (ts: number | null | undefined) => (ts ? `${dateOnly(ts)} ${hhmm(ts)}` : "--");
/** Parses "16 Nov 2026" (also ISO 2026-11-16). Returns local noon of that day, or null. */
export const parseDate = (txt: string): number | null => {
  const t = txt.trim(); let y: number, m: number, d: number; let r = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(t);
  if (r) { d = +r[1]; y = +r[3]; m = MON.findIndex((x) => r![2].toLowerCase().startsWith(x.toLowerCase())); if (m < 0) return null; }
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) { y = +r[1]; m = +r[2] - 1; d = +r[3]; } else return null;
  const dte = new Date(y, m, d, 12); return dte.getFullYear() === y && dte.getMonth() === m && dte.getDate() === d ? dte.getTime() : null;
};
export const dayMon = (ts: number) => { const d = new Date(ts); return `${d.getDate()} ${MON[d.getMonth()]}`; };

export type Tone = "ok" | "warn" | "alarm" | "off" | "info";
export const Chip = ({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) => <span className="fp-chip" data-tone={tone} title={title}><span className="fp-lamp" aria-hidden />{children}</span>;
export const STATUS: Record<string, [Tone, string]> = { ok: ["ok", "OK"], no_update: ["warn", "NO UPDATE"], no_data: ["off", "NO DATA"], low_battery: ["warn", "LOW BATTERY"], unknown: ["off", "UNKNOWN"], not_sent: ["info", "NOT SENT"], empty: ["off", "NO SENSORS"] };
export const StatusChip = ({ status }: { status: string }) => { const [t, w] = STATUS[status] ?? ["off", status.toUpperCase()]; return <Chip tone={t}>{w}</Chip>; };
export const SYNC: Record<string, [Tone, string]> = { in_gateway: ["ok", "IN GATEWAY"], not_sent: ["info", "NOT SENT"], changed: ["warn", "CHANGED"] };

// Four-segment level icon. Scale: empty at (low-voltage threshold - 0.4 V), full at 3.60 V, so a sensor sitting just above the warning line shows ONE segment.
// The icon is a hint only: the voltage is always printed, and "LOW" is added as a word, in amber, below the threshold.
export const Battery = ({ v, low, level, isLow }: { v?: number; low?: number; level?: number; isLow?: boolean }) => {
  // Operators get level and isLow computed by the server (they never receive the threshold); Admin pages may pass the threshold instead.
  const bound = (low ?? 3.2) - 0.4; const pct = level ?? (v ? Math.max(0, Math.min(1, (v - bound) / (3.6 - bound))) : 0); const lowNow = isLow ?? (!!v && low !== undefined && v < low);
  const segs = v ? Math.max(1, Math.ceil(pct * 4)) : 0;
  return <span className="fp-bat" data-low={lowNow ? 1 : 0} title={v ? `${v.toFixed(2)} V${lowNow ? " (low)" : ""}` : "no reading"}><i aria-hidden>{[0, 1, 2, 3].map((k) => <b key={k} data-on={k < segs ? 1 : 0} />)}</i>{v ? `${v.toFixed(2)} V` : "--"}{lowNow && <span className="fp-cap" style={{ color: "inherit" }}>LOW</span>}</span>;
};
export const Signal = ({ rssi, band }: { rssi?: number; band: string }) => {
  const n = band === "good" ? 4 : band === "weak" ? 2 : band === "poor" ? 1 : 0; const c = band === "good" ? "var(--fp-ok)" : band === "none" ? "var(--fp-off)" : "var(--fp-warn)";
  return <span className="fp-bat fp-sig" style={{ color: c }} title={band}><span className="fp-bars" aria-hidden>{[5, 8, 11, 14].map((h, i) => <b key={i} data-on={i < n ? 1 : 0} style={{ height: h }} />)}</span>{rssi === undefined ? "--" : `${Math.round(rssi)} dBm`}<span className="fp-cap" style={{ color: "inherit" }}>{band === "none" ? "" : band.toUpperCase()}</span></span>;
};
export function useNow(ms = 1000) { const [n, setN] = useState(Date.now()); useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]); return n; }
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return <div className="fp-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="fp-card fp-dialog"><div className="fp-row fp-spread"><h3>{title}</h3><button className="fp-btn small" onClick={onClose} aria-label="Close">Close</button></div>{children}</div></div>;
}
export const errText = (e: any) => String(e?.message ?? e);

/** Shown while commissioning mode (short T/H intervals) is on; it switches itself off after 8 hours. */
export const CommissioningBanner = ({ until, onOff }: { until: number | null; onOff?: () => void }) => (
  <div className="fp-banner" data-tone="warn" role="status"><b>COMMISSIONING MODE ON</b><span>short intervals reduce battery life · switches off by itself at {until ? hhmm(until) : "--"}</span>{onOff && <button className="fp-btn small" onClick={onOff}>Switch off now</button>}</div>
);
