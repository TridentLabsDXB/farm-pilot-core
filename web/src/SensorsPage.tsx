import { useCallback, useEffect, useState } from "react";
import { api, type Scada, type SensorView, type TypeInfo } from "./api";
import { go } from "./App";
import Scan, { scanSupported } from "./Scan";
import { Battery, Chip, Modal, Signal, SYNC, StatusChip, ago, dt, dur, errText } from "./ui";

interface GwInfo { enabled: boolean; online: boolean; lastOk: number | null; lastError: string | null; model: string; mapVersion: number; info: { address?: number; version?: number }; types: TypeInfo[]; unsent: number;
  pending: { type: string; serial: string; slot: number | null }[]; lastSync: { type: string; ok: boolean; at: number; items: { serial: string; slot: number; action: string; status: string; reason?: string }[] } | null;
  unassigned: { type: string; slot: number; serial: string; interval: number }[]; syncing: boolean; settings: { pollSec: number } }
interface SList { types: TypeInfo[]; sensors: SensorView[]; zones: { id: number; name: string }[]; pattern: string; }

export default function SensorsPage({ scada, reload }: { scada: Scada | null; reload: () => void }) {
  const [list, setList] = useState<SList | null>(null); const [gw, setGw] = useState<GwInfo | null>(null);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null); const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false); const [confirm, setConfirm] = useState<any>(null); const [advanced, setAdvanced] = useState(false);
  const load = useCallback(() => { api<SList>("/sensors").then(setList).catch((e) => setMsg({ t: "err", s: errText(e) })); api<GwInfo>("/gateway").then(setGw).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, scada]);
  const ok = (s: string) => setMsg({ t: "ok", s }); const fail = (e: unknown) => setMsg({ t: "err", s: errText(e) });
  if (!list || !gw) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const th = list.types.find((t) => t.key === "th"); const offline = !gw.online; const sensors = list.sensors;
  const send = async (confirmed = false) => {
    setBusy(true); setMsg(null);
    try { const r = await api<any[]>("/gateway/sync", { method: "POST", json: { types: ["th"], confirm: confirmed } }); setConfirm(null); const bad = r.flatMap((x) => x.items).filter((i: any) => i.status === "failed").length; bad ? fail(`${bad} item(s) failed, see RESULT OF LAST SEND`) : ok("Sent and confirmed by read-back."); }
    catch (e: any) { if (e.status === 409 && /confirmation required/.test(e.message)) { const p = await api<any>("/gateway/sync/plan", { method: "POST", json: { type: "th" } }).catch(() => null); setConfirm(p); } else fail(e); }
    finally { setBusy(false); load(); reload(); }
  };
  const setInterval_ = async (s: SensorView, v: string) => {
    let sec = Number(v); if (v === "custom") { const x = prompt(`Reporting interval in seconds (${th?.min}-${th?.max})`, String(s.intervalSec)); if (!x) return; sec = Number(x); }
    try { await api(`/sensors/${s.serial}`, { method: "PATCH", json: { interval: sec } }); load(); } catch (e) { fail(e); }
  };
  const presets = (s: SensorView) => { const t = list.types.find((x) => x.key === s.type)!; const set = new Set(t.presets.filter((p) => p !== 30 || advanced || s.intervalSec === 30)); set.add(s.intervalSec); return [...set].sort((a, b) => a - b); };
  const changes = sensors.filter((s) => s.syncState !== "in_gateway");
  const interval = (s: SensorView) => (
    <span className="fp-row" style={{ gap: 6 }}><select className="fp-input" aria-label={`Interval for ${s.label}`} value={s.intervalSec} onChange={(e) => setInterval_(s, e.target.value)}>{presets(s).map((p) => <option key={p} value={p}>{dur(p)}</option>)}<option value="custom">Custom...</option></select>{s.applying && <Chip tone="info">APPLYING</Chip>}</span>);
  return (<>
    <section className="fp-card">
      <div className="fp-row fp-spread"><div><h3>Gateway</h3><span className="fp-cap">{gw.model} · Modbus RTU 9600 8N1 · address {gw.info.address ?? "--"} · map v{gw.mapVersion} · poll {gw.settings.pollSec} s</span></div>
        {!gw.enabled ? <Chip tone="off">NO GATEWAY</Chip> : gw.online ? <Chip tone="ok">GATEWAY ONLINE</Chip> : <Chip tone="alarm">GATEWAY OFFLINE</Chip>}</div>
      {th && <div className="fp-field"><span className="fp-cap">T/H sensors: {th.used} of {th.groups} slots in gateway</span><div className="fp-progress" role="progressbar" aria-valuenow={th.used} aria-valuemax={th.groups}><b style={{ width: `${(th.used / th.groups) * 100}%` }} /></div></div>}
      <div className="fp-row fp-spread"><span className="fp-num">{gw.unsent + 0} change{gw.unsent === 1 ? "" : "s"} not sent{gw.lastSync ? ` · last sync ${dt(gw.lastSync.at)} ${gw.lastSync.ok ? "OK" : "FAILED"}` : ""}</span>
        <button className="fp-btn primary" disabled={busy || offline || gw.syncing} onClick={() => send(false)}>{busy ? "Sending..." : "Send to gateway"}</button></div>
      {offline && <p className="fp-msg err">Gateway is offline. Sending is disabled until it answers again.{gw.lastError ? ` (${gw.lastError})` : ""}</p>}
      {msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}
    </section>
    <div className="fp-two"><section className="fp-card">
      <div className="fp-row fp-spread"><h3>Sensors</h3><div className="fp-row"><button className="fp-btn" onClick={() => setAdding(true)}>Add sensors</button>{scanSupported() && <button className="fp-btn" onClick={() => setAdding(true)}>Scan QR</button>}</div></div>
      <label className="fp-row fp-cap"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Advanced / commissioning: allow the 30 s interval (short intervals reduce battery life)</label>
      <table className="fp-table responsive"><thead><tr><th>Slot</th><th>Serial</th><th>Label</th><th>Zone</th><th>Interval</th><th>Voltage</th><th>RSSI</th><th>Status</th><th>State</th></tr></thead><tbody>{sensors.map((s) => (
        <tr key={s.serial} className="click" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
          <td>{(s.slot ?? -1) + 1}</td><td>{s.serial}</td><td className="h">{s.label === s.serial ? "--" : s.label}</td><td>{list.zones.find((z) => z.id === s.zoneId)?.name ?? "--"}</td>
          <td onClick={(e) => e.stopPropagation()}>{interval(s)}</td><td><Battery v={s.voltage} low={s.lowVoltage} /></td><td><Signal rssi={s.rssi} band={s.rssiBand} /></td><td><StatusChip status={s.status} />{s.calDue && <> <Chip tone="warn">CAL DUE</Chip></>}</td>
          <td><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip></td></tr>))}</tbody></table>
      <div className="fp-cards">{sensors.map((s) => (
        <div key={s.serial} className="fp-srow" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
          <span className="l">{s.label}</span><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip>
          <span className="m"><span>slot {(s.slot ?? -1) + 1}</span><span>{s.serial}</span><span>{list.zones.find((z) => z.id === s.zoneId)?.name ?? "no zone"}</span></span>
          <span className="m" onClick={(e) => e.stopPropagation()}>{interval(s)}</span><span className="m"><StatusChip status={s.status} /><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /></span></div>))}</div>
      {!sensors.length && <p className="fp-msg fp-muted">No sensors yet. Press ADD SENSORS and type or paste the serials.</p>}
    </section>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="fp-card"><h3>Will be sent</h3>
        {!changes.length && !gw.pending.length ? <span className="fp-msg fp-muted">Nothing to send.</span> : <ul className="fp-list">
          {changes.map((s) => <li key={s.serial}><span>{s.syncState === "not_sent" ? "ADD" : "CHANGE"} {s.serial}</span><span className="fp-muted">{s.syncState === "not_sent" ? `slot ${(s.slot ?? 0) + 1}, ${dur(s.intervalSec)}` : `${dur(s.sentInterval ?? 0)} → ${dur(s.intervalSec)}`}</span></li>)}
          {gw.pending.map((p) => <li key={p.serial}><span>REMOVE {p.serial}</span><span className="fp-muted">slot {(p.slot ?? 0) + 1}</span></li>)}</ul>}
        <span className="fp-cap" style={{ textTransform: "none" }}>Polling pauses for about 10 s. Every write is read back.</span></section>
      <section className="fp-card"><h3>Result of last send</h3>
        {!gw.lastSync ? <span className="fp-msg fp-muted">No send yet.</span> : <ul className="fp-list">{gw.lastSync.items.map((i, k) => <li key={k}><span>{i.serial}</span><Chip tone={i.status === "confirmed" ? "ok" : "alarm"}>{i.status === "confirmed" ? "CONFIRMED" : `FAILED${i.reason ? ": " + i.reason.toUpperCase() : ""}`}</Chip></li>)}{!gw.lastSync.items.length && <li className="fp-muted">Nothing needed writing; gateway already matched.</li>}</ul>}
        {gw.lastSync && <span className="fp-cap">{ago(gw.lastSync.at)}</span>}</section>
      {gw.unassigned.length > 0 && <section className="fp-card"><h3>New sensor found</h3><span className="fp-msg">Configured in the gateway but not in CORE. Never added automatically.</span>
        <ul className="fp-list">{gw.unassigned.map((u) => <li key={u.serial}><span>{u.serial} · slot {u.slot + 1} · {dur(u.interval)}</span><span className="fp-row">
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/add", { method: "POST", json: { serial: u.serial } }).then(() => { load(); reload(); }).catch(fail)}>Add</button>
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/ignore", { method: "POST", json: { serial: u.serial } }).then(load).catch(fail)}>Ignore</button></span></li>)}</ul></section>}
    </div></div>
    {adding && <AddModal types={list.types} pattern={list.pattern} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); ok(`${n} sensor(s) added. Press SEND TO GATEWAY to push them.`); load(); reload(); }} />}
    {confirm && <Modal title="Confirm changes" onClose={() => setConfirm(null)}><p className="fp-msg">These sensors will be removed from or moved in the gateway:</p>
      <ul className="fp-list">{confirm.confirm.map((c: any, i: number) => <li key={i}><span>{c.kind.toUpperCase()} {c.serial}</span><span className="fp-muted">slot {c.slot + 1}</span></li>)}</ul>
      <div className="fp-row"><button className="fp-btn primary" onClick={() => send(true)}>Confirm and send</button><button className="fp-btn" onClick={() => setConfirm(null)}>Cancel</button></div></Modal>}
  </>);
}

