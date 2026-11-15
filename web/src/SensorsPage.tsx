import { useCallback, useEffect, useState } from "react";
import { api, type Scada, type SensorView, type TypeInfo } from "./api";
import { go } from "./App";
import Scan, { scanSupported } from "./Scan";
import { Battery, Chip, CommissioningBanner, Modal, Signal, SYNC, StatusChip, ago, dt, dur, errText } from "./ui";

export const linkText = (l: GwInfo["link"]) => (!l ? "no link configured" : l.transport === "rtu-serial" ? `${l.serialPath} · ${l.baud} 8${l.parity === "none" ? "N" : l.parity === "even" ? "E" : "O"}1` : `${l.transport === "tcp" ? "Modbus TCP" : "RTU over TCP"} ${l.host}:${l.port}`);
export interface GwInfo { link: null | { transport: string; host: string; port: number; serialPath: string; baud: number; parity: string; dataBits: number; stopBits: number; address: number; timeoutMs: number; retries: number }; enabled: boolean; online: boolean; lastOk: number | null; lastError: string | null; model: string; mapVersion: number; info: { address?: number; version?: number }; types: TypeInfo[]; unsent: number;
  pending: { type: string; serial: string; slot: number | null }[]; lastSync: { type: string; ok: boolean; at: number; items: { serial: string; slot: number; action: string; status: string; reason?: string }[] } | null;
  unassigned: { type: string; slot: number; serial: string; interval: number }[]; syncing: boolean; settings: { pollSec: number } }
interface SList { types: TypeInfo[]; sensors: SensorView[]; zones: { id: number; name: string }[]; pattern: string; }

