import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, ago, errText, hhmm, useNow, type Tone } from "./ui";
import { AccessBanner, LockedPage, loadAccess, type DsAccess } from "./DataSourceLock";
import "./plc.css";

// Settings > PLC (Data sources, Admin only; PRO or higher). Variant B of core-plc-data-source-page.md (approved 2026-11-18): connection strip on top, DATA ZONES list on the left,
// EDIT DATA ZONE with the points table on the right. READ ONLY: CORE reads the PLC and never writes to it. NO real addresses ship: the zone list starts empty and every address on this page is typed by an Admin.
// Lamp SHAPE plus WORD on every status. Operators never reach this page (the server answers 403).
type Link = "disabled" | "connecting" | "online" | "offline" | "locked";
type ZStatus = "OK" | "NO ANSWER" | "BAD DATA" | "DISABLED" | "NOT READ";
interface Pt { offset: number | string; name: string; type: string; scale: number | string; unit: string; maps_to: string; value?: number | null }
interface Req { fc: number; offset: number; end: number; length: number; plcStart: number | null; plcEnd: number | null; chunks: { fc: number; offset: number; count: number }[] }
interface Zone { id: number; code: string; name: string; farm_zone_id: number | null; area: string; start: number; length: number; style: string; enabled: boolean; request: Req | null; error: string | null; status: ZStatus; reason: string | null; lastAt: number | null; points: Pt[] }
interface View {
  access: DsAccess; config: { enabled: boolean; protocol: "tcp" | "rtu" | "other"; host: string; port: number; unit: number; rtu_port_id: number | null; poll_s: number; timeout_ms: number; word_order: "big" | "little" };
  status: { link: Link; lastPollAt: number | null; failedCycles: number; lastPollAgeS: number | null }; zones: Zone[]; ports: { id: number; name: string }[]; farm_zones: { id: number; name: string }[]; note: string;
}
const LAMP: Record<Link, { shape: string; word: string; tone: Tone }> = { online: { shape: "circle", word: "PLC ONLINE", tone: "ok" }, connecting: { shape: "triangle", word: "CONNECTING", tone: "warn" }, offline: { shape: "square", word: "OFFLINE", tone: "alarm" }, disabled: { shape: "ring", word: "DISABLED", tone: "off" }, locked: { shape: "ring", word: "LOCKED", tone: "off" } };
const ZS: Record<ZStatus, Tone> = { OK: "ok", "NO ANSWER": "alarm", "BAD DATA": "warn", DISABLED: "off", "NOT READ": "off" };
const PROTO: Record<string, string> = { tcp: "MODBUS TCP", rtu: "MODBUS RTU", other: "OTHER" };
const AREAS: [string, string][] = [["holding", "Holding registers"], ["input", "Input registers"], ["coils", "Coils"], ["discrete", "Discrete inputs"]];
const TYPES = ["INT16", "UINT16", "INT32", "UINT32", "FLOAT32", "BOOL"];
interface Draft { id: number | null; name: string; farm_zone_id: string; area: string; style: string; start: string; length: string; enabled: boolean; points: Pt[]; dirty: boolean }
const draftOf = (z: Zone | null): Draft => z ? { id: z.id, name: z.name, farm_zone_id: z.farm_zone_id === null ? "" : String(z.farm_zone_id), area: z.area, style: z.style, start: String(z.start), length: String(z.length), enabled: z.enabled, points: z.points.map((p) => ({ ...p })), dirty: false }
  : { id: null, name: "", farm_zone_id: "", area: "holding", style: "plc", start: "", length: "10", enabled: true, points: [], dirty: true };

