import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, ago, errText, hhmm, useNow, type Tone } from "./ui";
import "./mqtt.css";

// Settings > MQTT PAYLOAD (Data sources, Admin only). Variant A of core-mqtt-payload-page.md (approved 2026-11-18): ONE scrolling page of cards, in this order:
// status banner, CONNECTION, SUBSCRIPTIONS, NEW DEVICES FOUND, PAYLOAD MAPPING, LATEST MESSAGES. CORE is a read-only client of the broker. The password is never sent to the browser:
// the field stays empty, "saved" only says one is stored; typing a new one replaces it, REMOVE clears it.
// The payload format is a PLACEHOLDER until the owner supplies the real one (src/mqtt/defaults.ts); this page does not depend on it.
type State = "connected" | "connecting" | "disconnected" | "disabled";
interface Rule { path: string; name: string; unit: string; scale: number | string; offset: number | string; }
interface View {
  config: { enabled: boolean; host: string; port: number; tls: boolean; client_id: string; username: string; keepalive: number; has_password: boolean; password_unreadable: boolean };
  status: { state: State; host: string; port: number; lastError: string | null; lastMessageAt: number | null; perMinute: number; connectedAt: number | null; nextRetryAt: number | null; attempt: number };
  topics: { id: number; filter: string; qos: number; count: number; lastAt: number | null }[];
  devices: { device_id: string; state: "new" | "added" | "ignored"; label: string; first_seen: number; last_seen: number; msg_count: number }[];
  mapping: { id_path: string; ts_path: string; rules: Rule[]; unmapped: { field: string; count: number }[]; errors: number };
  messages: { ts: number; topic: string; raw: string; status: "ok" | "unmapped" | "error"; device: string | null; notes: string[]; stored: boolean }[];
}
/** Lamp shape + word, never colour alone: CONNECTED circle, CONNECTING triangle, DISCONNECTED square, DISABLED ring. */
const LAMP: Record<State, { shape: string; word: string; tone: Tone }> = { connected: { shape: "circle", word: "CONNECTED", tone: "ok" }, connecting: { shape: "triangle", word: "CONNECTING", tone: "warn" }, disconnected: { shape: "square", word: "DISCONNECTED", tone: "alarm" }, disabled: { shape: "ring", word: "DISABLED", tone: "off" } };
const MSG: Record<string, [Tone, string]> = { ok: ["ok", "OK"], unmapped: ["warn", "UNMAPPED"], error: ["alarm", "ERROR"] };
export const Lamp = ({ state }: { state: State }) => { const l = LAMP[state]; return <span className="mq-lamp" data-tone={l.tone}><span className="mq-shape" data-shape={l.shape} aria-hidden />{l.word}</span>; };
type Say = { t: "ok" | "err"; s: string } | null;

