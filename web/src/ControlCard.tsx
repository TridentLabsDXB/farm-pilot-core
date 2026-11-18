import { useState } from "react";
import { api, type Cmd, type State } from "./api";
import { Chip, Modal, ago, type Tone } from "./ui";
import { deviceState, kindWord, type ControlDevice } from "./control";

// 2026-11-16 -- generic ControlCard (CONTROL section). Moved out of ScadaView's PumpCard with the same behaviour: START / STOP (56 px) behind a one-step
// confirmation, command state SENT / CONFIRMED / TIMEOUT, last command with user and time, audit through POST /api/commands. Driven by a control_devices
// entry: buttons come from its capabilities (on_off today), the state lamp from deviceState(). Nothing here knows about pumps specifically.
const CMD_WORD: Record<Cmd["status"], string> = { sent: "SENT", confirmed: "CONFIRMED", timeout: "TIMEOUT" };

export default function ControlCard({ device, state, zoneName, now, reload }: { device: ControlDevice; state: State; zoneName: string | null; now: number; reload: () => void }) {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [ask, setAsk] = useState<"on" | "off" | null>(null);
  const st = deviceState(device, state, now); const last = state.commands.find((c) => c.pump === device.id); const pending = last?.status === "sent";
  const send = async (action: "on" | "off") => { setErr(""); setBusy(true); try { await api("/commands", { method: "POST", json: { pump: device.id, action } }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); reload(); } };
  const tone: Tone = last?.status === "confirmed" ? "ok" : last?.status === "timeout" ? "alarm" : last?.status === "sent" ? "info" : "off";
  const kw = kindWord(device); const nm = device.name;
  return (
    <section className="fp-card" aria-label={nm} data-testid={`control-${device.id}`}>
      <div className="fp-row fp-spread"><h3>{nm}</h3><Chip tone={st === "on" ? "ok" : "off"}>{st === "unknown" ? "UNKNOWN" : `${kw} ${st.toUpperCase()}`}</Chip></div>
      <span className="fp-cap" style={{ textTransform: "none", letterSpacing: ".04em" }}>{kw}{device.role ? ` · ${device.role.toUpperCase()}` : ""} · Zone: {zoneName ?? "No zone"}</span>
      {device.capabilities.includes("on_off") && <div className="fp-row"><button className="fp-btn go" style={{ flex: 1 }} disabled={busy || pending} aria-label={`Start ${nm}`} onClick={() => setAsk("on")}>Start</button>
        <button className="fp-btn stop" style={{ flex: 1 }} disabled={busy || pending} aria-label={`Stop ${nm}`} onClick={() => setAsk("off")}>Stop</button></div>}
      <div className="fp-inset" aria-live="polite"><div className="fp-cap">Last command</div>
        {last ? <div className="fp-row" style={{ marginTop: 6 }}><Chip tone={tone}>{CMD_WORD[last.status]}</Chip><span className="fp-num" style={{ fontSize: 13 }}>{last.action.toUpperCase()} · {last.username} · {ago(last.created_at, now)}</span></div> : <div className="fp-num">--</div>}
        {last?.status === "timeout" && <p className="fp-msg">No acknowledgement from the controller{last.note ? ` (${last.note})` : ""}.</p>}
        {last?.status === "sent" && <p className="fp-msg">Waiting for the controller, up to {state.commandTimeoutSec} s.</p>}</div>
      {device.link === "a100" && <p className="fp-msg">Radio link device. Commands are not available yet; the state stays UNKNOWN until the receiver reports back.</p>}
      {st === "unknown" && device.link !== "a100" && <p className="fp-msg">State unknown: no recent status from the controller.</p>}
      {err && <p className="fp-msg err" role="alert">{err}</p>}
      {ask && <Modal title={ask === "on" ? `Start ${nm}?` : `Stop ${nm}?`} onClose={() => setAsk(null)}>
        <p className="fp-msg">{ask === "on" ? "This sends a START command to the controller." : "This sends a STOP command to the controller."} It is logged with your name.</p>
        <div className="fp-row"><button className={`fp-btn ${ask === "on" ? "go" : "stop"}`} style={{ flex: 1 }} onClick={() => { const a = ask; setAsk(null); send(a); }}>{ask === "on" ? `Yes, start ${kw.toLowerCase()}` : `Yes, stop ${kw.toLowerCase()}`}</button><button className="fp-btn" style={{ flex: 1, minHeight: 56 }} onClick={() => setAsk(null)}>Cancel</button></div></Modal>}
      <span className="fp-cap" style={{ textTransform: "none" }}>The PLC keeps its own logic; this panel only sends commands.</span>
    </section>
  );
}
