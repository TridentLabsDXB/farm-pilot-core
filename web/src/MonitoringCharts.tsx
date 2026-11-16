import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ZoneView } from "./api";
import { downloadCsv, MAX_SERIES, type History, type Metric, type Range } from "./history";
import { Chip, dayMon, fmt, hhmm, tempUnit, tempVal, type Tone } from "./ui";

// 2026-11-16 -- CHARTS view of MONITORING: one chart card per zone, lines per sensor (calibrated) plus the zone average, legend toggles, tooltip, gaps (change request section 3).
// Hand written SVG (no library, nothing from the internet). Values come from /api/history in degC; the display unit is applied here only.
const DASH = ["", "7 4", "2 4", "9 4 2 4"];                 // beyond 4 series the dash style repeats with a new colour, so colour is never the only identifier
const COLORS = ["var(--fp-c1)", "var(--fp-c2)", "var(--fp-c3)", "var(--fp-c4)", "var(--fp-c5)", "var(--fp-c6)"];
const W = 640, H = 240, PL = 54, PR = 10, PT = 10, PB = 26;
const zoneTone = (z: ZoneView): [Tone, string] => z.status === "unknown" ? ["off", "UNKNOWN"] : z.status === "empty" ? ["off", "NO SENSORS"] : z.noUpdate ? ["warn", `${z.noUpdate} NO UPDATE`] : z.lowBattery ? ["warn", "LOW BATTERY"] : ["ok", "ONLINE"];
const conv = (metric: Metric, v: number) => (metric === "temperature" ? (tempVal(v) as number) : v);
const unitText = (m: Metric) => (m === "temperature" ? tempUnit() : "%RH");
const tFmt = (range: Range, ts: number) => (range === "1h" || range === "24h" ? hhmm(ts) : dayMon(ts));
const tipTime = (range: Range, ts: number) => (range === "1h" || range === "24h" ? hhmm(ts) : `${dayMon(ts)} ${hhmm(ts)}`);

/** Nearest non-null point at or before the cursor's neighbourhood; null when the nearest one is further than `tol` away (a gap). */
export function nearest(pts: [number, number | null][], t: number, tol: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [pt, v] of pts) if (v !== null && Math.abs(pt - t) <= tol && (!best || Math.abs(pt - t) < Math.abs(best[0] - t))) best = [pt, v];
  return best;
}

