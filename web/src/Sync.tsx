import { useCallback, useEffect, useState } from "react";
import { api, type AdminSensor, type Scada, type TypeInfo } from "./api";
import { Chip, Modal, ago, dt, dur, mdur, errText } from "./ui";

const ACTION: Record<string, string> = { add: "ADDED", interval: "INTERVAL CHANGED", move: "MOVED", replace: "REPLACED", remove: "REMOVED", clear: "CLEARED" };
export const linkText = (l: GwInfo["link"]) => (!l ? "no link configured" : l.transport === "rtu-serial" ? `${l.serialPath} · ${l.baud} 8${l.parity === "none" ? "N" : l.parity === "even" ? "E" : "O"}1` : `${l.transport === "tcp" ? "Modbus TCP" : "RTU over TCP"} ${l.host}:${l.port}`);
export interface GwInfo { link: null | { transport: string; host: string; port: number; serialPath: string; baud: number; parity: string; dataBits: number; stopBits: number; address: number; timeoutMs: number; retries: number }; enabled: boolean; online: boolean; lastOk: number | null; lastError: string | null; model: string; mapVersion: number; info: { address?: number; groupAddress?: number; version?: number }; types: TypeInfo[]; unsent: number;
  pending: { type: string; serial: string; slot: number | null }[]; lastSync: { type: string; ok: boolean; at: number; items: { serial: string; slot: number; action: string; status: string; reason?: string; interval?: number }[] } | null;
  unassigned: { type: string; slot: number; serial: string; interval: number }[]; syncing: boolean; settings: { pollSec: number } }
export interface SList { types: TypeInfo[]; sensors: AdminSensor[]; zones: { id: number; name: string }[]; pattern: string; }
/** One Send to Gateway job, one state, used by Settings > Sensors Gateway and Settings > Sensors. */
export function useSync(scada: Scada | null, reload: () => void) {
  const [list, setList] = useState<SList | null>(null); const [gw, setGw] = useState<GwInfo | null>(null);
  const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<any>(null);
  const load = useCallback(() => { api<SList>("/sensors").then(setList).catch((e) => setMsg({ t: "err", s: errText(e) })); api<GwInfo>("/gateway").then(setGw).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, scada]);
  const ok = (s: string) => setMsg({ t: "ok", s }); const fail = (e: unknown) => setMsg({ t: "err", s: errText(e) });
  const send = async (confirmed = false) => {
    setBusy(true); setMsg(null);
    try { const r = await api<any[]>("/gateway/sync", { method: "POST", json: { types: ["th"], confirm: confirmed } }); setConfirm(null); const bad = r.flatMap((x) => x.items).filter((i: any) => i.status === "failed").length; bad ? fail(`${bad} item(s) failed, see RESULT OF LAST SEND`) : ok("Sent and confirmed by read-back."); }
    catch (e: any) { if (e.status === 409 && /confirmation required/.test(e.message)) { const p = await api<any>("/gateway/sync/plan", { method: "POST", json: { type: "th" } }).catch(() => null); setConfirm(p); } else fail(e); }
    finally { setBusy(false); load(); reload(); }
  };
  return { list, gw, msg, setMsg, busy, confirm, setConfirm, send, load, ok, fail, reload };
}
export type Sync = ReturnType<typeof useSync>;

/** Changes count, last sync and the SEND TO GATEWAY button (56 px), disabled with a message while the gateway is offline. */
export function SendBar({ s }: { s: Sync }) {
  const { gw, busy, send, msg } = s; if (!gw) return null; const offline = !gw.online;
  return (<>
    <div className="fp-row fp-spread"><span className="fp-num">{gw.unsent + 0} change{gw.unsent === 1 ? "" : "s"} not sent{gw.lastSync ? ` · last sync ${dt(gw.lastSync.at)} ${gw.lastSync.ok ? "OK" : "FAILED"}` : ""}</span>
      <button className="fp-btn primary" style={{ minHeight: 56 }} disabled={busy || offline || gw.syncing} onClick={() => send(false)}>{busy ? "Sending..." : "Send to gateway"}</button></div>
    {offline && <p className="fp-msg err">Gateway is offline. Sending is disabled until it answers again.{gw.lastError ? ` (${gw.lastError})` : ""}</p>}
    {msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}
  </>);
}

