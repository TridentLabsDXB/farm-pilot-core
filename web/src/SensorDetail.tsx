import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Scada, type SensorView } from "./api";
import { go } from "./App";
import { Battery, Chip, Modal, Signal, StatusChip, SYNC, ago, dateOnly, dayMon, dt, dur, errText, fmt, hhmm, parseDate } from "./ui";
const addMonths = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.getTime(); };

interface Detail { sensor: SensorView | null; row: { serial: string; type: string; label: string; replacedBy: string | null; slot: number | null }; calibrations: any[]; active: Record<string, any>; limits: Record<string, { maxOffset: number; gainMin: number; gainMax: number }>;
  type: { presets: number[]; min: number; max: number; label: string } }
interface Trend { points: { ts: number; cal: number; raw: number | null }[]; markers: { ts: number; method: string }[] }
type Metric = "temperature" | "humidity";
const UNIT: Record<Metric, string> = { temperature: "°C", humidity: "%" };

function Chart({ t, metric, range }: { t: Trend; metric: Metric; range: string }) {
  const W = 640, H = 220, P = 34; const pts = t.points;
  if (pts.length < 2) return <div className="fp-inset fp-msg fp-muted">Not enough readings in this range yet.</div>;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts; const vals = pts.flatMap((p) => (p.raw === null ? [p.cal] : [p.cal, p.raw]));
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1) { lo -= 0.5; hi += 0.5; } const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const x = (ts: number) => P + ((ts - t0) / Math.max(1, t1 - t0)) * (W - P - 8), y = (v: number) => H - 22 - ((v - lo) / (hi - lo)) * (H - 22 - 10);
  const path = (f: (p: Trend["points"][0]) => number | null) => pts.map((p) => ({ ts: p.ts, v: f(p) })).filter((p) => p.v !== null).map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.v as number).toFixed(1)}`).join("");
  const fmtT = (ts: number) => range === "24h" ? hhmm(ts) : dayMon(ts);
  return (
    <svg className="fp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric} trend, calibrated solid line, raw dashed line`}>
      {[0, 1, 2, 3].map((i) => { const v = lo + ((hi - lo) * i) / 3; return <g key={i}><line x1={P} x2={W - 8} y1={y(v)} y2={y(v)} stroke="var(--fp-border)" strokeWidth="1" /><text x={4} y={y(v) + 3}>{v.toFixed(1)}</text></g>; })}
      <text x={P} y={H - 6}>{fmtT(t0)}</text><text x={W - 8} y={H - 6} textAnchor="end">{fmtT(t1)}</text>
      <path d={path((p) => p.raw)} fill="none" stroke="var(--fp-muted)" strokeWidth="1.5" strokeDasharray="5 4" />
      <path d={path((p) => p.cal)} fill="none" stroke="var(--fp-accent)" strokeWidth="2" />
      {t.markers.filter((m) => m.ts >= t0 && m.ts <= t1).map((m, i) => <g key={i}><line x1={x(m.ts)} x2={x(m.ts)} y1={8} y2={H - 22} stroke="var(--fp-warn)" strokeWidth="1.5" /><text x={x(m.ts) + 3} y={18} style={{ fill: "var(--fp-warn)" }}>CAL</text></g>)}
    </svg>
  );
}