function AddModal({ types, pattern, onClose, onDone }: { types: TypeInfo[]; pattern: string; onClose: () => void; onDone: (n: number) => void }) {
  const [type, setType] = useState(types[0]?.key ?? "th"); const [text, setText] = useState(""); const [err, setErr] = useState(""); const [scan, setScan] = useState(false);
  const t = types.find((x) => x.key === type)!; const serials = text.split(/[\s,;]+/).filter(Boolean); const re = new RegExp(pattern);
  const badOnes = serials.filter((s) => !re.test(s)); const dup = serials.length !== new Set(serials.map((s) => s.toUpperCase())).size;
  const onCode = useCallback((c: string) => setText((x) => (x.toUpperCase().includes(c.trim().toUpperCase()) ? x : (x ? x + "\n" : "") + c.trim())), []);
  return (
    <Modal title="Add sensors" onClose={onClose}>
      <label className="fp-field"><span className="fp-cap">Sensor type</span><select className="fp-input" value={type} onChange={(e) => setType(e.target.value)}>{types.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
      <label className="fp-field"><span className="fp-cap">Serials, one per line (paste a list or type)</span><textarea className="fp-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="4A01B3F2" spellCheck={false} /></label>
      {scanSupported() ? (scan ? <Scan onCode={onCode} onClose={() => setScan(false)} /> : <button className="fp-btn" onClick={() => setScan(true)}>Scan QR / barcode</button>) : <span className="fp-cap" style={{ textTransform: "none" }}>Camera scan is not available in this browser: type or paste the serials.</span>}
      <span className="fp-num">{t.label}: {t.used} of {t.groups} slots used, adding {serials.length}</span>
      {badOnes.length > 0 && <p className="fp-msg err">Not a valid serial (8 hex digits): {badOnes.slice(0, 3).join(", ")}{badOnes.length > 3 ? "..." : ""}</p>}{dup && <p className="fp-msg err">The list contains duplicates.</p>}
      {t.used + serials.length > t.groups && <p className="fp-msg err">This would exceed {t.groups} slots.</p>}{err && <p className="fp-msg err" role="alert">{err}</p>}
      <div className="fp-row"><button className="fp-btn primary" disabled={!serials.length || badOnes.length > 0 || dup || t.used + serials.length > t.groups} onClick={() => api("/sensors", { method: "POST", json: { type, serials } }).then(() => onDone(serials.length)).catch((e) => setErr(errText(e)))}>Add {serials.length || ""} sensor{serials.length === 1 ? "" : "s"}</button><button className="fp-btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
