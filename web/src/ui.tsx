import { useEffect, useState } from "react";
export const fmt = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "--" : v.toFixed(dp));
export const ago = (ts: number | null | undefined, now = Date.now()) => { if (!ts) return "--"; const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const dur = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} h` : sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);
export const dt = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "--");

export type Tone = "ok" | "warn" | "alarm" | "off" | "info";
export const Chip = ({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) => <span className="fp-chip" data-tone={tone} title={title}><span className="fp-lamp" aria-hidden />{children}</span>;
export const STATUS: Record<string, [Tone, string]> = { ok: ["ok", "OK"], no_update: ["warn", "NO UPDATE"], no_data: ["off", "NO DATA"], low_battery: ["warn", "LOW BATTERY"], unknown: ["off", "UNKNOWN"], not_sent: ["info", "NOT SENT"], empty: ["off", "NO SENSORS"] };
export const StatusChip = ({ status }: { status: string }) => { const [t, w] = STATUS[status] ?? ["off", status.toUpperCase()]; return <Chip tone={t}>{w}</Chip>; };
export const SYNC: Record<string, [Tone, string]> = { in_gateway: ["ok", "IN GATEWAY"], not_sent: ["info", "NOT SENT"], changed: ["warn", "CHANGED"] };

export const Battery = ({ v, low }: { v?: number; low: number }) => {
  const pct = v ? Math.max(0, Math.min(1, (v - 2.6) / (3.6 - 2.6))) : 0;     // icon fill only; the real value is always printed. Curve is illustrative until the battery type is confirmed.
  return <span className="fp-bat" style={{ color: v && v < low ? "var(--fp-warn)" : undefined }}><i><b style={{ width: `${pct * 100}%` }} /></i>{v ? `${v.toFixed(2)} V` : "--"}</span>;
};
export const Signal = ({ rssi, band }: { rssi?: number; band: string }) => {
  const n = band === "good" ? 4 : band === "weak" ? 2 : band === "poor" ? 1 : 0; const c = band === "good" ? "var(--fp-ok)" : band === "none" ? "var(--fp-off)" : "var(--fp-warn)";
  return <span className="fp-bat" style={{ color: c }} title={band}><span className="fp-bars" aria-hidden>{[5, 8, 11, 14].map((h, i) => <b key={i} data-on={i < n ? 1 : 0} style={{ height: h }} />)}</span>{rssi === undefined ? "--" : `${Math.round(rssi)} dBm`}<span className="fp-cap" style={{ color: "inherit" }}>{band === "none" ? "" : band.toUpperCase()}</span></span>;
};
export function useNow(ms = 1000) { const [n, setN] = useState(Date.now()); useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]); return n; }
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return <div className="fp-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="fp-card fp-dialog"><div className="fp-row fp-spread"><h3>{title}</h3><button className="fp-btn small" onClick={onClose} aria-label="Close">Close</button></div>{children}</div></div>;
}
export const errText = (e: any) => String(e?.message ?? e);
