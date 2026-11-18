import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Modal, errText } from "./ui";
import { LINK, Status, ShapeLamp, type LinkState } from "./lamp";
import "./serverlink.css";

// 2026-11-19 -- SYSTEM > Server Connection (Admin only, every build, not licence gated: FREE reports too). Mockup board 1 (Main.dc.html): status banner, CONNECTION, WHAT THE BOX REPORTS, RECENT CONTACTS, rules note.
// The access key never reaches this page: the API sends only "enrolment" (a word) and the page shows a fixed mask.
interface Settings { enabled: boolean; address: string; box_name: string; interval_s: number; enrol_state: string; enrolled_at: number | null; report_no: number; }
interface LinkStatus { state: LinkState; reason: string | null; host: string | null; enrolment: string; last_contact_at: number | null; last_contact_ok: boolean | null; round_trip_ms: number | null; next_report_in_s: number | null; reports_today: { ok: number; failed: number }; clock_diff_s: number | null; clock_warning: boolean; busy: boolean; device_id: string | null; }
interface Contact { id: number; ts: number; ok: boolean; code: number | null; error: string | null; rtt_ms: number | null; report_no: number | null; kind: "report" | "enrol"; }
interface View { settings: Settings; status: LinkStatus; contacts: Contact[]; }
const SENT: [string, boolean][] = [["Device ID, box name", true], ["Version and build", true], ["Licence type and valid until", true], ["Data sources, n of limit", true], ["Active sensors, n of limit", true], ["Uptime, last data received (time only)", true], ["Active alarms (count only)", true], ["Farm readings, sensor values", false], ["Users, passwords, contacts, farm logo", false]];
const INTERVALS: [number, string][] = [[60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"]];
const hms = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });
export const agoShort = (ts: number | null, now = Date.now()) => { if (!ts) return "never"; const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const BANNER: Record<LinkState, string> = { CONNECTED: "CONNECTED TO MAIN CORE SERVER", CONNECTING: "CONNECTING TO MAIN CORE SERVER", NOT_REACHABLE: "MAIN CORE SERVER NOT REACHABLE", NOT_ENROLLED: "THIS BOX IS NOT ENROLLED", DISABLED: "REPORTING IS SWITCHED OFF" };
const HELP: Record<LinkState, string> = { CONNECTED: "", CONNECTING: "Trying again. CORE keeps working as before.", NOT_REACHABLE: "CORE keeps working normally. It tries again with longer pauses, up to every 15 minutes.", NOT_ENROLLED: "Press ENROL BOX and enter the code from the server, or ask for approval.", DISABLED: "Nothing is sent. Switch it on below when you are ready." };

export default function ServerConnectionPage() {
  const [v, setV] = useState<View | null>(null), [err, setErr] = useState(""), [form, setForm] = useState<Settings | null>(null), [dirty, setDirty] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState(""), [enrol, setEnrol] = useState(false), [at, setAt] = useState(Date.now()), [, tickNow] = useState(0);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const load = useCallback(() => api<View>("/server-connection").then((x) => { setV(x); setAt(Date.now()); setErr(""); if (!dirtyRef.current) setForm(x.settings); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); const t = setInterval(load, 5000); const c = setInterval(() => tickNow((n) => n + 1), 1000); return () => { clearInterval(t); clearInterval(c); }; }, [load]);
  const apply = (x: View) => { setV(x); setAt(Date.now()); if (!dirtyRef.current) setForm(x.settings); };
  const act = async (name: string, f: () => Promise<{ ok: boolean; message?: string } & Partial<View>>, okText: string) => {
    setBusy(name); setMsg(null);
    try { const r = await f(); if (r.settings && r.status) apply(r as View); setMsg({ ok: r.ok, text: r.ok ? okText : r.message ?? "Failed" }); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(""); }
  };
  if (!v || !form) return <main className="fp-page"><div className="sc">{err ? <div className="fp-card" role="alert"><p className="fp-msg err">{err}</p><button className="fp-btn" onClick={load}>RETRY</button></div> : <p className="fp-msg">Loading...</p>}</div></main>;
  const st = v.status, L = LINK[st.state], set = (p: Partial<Settings>) => { setForm({ ...form, ...p }); setDirty(true); };
  const left = st.next_report_in_s === null ? null : Math.max(0, st.next_report_in_s - Math.round((Date.now() - at) / 1000));
  const save = () => act("save", async () => { const r = await api<View>("/server-connection", { method: "PUT", json: { enabled: form.enabled, address: form.address, box_name: form.box_name, interval_s: form.interval_s } }); setDirty(false); dirtyRef.current = false; return { ok: true, ...r }; }, "Saved.");
  const test = () => act("test", () => api("/server-connection/test", { method: "POST", json: { address: form.address } }), "Server reached over a verified secure connection.").then(() => undefined);
  const keyed = st.enrolment === "APPROVED";
  return (
    <main className="fp-page"><div className="sc">
      <div className="sc-title"><span className="fp-cap">FARM-PILOT CORE</span><h2>SERVER CONNECTION</h2></div>

      <section className="sl-banner" data-tone={L.tone} aria-label="Connection status" role="status">
        <Status shape={L.shape} tone={L.tone} size={26}><span className="sl-big">{BANNER[st.state]}</span></Status>
        <div className="sl-grow"><div className="sl-sub">{[st.host, st.last_contact_at && st.state !== "NOT_ENROLLED" ? `last contact ${agoShort(st.last_contact_at)}` : st.state === "CONNECTED" ? null : "no contact yet", st.round_trip_ms !== null && st.state === "CONNECTED" ? `round trip ${st.round_trip_ms} ms` : null, left !== null && st.state !== "NOT_ENROLLED" ? `next report in ${left} s` : null].filter(Boolean).join(" · ") || "--"}</div>
          {(st.reason || HELP[st.state]) && <div className="sl-sub">{[st.reason ? `Reason: ${st.reason}.` : "", HELP[st.state]].filter(Boolean).join(" ")}</div>}</div>
        <button className="fp-btn primary" disabled={busy !== "" || st.state === "DISABLED" || st.state === "NOT_ENROLLED"} onClick={() => act("send", () => api("/server-connection/send-now", { method: "POST" }), "Report sent.")}>{busy === "send" || st.busy ? "SENDING..." : "SEND NOW"}</button>
      </section>
      {st.clock_warning && <p className="sl-warn" role="status"><ShapeLamp shape="triangle" /> <b>CLOCK DIFFERENCE</b> The server time differs from this box by {Math.abs(Math.round((st.clock_diff_s ?? 0) / 60))} minutes. Check the date, time and time zone of this computer.</p>}

      <div className="sc-cols">
        <div className="sc-col">
          <section className="fp-card" aria-label="Connection">
            <h3>CONNECTION</h3>
            <label className="sc-check"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Report this box to the main server</label>
            <div className="sc-form">
              <label className="fp-field"><span className="fp-cap">SERVER ADDRESS</span><input className="fp-input" value={form.address} onChange={(e) => set({ address: e.target.value })} inputMode="url" autoCapitalize="off" spellCheck={false} aria-describedby="sc-addr" /></label>
              <label className="fp-field"><span className="fp-cap">BOX NAME ON SERVER</span><input className="fp-input" value={form.box_name} maxLength={64} onChange={(e) => set({ box_name: e.target.value })} /></label>
              <label className="fp-field"><span className="fp-cap">DEVICE ID (FIXED)</span><input className="fp-input" value={st.device_id ?? "unavailable"} readOnly aria-readonly="true" /></label>
              <label className="fp-field"><span className="fp-cap">REPORT EVERY</span><select className="fp-input" value={form.interval_s} onChange={(e) => set({ interval_s: Number(e.target.value) })}>{INTERVALS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
            </div>
            <p className="fp-cap" id="sc-addr">https:// only. Changing the address means enrolling again.</p>
            <div className="sl-kv"><span className="fp-cap">ENROLMENT</span><Status shape={keyed ? "circle" : st.enrolment === "WAITING FOR APPROVAL" ? "triangle" : st.enrolment === "REJECTED" ? "square" : "ring"} tone={keyed ? "ok" : st.enrolment === "WAITING FOR APPROVAL" ? "warn" : st.enrolment === "REJECTED" ? "alarm" : "off"}>{keyed ? "APPROVED BY SERVER" : st.enrolment}</Status></div>
            <div className="sl-kv"><span className="fp-cap">ACCESS KEY</span><span className="fp-num">{keyed ? "•••••••••••••••• (stored encrypted, never shown)" : "none"}</span></div>
            <div className="sc-btns">
              <button className="fp-btn" disabled={busy !== ""} onClick={test}>{busy === "test" ? "TESTING..." : "TEST CONNECTION"}</button>
              <button className="fp-btn" disabled={busy !== "" || dirty} onClick={() => setEnrol(true)} title={dirty ? "Save the settings first" : undefined}>{keyed ? "RE-ENROL BOX" : "ENROL BOX"}</button>
              <span className="sl-grow" /><button className="fp-btn primary" disabled={busy !== "" || !dirty} onClick={save}>{busy === "save" ? "SAVING..." : "SAVE"}</button>
            </div>
            <p className={`fp-msg sc-msg ${msg ? (msg.ok ? "ok" : "err") : ""}`} role="status" aria-live="polite">{msg ? (msg.ok ? "✓ " : "✗ ") + msg.text : ""}</p>
          </section>
          <section className="fp-card" aria-label="Recent contacts">
            <h3>RECENT CONTACTS</h3>
            {v.contacts.length === 0 ? <p className="fp-msg fp-muted">No contact yet.</p> : v.contacts.map((c) => (
              <div className="sc-contact" key={c.id}><span className="m">{hms(c.ts)}</span><Status shape={c.ok ? "circle" : "square"} tone={c.ok ? "ok" : "alarm"}>{c.ok ? "OK" : "FAILED"}</Status>
                <span className="m">{c.ok ? `${c.code ?? ""}${c.rtt_ms !== null ? ` · ${c.rtt_ms} ms` : ""}` : c.error ?? (c.code ? `HTTP ${c.code}` : "failed")}</span><span className="m">{c.kind === "enrol" ? "enrolment" : c.report_no !== null ? `report #${c.report_no}` : ""}</span></div>))}
            <p className="fp-cap">Last 20 attempts · today {st.reports_today.ok} ok, {st.reports_today.failed} failed</p>
          </section>
        </div>
        <div className="sc-col">
          <section className="fp-card" aria-label="What the box reports">
            <h3>WHAT THE BOX REPORTS</h3>
            {SENT.map(([t, sent]) => <div className="sc-report" key={t}><span>{t}</span><Status shape={sent ? "circle" : "square"} tone={sent ? "ok" : "alarm"}>{sent ? "SENT" : "NEVER SENT"}</Status></div>)}
          </section>
          <section className="fp-card" aria-label="Rules"><h3>RULES</h3>
            <p className="sl-note">The box always connects out. The server cannot open or control this box.<br /><br />If the server is not reachable, CORE keeps working as before. It retries after 1, 2 and 5 minutes, then every 15 minutes, sends only the latest state, and shows the state here and on the About page.</p></section>
        </div>
      </div>
      {enrol && <EnrolDialog onClose={() => setEnrol(false)} onDone={(r) => { setEnrol(false); if (r.settings) apply(r as View); setMsg({ ok: r.ok, text: r.message ?? "" }); void load(); }} />}
    </div></main>
  );
}

function EnrolDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: { ok: boolean; message?: string } & Partial<View>) => void }) {
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const go = async () => { setBusy(true); setErr(""); try { const r = await api<{ ok: boolean; message: string } & View>("/server-connection/enrol", { method: "POST", json: { code: code.trim() } }); if (r.ok) onDone(r); else setErr(r.message); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  return <Modal title="Enrol this box" onClose={onClose}>
    <p>On the main server press <b>ADD BOX</b> (SYSTEM, Connected Boxes) and enter the one-time code here. It is valid for 24 hours. With no code, the box asks the server's Admin to approve it.</p>
    <label className="fp-field"><span className="fp-cap">ENROLMENT CODE</span><input className="fp-input sc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX" autoFocus autoCapitalize="characters" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && !busy && void go()} /></label>
    {err && <p className="fp-msg err" role="alert">{err}</p>}
    <div className="fp-row"><button className="fp-btn primary" disabled={busy} onClick={go}>{busy ? "WORKING..." : code.trim() ? "ENROL" : "ASK FOR APPROVAL"}</button><button className="fp-btn" onClick={onClose}>CANCEL</button></div>
  </Modal>;
}