export function SyncCards({ s }: { s: Sync }) {
  const { gw, list, load, reload, fail } = s; if (!gw || !list) return null; const sensors = list.sensors; const changes = sensors.filter((x) => x.syncState !== "in_gateway");
  return (<>
      <section className="fp-card"><h3>Will be sent</h3>
        {!changes.length && !gw.pending.length ? <span className="fp-msg fp-muted">Nothing to send.</span> : <ul className="fp-list">
          {changes.map((s) => <li key={s.serial}><span>{s.syncState === "not_sent" ? "ADD" : "CHANGE"} {s.serial}</span><span className="fp-muted">{s.syncState === "not_sent" ? `slot ${s.slot}, ${dur(s.intervalSec)}` : `${mdur(s.sentInterval ?? 0)} → ${dur(s.intervalSec)}`}</span></li>)}
          {gw.pending.map((p) => <li key={p.serial}><span>REMOVE {p.serial}</span><span className="fp-muted">slot {p.slot}</span></li>)}</ul>}
        <span className="fp-cap" style={{ textTransform: "none" }}>Polling pauses for about 10 s. Every write is read back.</span></section>
      <section className="fp-card"><h3>Result of last send</h3>
        {!gw.lastSync ? <span className="fp-msg fp-muted">No send yet.</span> : <ul className="fp-list">{gw.lastSync.items.map((i, k) => { const known = sensors.find((s) => s.serial === i.serial); return <li key={k}><span className="fp-row" style={{ gap: 8 }}><Chip tone="info">{ACTION[i.action] ?? i.action.toUpperCase()}</Chip><span>{known?.labelSet ? `${known.label} · ` : ""}{i.serial}{i.interval && (i.action === "interval" || i.action === "add") ? ` · ${mdur(i.interval)}` : ""}</span></span><Chip tone={i.status === "confirmed" ? "ok" : "alarm"}>{i.status === "confirmed" ? "CONFIRMED" : `FAILED${i.reason ? ": " + i.reason.toUpperCase() : ""}`}</Chip></li>; })}{!gw.lastSync.items.length && <li className="fp-muted">Nothing needed writing; gateway already matched.</li>}</ul>}
        {gw.lastSync && <span className="fp-cap">{ago(gw.lastSync.at)}</span>}</section>
      {gw.unassigned.length > 0 && <section className="fp-card"><h3>New sensor found</h3><span className="fp-msg">Configured in the gateway but not in CORE. Never added automatically.</span>
        <ul className="fp-list">{gw.unassigned.map((u) => <li key={u.serial}><span>{u.serial} · slot {u.slot} · {mdur(u.interval)}</span><span className="fp-row">
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/add", { method: "POST", json: { serial: u.serial } }).then(() => { load(); reload(); }).catch(fail)}>Add</button>
          <button className="fp-btn small" onClick={() => api("/gateway/unassigned/ignore", { method: "POST", json: { serial: u.serial } }).then(load).catch(fail)}>Ignore</button></span></li>)}</ul></section>}
  </>);
}
export function ConfirmModal({ s }: { s: Sync }) {
  const { confirm, setConfirm, send } = s; if (!confirm) return null;
  return (
    <Modal title="Confirm changes" onClose={() => setConfirm(null)}><p className="fp-msg">These sensors will be removed from or moved in the gateway:</p>
      <ul className="fp-list">{confirm.confirm.map((c: any, i: number) => <li key={i}><span>{c.kind.toUpperCase()} {c.serial}</span><span className="fp-muted">slot {c.slot}</span></li>)}</ul>
      <div className="fp-row"><button className="fp-btn primary" onClick={() => send(true)}>Confirm and send</button><button className="fp-btn" onClick={() => setConfirm(null)}>Cancel</button></div></Modal>
  );
}
