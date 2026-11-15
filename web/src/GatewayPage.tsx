import { useEffect, useState } from "react";
import { api } from "./api";
import { linkText } from "./SensorsPage";
import { Chip, Modal, dt, errText } from "./ui";

export default function GatewayPage({ reload }: { reload: () => void }) {
  const [g, setG] = useState<any>(null); const [msg, setMsg] = useState<{ t: string; s: string } | null>(null); const [f, setF] = useState<any>({}); const [del, setDel] = useState(false); const [txt, setTxt] = useState("");
  const [to, setTo] = useState("10"); const [farm, setFarm] = useState(""); const [toMsg, setToMsg] = useState<{ t: string; s: string } | null>(null);
  const load = () => api<any>("/gateway").then((x) => { setG(x); setF({ pollSec: x.settings.pollSec, offlineMultiplier: x.settings.offlineMultiplier, rssiGood: x.settings.rssiGood, rssiPoor: x.settings.rssiPoor, lowV: x.settings.types.th?.low_voltage, tOff: x.settings.limits.temperature.maxOffset, hOff: x.settings.limits.humidity.maxOffset }); });
  useEffect(() => { load(); api<{ commandTimeoutSec: number; farm: string }>("/state").then((s) => { setTo(String(s.commandTimeoutSec)); setFarm(s.farm); }); }, []);
  if (!g) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const save = () => api("/gateway/settings", { method: "PUT", json: { pollSec: +f.pollSec, offlineMultiplier: +f.offlineMultiplier, rssiGood: +f.rssiGood, rssiPoor: +f.rssiPoor, types: { th: { low_voltage: +f.lowV } },
    limits: { temperature: { ...g.settings.limits.temperature, maxOffset: +f.tOff }, humidity: { ...g.settings.limits.humidity, maxOffset: +f.hOff } } } }).then(() => { setMsg({ t: "ok", s: "Saved." }); load(); reload(); }).catch((e) => setMsg({ t: "err", s: errText(e) }));
  const fld = (k: string, label: string, hint?: string) => <label className="fp-field"><span className="fp-cap">{label}</span><input className="fp-input" inputMode="decimal" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />{hint && <span className="fp-hint">{hint}</span>}</label>;
  const l = g.link;
  return (<>
    <section className="fp-card"><div className="fp-row fp-spread"><h3>Gateway</h3>{!g.enabled ? <Chip tone="off">NO GATEWAY</Chip> : g.online ? <Chip tone="ok">ONLINE</Chip> : <Chip tone="alarm">OFFLINE</Chip>}</div>
      <ul className="fp-list"><li><span>Model</span><span>{g.model} (manual {g.manual})</span></li><li><span>Register map version</span><span>{g.mapVersion}</span></li><li><span>Version register</span><span>{g.info.version == null ? "--" : "0x" + g.info.version.toString(16).toUpperCase().padStart(4, "0")}</span></li><li><span>Last successful poll</span><span>{dt(g.lastOk)}</span></li>{g.lastError && <li><span>Last error</span><span>{g.lastError}</span></li>}</ul></section>
    <section className="fp-card"><h3>Link</h3>
      {!l ? <p className="fp-msg fp-muted">No gateway link is configured.</p> : <ul className="fp-list">
        <li><span>Transport</span><span>{l.transport === "rtu-serial" ? "RTU over serial (RS485)" : l.transport === "tcp" ? "Modbus TCP (bench simulator)" : "RTU over TCP"}</span></li>
        {l.transport === "rtu-serial" ? <>
          <li><span>Serial port</span><span>{l.serialPath}</span></li><li><span>Baud rate</span><span>{l.baud}</span></li>
          <li><span>Data / parity / stop bits</span><span>{l.dataBits}{l.parity === "none" ? "N" : l.parity === "even" ? "E" : "O"}{l.stopBits}</span></li></> : <>
          <li><span>Host</span><span>{l.host}</span></li><li><span>TCP port</span><span>{l.port}</span></li></>}
        <li><span>Modbus address</span><span>{l.address}</span></li><li><span>Timeout</span><span>{l.timeoutMs} ms</span></li><li><span>Retries</span><span>{l.retries}</span></li></ul>}
      <span className="fp-hint">Read-only for now. An Admin screen to change these is planned.</span></section>
    <section className="fp-card"><h3>Timing, battery and signal</h3>
      <div className="fp-form"><span className="fp-cap wide">Timing</span>{fld("pollSec", "Modbus poll (s)", "Shortened to half the shortest sensor interval, minimum 10 s.")}{fld("offlineMultiplier", "No update after (intervals)", "Missed intervals before NO UPDATE.")}
        <span className="fp-cap wide">Battery</span>{fld("lowV", "T/H low voltage (V)")}<span />
        <span className="fp-cap wide">Signal</span>{fld("rssiGood", "Good above (dBm)")}{fld("rssiPoor", "Poor below (dBm)")}
        <span className="fp-hint wide">The SCADA View shows three words: <b>GOOD</b> above {f.rssiGood} dBm, <b>WEAK</b> from {f.rssiGood} down to {f.rssiPoor} dBm, <b>POOR</b> below {f.rssiPoor} dBm.</span>
        <span className="fp-cap wide">Calibration limits</span>{fld("tOff", "Max temperature offset (°C)")}{fld("hOff", "Max humidity offset (%RH)")}</div>
      <div className="fp-row"><button className="fp-btn primary" onClick={save}>Save</button></div>{msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}</section>
    <section className="fp-card"><h3>Control: pump commands</h3>
      <div className="fp-form"><label className="fp-field"><span className="fp-cap">Acknowledgement timeout (s)</span><input className="fp-input" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} /><span className="fp-hint">3 to 120 seconds.</span></label></div>
      <div className="fp-row"><button className="fp-btn" onClick={() => api("/settings", { method: "PUT", json: { commandTimeoutSec: Number(to) } }).then(() => { setToMsg({ t: "ok", s: "Saved." }); reload(); }).catch((e) => setToMsg({ t: "err", s: errText(e) }))}>Save timeout</button></div>{toMsg && <p className={`fp-msg ${toMsg.t}`} role="status">{toMsg.s}</p>}</section>
    <section className="fp-card"><h3>Factory reset</h3><p className="fp-msg">Deletes EVERY sensor configured in the gateway (all types). Sensors stay in CORE and show NOT SENT; press SEND TO GATEWAY to push them again.</p>
      <div className="fp-row"><button className="fp-btn danger" disabled={!g.online} onClick={() => { setTxt(""); setDel(true); }}>Delete all sensors in gateway</button></div>
      {del && <Modal title="Delete all sensors in the gateway?" onClose={() => setDel(false)}><p className="fp-msg err">This cannot be undone from here. Type the farm name <b className="fp-num">{farm}</b> to confirm. The action is written to the audit log.</p><input className="fp-input" value={txt} onChange={(e) => setTxt(e.target.value)} aria-label="Confirmation text" placeholder={farm} autoComplete="off" />
        <div className="fp-row"><button className="fp-btn danger" disabled={!farm || txt !== farm} onClick={() => api("/gateway/delete-all", { method: "POST", json: { confirmText: txt } }).then(() => { setDel(false); setMsg({ t: "ok", s: "Gateway cleared." }); load(); reload(); }).catch((e) => { setDel(false); setMsg({ t: "err", s: errText(e) }); })}>Delete all</button><button className="fp-btn" onClick={() => setDel(false)}>Cancel</button></div></Modal>}</section>
  </>);
}
