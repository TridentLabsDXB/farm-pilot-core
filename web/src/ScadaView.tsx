import { useEffect, useState } from "react";
import { api, type Scada, type SensorView, type State, type ZoneView } from "./api";
import { go } from "./App";
import MonitoringCharts from "./MonitoringCharts";
import { effectiveRange, loadPref, monitoringQuery, parseMonitoringQuery, RANGES, rangeLocked, savePref, type Range, type ReportsMeta, type View } from "./history";
import ControlStatusLine from "./ControlStatusLine";
import type { ControlDevice } from "./control";
import { Battery, Chip, CommissioningBanner, Modal, Signal, StatusChip, ago, fmt, tempUnit, tempVal, useNow, type Tone } from "./ui";

const ZONE_STATUS = (z: ZoneView): [Tone, string] => z.status === "unknown" ? ["off", "UNKNOWN"] : z.status === "empty" ? ["off", "NO SENSORS"] : z.noUpdate ? ["warn", `${z.noUpdate} NO UPDATE`] : z.lowBattery ? ["warn", "LOW BATTERY"] : ["ok", "ONLINE"];

function Row({ s, now }: { s: SensorView; now: number }) {
  const dim = s.status !== "ok" && s.status !== "low_battery"; const warn = s.status === "no_update" || s.status === "low_battery";
  return (
    <div className="fp-srow" data-warn={warn ? 1 : 0}>
      <span className="l">{s.label}</span><span className={`v ${dim ? "dim" : ""}`}>{fmt(tempVal(s.temperature))} {tempUnit()} &nbsp;{fmt(s.humidity, 0)} %</span>
      <span className="m"><StatusChip status={s.status} />{!s.kind && <Battery v={s.voltage} level={s.batteryLevel} isLow={s.batteryLow} />}{!s.kind && <Signal rssi={s.rssi} band={s.rssiBand} />}<span>{s.kind ? "updated" : "changed"} {ago(s.lastChange, now)}</span>{s.calDue && <Chip tone="warn">CAL DUE</Chip>}{s.checkSensor && <Chip tone="warn">CHECK SENSOR</Chip>}</span>
    </div>
  );
}
function Zone({ z, now }: { z: ZoneView; now: number }) {
  const [tone, word] = ZONE_STATUS(z);
  const note = z.total === 0 ? "No sensors in this zone" : z.reporting === z.total ? `Average of ${z.reporting} sensor${z.reporting === 1 ? "" : "s"}` : `${z.reporting} of ${z.total} sensors reporting`;
  const off = z.status === "unknown";
  return (
    <section className="fp-card" aria-label={z.name}>
      <div className="fp-row fp-spread"><h3>{z.name}</h3><Chip tone={tone}>{word}</Chip></div>
      <div className="fp-tiles">
        <div className="fp-tile"><span className="fp-cap">Temperature</span><span className="fp-big" style={{ color: off ? "var(--fp-off)" : undefined }}>{off ? "--" : fmt(tempVal(z.avgTemperature))}<small> {tempUnit()}</small></span></div>
        <div className="fp-tile"><span className="fp-cap">Humidity</span><span className="fp-big" style={{ color: off ? "var(--fp-off)" : undefined }}>{off ? "--" : fmt(z.avgHumidity, 0)}<small> %</small></span></div>
      </div>
      <span className="fp-cap" style={{ textTransform: "none", letterSpacing: ".04em" }}>{off ? "Gateway offline: values unknown" : note}</span>
      {z.sensors.map((s, i) => <Row key={i} s={s} now={now} />)}
    </section>
  );
}

export default function ScadaView({ state, scada, control, controlError, onRetry, query }: { state: State | null; scada: Scada | null; control: ControlDevice[] | null; controlError: string | null; onRetry: () => void; query: string }) {
  const now = useNow(1000);
  // 2026-11-16 -- CARDS | CHARTS switch. The URL (#/monitoring?view=charts&range=24h) is the state; the last choice is remembered per browser only as a convenience (a bare #/monitoring uses it).
  // The licence range rule comes from /api/reports/meta, so a locked range is never offered and a URL asking for one falls back to 24H.
  const asked = query ? parseMonitoringQuery(query) : { view: (loadPref().view === "charts" ? "charts" : "cards") as View, range: (RANGES as string[]).includes(loadPref().range ?? "") ? (loadPref().range as Range) : "24h" as Range };
  const [meta, setMeta] = useState<ReportsMeta | null>(null);
  useEffect(() => { if (asked.view === "charts") api<ReportsMeta>("/reports/meta").then(setMeta).catch(() => setMeta(null)); }, [asked.view, scada?.now]);
  const view = asked.view, range = effectiveRange(asked.range, meta);
  const setUrl = (v: View, r: Range) => { savePref(v, r); go("/monitoring" + monitoringQuery(v, r)); };
  if (!state || !scada) return <main className="fp-page"><p className="fp-msg">Loading...</p></main>;
  // 2026-11-16 -- a zone card is a sensor view: a zone that is not a climate zone and has no sensors (e.g. "VFD Section # 1", type custom, made in Farm Structure for equipment) is not drawn.
  // The zone itself stays in the database and in Settings; it can still be given to a control device. Climate zones always show, even with no sensors yet.
  const zones = scada.zones.filter((z) => z.type === "climate" || z.total > 0);
  const worst = scada.alarms.slice(0, 2).map((a) => a.text).join(" · ");
  const tone = !scada.alarms.length ? "ok" : scada.alarms.some((a) => a.severity === "alarm") ? "alarm" : "warn";
  return (
    <main className="fp-page">
      {scada.commissioning?.on && <CommissioningBanner until={scada.commissioning.until} />}
      <div className="fp-banner" data-tone={tone} role="status">{!scada.alarms.length ? <><span className="fp-lamp" style={{ width: 10, height: 10, background: "currentColor", borderRadius: "50%" }} />NO ACTIVE ALARMS</> : <><b>{scada.alarms.length} ACTIVE ALARM{scada.alarms.length > 1 ? "S" : ""}</b><span>{worst}</span></>}</div>
      <ControlStatusLine devices={control} state={state} now={now} error={controlError} onRetry={onRetry} />
      <div className="fp-row fp-spread fp-viewbar">
        <div className="fp-seg" role="group" aria-label="View">{(["cards", "charts"] as View[]).map((v) => <button key={v} className="fp-btn" aria-pressed={view === v} onClick={() => setUrl(v, range)}>{v.toUpperCase()}</button>)}</div>
        {view === "charts" && <div className="fp-seg fp-ranges" role="group" aria-label="Range">{RANGES.map((r) => { const lock = rangeLocked(r, meta);
          return <button key={r} className="fp-btn" aria-pressed={range === r} disabled={lock} title={lock ? "PRO licence: longer ranges" : undefined} data-locked={lock ? 1 : 0} onClick={() => setUrl(view, r)}>{lock && <svg className="fp-lock" width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" /><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>}{r.toUpperCase()}{lock && <span className="fp-pro"> PRO</span>}</button>; })}</div>}
      </div>
      {view === "charts" ? <MonitoringCharts zones={zones} range={range} now={now} /> : <div className="fp-grid fp-grid-fill">
        {zones.map((z) => <Zone key={z.id} z={z} now={now} />)}
      </div>}
      {view === "cards" && !zones.length && <p className="fp-msg fp-muted">No zones yet. An Admin defines the farm structure in Settings.</p>}
    </main>
  );
}