function ZoneChart({ z, metric, setMetric, range, refreshKey, onExportMsg }: { z: ZoneView; metric: Metric; setMetric: (m: Metric) => void; range: Range; refreshKey: number; onExportMsg: (m: string | null) => void }) {
  const [h, setH] = useState<History | null>(null); const [err, setErr] = useState<string | null>(null);
  const [off, setOff] = useState<Record<string, boolean>>({}); const [cur, setCur] = useState<number | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; setErr(null); api<History>(`/history?zone=${z.id}&metric=${metric}&range=${range}`).then((x) => { if (live) { setH(x); setOff((o) => { const n = { ...o }; x.sensors.forEach((s, i) => { if (!(s.key in n)) n[s.key] = i >= MAX_SERIES; }); return n; }); } }).catch((e) => live && setErr(e.message)); return () => { live = false; }; }, [z.id, metric, range, refreshKey]);
  const svg = useRef<SVGSVGElement>(null);
  const all = h ? [...h.sensors.map((s, i) => ({ id: s.key, label: s.label, status: s.status, pts: s.points, i, avg: false })), { id: "avg", label: "Zone average", status: "ok", pts: h.average.points, i: -1, avg: true }] : [];
  const shown = all.filter((s) => !off[s.id]);
  const hasData = all.some((s) => s.pts.some(([, v]) => v !== null));
  const dom = useMemo(() => {
    if (!h) return null; const vs = shown.flatMap((s) => s.pts.filter(([, v]) => v !== null).map(([, v]) => conv(metric, v as number)));
    if (!vs.length) return null; let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1) { lo -= 0.5; hi += 0.5; } const pad = (hi - lo) * 0.1; return { lo: lo - pad, hi: hi + pad };
  }, [h, off, metric]);   // eslint-disable-line react-hooks/exhaustive-deps
  const x = (t: number) => PL + ((t - h!.from) / Math.max(1, h!.to - h!.from)) * (W - PL - PR), y = (v: number) => H - PB - ((v - dom!.lo) / (dom!.hi - dom!.lo)) * (H - PB - PT);
  const path = (pts: [number, number | null][]) => { let d = "", pen = false; for (const [t, v] of pts) { if (v === null) { pen = false; continue; } d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(conv(metric, v)).toFixed(1)}`; pen = true; } return d; };
  const move = (clientX: number) => { const r = svg.current!.getBoundingClientRect(); const px = ((clientX - r.left) / r.width) * W; setCur(Math.min(h!.to, Math.max(h!.from, h!.from + ((px - PL) / (W - PL - PR)) * (h!.to - h!.from)))); };
  const tol = h ? Math.max(h.bucket_ms * 1.5, (h.to - h.from) / 60) : 0;
  const [tone, word] = zoneTone(z);
  const exp = async () => { setBusy(true); onExportMsg(await downloadCsv(z.id, range)); setBusy(false); };
  return (
    <section className="fp-card fp-chartcard" aria-label={`${z.name} chart`} data-testid="zone-chart">
      <div className="fp-row fp-spread"><div className="fp-row"><h3>{z.name}</h3><Chip tone={tone}>{word}</Chip></div><div className="fp-row"><div className="fp-seg" role="group" aria-label="Metric">{(["temperature", "humidity"] as Metric[]).map((m) => <button key={m} className="fp-btn small" aria-pressed={metric === m} onClick={() => setMetric(m)}>{m.toUpperCase()}</button>)}</div><button className="fp-btn small" onClick={exp} disabled={busy || z.total === 0} title="Export this zone as CSV">EXPORT CSV</button></div></div>
      {z.total === 0 ? <div className="fp-inset fp-msg fp-muted">No sensors in this zone yet</div>
        : err ? <div className="fp-inset fp-msg err" role="alert">{err}</div>
        : !h ? <div className="fp-inset fp-msg fp-muted">Loading...</div>
        : !hasData || !dom ? <div className="fp-inset fp-msg fp-muted">No data in this range</div>
        : <>
          <svg ref={svg} className="fp-chart fp-hchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${z.name} ${metric}, ${shown.length} lines`} style={{ touchAction: "pan-y" }}
            onPointerMove={(e) => move(e.clientX)} onPointerDown={(e) => move(e.clientX)} onPointerLeave={(e) => e.pointerType === "mouse" && setCur(null)}>
            {[0, 1, 2, 3].map((i) => { const v = dom.lo + ((dom.hi - dom.lo) * i) / 3; return <g key={i}><line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--fp-border)" strokeWidth="1" /><text x={PL - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(metric === "humidity" ? 0 : 1)}</text></g>; })}
            {[0, 1, 2, 3].map((i) => { const t = h.from + ((h.to - h.from) * i) / 3; return <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>{tFmt(range, t)}</text>; })}
            <text x={PL} y={PT + 2} className="fp-unit">{unitText(metric)}</text>
            {shown.filter((s) => !s.avg).map((s) => <path key={s.id} d={path(s.pts)} fill="none" stroke={s.status === "no_update" || s.status === "no_data" ? "var(--fp-off)" : COLORS[s.i % COLORS.length]} strokeWidth="1.6" strokeDasharray={DASH[Math.floor(s.i / COLORS.length) % DASH.length] || undefined} />)}
            {shown.filter((s) => s.avg).map((s) => <path key={s.id} d={path(s.pts)} fill="none" stroke="var(--fp-text)" strokeWidth="3.2" strokeLinejoin="round" />)}
            {cur !== null && <line x1={x(cur)} x2={x(cur)} y1={PT} y2={H - PB} stroke="var(--fp-muted)" strokeWidth="1" strokeDasharray="3 3" />}
          </svg>
          {cur !== null && <div className="fp-tip" role="status" data-testid="chart-tooltip"><b>{tipTime(range, cur)}</b>{shown.map((s) => { const n = nearest(s.pts, cur, tol); return <span key={s.id}>{s.label}: <b className="fp-num">{n ? `${fmt(conv(metric, n[1]), metric === "humidity" ? 0 : 1)} ${unitText(metric)}` : "--"}</b></span>; })}</div>}
          <div className="fp-legend" role="group" aria-label="Lines">
            {all.map((s) => { const stale = s.status === "no_update" || s.status === "no_data";
              return <button key={s.id} className="fp-leg" aria-pressed={!off[s.id]} data-stale={stale ? 1 : 0} onClick={() => setOff((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                <svg width="26" height="10" aria-hidden><line x1="0" x2="26" y1="5" y2="5" stroke={s.avg ? "var(--fp-text)" : stale ? "var(--fp-off)" : COLORS[s.i % COLORS.length]} strokeWidth={s.avg ? 3.2 : 1.8} strokeDasharray={s.avg ? undefined : DASH[Math.floor(s.i / COLORS.length) % DASH.length] || undefined} /></svg>
                {s.label}{stale && <span className="fp-leg-w"> NO UPDATE</span>}{off[s.id] && <span className="fp-leg-w"> HIDDEN</span>}
              </button>; })}
          </div>
        </>}
    </section>
  );
}

export default function MonitoringCharts({ zones, range, now }: { zones: ZoneView[]; range: Range; now: number }) {
  const [metric, setMetric] = useState<Metric>("temperature"); const [key, setKey] = useState(0); const [stamp, setStamp] = useState(Date.now()); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => { setKey((k) => k + 1); setStamp(Date.now()); }, []);
  useEffect(() => { setStamp(Date.now()); }, [range]);          // each chart refetches by itself when the range changes; this only moves the 'updated' time
  useEffect(() => { const i = setInterval(refresh, 60_000); return () => clearInterval(i); }, [refresh]);       // automatic refresh every 60 s
  void now;
  const expAll = async () => { setBusy(true); setMsg(await downloadCsv("all", range)); setBusy(false); };
  return (
    <div className="fp-charts" data-testid="charts-view">
      <div className="fp-row fp-spread fp-chartbar">
        <span className="fp-meta">Calibrated values, zone average in bold</span>
        <div className="fp-row"><span className="fp-meta" data-testid="chart-updated">updated {hhmm(stamp)}</span><button className="fp-btn small" onClick={refresh} aria-label="Refresh charts">REFRESH</button><button className="fp-btn small" onClick={expAll} disabled={busy} data-testid="export-all">EXPORT CSV</button></div>
      </div>
      {msg && <p className="fp-msg err" role="alert" data-testid="export-error">{msg}</p>}
      {zones.map((z) => <ZoneChart key={z.id} z={z} metric={metric} setMetric={setMetric} range={range} refreshKey={key} onExportMsg={setMsg} />)}
      {!zones.length && <p className="fp-msg fp-muted">No zones yet. An Admin defines the farm structure in Settings.</p>}
    </div>
  );
}