export default function SensorDetail({ serial, focus, scada, reload }: { serial: string; focus?: string; scada: Scada | null; reload: () => void }) {
  const calRef = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<Detail | null>(null); const [metric, setMetric] = useState<Metric>("temperature"); const [range, setRange] = useState("24h"); const [trend, setTrend] = useState<Trend | null>(null);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null); const [zones, setZones] = useState<{ id: number; name: string }[]>([]);
  const load = useCallback(() => { api<Detail>(`/sensors/${serial}`).then(setD).catch((e) => setMsg({ t: "err", s: errText(e) })); }, [serial]);
  useEffect(() => { load(); api<any>("/structure").then((s) => setZones(s.zones)).catch(() => {}); }, [load, scada?.now]);
  useEffect(() => { api<Trend>(`/sensors/${serial}/trend?metric=${metric}&range=${range}`).then(setTrend).catch(() => setTrend(null)); }, [serial, metric, range, scada?.now]);
  // Arriving from the CALIBRATE button on the sensor list scrolls straight to the calibration wizard.
  useEffect(() => { if (focus === "calibrate" && d?.sensor) calRef.current?.scrollIntoView({ block: "start" }); }, [focus, !!d?.sensor]);
  if (!d) return <section className="fp-card"><button className="fp-btn small" onClick={() => go("/settings/sensors")}>Back to sensors</button><p className="fp-msg">{msg?.s ?? "Loading..."}</p></section>;
  const s = d.sensor; const act = d.active[metric]; const raw = s?.raw?.[metric]; const cal = s?.[metric];
  return (<>
    <section className="fp-card">
      <div className="fp-row fp-spread"><button className="fp-btn small" onClick={() => go("/settings/sensors")}>← Sensors</button>{s && <span className="fp-row"><StatusChip status={s.status} /><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip></span>}</div>
      <div className="fp-row fp-spread"><div><h3>{d.row.label || serial}</h3><span className="fp-cap">{d.type.label} · slot {d.row.slot ?? "--"}{d.row.label ? ` · ${serial}` : ""}{d.row.replacedBy ? ` · replaced by ${d.row.replacedBy}` : ""}</span></div>
        {s && <Identity serial={serial} label={d.row.label} zoneId={s.zoneId} zones={zones} onDone={() => { load(); reload(); }} onErr={(e) => setMsg({ t: "err", s: e })} />}</div>
      {msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}
      {!s && <p className="fp-msg fp-muted">This sensor was replaced. Its history stays available; it is no longer polled.</p>}
    </section>
    {s && <div className="fp-detail"><div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <section className="fp-card"><div className="fp-row" role="tablist">{(["temperature", "humidity"] as Metric[]).map((m) => <button key={m} className="fp-tab" aria-current={metric === m ? "page" : undefined} onClick={() => setMetric(m)}>{m}</button>)}</div>
        <div className="fp-tiles"><div className="fp-tile"><span className="fp-cap">{metric} (calibrated)</span><span className="fp-big">{fmt(cal, 1)}<small> {UNIT[metric]}</small></span><span className="fp-cap" style={{ textTransform: "none" }}>raw {fmt(raw, 1)}, correction {act ? `${act.gain !== 1 ? `×${act.gain} ` : ""}${act.offset >= 0 ? "+" : ""}${act.offset}` : "none (not calibrated)"}</span></div>
          <div className="fp-tile"><span className="fp-cap">Last change</span><span className="fp-big" style={{ fontSize: 22 }}>{ago(s.lastChange, scada?.now)}</span><span className="fp-cap" style={{ textTransform: "none" }}>offline after {dur(s.offlineAfterSec)}</span></div></div>
        <div className="fp-row">{["24h", "7d", "30d"].map((r) => <button key={r} className="fp-btn small" aria-pressed={range === r} style={range === r ? { borderColor: "var(--fp-accent)", color: "var(--fp-accent)" } : undefined} onClick={() => setRange(r)}>{r.toUpperCase()}</button>)}
          <span className="fp-cap" style={{ textTransform: "none" }}>solid = calibrated, dashed = raw, CAL = calibration change</span></div>
        {trend && <Chart t={trend} metric={metric} range={range} />}</section>
      <div className="fp-tiles" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        <div className="fp-tile"><span className="fp-cap">Battery</span><Battery v={s.voltage} low={s.lowVoltage} /><span className="fp-cap" style={{ textTransform: "none" }}>{s.voltage && s.voltage < s.lowVoltage ? "LOW" : "OK"}, warns below {s.lowVoltage.toFixed(2)} V</span></div>
        <div className="fp-tile"><span className="fp-cap">Signal</span><Signal rssi={s.rssi} band={s.rssiBand} /></div>
        <div className="fp-tile"><span className="fp-cap">Reporting interval</span><span className="fp-num" style={{ fontWeight: 700 }}>{dur(s.intervalSec)} {s.applying && <Chip tone="info">APPLYING</Chip>}{!s.intervalOk && <Chip tone="warn" title="Not in the allowed set; choose another on the sensor list.">NOT ALLOWED</Chip>}</span><span className="fp-cap" style={{ textTransform: "none" }}>offline after {dur(s.offlineAfterSec)}</span></div></div>
    </div>
    <div ref={calRef} style={{ scrollMarginTop: 88 }}><CalCard d={d} metric={metric} raw={raw} serial={serial} onDone={(m) => { setMsg({ t: "ok", s: m }); load(); reload(); }} onErr={(e) => setMsg({ t: "err", s: e })} /></div>
    </div>}
    {s && <Danger serial={serial} />}
  </>);
}

