import { useCallback, useEffect, useState } from "react";
import { api, type Scada } from "./api";
import { Chip, dt, errText, hhmm } from "./ui";

interface Ev { id: number; kind: string; source: string; severity: string; text: string; raised_at: number; cleared_at: number | null; acked_by: string | null; acked_at: number | null; clear_reason: string | null; last_data_at: number | null; unknown?: boolean; }
const REASON: Record<string, string> = { recovered: "RECOVERED", sensor_removed: "SENSOR REMOVED", other: "OTHER" };
const KIND: Record<string, string> = { gateway_offline: "GATEWAY OFFLINE", no_update: "NO UPDATE", low_battery: "LOW BATTERY", calibration_due: "CALIBRATION DUE" };
const span = (a: number, b: number) => { const m = Math.max(0, Math.round((b - a) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} d`; };

export default function Alarms({ scada }: { scada: Scada | null }) {
  const [who, setWho] = useState<Record<string, { name: string; role: string; phone: string }[]>>({}); useEffect(() => { api<typeof who>("/farm-contacts/alarm-view").then(setWho).catch(() => {}); }, []);
  const [ev, setEv] = useState<Ev[] | null>(null); const [err, setErr] = useState("");
  const load = useCallback(() => api<Ev[]>("/alarms/history?limit=100").then(setEv).catch((e) => setErr(errText(e))), []);
  useEffect(() => { load(); }, [load, scada?.now, scada?.alarms.length]);
  if (!scada || !ev) return <main className="fp-page"><p className="fp-msg">{err || "Loading..."}</p></main>;
  const active = ev.filter((e) => e.cleared_at === null), past = ev.filter((e) => e.cleared_at !== null);
  const ack = (id: number) => api(`/alarms/${id}/ack`, { method: "POST" }).then(load).catch((e) => setErr(errText(e)));
  return (
    <main className="fp-page">
      <section className="fp-card"><h3>Active alarms</h3>
        {!active.length ? <Chip tone="ok">NO ACTIVE ALARMS</Chip> : <ul className="fp-list">{active.map((a) => (
          <li key={a.id}><span className="fp-row"><Chip tone={a.severity === "alarm" ? "alarm" : "warn"}>{KIND[a.kind] ?? a.kind}</Chip><span style={{ fontFamily: "var(--fp-head)", fontSize: 16, fontWeight: 700 }}>{a.text}</span>{a.last_data_at && <span className="fp-muted">last data {dt(a.last_data_at)}</span>}{a.unknown && <Chip tone="off" title="The gateway is offline, so the sensor state cannot be checked. The alarm stays open until the gateway answers again.">STATUS UNKNOWN (GATEWAY OFFLINE)</Chip>}</span>
            {(who[a.kind] ?? []).length > 0 && <span className="fp-cap" style={{ textTransform: "none" }}>Who to inform: {who[a.kind].map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}${c.phone ? " " + c.phone : ""}`).join(", ")}</span>}
            <span className="fp-row"><span className="fp-muted">since {dt(a.raised_at)}</span>{a.acked_at ? <Chip tone="info">ACK {a.acked_by} {hhmm(a.acked_at)}</Chip> : <button className="fp-btn small" onClick={() => ack(a.id)}>Acknowledge</button>}</span></li>))}</ul>}
        {err && <p className="fp-msg err" role="alert">{err}</p>}</section>
      <section className="fp-card"><h3>Recent history</h3>
        {!past.length ? <p className="fp-msg fp-muted">No cleared alarms yet.</p> : <div className="fp-gt"><div className="fp-gr head" style={{ gridTemplateColumns: "150px minmax(160px,1fr) 150px 150px 80px 130px 140px", minWidth: 1010 }}><span>Type</span><span>Alarm</span><span>Raised</span><span>Cleared</span><span>Lasted</span><span>Reason</span><span>Acknowledged</span></div>
          {past.map((a) => <div key={a.id} className="fp-gr" style={{ gridTemplateColumns: "150px minmax(160px,1fr) 150px 150px 80px 130px 140px", minWidth: 1010 }}><span>{KIND[a.kind] ?? a.kind}</span><span className="stack"><span className="nm" style={{ fontWeight: 500, fontSize: 14 }}>{a.text}</span>{a.last_data_at && <span className="fp-muted">last data {dt(a.last_data_at)}</span>}</span><span>{dt(a.raised_at)}</span><span>{dt(a.cleared_at)}</span><span>{span(a.raised_at, a.cleared_at!)}</span><span>{a.clear_reason ? REASON[a.clear_reason] ?? a.clear_reason : "--"}</span><span>{a.acked_by ? `${a.acked_by} ${hhmm(a.acked_at!)}` : "--"}</span></div>)}</div>}
        <span className="fp-hint">Times are when CORE detected and cleared the alarm. While the gateway is offline sensor alarms are neither raised nor cleared: open ones show STATUS UNKNOWN. For NO UPDATE, "last data" is when the sensor's data last changed.</span></section>
    </main>
  );
}