export default function SensorsPage({ scada, reload }: { scada: Scada | null; reload: () => void }) {
  const [list, setList] = useState<SList | null>(null); const [gw, setGw] = useState<GwInfo | null>(null);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null); const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false); const [confirm, setConfirm] = useState<any>(null);
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
  // Only the server's allowed set is offered (T/H: 1 min, 5 min; plus 30 s in commissioning mode). The server rejects anything else.
  const setInterval_ = async (s: SensorView, v: string) => { try { await api(`/sensors/${s.serial}`, { method: "PATCH", json: { interval: Number(v) } }); load(); } catch (e) { fail(e); } };
  const presets = (s: SensorView) => { const t = list.types.find((x) => x.key === s.type)!; return [...new Set([...t.presets, s.intervalSec])].sort((a, b) => a - b); };   // a stored value that is no longer allowed is still shown, and flagged
  const setCommissioning = async (on: boolean) => { try { await api("/gateway/settings", { method: "PUT", json: { commissioning: on } }); load(); } catch (e) { fail(e); } };
  const changes = sensors.filter((s) => s.syncState !== "in_gateway");
  const interval = (s: SensorView) => (
    <span className="stack"><select className="fp-input" aria-label={`Interval for ${s.label}`} value={s.intervalSec} onChange={(e) => setInterval_(s, e.target.value)}>{presets(s).map((p) => <option key={p} value={p}>{dur(p)}{s.intervalOk || p !== s.intervalSec ? "" : " (not allowed)"}</option>)}</select>{!s.intervalOk && <Chip tone="warn" title="This stored value is not in the allowed set. Choose an allowed interval.">NOT ALLOWED</Chip>}{s.applying && <Chip tone="info">APPLYING</Chip>}</span>);
  return (<>
    {th?.commissioning && <CommissioningBanner until={scada?.commissioning?.until ?? null} onOff={() => setCommissioning(false)} />}
    <section className="fp-card">
      <div className="fp-row fp-spread"><div><h3>Gateway</h3><span className="fp-cap">{gw.model} · {linkText(gw.link)} · address {gw.info.address ?? "--"} · map v{gw.mapVersion} · poll {gw.settings.pollSec} s</span></div>
        {!gw.enabled ? <Chip tone="off">NO GATEWAY</Chip> : gw.online ? <Chip tone="ok">GATEWAY ONLINE</Chip> : <Chip tone="alarm">GATEWAY OFFLINE</Chip>}</div>
      {th && <div className="fp-field"><span className="fp-cap">T/H sensors: {th.used} of {th.groups} slots in gateway</span><div className="fp-progress" role="progressbar" aria-valuenow={th.used} aria-valuemax={th.groups}><b style={{ width: `${(th.used / th.groups) * 100}%` }} /></div></div>}
      <div className="fp-row fp-spread"><span className="fp-num">{gw.unsent + 0} change{gw.unsent === 1 ? "" : "s"} not sent{gw.lastSync ? ` · last sync ${dt(gw.lastSync.at)} ${gw.lastSync.ok ? "OK" : "FAILED"}` : ""}</span>
        <button className="fp-btn primary" disabled={busy || offline || gw.syncing} onClick={() => send(false)}>{busy ? "Sending..." : "Send to gateway"}</button></div>
      {offline && <p className="fp-msg err">Gateway is offline. Sending is disabled until it answers again.{gw.lastError ? ` (${gw.lastError})` : ""}</p>}
      {msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}
    </section>
    <div className="fp-two"><section className="fp-card">
      <div className="fp-row fp-spread"><h3>Sensors</h3><div className="fp-row"><button className="fp-btn" onClick={() => setAdding(true)}>Add sensors</button>{scanSupported() && <button className="fp-btn" onClick={() => setAdding(true)}>Scan QR</button>}</div></div>
      <span className="fp-hint">Click a row to open the sensor: label, zone, calibration, replace and remove are all on its page.</span>
      <label className="fp-row fp-cap" style={{ textTransform: "none", letterSpacing: ".02em" }}><input type="checkbox" checked={!!th?.commissioning} onChange={(e) => setCommissioning(e.target.checked)} /> Commissioning mode (switches off by itself after 8 hours): also allow {(th?.commissioningPresets ?? []).map((p) => dur(p)).join(", ") || "short intervals"} (short intervals reduce battery life). Allowed otherwise: {(th?.presets ?? []).filter((p) => !(th?.commissioningPresets ?? []).includes(p)).map(dur).join(", ")}.</label>
      <div className="fp-gt" role="table" aria-label="Sensors">
        <div className="fp-gr head" role="row"><span>Slot</span><span>Serial</span><span>Label / zone</span><span>Interval</span><span>Battery / signal</span><span>State</span><span /></div>
        {sensors.map((s) => (
          <div key={s.serial} role="row" className="fp-gr click" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
            <span>{s.slot ?? "--"}</span><span>{s.serial}</span>
            <span className="stack"><span className="nm">{s.labelSet ? s.label : <span className="fp-muted" style={{ fontWeight: 500 }}>No label</span>}</span><span className="fp-muted">{list.zones.find((z) => z.id === s.zoneId)?.name ?? "No zone"}</span></span>
            <span onClick={(e) => e.stopPropagation()}>{interval(s)}</span>
            <span className="stack"><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /></span>
            <span className="stack"><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip><StatusChip status={s.status} />{s.calDue && <Chip tone="warn">CAL DUE</Chip>}</span>
            <button className="fp-btn small" aria-label={`Calibrate ${s.label}`} onClick={(e) => { e.stopPropagation(); go(`/settings/sensors/${s.serial}/calibrate`); }}>Calibrate</button>
          </div>))}
      </div>
      <div className="fp-cards">{sensors.map((s) => (
        <div key={s.serial} className="fp-srow" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
          <span className="l">{s.labelSet ? s.label : "No label"}</span><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip>
          <span className="m"><span>slot {s.slot ?? "--"}</span><span>{s.serial}</span><span>{list.zones.find((z) => z.id === s.zoneId)?.name ?? "no zone"}</span></span>
          <span className="m" onClick={(e) => e.stopPropagation()}>{interval(s)}</span><span className="m"><StatusChip status={s.status} /><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /></span>
          <span className="m" onClick={(e) => e.stopPropagation()}><button className="fp-btn small" onClick={() => go(`/settings/sensors/${s.serial}/calibrate`)}>Calibrate</button><button className="fp-btn small" onClick={() => go(`/settings/sensors/${s.serial}`)}>Details</button></span></div>))}</div>
      {!sensors.length && <p className="fp-msg fp-muted">No sensors yet. Press ADD SENSORS and type or paste the serials.</p>}
    </section>
    <div className="fp-sidecards">
      <section className="fp-card"><h3>Will be sent</h3>
        {!changes.length && !gw.pending.length ? <span className="fp-msg fp-muted">Nothing to send.</span> : <ul className="fp-list">
          {changes.map((s) => <li key={s.serial}><span>{s.syncState === "not_sent" ? "ADD" : "CHANGE"} {s.serial}</span><span className="fp-muted">{s.syncState === "not_sent" ? `slot ${s.slot}, ${dur(s.intervalSec)}` : `${dur(s.sentInterval ?? 0)} → ${dur(s.intervalSec)}`}</span></li>)}
          {gw.pending.map((p) => <li key={p.serial}><span>REMOVE {p.serial}</span><span className="fp-muted">slot {p.slot}</span></li>)}</ul>}
        <span className="fp-cap" style={{ textTransform: "none" }}>Polling pauses for about 10 s. Every write is read back.</span></section>
      <section className="fp-card"><h3>Result of last send</h3>
        {!gw.lastSync ? <span className="fp-msg fp-muted">No send yet.</span> : <ul className="fp-list">{gw.lastSync.items.map((i, k) => <li key={k}><span>{i.serial}</span><Chip tone={i.status === "confirmed" ? "ok" : "alarm"}>{i.status === "confirmed" ? "CONFIRMED" : `FAILED${i.reason ? ": " + i.reason.toUpperCase() : ""}`}</Chip></li>)}{!gw.lastSync.items.length && <li className="fp-muted">Nothing needed writing; gateway already matched.</li>}</ul>}
        {gw.lastSync && <span className="fp-cap">{ago(gw.lastSync.at)}</span>}</section>
      {gw.unassigned.length > 0 && <section className="fp-card"><h3>New sensor found</h3><span className="fp-msg">Configured in the gateway but not in CORE. Never added automatically.</span>
        <ul className="fp-list">{gw.unassigned.map((u) => <li key={u.serial}><span>{u.serial} · slot {u.slot} · {dur(u.interval)}</span><span className="fp-row">
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/add", { method: "POST", json: { serial: u.serial } }).then(() => { load(); reload(); }).catch(fail)}>Add</button>
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/ignore", { method: "POST", json: { serial: u.serial } }).then(load).catch(fail)}>Ignore</button></span></li>)}</ul></section>}
    </div></div>
    {adding && <AddModal types={list.types} pattern={list.pattern} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); ok(`${n} sensor(s) added. Press SEND TO GATEWAY to push them.`); load(); reload(); }} />}
    {confirm && <Modal title="Confirm changes" onClose={() => setConfirm(null)}><p className="fp-msg">These sensors will be removed from or moved in the gateway:</p>
      <ul className="fp-list">{confirm.confirm.map((c: any, i: number) => <li key={i}><span>{c.kind.toUpperCase()} {c.serial}</span><span className="fp-muted">slot {c.slot}</span></li>)}</ul>
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