export default function PlcPage() {
  const [v, setV] = useState<View | null>(null); const [err, setErr] = useState(""); const now = useNow(1000); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null);
  const [sel, setSel] = useState<number | "new" | null>(null); const [d, setD] = useState<Draft | null>(null); const [open, setOpen] = useState(false); const [showConn, setShowConn] = useState(false);
  const [conn, setConn] = useState<Record<string, string> | null>(null); const [read, setRead] = useState<any>(null); const [acc, setAcc] = useState<DsAccess | null>(null);
  const load = useCallback(async () => { try { const x = await api<View>("/plc"); setV(x); setAcc(x.access); setErr(""); } catch (e) { setErr(errText(e)); } }, []);
  useEffect(() => { void load(); const i = setInterval(() => void load(), 3000); return () => clearInterval(i); }, [load]);
  useEffect(() => { loadAccess().then(setAcc).catch(() => {}); }, []);
  useEffect(() => { if (!v) return; const z = typeof sel === "number" ? v.zones.find((x) => x.id === sel) ?? null : null; if (sel === "new") setD((cur) => (cur && cur.id === null ? cur : draftOf(null))); else if (z) setD((cur) => (cur && cur.id === z.id && cur.dirty ? cur : draftOf(z))); else if (sel === null && v.zones.length) setSel(v.zones[0].id); }, [v, sel]);
  const say = (t: "ok" | "err", s: string) => setMsg({ t, s });
  const run = async (key: string, f: () => Promise<void>) => { setBusy(key); setMsg(null); try { await f(); } catch (e) { say("err", errText(e)); } finally { setBusy(null); } };
  if (err && !v) return <section className="fp-card pl"><p className="fp-msg err">{err}</p></section>;
  if (!v || !acc) return <section className="fp-card pl"><p className="fp-msg">Loading...</p></section>;
  if (acc.state === "locked") return <LockedPage title="PLC" message={acc.message ?? ""} />;
  const frozen = acc.state === "stopped", c = v.config, st = v.status, lamp = LAMP[st.link], zone = typeof sel === "number" ? v.zones.find((z) => z.id === sel) ?? null : null;
  const setC = (p: Record<string, string>) => setConn((x) => ({ ...(x ?? { protocol: c.protocol, host: c.host, port: String(c.port), unit: String(c.unit), rtu_port_id: c.rtu_port_id === null ? "" : String(c.rtu_port_id), poll_s: String(c.poll_s), timeout_ms: String(c.timeout_ms), word_order: c.word_order }), ...p }));
  const cf = conn ?? { protocol: c.protocol, host: c.host, port: String(c.port), unit: String(c.unit), rtu_port_id: c.rtu_port_id === null ? "" : String(c.rtu_port_id), poll_s: String(c.poll_s), timeout_ms: String(c.timeout_ms), word_order: c.word_order };
  const saveConn = () => run("conn", async () => { const r = await api<View>("/plc/config", { method: "PUT", json: { protocol: cf.protocol, host: cf.host, port: Number(cf.port), unit: Number(cf.unit), rtu_port_id: cf.rtu_port_id === "" ? null : Number(cf.rtu_port_id), poll_s: Number(cf.poll_s), timeout_ms: Number(cf.timeout_ms), word_order: cf.word_order } }); setV(r); setConn(null); say("ok", "Connection settings saved."); });
  const toggle = () => run("enable", async () => { setV(await api<View>("/plc/enabled", { method: "POST", json: { enabled: !c.enabled } })); });
  const test = () => run("test", async () => { const r = await api<{ ok: boolean; message: string }>("/plc/test", { method: "POST", json: {} }); say(r.ok ? "ok" : "err", (r.ok ? "TEST OK. " : "TEST FAILED. ") + r.message); });
  const upd = (p: Partial<Draft>) => setD((x) => x && { ...x, ...p, dirty: true });
  const setPt = (i: number, p: Partial<Pt>) => d && upd({ points: d.points.map((q, j) => (j === i ? { ...q, ...p } : q)) });
  const body = () => d && ({ name: d.name, farm_zone_id: d.farm_zone_id === "" ? null : Number(d.farm_zone_id), area: d.area, style: d.style, start: Number(d.start), length: Number(d.length), enabled: d.enabled, points: d.points.map((p) => ({ ...p, offset: Number(p.offset), scale: Number(p.scale) })) });
  const saveZone = () => run("zone", async () => { if (!d) return; const r = await api<View>(d.id === null ? "/plc/zones" : "/plc/zones/" + d.id, { method: d.id === null ? "POST" : "PUT", json: body() }); setV(r); if (d.id === null) setSel(r.zones[r.zones.length - 1].id); setD(null); say("ok", "Data zone saved."); });
  const delZone = () => run("zone", async () => { if (!d || d.id === null || !confirm(`Delete data zone ${zone?.code}?`)) return; setV(await api<View>("/plc/zones/" + d.id, { method: "DELETE" })); setSel(null); setD(null); setOpen(false); say("ok", "Data zone deleted."); });
  const readNow = () => run("read", async () => { if (d?.id == null) return; setRead(await api<any>(`/plc/zones/${d.id}/read`, { method: "POST", json: {} })); });
  const req = zone?.request, Msg = () => (msg ? <p className={"fp-msg" + (msg.t === "err" ? " err" : "")} role="status">{msg.s}</p> : null);

  return (
    <fieldset className="pl" data-testid="plc-page" disabled={frozen}>
      <AccessBanner a={acc} />
      <section className="fp-card" aria-label="PLC connection"><div className="pl-strip">
        <span className="pl-lamp" data-tone={lamp.tone} data-testid="plc-state"><span className="pl-shape" data-shape={lamp.shape} aria-hidden />{lamp.word}</span>
        <dl className="pl-facts">
          <div><dt className="fp-cap">PROTOCOL</dt><dd className="pl-num">{PROTO[c.protocol]}</dd></div>
          <div><dt className="fp-cap">{c.protocol === "rtu" ? "RS-485 PORT · UNIT" : "ADDRESS · UNIT"}</dt><dd className="pl-num">{c.protocol === "rtu" ? `${v.ports.find((p) => p.id === c.rtu_port_id)?.name ?? "no port"} · ${c.unit}` : c.host ? `${c.host}:${c.port} · ${c.unit}` : "not set"}</dd></div>
          <div><dt className="fp-cap">POLL EVERY</dt><dd className="pl-num">{c.poll_s} s</dd></div>
          <div><dt className="fp-cap">LAST POLL</dt><dd className="pl-num">{ago(st.lastPollAt, now)}</dd></div>
        </dl>
        <span className="fp-row pl-btns">
          <button className={"fp-btn " + (c.enabled ? "stop" : "go")} aria-pressed={c.enabled} disabled={busy !== null} onClick={toggle}>{c.enabled ? "DISABLE" : "ENABLE"}</button>
          <button className="fp-btn" aria-expanded={showConn} onClick={() => setShowConn(!showConn)}>CONNECTION SETTINGS</button>
          <button className="fp-btn" disabled={busy !== null} onClick={test}>TEST</button>
        </span>
      </div>
        {showConn && <div className="pl-form" style={{ marginTop: 16 }}>
          <label>Protocol<select className="fp-input" value={cf.protocol} onChange={(e) => setC({ protocol: e.target.value })}><option value="tcp">Modbus TCP</option><option value="rtu">Modbus RTU</option><option value="other">OTHER (not available yet)</option></select></label>
          {cf.protocol === "tcp" && <><label>PLC address<input className="fp-input" value={cf.host} onChange={(e) => setC({ host: e.target.value })} autoComplete="off" /></label><label>Port<input className="fp-input" inputMode="numeric" value={cf.port} onChange={(e) => setC({ port: e.target.value })} /></label></>}
          {cf.protocol === "rtu" && <label>RS-485 port<select className="fp-input" value={cf.rtu_port_id} onChange={(e) => setC({ rtu_port_id: e.target.value })}><option value="">Choose a port</option>{v.ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <label>Unit or station ID<input className="fp-input" inputMode="numeric" value={cf.unit} onChange={(e) => setC({ unit: e.target.value })} /></label>
          <label>Poll every (s)<input className="fp-input" inputMode="numeric" value={cf.poll_s} onChange={(e) => setC({ poll_s: e.target.value })} /></label>
          <label>Timeout (ms)<input className="fp-input" inputMode="numeric" value={cf.timeout_ms} onChange={(e) => setC({ timeout_ms: e.target.value })} /></label>
          <label>32-bit word order<select className="fp-input" value={cf.word_order} onChange={(e) => setC({ word_order: e.target.value })}><option value="big">Big-endian words (default)</option><option value="little">Little-endian words</option></select></label>
          <span className="fp-row"><button className="fp-btn primary" disabled={busy !== null} onClick={saveConn}>SAVE</button></span>
        </div>}
        <Msg />
      </section>

      <div className="pl-cols" data-open={open ? "1" : "0"}>
        <section className="fp-card pl-listcard" aria-label="Data zones"><h3>DATA ZONES</h3>
          {v.zones.length === 0 && <p className="fp-msg">No data zones yet. Add one and type the address the PLC documentation gives.</p>}
          <ul className="pl-list">{v.zones.map((z) => <li key={z.id}><button className="fp-btn pl-zone" aria-pressed={sel === z.id} onClick={() => { setSel(z.id); setD(draftOf(z)); setRead(null); setOpen(true); }}>
            <span className="pl-zh"><strong className="pl-num">{z.code}</strong><Chip tone={ZS[z.status]}>{z.status}</Chip></span><span>{z.name}</span>
            <span className="fp-cap">{AREAS.find(([k]) => k === z.area)?.[1]} · {z.start} · {z.length} reg · {v.farm_zones.find((f) => f.id === z.farm_zone_id)?.name ?? "Not assigned"}</span></button></li>)}</ul>
          <button className="fp-btn" onClick={() => { setSel("new"); setD(draftOf(null)); setRead(null); setOpen(true); }}>+ ADD DATA ZONE</button>
        </section>

        <section className="fp-card pl-editor" aria-label="Edit data zone">
          <button className="fp-btn small pl-back" onClick={() => setOpen(false)}>&larr; BACK TO ZONES</button>
          <h3>EDIT DATA ZONE {d?.dirty && <Chip tone="warn">CHANGED</Chip>}</h3>
          {!d ? <p className="fp-msg">Select a data zone or add one.</p> : <>
            <div className="pl-form">
              <label>Name<input className="fp-input" value={d.name} onChange={(e) => upd({ name: e.target.value })} /></label>
              <label>Farm zone<select className="fp-input" value={d.farm_zone_id} onChange={(e) => upd({ farm_zone_id: e.target.value })}><option value="">Not assigned</option>{v.farm_zones.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
              <label>Area<select className="fp-input" value={d.area} onChange={(e) => upd({ area: e.target.value })}>{AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label>Address style<select className="fp-input" value={d.style} onChange={(e) => upd({ style: e.target.value })}><option value="plc">PLC style (40001 = first)</option><option value="protocol">Protocol style (0 = first)</option></select></label>
              <label>Start address<input className="fp-input" inputMode="numeric" value={d.start} onChange={(e) => upd({ start: e.target.value })} /></label>
              <label>Length (registers or bits)<input className="fp-input" inputMode="numeric" value={d.length} onChange={(e) => upd({ length: e.target.value })} /></label>
            </div>
            {zone && !d.dirty && <div className="pl-calc" data-testid="plc-request">
              {req ? <><span className="fp-cap">END ADDRESS</span><span className="pl-num">{d.style === "plc" && req.plcEnd !== null ? req.plcEnd : req.end}</span><span className="fp-cap">REQUEST</span><span className="pl-num">{req.chunks.map((k) => `FC${String(k.fc).padStart(2, "0")} offset ${k.offset} count ${k.count}`).join(" + ")}</span></> : <span className="fp-msg err">{zone.error}</span>}
              <span className="fp-cap">LAST READ</span><span className="pl-num">{zone.lastAt ? hhmm(zone.lastAt) : "--"}</span>{zone.reason && <span className="fp-msg err">{zone.reason}</span>}
              <button className="fp-btn small" disabled={busy !== null || c.protocol === "other"} onClick={readNow}>READ ZONE NOW</button></div>}
            {read && <div className="pl-calc" data-testid="plc-read">{read.ok ? <><span className="fp-cap">RAW (not stored)</span><span className="pl-raw">{read.raw.join(" ")}</span></> : <span className="fp-msg err">{read.status}: {read.reason}</span>}</div>}
            <div className="pl-scroll"><table className="fp-table"><thead><tr><th>OFFSET</th><th>POINT NAME</th><th>TYPE</th><th>SCALE</th><th>UNIT</th><th>LIVE</th><th>MAPS TO</th><th /></tr></thead><tbody>
              {d.points.length === 0 && <tr><td colSpan={8}>No points. Add one for each value you want to keep.</td></tr>}
              {d.points.map((p, i) => <tr key={i}>
                <td><input className="fp-input pl-cell" aria-label={`offset ${i + 1}`} inputMode="numeric" value={String(p.offset)} onChange={(e) => setPt(i, { offset: e.target.value })} /></td>
                <td><input className="fp-input pl-cell" aria-label={`name ${i + 1}`} value={p.name} onChange={(e) => setPt(i, { name: e.target.value })} /></td>
                <td><select className="fp-input pl-cell" aria-label={`type ${i + 1}`} value={p.type} onChange={(e) => setPt(i, { type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
                <td><input className="fp-input pl-cell" aria-label={`scale ${i + 1}`} value={String(p.scale)} onChange={(e) => setPt(i, { scale: e.target.value })} /></td>
                <td><input className="fp-input pl-cell" aria-label={`unit ${i + 1}`} value={p.unit} onChange={(e) => setPt(i, { unit: e.target.value })} /></td>
                <td className="pl-num">{p.value === null || p.value === undefined ? "--" : Number(p.value.toFixed(3))}</td>
                <td><input className="fp-input pl-cell" aria-label={`maps to ${i + 1}`} placeholder="farm point" value={p.maps_to} onChange={(e) => setPt(i, { maps_to: e.target.value })} /></td>
                <td><button className="fp-btn small" aria-label={`Remove point ${i + 1}`} onClick={() => d && upd({ points: d.points.filter((_, j) => j !== i) })}>REMOVE</button></td></tr>)}
            </tbody></table></div>
            <div className="fp-row pl-btns">
              <button className="fp-btn" onClick={() => upd({ points: [...d.points, { offset: d.points.length ? Number(d.points[d.points.length - 1].offset) + 1 : 0, name: "", type: "UINT16", scale: 1, unit: "", maps_to: "" }] })}>+ ADD POINT</button>
              {d.id !== null && <button className="fp-btn danger" disabled={busy !== null} onClick={delZone}>DELETE ZONE</button>}
              <button className="fp-btn" disabled={!d.dirty} onClick={() => { setD(draftOf(zone)); setSel(zone?.id ?? null); }}>REVERT</button>
              <button className="fp-btn primary" disabled={busy !== null || !d.dirty || !d.name.trim()} onClick={saveZone}>SAVE ZONE</button>
            </div></>}
        </section>
      </div>
      <p className="fp-cap" data-testid="plc-note">{v.note}</p>
    </fieldset>
  );
}
