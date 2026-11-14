import { useEffect, useState } from "react";
import { api, type Cmd, type Sensor, type State } from "./api";

const fmt = (v: number | undefined, dp = 1) => (v === undefined || !Number.isFinite(v) ? "--" : v.toFixed(dp));
const age = (ts: number | undefined, now: number) => (ts ? (now - ts < 60_000 ? `${Math.max(0, Math.round((now - ts) / 1000))} s` : `${Math.round((now - ts) / 60_000)} min`) + " ago" : "--");
const STALE_MS = 30_000;

interface Well { label: string; metric: string; unit: string; dp: number; tone: "cyan" | "amber" | "humidity" }
function Zone({ title, topic, sensorKey, wells, state, now }: { title: string; topic: string; sensorKey: string; wells: Well[]; state: State; now: number }) {
  const t = state.topics.find((x) => x.topic === `farmpilot/${state.farm}/${topic}`);
  const s: Sensor | undefined = t?.sensors.find((x) => x.key === sensorKey);
  const stale = !t || now - t.ts > STALE_MS;
  return (
    <section className="core-card" aria-label={title}>
      <div className="core-head"><h3 className="core-name">{title}</h3>
        <span className="core-plate" data-state={stale ? "nodata" : "run"}><span className="core-lamp" /><span className="core-word">{stale ? "NO DATA" : "ONLINE"}</span></span></div>
      <div className="core-wells">{wells.map((w) => (
        <div className="core-well" key={w.metric}><span className="core-cap">{w.label}</span>
          <span className={`core-digits core-${stale ? "dim" : w.tone}`}>{stale ? "--" : fmt(s?.readings[w.metric], w.dp)}<small>{w.unit}</small></span></div>))}</div>
      <div className="core-foot">farmpilot/{state.farm}/{topic} · {age(t?.ts, now)}</div>
    </section>
  );
}

const CMD_WORD: Record<Cmd["status"], string> = { sent: "SENT", confirmed: "CONFIRMED", timeout: "TIMEOUT" };

function PumpCard({ state, now, reload }: { state: State; now: number; reload: () => void }) {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const t = state.topics.find((x) => x.topic === `farmpilot/${state.farm}/water`);
  const st = t?.sensors.find((x) => x.key === "WPump1")?.readings.status;
  const fresh = !!t && now - t.ts <= STALE_MS;
  const look = !fresh || (st !== 0 && st !== 1) ? "nodata" : st === 1 ? "run" : "stopped";
  const last = state.commands.find((c) => c.pump === "pump1");
  const pending = last?.status === "sent";
  const send = async (action: "on" | "off") => {
    setErr(""); setBusy(true);
    try { await api("/commands", { method: "POST", json: { pump: "pump1", action } }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); reload(); }
  };
  return (
    <section className="core-card" aria-label="Pump 1">
      <div className="core-head"><h3 className="core-name">PUMP 1</h3>
        <span className="core-plate" data-state={look}><span className="core-lamp" /><span className="core-word">{look === "run" ? "PUMP ON" : look === "stopped" ? "PUMP OFF" : "NO DATA"}</span></span></div>
      <div className="core-keys">
        <button className="core-key core-key-primary" disabled={busy || pending} aria-label="Start pump 1" onClick={() => send("on")}>Start</button>
        <button className="core-key core-key-danger" disabled={busy || pending} aria-label="Stop pump 1" onClick={() => send("off")}>Stop</button>
      </div>
      <div className="core-cmd" aria-live="polite" data-status={last?.status ?? "none"}>
        <span className="core-cap">Last command</span>
        {last ? <span className="core-cmdline"><span className="core-lamp" /><b>{CMD_WORD[last.status]}</b> {last.action.toUpperCase()} · {last.username} · {age(last.created_at, now)}</span> : <span className="core-cmdline">--</span>}
        {last?.status === "timeout" && <span className="core-msg">No acknowledgement from the controller{last.note ? ` (${last.note})` : ""}.</span>}
        {last?.status === "sent" && <span className="core-msg">Waiting for the controller, up to {state.commandTimeoutSec} s.</span>}
      </div>
      {err && <p className="core-msg" role="alert">{err}</p>}
      <div className="core-foot">The PLC keeps its own logic; this panel only sends commands.</div>
    </section>
  );
}

export default function ScadaView({ state, reload }: { state: State | null; reload: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  if (!state) return <main className="core-main"><p className="core-msg">Loading...</p></main>;
  return (
    <main className="core-main">
      <Zone title="AIR" topic="air" sensorKey="AIR1" state={state} now={now} wells={[
        { label: "Temperature", metric: "temp", unit: " °C", dp: 1, tone: "amber" }, { label: "Humidity", metric: "humidity", unit: " %", dp: 0, tone: "humidity" }, { label: "CO2", metric: "co2", unit: " ppm", dp: 0, tone: "cyan" }]} />
      <Zone title="SOIL" topic="soil" sensorKey="SOIL1" state={state} now={now} wells={[
        { label: "Moisture", metric: "moisture", unit: " %", dp: 0, tone: "humidity" }, { label: "Temperature", metric: "temp", unit: " °C", dp: 1, tone: "amber" }, { label: "EC", metric: "ec", unit: " mS", dp: 2, tone: "cyan" }]} />
      <Zone title="WATER" topic="water" sensorKey="WATER1" state={state} now={now} wells={[
        { label: "Tank level", metric: "level", unit: " %", dp: 0, tone: "cyan" }, { label: "pH", metric: "ph", unit: "", dp: 2, tone: "cyan" }, { label: "Flow", metric: "flow", unit: " L/min", dp: 1, tone: "cyan" }]} />
      <PumpCard state={state} now={now} reload={reload} />
    </main>
  );
}