function Identity({ serial, label, zoneId, zones, onDone, onErr }: { serial: string; label: string; zoneId: number | null; zones: { id: number; name: string }[]; onDone: () => void; onErr: (e: string) => void }) {
  const [l, setL] = useState(label); useEffect(() => setL(label), [label]);
  const patch = (b: object) => api(`/sensors/${serial}`, { method: "PATCH", json: b }).then(onDone).catch((e) => onErr(errText(e)));
  return <div className="fp-row"><input className="fp-input" aria-label="Label" value={l} onChange={(e) => setL(e.target.value)} onBlur={() => l !== label && patch({ label: l })} placeholder="label" />
    <select className="fp-input" aria-label="Zone" value={zoneId ?? ""} onChange={(e) => patch({ zone_id: e.target.value ? Number(e.target.value) : null })}><option value="">No zone</option>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></div>;
}

function CalCard({ d, metric, raw, serial, onDone, onErr }: { d: Detail; metric: Metric; raw?: number; serial: string; onDone: (m: string) => void; onErr: (e: string) => void }) {
  const [mode, setMode] = useState<"offset" | "two_point" | "manual">("offset"); const [ref, setRef] = useState(""); const [raw2, setRaw2] = useState(""); const [ref2, setRef2] = useState(""); const [off, setOff] = useState(""); const [gain, setGain] = useState("1");
  const [due, setDue] = useState(""); const [ok, setOk] = useState(false); const [hist, setHist] = useState(false); const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { setRef(""); setOk(false); }, [metric]);
  const lim = d.limits[metric]; const act = d.active[metric]; const hist2 = d.calibrations.filter((c) => c.metric === metric);
  const calc = useMemo(() => {
    const n = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    if (mode === "offset") { const r = n(ref); return raw === undefined || r === null ? null : { offset: Math.round((r - raw) * 1000) / 1000, gain: 1 }; }
    if (mode === "two_point") { const a = n(ref), r2 = n(raw2), b = n(ref2); if (raw === undefined || a === null || r2 === null || b === null || Math.abs(r2 - raw) < 1e-9) return null; const g = (b - a) / (r2 - raw); return { gain: Math.round(g * 10000) / 10000, offset: Math.round((a - g * raw) * 1000) / 1000 }; }
    const o = n(off), g = n(gain); return o === null || g === null ? null : { offset: o, gain: g };
  }, [mode, ref, raw2, ref2, off, gain, raw]);
  const viol = calc ? [...(Math.abs(calc.offset) > lim.maxOffset ? [`offset ${calc.offset} is outside ±${lim.maxOffset}`] : []), ...(calc.gain < lim.gainMin || calc.gain > lim.gainMax ? [`gain ${calc.gain} is outside ${lim.gainMin}-${lim.gainMax}`] : [])] : [];
  const apply = () => {
    const dueAt = due.trim() ? parseDate(due) : null;
    const body: any = { metric, method: mode, dueAt, confirmOutOfLimits: ok };
    if (mode === "offset") Object.assign(body, { raw, reference: Number(ref) }); else if (mode === "two_point") Object.assign(body, { raw, reference: Number(ref), raw2: Number(raw2), reference2: Number(ref2) }); else Object.assign(body, { offset: Number(off), gain: Number(gain) });
    api(`/sensors/${serial}/calibrate`, { method: "POST", json: body }).then(() => { setRef(""); setOk(false); onDone("Calibration applied."); }).catch((e) => onErr(errText(e)));
  };
  return (
    <section className="fp-card"><h3>Calibration · {metric}</h3>
      <div className="fp-row">{([["offset", "Offset"], ["two_point", "Two-point"], ["manual", "Manual"]] as const).map(([k, l]) => <button key={k} className="fp-btn small" style={mode === k ? { borderColor: "var(--fp-accent)", color: "var(--fp-accent)" } : undefined} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}</div>
      <div className="fp-inset"><span className="fp-cap">1 · Raw reading now</span><div className="fp-big">{fmt(raw, 1)}<small> {UNIT[metric]}</small></div><span className="fp-cap" style={{ textTransform: "none" }}>current correction: {act ? `×${act.gain} ${act.offset >= 0 ? "+" : ""}${act.offset}` : "none"}</span></div>
      {mode === "offset" && <label className="fp-field"><span className="fp-cap">2 · Reference reading (trusted instrument)</span><input className="fp-input" inputMode="decimal" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. 22.9" /></label>}
      {mode === "two_point" && <div className="fp-field"><span className="fp-cap">2 · Two reference points (e.g. salt-solution test)</span>
        <div className="fp-row"><span className="fp-num">Point 1: raw {fmt(raw, 1)} →</span><input className="fp-input" style={{ width: 110 }} inputMode="decimal" aria-label="Reference 1" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="reference" /></div>
        <div className="fp-row"><span className="fp-cap">Point 2: raw</span><input className="fp-input" style={{ width: 90 }} inputMode="decimal" aria-label="Raw 2" value={raw2} onChange={(e) => setRaw2(e.target.value)} placeholder="raw" /><span>→</span><input className="fp-input" style={{ width: 110 }} inputMode="decimal" aria-label="Reference 2" value={ref2} onChange={(e) => setRef2(e.target.value)} placeholder="reference" /></div></div>}
      {mode === "manual" && <div className="fp-row"><label className="fp-field"><span className="fp-cap">Offset</span><input className="fp-input" inputMode="decimal" value={off} onChange={(e) => setOff(e.target.value)} /></label><label className="fp-field"><span className="fp-cap">Gain</span><input className="fp-input" inputMode="decimal" value={gain} onChange={(e) => setGain(e.target.value)} /></label></div>}
      <div className="fp-inset"><span className="fp-cap">3 · New correction</span>
        {calc ? <div className="fp-num" style={{ marginTop: 4 }}>{mode === "offset" && raw !== undefined ? `raw ${raw.toFixed(1)}, reference ${ref}, ` : ""}offset {calc.offset >= 0 ? "+" : ""}{calc.offset}{calc.gain !== 1 ? `, gain ${calc.gain}` : ""}</div> : <div className="fp-num fp-muted" style={{ marginTop: 4 }}>enter the values above</div>}
        {calc && (viol.length ? <div style={{ marginTop: 6 }}><Chip tone="alarm">OUTSIDE LIMIT</Chip><p className="fp-msg err">{viol.join("; ")}. The sensor will be flagged CHECK SENSOR.</p><label className="fp-row"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I understand, apply anyway</label></div> : <div style={{ marginTop: 6 }}><Chip tone="ok">WITHIN LIMIT ±{lim.maxOffset}</Chip></div>)}</div>
      <div className="fp-field"><span className="fp-cap">Calibration due date (optional)</span>
        <div className="fp-row"><input className="fp-input" style={{ width: 150 }} aria-label="Calibration due date" value={due} onChange={(e) => setDue(e.target.value)} placeholder="16 Nov 2026" />
          <button type="button" className="fp-btn small" onClick={() => setDue(dateOnly(addMonths(6)))}>+6 months</button><button type="button" className="fp-btn small" onClick={() => setDue(dateOnly(addMonths(12)))}>+1 year</button>{due && <button type="button" className="fp-btn small" onClick={() => setDue("")}>Clear</button>}</div>
        {due.trim() !== "" && parseDate(due) === null && <span className="fp-msg err">Use a date like 16 Nov 2026.</span>}</div>
      <div className="fp-row"><button className="fp-btn primary" disabled={!calc || (viol.length > 0 && !ok) || (due.trim() !== "" && parseDate(due) === null)} onClick={apply}>Apply calibration</button><button className="fp-btn" onClick={() => { setRef(""); setRaw2(""); setRef2(""); setOk(false); }}>Cancel</button></div>
      <span className="fp-cap" style={{ textTransform: "none" }}>{act ? `Calibrated ${dt(act.calibrated_at)} by ${act.calibrated_by}${act.due_at ? `, due ${dateOnly(act.due_at)}` : ""}` : "Not calibrated. The sensor shows raw values."}</span>
      <div className="fp-row"><button className="fp-btn small danger" disabled={!act} onClick={() => setConfirmReset(true)}>Reset to raw</button><button className="fp-btn small" onClick={() => setHist(!hist)}>History</button></div>
      {hist && <ul className="fp-list">{hist2.map((c) => <li key={c.id}><span>{dt(c.calibrated_at)} · {c.method}</span><span className="fp-muted">×{c.gain} {c.offset >= 0 ? "+" : ""}{c.offset} · {c.calibrated_by}{c.active ? " · ACTIVE" : ""}</span></li>)}{!hist2.length && <li className="fp-muted">No calibration yet.</li>}</ul>}
      {confirmReset && <Modal title="Reset to raw?" onClose={() => setConfirmReset(false)}><p className="fp-msg">The {metric} correction is removed. Past history is not rewritten.</p><div className="fp-row"><button className="fp-btn danger" onClick={() => { setConfirmReset(false); api(`/sensors/${serial}/calibrate/reset`, { method: "POST", json: { metric } }).then(() => onDone("Reset to raw.")).catch((e) => onErr(errText(e))); }}>Reset to raw</button><button className="fp-btn" onClick={() => setConfirmReset(false)}>Cancel</button></div></Modal>}
    </section>
  );
}

function Danger({ serial }: { serial: string }) {
  const [mode, setMode] = useState<"" | "replace" | "remove">(""); const [ns, setNs] = useState(""); const [err, setErr] = useState("");
  return (<section className="fp-card"><h3>Replace or remove</h3>
    <p className="fp-msg">Replace moves label, zone and thresholds to the new serial. Calibration does NOT transfer: the new sensor starts uncalibrated. History stays on the old serial.</p>
    <div className="fp-row"><button className="fp-btn" onClick={() => setMode("replace")}>Replace sensor</button><button className="fp-btn danger" onClick={() => setMode("remove")}>Remove sensor</button></div>
    {mode && <Modal title={mode === "replace" ? "Replace sensor" : "Remove sensor"} onClose={() => setMode("")}>
      {mode === "replace" ? <label className="fp-field"><span className="fp-cap">Serial of the new sensor</span><input className="fp-input" value={ns} onChange={(e) => setNs(e.target.value)} placeholder="4A01B3FA" /></label> : <p className="fp-msg">{serial} leaves the registry. Its group is cleared in the gateway on the next SEND TO GATEWAY.</p>}
      {err && <p className="fp-msg err">{err}</p>}
      <div className="fp-row"><button className="fp-btn primary" onClick={() => (mode === "replace" ? api<{ newSerial: string }>(`/sensors/${serial}/replace`, { method: "POST", json: { newSerial: ns } }).then((r) => go(`/settings/sensors/${r.newSerial}`)) : api(`/sensors/${serial}`, { method: "DELETE" }).then(() => go("/settings/sensors"))).catch((e) => setErr(errText(e)))}>Confirm</button><button className="fp-btn" onClick={() => setMode("")}>Cancel</button></div></Modal>}
  </section>);
}
