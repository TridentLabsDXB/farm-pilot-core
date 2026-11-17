import { useEffect, useState } from "react";
import { api } from "./api";
import { ConfirmModal, SendBar, SyncCards, linkText, useSync } from "./Sync";
import type { Scada } from "./api";
import { Chip, Modal, dt, errText } from "./ui";
import { go } from "./App";
import { SectionReads } from "./SectionRead";

export default function GatewayPage({ scada, reload }: { scada: Scada | null; reload: () => void }) {
  const S = useSync(scada, reload); const th = S.list?.types.find((t) => t.key === "th");
  const [addr, setAddr] = useState(""); const [setA, setSetA] = useState(false); const [addrTxt, setAddrTxt] = useState("");
  const [g, setG] = useState<any>(null); const [msg, setMsg] = useState<{ t: string; s: string } | null>(null); const [f, setF] = useState<any>({}); const [del, setDel] = useState(false); const [txt, setTxt] = useState("");
  const [to, setTo] = useState("10"); const [farm, setFarm] = useState(""); const [toMsg, setToMsg] = useState<{ t: string; s: string } | null>(null);
  const load = () => api<any>("/gateway").then((x) => { setG(x); setF({ pollSec: x.settings.pollSec, tOff: x.settings.limits.temperature.maxOffset, hOff: x.settings.limits.humidity.maxOffset }); });
  useEffect(() => { load(); api<{ commandTimeoutSec: number }>("/state").then((s) => setTo(String(s.commandTimeoutSec))); api<{ farm_name: string }>("/farm-profile/public").then((p) => setFarm(p.farm_name)); }, []);
  if (!g) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const save = () => api("/gateway/settings", { method: "PUT", json: { pollSec: +f.pollSec,
    limits: { temperature: { ...g.settings.limits.temperature, maxOffset: +f.tOff }, humidity: { ...g.settings.limits.humidity, maxOffset: +f.hOff } } } }).then(() => { setMsg({ t: "ok", s: "Saved." }); load(); reload(); }).catch((e) => setMsg({ t: "err", s: errText(e) }));
  const fld = (k: string, label: string, hint?: string) => <label className="fp-field"><span className="fp-cap">{label}</span><input className="fp-input" inputMode="decimal" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />{hint && <span className="fp-hint">{hint}</span>}</label>;
  const l = g.link;
  return (<>
    <section className="fp-card"><h3>Send to gateway</h3>
      {th && <div className="fp-field"><span className="fp-cap">T/H sensors: {th.used} of {th.groups} slots in gateway</span><div className="fp-progress" role="progressbar" aria-valuenow={th.used} aria-valuemax={th.groups}><b style={{ width: `${(th.used / th.groups) * 100}%` }} /></div></div>}
      <SendBar s={S} /></section>
    <SectionReads reload={() => { load(); reload(); }} />
    <div className="fp-two"><div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
    <section className="fp-card"><div className="fp-row fp-spread"><h3>Gateway</h3>{!g.enabled ? <Chip tone="off">NO GATEWAY</Chip> : g.online ? <Chip tone="ok">ONLINE</Chip> : <Chip tone="alarm">OFFLINE</Chip>}</div>
      <ul className="fp-list"><li><span>Model</span><span>{g.model} (manual {g.manual})</span></li><li><span>Modbus address / PID (group address)</span><span>{g.info.address ?? "--"} / {g.info.groupAddress ?? "--"}</span></li><li><span>Polling interval</span><span>{g.settings.pollSec} s</span></li><li><span>Register map version</span><span>{g.mapVersion}</span></li><li><span>Version register</span><span>{g.info.version == null ? "--" : "0x" + g.info.version.toString(16).toUpperCase().padStart(4, "0")}</span></li><li><span>Last successful poll</span><span>{dt(g.lastOk)}</span></li>{g.lastError && <li><span>Last error</span><span>{g.lastError}</span></li>}</ul></section>
    <section className="fp-card"><div className="fp-row fp-spread"><h3>Link</h3>{l && <Chip tone={l.enabled ? "info" : "off"}>{l.portLabel}</Chip>}</div>
      {!l ? <p className="fp-msg fp-muted">No gateway link is configured.</p> : <ul className="fp-list">
        <li><span>Port</span><span>Port {l.portId}, {l.transport === "serial" ? l.line : l.transport === "tcp" ? `TCP ${l.host}:${l.port}` : ""}{l.enabled ? "" : !l.portEnabled ? " (switched off: the port is switched off in RS-485 Ports)" : !l.deviceEnabled ? " (switched off: the gateway device is switched off in RS-485 Ports > Devices on ports)" : " (switched off)"}</span></li>
        <li><span>Modbus address</span><span>{l.address}</span></li><li><span>Timeout / retries</span><span>{l.timeoutMs} ms / {l.retries}</span></li></ul>}
      <span className="fp-hint">Read-only summary. The line settings, the port and the address of this device are set in <a className="fp-link" href="#/settings/rs485-ports" onClick={(e) => { e.preventDefault(); go("/settings/rs485-ports"); }}>RS-485 Ports</a>.</span></section>
    <section className="fp-card"><h3>Timing and calibration limits</h3>
      <div className="fp-form"><span className="fp-cap wide">Timing</span>{fld("pollSec", "Modbus poll (s)", "Shortened to half the shortest sensor interval, minimum 10 s.")}<span />
        <span className="fp-cap wide">Calibration limits</span>{fld("tOff", "Max temperature offset (°C)")}{fld("hOff", "Max humidity offset (%RH)")}</div>
      <span className="fp-hint">Battery, signal and "no update" thresholds are farm-wide defaults now: Settings, Farm Profile, Defaults and thresholds.</span>
      <div className="fp-row"><button className="fp-btn primary" onClick={save}>Save</button></div>{msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}</section>
    <section className="fp-card"><h3>Control: pump commands</h3>
      <div className="fp-form"><label className="fp-field"><span className="fp-cap">Acknowledgement timeout (s)</span><input className="fp-input" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} /><span className="fp-hint">3 to 120 seconds.</span></label></div>
      <div className="fp-row"><button className="fp-btn" onClick={() => api("/settings", { method: "PUT", json: { commandTimeoutSec: Number(to) } }).then(() => { setToMsg({ t: "ok", s: "Saved." }); reload(); }).catch((e) => setToMsg({ t: "err", s: errText(e) }))}>Save timeout</button></div>{toMsg && <p className={`fp-msg ${toMsg.t}`} role="status">{toMsg.s}</p>}</section>
    <section className="fp-card"><h3>Danger zone</h3><div className="fp-row"><button className="fp-btn danger" disabled={!g.online} onClick={() => { setAddrTxt(""); setAddr(""); setSetA(true); }}>Set gateway address</button></div><span className="fp-hint">Writes the gateway's own Modbus address to its current address (never a broadcast). Never 123 or 160. Afterwards set GW_ADDRESS in /etc/farmpilot-core.env to the same number, or CORE will look for the old address after a restart.</span><p className="fp-msg">Deletes EVERY sensor configured in the gateway (all types). Sensors stay in CORE and show NOT SENT; press SEND TO GATEWAY to push them again.</p>
      <div className="fp-row"><button className="fp-btn danger" disabled={!g.online} onClick={() => { setTxt(""); setDel(true); }}>Delete all sensors in gateway</button></div>
      {del && <Modal title="Delete all sensors in the gateway?" onClose={() => setDel(false)}><p className="fp-msg err">This cannot be undone from here. Type the farm name <b className="fp-num">{farm}</b> to confirm. The action is written to the audit log.</p><input className="fp-input" value={txt} onChange={(e) => setTxt(e.target.value)} aria-label="Confirmation text" placeholder={farm} autoComplete="off" />
        <div className="fp-row"><button className="fp-btn danger" disabled={!farm || txt !== farm} onClick={() => api("/gateway/delete-all", { method: "POST", json: { confirmText: txt } }).then(() => { setDel(false); setMsg({ t: "ok", s: "Gateway cleared." }); load(); reload(); }).catch((e) => { setDel(false); setMsg({ t: "err", s: errText(e) }); })}>Delete all</button><button className="fp-btn" onClick={() => setDel(false)}>Cancel</button></div></Modal>}</section>
    </div><div className="fp-sidecards"><SyncCards s={S} /></div></div>
    <ConfirmModal s={S} />
    {setA && <Modal title="Set the gateway's Modbus address?" onClose={() => setSetA(false)}><p className="fp-msg err">Every sensor read will use the new address at once. Type the new address (1 to 254, not 123 or 160) and the farm name <b className="fp-num">{farm}</b>.</p>
      <input className="fp-input" inputMode="numeric" value={addr} onChange={(e) => setAddr(e.target.value)} aria-label="New Modbus address" placeholder="new address" /><input className="fp-input" value={addrTxt} onChange={(e) => setAddrTxt(e.target.value)} aria-label="Confirmation text" placeholder={farm} autoComplete="off" />
      <div className="fp-row"><button className="fp-btn danger" disabled={!farm || addrTxt !== farm || !addr} onClick={() => api("/gateway/set-address", { method: "POST", json: { address: Number(addr), confirmText: addrTxt } }).then(() => { setSetA(false); setMsg({ t: "ok", s: `Gateway address set to ${addr}.` }); load(); reload(); }).catch((e) => { setSetA(false); setMsg({ t: "err", s: errText(e) }); })}>Set address</button><button className="fp-btn" onClick={() => setSetA(false)}>Cancel</button></div></Modal>}
  </>);
}
