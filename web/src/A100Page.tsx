import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { go } from "./App";
import { Chip, Modal, dt, errText, useNow, type Tone } from "./ui";
import "./a100.css";

// CONTROL DEVICES > Ashining A100 (Admin only, NOT licence gated; variant A of core-control-devices-ashining-a100-page.md, approved 2026-11-18).
// The A100 is a transparent RS-485 radio pipe with NO device address. Honest status: SENT = written to the A100; the radio ACK is not reported to CORE; CONFIRMED needs real feedback (not defined yet).
// The encryption key is never shown or returned: SET NEW KEY sends it to the unit and the page forgets it. Lamp SHAPE plus WORD on every status. Operators never reach this page (the server answers 403).
interface Params { version: string | null; rssi: { envDbm: number; packetDbm: number } | null; baud: number | null; format: { dataBits: number; stopBits: number; parity: string } | null; radio: { channel: number; mhz: number; powerDbm: number; airKbps: number } | null;
  mode: { value: number; name: string } | null; ack: { enabled: boolean; retries: number } | null; retryMs: number | null; packetLen: number | null; packTimeMs: number | null; options: { remoteConfig: boolean } | null;
  local: { group: number; address: number } | null; dest: { group: number; address: number } | null; defaultKey: boolean | null; missing: string[] }
interface Dev { id: number; name: string; kind: string; role: string | null; zoneId: number | null; scope: string; destGroup: number; destAddr: number; channel: number; rateLimitS: number; enabled: boolean; commands: string[]; state: string; lastCommand: { command: string; status: string; at: number } | null }
interface Cmd { id: string; device: string | null; command: string; user: string; status: string; note: string | null; at: number }
interface View { banner: string; link: { portId: number; enabled: boolean } | null; port: { id: number; label: string; transport: string; baud: number; dataBits: number; parity: string; stopBits: number; timeoutMs: number; retries: number; open: boolean } | null; ports: { id: number; label: string }[];
  params: Params | null; readAt: number | null; warnings: { code: string; text: string }[]; devices: Dev[]; commands: Cmd[]; ranges: { maxChannel: number; airKbps: number[]; powerDbm: number[]; bauds: number[] }; notes: { regulatory: string; keyStorage: string; feedback: string; local: string } }
const LAMP: Record<string, { shape: string; tone: Tone }> = { "A100 ANSWERING": { shape: "circle", tone: "ok" }, CONNECTING: { shape: "triangle", tone: "warn" }, "NO ANSWER": { shape: "square", tone: "alarm" }, DISABLED: { shape: "ring", tone: "off" } };
const ST: Record<string, Tone> = { SENT: "info", UNKNOWN: "warn", CONFIRMED: "ok", FAILED: "alarm" };
const MODES: [number, string][] = [[1, "Transparent"], [2, "Target transmission"], [4, "Master-slave"]];
interface Draft { mode: string; localGroup: string; localAddress: string; destGroup: string; destAddress: string; channel: string; powerDbm: string; airKbps: string; ackEnabled: boolean; ackRetries: string; retryMs: string; remoteConfig: boolean }
const draftOf = (p: Params | null): Draft => ({ mode: p?.mode ? String(p.mode.value) : "", localGroup: p?.local ? String(p.local.group) : "", localAddress: p?.local ? String(p.local.address) : "", destGroup: p?.dest ? String(p.dest.group) : "", destAddress: p?.dest ? String(p.dest.address) : "",
  channel: p?.radio ? String(p.radio.channel) : "", powerDbm: p?.radio ? String(p.radio.powerDbm) : "", airKbps: p?.radio ? String(p.radio.airKbps) : "", ackEnabled: !!p?.ack?.enabled, ackRetries: p?.ack ? String(p.ack.retries) : "", retryMs: p?.retryMs != null ? String(p.retryMs) : "", remoteConfig: !!p?.options?.remoteConfig });
const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
const lineOf = (b: number, d: number, p: string, s: number) => `${b} ${d}${p === "none" ? "N" : p === "even" ? "E" : "O"}${s}`;

