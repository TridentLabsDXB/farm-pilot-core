import { type Scada, type SensorView, type State, type ZoneView } from "./api";
import ControlStatusLine from "./ControlStatusLine";
import type { ControlDevice } from "./control";
import { Battery, Chip, CommissioningBanner, Modal, Signal, StatusChip, ago, fmt, tempUnit, tempVal, useNow, type Tone } from "./ui";

const ZONE_STATUS = (z: ZoneView): [Tone, string] => z.status === "unknown" ? ["off", "UNKNOWN"] : z.status === "empty" ? ["off", "NO SENSORS"] : z.noUpdate ? ["warn", `${z.noUpdate} NO UPDATE`] : z.lowBattery ? ["warn", "LOW BATTERY"] : ["ok", "ONLINE"];

function Row({ s, now }: { s: SensorView; now: number }) {
  const dim = s.status !== "ok" && s.status !== "low_battery"; const warn = s.status === "no_update" || s.status === "low_battery";
  return (
    <div className="fp-srow" data-warn={warn ? 1 : 0}>
      <span className="l">{s.label}</span><span className={`v ${dim ? "dim" : ""}`}>{fmt(tempVal(s.temperature))} {tempUnit()} &nbsp;{fmt(s.humidity, 0)} %</span>
      <span className="m"><StatusChip status={s.status} /><Battery v={s.voltage} level={s.batteryLevel} isLow={s.batteryLow} /><Signal rssi={s.rssi} band={s.rssiBand} /><span>changed {ago(s.lastChange, now)}</span>{s.calDue && <Chip tone="warn">CAL DUE</Chip>}{s.checkSensor && <Chip tone="warn">CHECK SENSOR</Chip>}</span>
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

export default function ScadaView({ state, scada, control, controlError, onRetry }: { state: State | null; scada: Scada | null; control: ControlDevice[] | null; controlError: string | null; onRetry: () => void }) {
  const now = useNow(1000);
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
      <div className="fp-grid fp-grid-fill">
        {zones.map((z) => <Zone key={z.id} z={z} now={now} />)}
      </div>
      {!zones.length && <p className="fp-msg fp-muted">No zones yet. An Admin defines the farm structure in Settings.</p>}
    </main>
  );
}