export default function MqttPayloadPage() {
  const [v, setV] = useState<View | null>(null); const now = useNow(1000); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<Record<string, Say>>({});
  const [c, setC] = useState({ host: "", port: "", tls: true, client_id: "", username: "", password: "", keepalive: "", dirty: false });
  const [nt, setNt] = useState({ filter: "", qos: "1" }); const [map, setMap] = useState<{ id_path: string; ts_path: string; rules: Rule[]; dirty: boolean } | null>(null);
  const say = (k: string, t: "ok" | "err", s: string) => setMsg((m) => ({ ...m, [k]: { t, s } }));

  const load = useCallback(async (fresh = false) => {
    const x = await api<View>("/mqtt"); setV(x);
    setC((d) => (fresh || !d.dirty ? { host: x.config.host, port: String(x.config.port), tls: x.config.tls, client_id: x.config.client_id, username: x.config.username, password: "", keepalive: String(x.config.keepalive), dirty: false } : d));
    setMap((d) => (fresh || !d || !d.dirty ? { id_path: x.mapping.id_path, ts_path: x.mapping.ts_path, rules: x.mapping.rules, dirty: false } : d));
  }, []);
  useEffect(() => { void load(true).catch(() => {}); const i = setInterval(() => void load().catch(() => {}), 3000); return () => clearInterval(i); }, [load]);
  if (!v || !map) return <section className="fp-card mq"><p className="fp-msg">Loading...</p></section>;
  const run = async (key: string, f: () => Promise<void>) => { setBusy(key); setMsg((m) => ({ ...m, [key]: null })); try { await f(); } catch (e) { say(key, "err", errText(e)); } finally { setBusy(null); } };
  const body = (withPw: boolean) => ({ host: c.host.trim(), port: Number(c.port), tls: c.tls, client_id: c.client_id, username: c.username, keepalive: Number(c.keepalive), ...(withPw && c.password !== "" ? { password: c.password } : {}) });
  const setCf = (p: Partial<typeof c>) => setC((d) => ({ ...d, ...p, dirty: true }));
  const st = v.status, on = v.config.enabled;
  const nextIn = st.nextRetryAt ? Math.max(0, Math.round((st.nextRetryAt - now) / 1000)) : null;
  const Msg = ({ k }: { k: string }) => (msg[k] ? <p className={"fp-msg" + (msg[k]!.t === "err" ? " err" : "")} role="status">{msg[k]!.s}</p> : null);

  const test = () => run("test", async () => { const r = await api<{ ok: boolean; message: string }>("/mqtt/test", { method: "POST", json: body(true) }); say("test", r.ok ? "ok" : "err", (r.ok ? "TEST OK. " : "TEST FAILED. ") + r.message); });
  const save = (pw?: "remove") => run("save", async () => { const r = await api<View>("/mqtt/config", { method: "PUT", json: { ...body(true), ...(pw ? { password: "" } : {}) } }); setV(r); await load(true); say("save", "ok", pw ? "Saved. The stored password was removed." : "Saved." + (on ? " Reconnecting." : "")); });
  const toggle = () => run("enable", async () => { await api("/mqtt/enabled", { method: "POST", json: { enabled: !on } }); await load(); });
  const addTopic = () => run("topic", async () => { await api("/mqtt/topics", { method: "POST", json: { filter: nt.filter.trim(), qos: Number(nt.qos) } }); setNt({ filter: "", qos: nt.qos }); await load(); say("topic", "ok", "Topic added."); });
  const delTopic = (id: number) => run("topic", async () => { await api("/mqtt/topics/" + id, { method: "DELETE" }); await load(); });
  const devAct = (id: string, a: "add" | "ignore") => run("dev", async () => { await api(`/mqtt/devices/${encodeURIComponent(id)}/${a}`, { method: "POST", json: {} }); await load(); say("dev", "ok", a === "add" ? `Device ${id} added. Its values are stored from now on.` : `Device ${id} ignored.`); });
  const setRule = (i: number, p: Partial<Rule>) => setMap((m) => m && { ...m, dirty: true, rules: m.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const saveMap = () => run("map", async () => { const rules = map.rules.map((r) => ({ ...r, scale: Number(r.scale), offset: Number(r.offset) })); await api("/mqtt/mapping", { method: "PUT", json: { id_path: map.id_path.trim(), ts_path: map.ts_path.trim(), rules } }); await load(true); say("map", "ok", "Mapping saved."); });
  const fresh = v.devices.filter((d) => d.state === "new"), added = v.devices.filter((d) => d.state === "added");

  return (
    <div className="mq" data-testid="mqtt-page">
      <section className="fp-card mq-banner" aria-label="Connection status" data-state={st.state}>
        <div className="mq-row"><Lamp state={st.state} /><span className="mq-num" data-testid="mq-host">{st.host}:{st.port}</span></div>
        <dl className="mq-facts"><div><dt className="fp-cap">LAST MESSAGE</dt><dd className="mq-num">{ago(st.lastMessageAt, now)}</dd></div><div><dt className="fp-cap">MESSAGES / MIN</dt><dd className="mq-num">{st.perMinute}</dd></div></dl>
        {st.lastError && <p className="fp-msg err" role="status">{st.lastError}{nextIn !== null ? ` Trying again in ${nextIn} s.` : ""}</p>}
      </section>

      <section className="fp-card" aria-label="Connection"><h3>CONNECTION</h3>
        <div className="mq-form">
          <label>Broker host<input className="fp-input" value={c.host} onChange={(e) => setCf({ host: e.target.value })} autoComplete="off" /></label>
          <label>Port<input className="fp-input" inputMode="numeric" value={c.port} onChange={(e) => setCf({ port: e.target.value })} /></label>
          <div className="mq-fld"><span className="mq-lab">TLS</span><div className="fp-seg" role="group" aria-label="TLS"><button className="fp-btn" aria-pressed={c.tls} onClick={() => setCf({ tls: true })}>ON</button><button className="fp-btn" aria-pressed={!c.tls} onClick={() => setCf({ tls: false })}>OFF</button></div></div>
          <label>Client ID (empty = automatic)<input className="fp-input" value={c.client_id} onChange={(e) => setCf({ client_id: e.target.value })} autoComplete="off" /></label>
          <label>User name<input className="fp-input" value={c.username} onChange={(e) => setCf({ username: e.target.value })} autoComplete="off" /></label>
          <label>Password<input className="fp-input" type="password" value={c.password} autoComplete="new-password" placeholder={v.config.has_password ? "saved (hidden)" : "none"} onChange={(e) => setCf({ password: e.target.value })} /></label>
          <label>Keep-alive (s)<input className="fp-input" inputMode="numeric" value={c.keepalive} onChange={(e) => setCf({ keepalive: e.target.value })} /></label>
        </div>
        <p className="fp-cap" data-testid="pw-note">{v.config.password_unreadable ? "The stored password cannot be read on this box. Enter it again." : v.config.has_password ? "A password is stored (encrypted). It is never shown again." : "No password stored."}</p>
        <div className="fp-row mq-btns">
          <button className="fp-btn" disabled={busy !== null} onClick={test}>TEST CONNECTION</button>
          <button className="fp-btn primary" disabled={busy !== null} onClick={() => save()}>SAVE</button>
          <button className={"fp-btn " + (on ? "stop" : "go")} disabled={busy !== null} aria-pressed={on} onClick={toggle}>{on ? "DISABLE" : "ENABLE"}</button>
          {v.config.has_password && <button className="fp-btn small danger" disabled={busy !== null} onClick={() => confirm("Remove the stored password?") && save("remove")}>REMOVE PASSWORD</button>}
        </div>
        <Msg k="test" /><Msg k="save" /><Msg k="enable" />
      </section>

      <section className="fp-card" aria-label="Subscriptions"><h3>SUBSCRIPTIONS</h3>
        <table className="fp-table"><thead><tr><th>TOPIC FILTER</th><th>QOS</th><th>MESSAGES</th><th /></tr></thead><tbody>
          {v.topics.length === 0 && <tr><td colSpan={4}>No topic filters. Add one below.</td></tr>}
          {v.topics.map((t) => <tr key={t.id}><td>{t.filter}</td><td>{t.qos}</td><td className="mq-num">{t.count}</td><td><button className="fp-btn small" disabled={busy !== null} aria-label={`Remove ${t.filter}`} onClick={() => delTopic(t.id)}>REMOVE</button></td></tr>)}
        </tbody></table>
        <div className="fp-row"><input className="fp-input" aria-label="New topic filter" placeholder="fp/+/data" value={nt.filter} onChange={(e) => setNt({ ...nt, filter: e.target.value })} />
          <select className="fp-input" aria-label="QoS" value={nt.qos} onChange={(e) => setNt({ ...nt, qos: e.target.value })}><option value="0">QoS 0</option><option value="1">QoS 1</option><option value="2">QoS 2</option></select>
          <button className="fp-btn" disabled={busy !== null || !nt.filter.trim()} onClick={addTopic}>ADD TOPIC</button></div>
        <Msg k="topic" />
      </section>

      <section className="fp-card" aria-label="New devices found"><h3>NEW DEVICES FOUND</h3>
        {fresh.length === 0 ? <p className="fp-msg">No new devices. {added.length > 0 ? `${added.length} added device${added.length === 1 ? "" : "s"} (${added.map((d) => d.device_id).join(", ")}).` : "A device appears here when a message with an unknown device ID arrives."}</p> :
          <ul className="fp-list mq-list">{fresh.map((d) => <li key={d.device_id}><span><strong className="mq-num">{d.device_id}</strong> <span className="fp-cap">first seen {hhmm(d.first_seen)}</span></span>
            <span className="fp-row"><button className="fp-btn small" disabled={busy !== null} onClick={() => devAct(d.device_id, "add")}>ADD AS SENSOR</button><button className="fp-btn small" disabled={busy !== null} onClick={() => devAct(d.device_id, "ignore")}>IGNORE</button></span></li>)}</ul>}
        <Msg k="dev" />
      </section>

      <section className="fp-card" aria-label="Payload mapping"><h3>PAYLOAD MAPPING</h3>
        <p className="fp-msg">Placeholder format until the real payload is decided. Value in CORE = payload value × scale + offset.</p>
        <div className="mq-form"><label>Device ID field<input className="fp-input" value={map.id_path} onChange={(e) => setMap({ ...map, id_path: e.target.value, dirty: true })} /></label><label>Timestamp field<input className="fp-input" value={map.ts_path} onChange={(e) => setMap({ ...map, ts_path: e.target.value, dirty: true })} /></label></div>
        <div className="mq-scroll"><table className="fp-table"><thead><tr><th>PAYLOAD FIELD</th><th>MEASUREMENT</th><th>UNIT</th><th>SCALE</th><th>OFFSET</th><th /></tr></thead><tbody>
          {map.rules.map((r, i) => <tr key={i}>{(["path", "name", "unit", "scale", "offset"] as const).map((k) => <td key={k}><input className="fp-input mq-cell" aria-label={`${k} row ${i + 1}`} value={String(r[k])} onChange={(e) => setRule(i, { [k]: e.target.value })} /></td>)}
            <td><button className="fp-btn small" aria-label={`Remove row ${i + 1}`} onClick={() => setMap({ ...map, dirty: true, rules: map.rules.filter((_, j) => j !== i) })}>REMOVE</button></td></tr>)}
        </tbody></table></div>
        <div className="fp-row"><button className="fp-btn" onClick={() => setMap({ ...map, dirty: true, rules: [...map.rules, { path: "", name: "", unit: "", scale: 1, offset: 0 }] })}>ADD ROW</button><button className="fp-btn primary" disabled={busy !== null || !map.dirty} onClick={saveMap}>SAVE MAPPING</button></div>
        <Msg k="map" />
        <div className="mq-split"><div><span className="fp-cap">UNMAPPED FIELDS</span>{v.mapping.unmapped.length === 0 ? <p className="fp-msg">None seen.</p> : <ul className="mq-chips">{v.mapping.unmapped.map((u) => <li key={u.field}><Chip tone="warn">{u.field} × {u.count}</Chip></li>)}</ul>}</div>
          <div><span className="fp-cap">PARSE ERRORS</span><p className="mq-num" data-testid="mq-errors">{v.mapping.errors}</p></div></div>
      </section>

      <section className="fp-card" aria-label="Latest messages"><h3>LATEST MESSAGES</h3>
        {v.messages.length === 0 ? <p className="fp-msg">No messages received yet.</p> :
          <ol className="mq-msgs">{v.messages.map((m, i) => { const [tone, word] = MSG[m.status]; return <li key={m.ts + ":" + i}>
            <div className="fp-row mq-mh"><span className="mq-num">{hhmm(m.ts)}</span><span className="mq-num">{m.topic}</span><Chip tone={tone}>{word}</Chip>{m.device && <span className="fp-cap">{m.device}</span>}</div>
            {m.notes.length > 0 && <p className="fp-cap mq-notes">{m.notes.join(" · ")}</p>}<pre className="mq-raw">{m.raw}</pre></li>; })}</ol>}
      </section>
    </div>
  );
}