export default function A100Page() {
  const [v, setV] = useState<View | null>(null), [err, setErr] = useState(""), [busy, setBusy] = useState<string | null>(null), [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null), now = useNow(1000);
  const [d, setD] = useState<Draft>(draftOf(null)), [confirm, setConfirm] = useState<null | "write" | "key" | "reboot" | "factory" | "revert">(null), [dev, setDev] = useState<null | "new" | Dev>(null);
  const [test, setTest] = useState<{ ok: boolean; checks: { name: string; ok: boolean; text: string }[]; note: string } | null>(null);
  const load = useCallback(async (resetDraft = false) => { try { const x = await api<View>("/a100"); setV(x); setErr(""); if (resetDraft) setD(draftOf(x.params)); } catch (e) { setErr(errText(e)); } }, []);
  useEffect(() => { void load(true); const i = setInterval(() => void load(), 10000); return () => clearInterval(i); }, [load]);
  const say = (t: "ok" | "err", s: string) => setMsg({ t, s });
  const run = async (k: string, f: () => Promise<void>) => { setBusy(k); setMsg(null); try { await f(); } catch (e) { say("err", errText(e)); } finally { setBusy(null); } };
  if (!v) return <section className="fp-card a1"><h3>Ashining A100</h3><p className="fp-msg">{err || "Loading..."}</p></section>;
  const p = v.params, lamp = LAMP[v.banner] ?? LAMP.DISABLED, port = v.port, ready = !!p;
  const mismatch = v.warnings.find((w) => w.code === "serial_mismatch");
  const read = () => run("read", async () => { const r = await api<{ params: Params; first: boolean }>("/a100/read", { method: "POST", json: {} }); setD(draftOf(r.params)); await load(); say("ok", r.first ? "READ FROM UNIT. These are the values the unit has now. Compare them with the Online and EDGE fan link before you write anything." : "READ FROM UNIT done."); });
  const changes = () => ({ mode: num(d.mode), localGroup: num(d.localGroup), localAddress: num(d.localAddress), destGroup: num(d.destGroup), destAddress: num(d.destAddress), channel: num(d.channel), powerDbm: num(d.powerDbm), airKbps: num(d.airKbps), ackEnabled: d.ackEnabled, ackRetries: num(d.ackRetries), retryMs: num(d.retryMs), remoteConfig: d.remoteConfig });
  const mhz = d.channel.trim() !== "" && Number.isInteger(Number(d.channel)) ? 410 + Number(d.channel) : null;
  const setLink = (body: Record<string, unknown>) => run("link", async () => { await api("/a100/link", { method: "PUT", json: body }); await load(); say("ok", "Saved."); });

  return (<div className="a1">
    <section className="fp-card" aria-label="A100 status">
      <h3>ASHINING A100</h3>
      <div className="a1-strip">
        <span className="a1-lamp" data-tone={lamp.tone}><span className="a1-shape" data-shape={lamp.shape} aria-hidden="true" />{v.banner}</span>
        <dl className="a1-facts">
          <div><dt className="fp-cap">SERIAL SIDE</dt><dd>{port ? `${port.label} · ${lineOf(port.baud, port.dataBits, port.parity, port.stopBits)}` : "--"}</dd></div>
          <div><dt className="fp-cap">RADIO</dt><dd>{p?.radio ? `${p.radio.mhz} MHz · CH ${p.radio.channel}` : "--"}</dd></div>
          <div><dt className="fp-cap">SIGNAL</dt><dd>{p?.rssi ? `${p.rssi.packetDbm} dBm` : "--"}</dd></div>
          <div><dt className="fp-cap">FEEDBACK</dt><dd>{p?.ack?.enabled ? "RADIO ACK ON (NOT SHOWN TO CORE)" : "NONE"}</dd></div>
          <div><dt className="fp-cap">LAST COMMAND</dt><dd>{v.commands[0] ? `${dt(v.commands[0].at)} ${v.commands[0].status}` : "--"}</dd></div>
          <div><dt className="fp-cap">DEVICES</dt><dd>{v.devices.length}</dd></div>
        </dl>
        <label className="a1-check"><input type="checkbox" checked={!!v.link?.enabled} disabled={!v.link || busy !== null} onChange={(e) => setLink({ enabled: e.target.checked })} />LINK ENABLED</label>
        <button className="fp-btn a1-primary" style={{ minHeight: 56 }} disabled={busy !== null} onClick={() => run("test", async () => { setTest(await api("/a100/test", { method: "POST", json: {} })); await load(); })}>{busy === "test" ? "TESTING..." : "TEST LINK"}</button>
      </div>
      {msg && <p className="fp-msg" role="status" data-tone={msg.t === "ok" ? "ok" : "alarm"}>{msg.s}</p>}{err && <p className="fp-msg" role="alert">{err}</p>}
    </section>

    {v.warnings.filter((w) => w.code !== "serial_mismatch").map((w) => <div key={w.code} className="a1-warn" role="alert" data-tone={w.code === "default_key" ? "alarm" : "warn"}>
      <Chip tone={w.code === "default_key" ? "alarm" : "warn"}>{w.code === "default_key" ? "DEFAULT KEY IN USE" : "REMOTE CONFIGURATION ON"}</Chip><span style={{ flex: 1, minWidth: 220 }}>{w.text}</span>
      {w.code === "default_key" && <button className="fp-btn" onClick={() => setConfirm("key")}>SET NEW KEY</button>}</div>)}

    <div className="a1-two">
      <section className="fp-card" aria-label="Serial side">
        <h3>SERIAL SIDE (RS-485)</h3>
        <div className="a1-form">
          <label>RS-485 port<select className="fp-input" value={v.link?.portId ?? ""} disabled={busy !== null} onChange={(e) => setLink({ port_id: Number(e.target.value), enabled: v.link?.enabled ?? false })}><option value="" disabled>Choose a port</option>{v.ports.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          <label>Port line<input className="fp-input" readOnly value={port ? lineOf(port.baud, port.dataBits, port.parity, port.stopBits) : "--"} /></label>
          <label>Response timeout<input className="fp-input" readOnly value={port ? `${port.timeoutMs} ms` : "--"} /></label>
          <label>Retries<input className="fp-input" readOnly value={port ? String(port.retries) : "--"} /></label>
          <label>A100 serial registers<input className="fp-input" readOnly value={p?.baud != null && p.format ? lineOf(p.baud, p.format.dataBits, p.format.parity, p.format.stopBits) : "NOT READ"} /></label>
        </div>
        <p><Chip tone={!ready ? "off" : mismatch ? "alarm" : "ok"}>{!ready ? "NOT READ" : mismatch ? "MISMATCH" : "MATCH"}</Chip></p>
        {mismatch && <p className="fp-msg" role="alert">{mismatch.text}</p>}
        <p className="a1-note">The A100 is a radio pipe with no device address: it holds its port alone. Use a dedicated RS-485 port. Baud, parity and timeout of the port are set on <button className="fp-btn small" onClick={() => go("/settings/rs485-ports")}>RS-485 PORTS</button></p>
      </section>

      <section className="fp-card" aria-label="Radio">
        <h3>RADIO</h3>
        <div className="a1-btns" style={{ marginTop: 0, marginBottom: 12 }}><Chip tone={ready ? "ok" : "off"}>{ready ? `READ FROM UNIT ${v.readAt ? dt(v.readAt) : ""}` : "NOT READ YET"}</Chip>{p?.version && <span className="fp-cap">{p.version}</span>}</div>
        <div className="a1-form">
          <label>Mode<select className="fp-input" value={d.mode} disabled={!ready} onChange={(e) => setD({ ...d, mode: e.target.value })}>{!MODES.some(([n]) => String(n) === d.mode) && <option value={d.mode}>{p?.mode?.name ?? "--"} (advanced)</option>}{MODES.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
          <label>Channel<input className="fp-input" inputMode="numeric" value={d.channel} disabled={!ready} onChange={(e) => setD({ ...d, channel: e.target.value })} /></label>
          <label>Frequency<span className="a1-mhz">{mhz !== null && mhz <= 525 ? `${mhz} MHz` : "--"}</span></label>
          <label>TX power<select className="fp-input" value={d.powerDbm} disabled={!ready} onChange={(e) => setD({ ...d, powerDbm: e.target.value })}>{v.ranges.powerDbm.map((x) => <option key={x} value={x}>{x} dBm</option>)}</select></label>
          <label>Air rate<select className="fp-input" value={d.airKbps} disabled={!ready} onChange={(e) => setD({ ...d, airKbps: e.target.value })}>{v.ranges.airKbps.map((x) => <option key={x} value={x}>{x} kbps</option>)}</select></label>
          <label>Local group<input className="fp-input" inputMode="numeric" value={d.localGroup} disabled={!ready} onChange={(e) => setD({ ...d, localGroup: e.target.value })} /></label>
          <label>Local address<input className="fp-input" inputMode="numeric" value={d.localAddress} disabled={!ready} onChange={(e) => setD({ ...d, localAddress: e.target.value })} /></label>
          <label>Default destination group<input className="fp-input" inputMode="numeric" value={d.destGroup} disabled={!ready} onChange={(e) => setD({ ...d, destGroup: e.target.value })} /></label>
          <label>Default destination address<input className="fp-input" inputMode="numeric" value={d.destAddress} disabled={!ready} onChange={(e) => setD({ ...d, destAddress: e.target.value })} /></label>
          <label>Radio ACK retries<input className="fp-input" inputMode="numeric" value={d.ackRetries} disabled={!ready} onChange={(e) => setD({ ...d, ackRetries: e.target.value })} /></label>
          <label>Retry interval (ms)<input className="fp-input" inputMode="numeric" value={d.retryMs} disabled={!ready} onChange={(e) => setD({ ...d, retryMs: e.target.value })} /></label>
          <label className="a1-check" style={{ flexDirection: "row" }}><input type="checkbox" checked={d.ackEnabled} disabled={!ready} onChange={(e) => setD({ ...d, ackEnabled: e.target.checked })} />RADIO ACK</label>
          <label className="a1-check" style={{ flexDirection: "row" }}><input type="checkbox" checked={d.remoteConfig} disabled={!ready} onChange={(e) => setD({ ...d, remoteConfig: e.target.checked })} />REMOTE CONFIGURATION</label>
          <label>Encryption key<input className="fp-input" readOnly value={!ready ? "--" : p?.defaultKey === true ? "FACTORY KEY" : p?.defaultKey === false ? "••••••••••••••••" : "UNKNOWN"} aria-label="Encryption key (never shown)" /></label>
        </div>
        <p className="a1-note">{v.notes.regulatory}</p><p className="a1-note">{v.notes.keyStorage}</p>
        <div className="a1-btns">
          <button className="fp-btn" disabled={busy !== null || !v.link?.enabled} onClick={read}>{busy === "read" ? "READING..." : "READ FROM UNIT"}</button>
          <button className="fp-btn a1-primary" disabled={!ready || busy !== null} onClick={() => setConfirm("write")}>WRITE TO UNIT</button>
          <button className="fp-btn" disabled={!ready || busy !== null} onClick={() => setConfirm("revert")}>REVERT</button>
          <button className="fp-btn" disabled={!ready || busy !== null} onClick={() => setConfirm("key")}>SET NEW KEY</button>
          <button className="fp-btn" disabled={!ready || busy !== null} onClick={() => setConfirm("reboot")}>REBOOT UNIT</button>
          <button className="fp-btn" disabled={!ready || busy !== null} onClick={() => setConfirm("factory")}>FACTORY RESTORE</button>
        </div>
      </section>
    </div>

    <section className="fp-card" aria-label="Devices behind this link">
      <div className="fp-row fp-spread"><h3>DEVICES BEHIND THIS LINK</h3><button className="fp-btn" onClick={() => setDev("new")}>+ ADD DEVICE</button></div>
      {v.devices.length === 0 ? <p className="fp-msg">No device yet. Add the receivers the A100 sends commands to.</p> : <div className="a1-scroll"><table className="fp-table"><thead><tr><th>Name</th><th>Kind</th><th>Role</th><th>Scope</th><th>Destination</th><th>Commands</th><th>State</th><th>Last command</th><th /></tr></thead><tbody>{v.devices.map((x) => (
        <tr key={x.id}><td>{x.name}</td><td>{x.kind}</td><td>{x.role ?? "--"}</td><td>{x.scope}</td><td className="fp-num">{`G${x.destGroup} A${x.destAddr} CH${x.channel}`}</td><td>{x.commands.length ? x.commands.join(", ") : "NONE SET"}</td>
          <td><Chip tone={ST[x.state] ?? "warn"}>{x.state}</Chip></td><td>{x.lastCommand ? `${x.lastCommand.command} ${dt(x.lastCommand.at)}` : "--"}</td><td><button className="fp-btn small" style={{ minHeight: 44 }} onClick={() => setDev(x)}>EDIT</button></td></tr>))}</tbody></table></div>}
      <p className="a1-note">Devices appear on the CONTROL page. If the link does not answer, every device shows UNKNOWN and commands are disabled. TODO: the fan command frames and the feedback protocol come from the Online / EDGE fan link and are not set here.</p>
    </section>

    <div className="a1-two">
      <section className="fp-card" aria-label="Last commands"><h3>LAST COMMANDS</h3>
        {v.commands.length === 0 ? <p className="fp-msg">No command yet.</p> : <div className="a1-scroll"><table className="fp-table"><thead><tr><th>Time</th><th>Device</th><th>Command</th><th>User</th><th>Result</th></tr></thead><tbody>{v.commands.map((c) => <tr key={c.id}><td>{dt(c.at)}</td><td>{c.device ?? "--"}</td><td>{c.command}</td><td>{c.user}</td><td><Chip tone={ST[c.status] ?? "warn"} title={c.note ?? undefined}>{c.status}</Chip></td></tr>)}</tbody></table></div>}
        <p className="a1-note">{v.notes.feedback}</p></section>
      <section className="fp-card" aria-label="Link test"><h3>LINK TEST</h3>
        <p className="a1-note" style={{ marginTop: 0 }}>Checks that the port opens, the A100 answers and its serial registers match the port. It sends no command to any fan or other device.</p>
        {test && <ul className="a1-chk">{test.checks.map((c) => <li key={c.name}><Chip tone={c.ok ? "ok" : "alarm"}>{c.ok ? "OK" : "FAIL"}</Chip><span className="fp-cap">{c.name}</span><span>{c.text}</span></li>)}</ul>}
        <div className="a1-btns"><button className="fp-btn" disabled={busy !== null} onClick={() => run("test", async () => { setTest(await api("/a100/test", { method: "POST", json: {} })); await load(); })}>TEST LINK</button></div>
      </section>
    </div>
    <p className="a1-note">{v.notes.local}</p>
    <span hidden>{now}</span>

    {confirm === "write" && <ConfirmWrite d={d} onClose={() => setConfirm(null)} onGo={(remote) => run("write", async () => { const r = await api<{ note?: string; unchanged?: boolean }>("/a100/write", { method: "POST", json: { confirm: true, confirmRemote: remote, changes: changes() } }); setConfirm(null); await load(true); say("ok", r.unchanged ? "Nothing to change." : "Written, read back and checked." + (r.note ? " " + r.note : "")); })} busy={busy === "write"} err={msg?.t === "err" ? msg.s : ""} />}
    {confirm === "revert" && <Confirm title="REVERT" text="Write the values the unit had before the last WRITE TO UNIT back to the unit." onClose={() => setConfirm(null)} onGo={() => run("revert", async () => { const r = await api<{ ok: boolean; failed: string[] }>("/a100/revert", { method: "POST", json: { confirm: true } }); setConfirm(null); await load(true); say(r.ok ? "ok" : "err", r.ok ? "Reverted." : "Some registers could not be put back: " + r.failed.join(", ")); })} />}
    {confirm === "key" && <KeyDialog onClose={() => setConfirm(null)} onGo={(key) => run("key", async () => { await api("/a100/key", { method: "POST", json: { confirm: true, key } }); setConfirm(null); await load(); say("ok", "The new key is on the unit. Change it on the other end of the link too."); })} />}
    {(confirm === "reboot" || confirm === "factory") && <TypedConfirm word={confirm === "reboot" ? "REBOOT" : "FACTORY"} text={confirm === "reboot" ? "The unit restarts and is silent for a moment." : "Factory restore sets EVERY A100 setting back, including the radio settings and the key. The link to the fans will not work until they are set again."} onClose={() => setConfirm(null)} onGo={() => run("reset", async () => { await api("/a100/reset", { method: "POST", json: { action: confirm, confirm: confirm === "reboot" ? "REBOOT" : "FACTORY" } }); setConfirm(null); await load(true); say("ok", confirm === "reboot" ? "Reboot sent." : "Factory restore sent. READ FROM UNIT again."); })} />}
    {dev && <DeviceDialog dev={dev === "new" ? null : dev} onClose={() => setDev(null)} onSave={(body, id) => run("dev", async () => { await api(id ? `/a100/devices/${id}` : "/a100/devices", { method: id ? "PUT" : "POST", json: body }); setDev(null); await load(); say("ok", "Saved."); })} onDelete={(id) => run("dev", async () => { await api(`/a100/devices/${id}`, { method: "DELETE" }); setDev(null); await load(); say("ok", "Removed."); })} />}
  </div>);
}

function Confirm({ title, text, onClose, onGo, busy }: { title: string; text: string; onClose: () => void; onGo: () => void; busy?: boolean }) {
  return <Modal title={title} onClose={onClose}><p>{text}</p><div className="a1-btns"><button className="fp-btn" onClick={onClose}>CANCEL</button><button className="fp-btn a1-primary" disabled={busy} onClick={onGo}>{title}</button></div></Modal>;
}
function ConfirmWrite({ d, onClose, onGo, busy, err }: { d: Draft; onClose: () => void; onGo: (remote: boolean) => void; busy: boolean; err: string }) {
  const [ok, setOk] = useState(false), [rc, setRc] = useState(false);
  return <Modal title="WRITE TO UNIT" onClose={onClose}>
    <p>A wrong radio or serial setting can cut the link to the fans. CORE keeps the values it read, writes the unit, reads them back and puts the old values back if the check fails.</p>
    <p className="a1-note">Do not change a working link unless it is meant to match the Online and EDGE fan link. CORE sets no power or channel by itself.</p>
    <label className="a1-check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I understand this can cut the link to the fans</label>
    <label className="a1-check"><input type="checkbox" checked={rc} onChange={(e) => setRc(e.target.checked)} />Remote configuration may change (lets other modules in range reconfigure the unit)</label>
    {err && <p className="fp-msg" role="alert">{err}</p>}
    <div className="a1-btns"><button className="fp-btn" onClick={onClose}>CANCEL</button><button className="fp-btn a1-primary" disabled={!ok || busy} onClick={() => onGo(rc)}>{busy ? "WRITING..." : "WRITE TO UNIT"}</button></div><span hidden>{d.channel}</span></Modal>;
}
function KeyDialog({ onClose, onGo }: { onClose: () => void; onGo: (k: string) => void }) {
  const [k, setK] = useState(""), [ok, setOk] = useState(false), good = /^[\x20-\x7e]{16}$/.test(k);
  return <Modal title="SET NEW KEY" onClose={onClose}><p>The key is exactly 16 printable characters. CORE writes it to the unit and does not keep it. The same key must be set on the other end of the link, or the radios stop understanding each other.</p>
    <label className="a1-form" style={{ display: "flex", flexDirection: "column" }}><span className="fp-cap">NEW KEY ({k.length}/16)</span><input className="fp-input" type="password" autoComplete="off" value={k} maxLength={16} onChange={(e) => setK(e.target.value)} /></label>
    <label className="a1-check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I will set the same key on the other end</label>
    <div className="a1-btns"><button className="fp-btn" onClick={onClose}>CANCEL</button><button className="fp-btn a1-primary" disabled={!good || !ok} onClick={() => onGo(k)}>SET NEW KEY</button></div></Modal>;
}
function TypedConfirm({ word, text, onClose, onGo }: { word: string; text: string; onClose: () => void; onGo: () => void }) {
  const [t, setT] = useState(""); return <Modal title={word === "REBOOT" ? "REBOOT UNIT" : "FACTORY RESTORE"} onClose={onClose}><p>{text}</p><label className="a1-form" style={{ display: "flex", flexDirection: "column" }}><span className="fp-cap">TYPE {word} TO CONFIRM</span><input className="fp-input" value={t} onChange={(e) => setT(e.target.value)} /></label>
    <div className="a1-btns"><button className="fp-btn" onClick={onClose}>CANCEL</button><button className="fp-btn a1-primary" disabled={t !== word} onClick={onGo}>{word === "REBOOT" ? "REBOOT" : "RESTORE"}</button></div></Modal>;
}
function DeviceDialog({ dev, onClose, onSave, onDelete }: { dev: Dev | null; onClose: () => void; onSave: (b: Record<string, unknown>, id: number | null) => void; onDelete: (id: number) => void }) {
  const [f, setF] = useState({ name: dev?.name ?? "", kind: dev?.kind ?? "fan", role: dev?.role ?? "", scope: dev?.scope ?? "site", dest_group: String(dev?.destGroup ?? 0), dest_addr: String(dev?.destAddr ?? 0), channel: String(dev?.channel ?? 0), rate_limit_s: String(dev?.rateLimitS ?? 10), enabled: dev?.enabled ?? true });
  const [pl, setPl] = useState<{ name: string; hex: string }[]>([]); const [touched, setTouched] = useState(false); const set = (k: string, v: string | boolean) => setF({ ...f, [k]: v });
  return <Modal title={dev ? "EDIT DEVICE" : "ADD DEVICE"} onClose={onClose}><div className="a1-form">
    <label>Name<input className="fp-input" value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
    <label>Kind<select className="fp-input" value={f.kind} onChange={(e) => set("kind", e.target.value)}>{["fan", "valve", "actuator", "other"].map((x) => <option key={x}>{x}</option>)}</select></label>
    <label>Role<input className="fp-input" placeholder="exhaust, mixing..." value={f.role} onChange={(e) => set("role", e.target.value)} /></label>
    <label>Scope (greenhouse and section, or site)<input className="fp-input" value={f.scope} onChange={(e) => set("scope", e.target.value)} /></label>
    <label>Destination group<input className="fp-input" inputMode="numeric" value={f.dest_group} onChange={(e) => set("dest_group", e.target.value)} /></label>
    <label>Destination address<input className="fp-input" inputMode="numeric" value={f.dest_addr} onChange={(e) => set("dest_addr", e.target.value)} /></label>
    <label>Destination channel<input className="fp-input" inputMode="numeric" value={f.channel} onChange={(e) => set("channel", e.target.value)} /></label>
    <label>Min. seconds between commands<input className="fp-input" inputMode="numeric" value={f.rate_limit_s} onChange={(e) => set("rate_limit_s", e.target.value)} /></label>
  </div>
  <p className="a1-note">In target transmission mode CORE puts group, address and channel in front of every frame. Command payloads (hex) are typed here from the working Online / EDGE fan link: none are shipped with CORE. Existing commands: {dev?.commands.length ? dev.commands.join(", ") : "none"}.</p>
  {pl.map((x, i) => <div key={i} className="a1-form"><label>Command name<input className="fp-input" value={x.name} onChange={(e) => { setTouched(true); setPl(pl.map((y, j) => (j === i ? { ...y, name: e.target.value } : y))); }} /></label><label>Payload (hex)<input className="fp-input" value={x.hex} onChange={(e) => { setTouched(true); setPl(pl.map((y, j) => (j === i ? { ...y, hex: e.target.value } : y))); }} /></label></div>)}
  <div className="a1-btns"><button className="fp-btn" onClick={() => setPl([...pl, { name: "", hex: "" }])}>+ ADD PAYLOAD</button></div>
  <div className="a1-btns">{dev && <button className="fp-btn" onClick={() => onDelete(dev.id)}>REMOVE</button>}<button className="fp-btn" onClick={onClose}>CANCEL</button>
    <button className="fp-btn a1-primary" disabled={!f.name.trim()} onClick={() => onSave({ name: f.name, kind: f.kind, role: f.role, scope: f.scope, dest_group: Number(f.dest_group), dest_addr: Number(f.dest_addr), channel: Number(f.channel), rate_limit_s: Number(f.rate_limit_s), enabled: f.enabled, ...(touched ? { payloads: Object.fromEntries(pl.filter((x) => x.name).map((x) => [x.name, x.hex])) } : {}) }, dev?.id ?? null)}>SAVE</button></div></Modal>;
}
