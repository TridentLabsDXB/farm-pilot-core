import { useState } from "react";
import { api, type Cmd, type Scada, type SensorView, type State, type ZoneView } from "./api";
import { Battery, Chip, Signal, StatusChip, ago, fmt, useNow, type Tone } from "./ui";

const ZONE_STATUS = (z: ZoneView): [Tone, string] => z.status === "unknown" ? ["off", "UNKNOWN"] : z.status === "empty" ? ["off", "NO SENSORS"] : z.noUpdate ? ["warn", `${z.noUpdate} NO UPDATE`] : z.lowBattery ? ["warn", "LOW BATTERY"] : ["ok", "ONLINE"];

function Row({ s, now }: { s: SensorView; now: number }) {
  const dim = s.status !== "ok" && s.status !== "low_battery"; const warn = s.status === "no_update" || s.status === "low_battery";
  return (
    <div className="fp-srow" data-warn={warn ? 1 : 0}>
      <span className="l">{s.label}</span><span className={`v ${dim ? "dim" : ""}`}>{fmt(s.temperature)} °C &nbsp;{fmt(s.humidity, 0)} %</span>
      <span className="m"><StatusChip status={s.status} /><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /><span>changed {ago(s.lastChange, now)}</span>{s.calDue && <Chip tone="warn">CAL DUE</Chip>}{s.checkSensor && <Chip tone="warn">CHECK SENSOR</Chip>}</span>
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
        <div className="fp-tile"><span className="fp-cap">Temperature</span><span className="fp-big" style={{ color: off ? "var(--fp-off)" : undefined }}>{off ? "--" : fmt(z.avgTemperature)}<small> °C</small></span></div>
        <div className="fp-tile"><span className="fp-cap">Humidity</span><span className="fp-big" style={{ color: off ? "var(--fp-off)" : undefined }}>{off ? "--" : fmt(z.avgHumidity, 0)}<small> %</small></span></div>
      </div>
      <span className="fp-cap" style={{ textTransform: "none", letterSpacing: ".04em" }}>{off ? "Gateway offline: values unknown" : note}</span>
      {z.sensors.map((s, i) => <Row key={i} s={s} now={now} />)}
    </section>
  );
}

const CMD_WORD: Record<Cmd["status"], string> = { sent: "SENT", confirmed: "CONFIRMED", timeout: "TIMEOUT" };
function PumpCard({ state, now, reload }: { state: State; now: number; reload: () => void }) {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const t = state.topics.find((x) => x.topic === `farmpilot/${state.farm}/water`); const st = t?.sensors.find((x) => x.key === "WPump1")?.readings.status;
  const fresh = !!t && now - t.ts <= 30_000; const look = !fresh || (st !== 0 && st !== 1) ? "nodata" : st === 1 ? "run" : "stopped";
  const last = state.commands.find((c) => c.pump === "pump1"); const pending = last?.status === "sent";
  const send = async (action: "on" | "off") => { setErr(""); setBusy(true); try { await api("/commands", { method: "POST", json: { pump: "pump1", action } }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); reload(); } };
  const tone: Tone = last?.status === "confirmed" ? "ok" : last?.status === "timeout" ? "alarm" : last?.status === "sent" ? "info" : "off";
  return (
    <section className="fp-card" aria-label="Pump 1">
      <div className="fp-row fp-spread"><h3>Pump 1</h3><Chip tone={look === "run" ? "ok" : "off"}>{look === "run" ? "PUMP ON" : look === "stopped" ? "PUMP OFF" : "NO DATA"}</Chip></div>
      <div className="fp-row"><button className="fp-btn go" style={{ flex: 1 }} disabled={busy || pending} aria-label="Start pump 1" onClick={() => send("on")}>Start</button>
        <button className="fp-btn stop" style={{ flex: 1 }} disabled={busy || pending} aria-label="Stop pump 1" onClick={() => send("off")}>Stop</button></div>
      <div className="fp-inset" aria-live="polite"><div className="fp-cap">Last command</div>
        {last ? <div className="fp-row" style={{ marginTop: 6 }}><Chip tone={tone}>{CMD_WORD[last.status]}</Chip><span className="fp-num" style={{ fontSize: 13 }}>{last.action.toUpperCase()} · {last.username} · {ago(last.created_at, now)}</span></div> : <div className="fp-num">--</div>}
        {last?.status === "timeout" && <p className="fp-msg">No acknowledgement from the controller{last.note ? ` (${last.note})` : ""}.</p>}
        {last?.status === "sent" && <p className="fp-msg">Waiting for the controller, up to {state.commandTimeoutSec} s.</p>}</div>
      {err && <p className="fp-msg err" role="alert">{err}</p>}
      <span className="fp-cap" style={{ textTransform: "none" }}>The PLC keeps its own logic; this panel only sends commands.</span>
    </section>
  );
}

export default function ScadaView({ state, scada, reload }: { state: State | null; scada: Scada | null; reload: () => void }) {
  const now = useNow(1000);
  if (!state || !scada) return <main className="fp-page"><p className="fp-msg">Loading...</p></main>;
  const worst = scada.alarms.slice(0, 2).map((a) => a.text).join(" · ");
  const tone = !scada.alarms.length ? "ok" : scada.alarms.some((a) => a.severity === "alarm") ? "alarm" : "warn";
  return (
    <main className="fp-page">
      <div className="fp-banner" data-tone={tone} role="status">{!scada.alarms.length ? <><span className="fp-lamp" style={{ width: 10, height: 10, background: "currentColor", borderRadius: "50%" }} />NO ACTIVE ALARMS</> : <><b>{scada.alarms.length} ACTIVE ALARM{scada.alarms.length > 1 ? "S" : ""}</b><span>{worst}</span></>}</div>
      <div className="fp-grid">
        {scada.zones.map((z) => <Zone key={z.id} z={z} now={now} />)}
        <PumpCard state={state} now={now} reload={reload} />
      </div>
      {!scada.zones.length && <p className="fp-msg fp-muted">No zones yet. An Admin defines the farm structure in Settings.</p>}
    </main>
  );
}
