import { useEffect, useState } from "react";
import { api } from "./api";
import { Chip, Modal, dt, errText } from "./ui";

export default function GatewayPage({ reload }: { reload: () => void }) {
  const [g, setG] = useState<any>(null); const [msg, setMsg] = useState<{ t: string; s: string } | null>(null); const [f, setF] = useState<any>({}); const [del, setDel] = useState(false); const [txt, setTxt] = useState("");
  const load = () => api<any>("/gateway").then((x) => { setG(x); setF({ pollSec: x.settings.pollSec, offlineMultiplier: x.settings.offlineMultiplier, rssiGood: x.settings.rssiGood, rssiPoor: x.settings.rssiPoor, lowV: x.settings.types.th?.low_voltage, tOff: x.settings.limits.temperature.maxOffset, hOff: x.settings.limits.humidity.maxOffset }); });
  useEffect(() => { load(); }, []);
  if (!g) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const save = () => api("/gateway/settings", { method: "PUT", json: { pollSec: +f.pollSec, offlineMultiplier: +f.offlineMultiplier, rssiGood: +f.rssiGood, rssiPoor: +f.rssiPoor, types: { th: { low_voltage: +f.lowV } },
    limits: { temperature: { ...g.settings.limits.temperature, maxOffset: +f.tOff }, humidity: { ...g.settings.limits.humidity, maxOffset: +f.hOff } } } }).then(() => { setMsg({ t: "ok", s: "Saved." }); load(); reload(); }).catch((e) => setMsg({ t: "err", s: errText(e) }));
  const fld = (k: string, label: string, hint?: string) => <label className="fp-field"><span className="fp-cap">{label}</span><input className="fp-input" inputMode="decimal" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />{hint && <span className="fp-cap" style={{ textTransform: "none" }}>{hint}</span>}</label>;
  return (<>
    <section className="fp-card"><div className="fp-row fp-spread"><h3>Gateway</h3>{!g.enabled ? <Chip tone="off">NO GATEWAY</Chip> : g.online ? <Chip tone="ok">ONLINE</Chip> : <Chip tone="alarm">OFFLINE</Chip>}</div>
      <ul className="fp-list"><li><span>Model</span><span>{g.model} (manual {g.manual})</span></li><li><span>Register map version</span><span>{g.mapVersion}</span></li><li><span>Modbus address / version register</span><span>{g.info.address ?? "--"} / {g.info.version ?? "--"}</span></li><li><span>Last successful poll</span><span>{dt(g.lastOk)}</span></li>{g.lastError && <li><span>Last error</span><span>{g.lastError}</span></li>}</ul>
      <span className="fp-cap" style={{ textTransform: "none" }}>Link settings (RS485 port, baud, address) are set in /etc/farmpilot-core.env, see the README.</span></section>
    <section className="fp-card"><h3>Timing, battery and signal</h3>
      <div className="fp-row">{fld("pollSec", "Modbus poll (s)", "Shortened automatically to half the shortest sensor interval, floor 10 s")}{fld("offlineMultiplier", "No update after (missed intervals)")}{fld("lowV", "T/H low-voltage warning (V)", "ASSUMED until the battery type is confirmed")}</div>
      <div className="fp-row">{fld("rssiGood", "Signal good above (dBm)")}{fld("rssiPoor", "Signal poor below (dBm)")}</div>
      <div className="fp-row">{fld("tOff", "Max temperature offset (°C)")}{fld("hOff", "Max humidity offset (%RH)")}</div>
      <div className="fp-row"><button className="fp-btn primary" onClick={save}>Save</button></div>{msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}</section>
    <section className="fp-card"><h3>Factory reset</h3><p className="fp-msg">Deletes EVERY sensor configured in the gateway (all types). Sensors stay in CORE and show NOT SENT; press SEND TO GATEWAY to push them again.</p>
      <div className="fp-row"><button className="fp-btn danger" disabled={!g.online} onClick={() => { setTxt(""); setDel(true); }}>Delete all sensors in gateway</button></div>
      {del && <Modal title="Delete all sensors in the gateway?" onClose={() => setDel(false)}><p className="fp-msg err">This cannot be undone from here. Type DELETE ALL to confirm.</p><input className="fp-input" value={txt} onChange={(e) => setTxt(e.target.value)} aria-label="Confirmation text" />
        <div className="fp-row"><button className="fp-btn danger" disabled={txt !== "DELETE ALL"} onClick={() => api("/gateway/delete-all", { method: "POST", json: { confirmText: txt } }).then(() => { setDel(false); setMsg({ t: "ok", s: "Gateway cleared." }); load(); reload(); }).catch((e) => { setDel(false); setMsg({ t: "err", s: errText(e) }); })}>Delete all</button><button className="fp-btn" onClick={() => setDel(false)}>Cancel</button></div></Modal>}</section>
  </>);
}
