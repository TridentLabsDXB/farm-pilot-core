import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { go } from "./App";
import { Modal, errText, fmtCfg } from "./ui";
import { dayStamp, groupDays, stamp, zoneLabel, zoneOf, type HourRow } from "./fleetTime";
import { BOX, Status, ShapeLamp, type BoxStatus } from "./lamp";
import { copyText, upFor } from "./About";
import "./serverlink.css";

// 2026-11-19 -- SYSTEM > Connected Boxes (Online build only, Admin only). Mockup board 4 (Fleet.dc.html): KPI row, table with search and filters, BOX DETAIL, ADD BOX, WAITING FOR APPROVAL, CSV.
// Read-only apart from rename / approve / reject / revoke / new enrolment code. It never issues or changes a licence (LICENCE opens Licence Management for the Device ID) and never sends anything to a box.
interface Lic { type: string; state: string; valid_until: string | null; days_left: number | null; expiring: boolean; }
interface Lim { n: number | null; max: number | null; }
interface Box { id: number; device_id: string; name: string; renamed: boolean; state: string; status: BoxStatus; interval_s: number; licence: Lic | null; sources: Lim | null; sensors: Lim | null; version: string | null; build: string | null; os: string | null; runs_as: string | null; uptime_s: number | null; last_data_at: string | null; active_alarms: number | null; last_report_at: number | null; last_seen_s: number | null; first_enrolled_at: number | null; auth_failures: number; licence_known: boolean; percent_online_30d: number | null; }
interface Waiting { id: number; device_id: string; name: string; version: string | null; requested_at: number; asked_s: number; licence_known: boolean; }
interface Code { id: number; hint: string; note: string | null; created_at: number; expires_at: number; }
interface Fleet { now: number; boxes: Box[]; waiting: Waiting[]; codes: Code[]; kpi: { boxes: number; online: number; late: number; offline: number; waiting: number }; }
interface Hist { hours: HourRow[]; days: { day_ts: number; expected: number; received: number; pct: number | null }[]; percent_online_30d: number | null; events: { ts: number; status: string; note: string | null }[]; }
const lim = (l: Lim | null) => (l === null ? "·" : `${l.n ?? "?"} / ${l.max === null ? "∞" : l.max}`);
const seen = (s: number | null) => (s === null ? "never" : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const ago = (ts: number | null, now: number) => (ts === null ? "never" : seen(Math.max(0, Math.round((now - ts) / 1000))) + " ago");
// 2026-11-19: every date and time on this page is shown in the time zone of THIS server's Farm Profile (fmtCfg.tz, same source as the header clock); UTC when none is set. Storage and API stay UTC.
const dstr = (ts: number | null) => (ts ? dayStamp(fmtCfg.tz, ts) : "--");
const dtstr = (ts: number) => stamp(fmtCfg.tz, ts);
const cellOf = (pct: number | null): { shape: "circle" | "triangle" | "square" | "ring"; tone: "ok" | "warn" | "alarm" | "off"; word: string } => pct === null ? { shape: "ring", tone: "off", word: "no data" } : pct >= 95 ? { shape: "circle", tone: "ok", word: "online" } : pct >= 50 ? { shape: "triangle", tone: "warn", word: "partly" } : { shape: "square", tone: "alarm", word: "mostly offline" };
const LICENCES = ["FREE", "PRO", "FULL", "ENGINEERING"];

function LicChip({ l }: { l: Lic | null }) { if (!l) return <span className="fl-id">·</span>; const warn = l.type === "FREE" || l.expiring || l.state === "EXPIRED"; return <span className="fl-chip" data-t={warn ? "warn" : "ok"}>{l.type}{l.state === "EXPIRED" ? " · EXPIRED" : l.expiring && l.days_left !== null ? ` · ${l.days_left} d LEFT` : ""}</span>; }

export default function FleetPage() {
  const [f, setF] = useState<Fleet | null>(null), [err, setErr] = useState(""), [q, setQ] = useState(""), [st, setSt] = useState("ALL"), [lic, setLic] = useState("ALL"), [sel, setSel] = useState<number | null>(null), [modal, setModal] = useState<null | "add" | "rename" | "revoke">(null), [hist, setHist] = useState<Hist | null>(null), [note, setNote] = useState("");
  const load = useCallback(() => api<Fleet>("/fleet/boxes").then((x) => { setF(x); setErr(""); setSel((c) => (c !== null && x.boxes.some((b) => b.id === c) ? c : x.boxes[0]?.id ?? null)); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  const box = f?.boxes.find((b) => b.id === sel) ?? null;
  useEffect(() => { if (!box) { setHist(null); return; } let live = true; api<Hist>(`/fleet/boxes/${box.id}/history`).then((h) => live && setHist(h)).catch(() => live && setHist(null)); return () => { live = false; }; }, [box?.id, box?.status, box?.last_report_at]);       // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (f?.boxes ?? []).filter((b) => { const t = q.trim().toLowerCase(); return (st === "ALL" || b.status === st) && (lic === "ALL" || b.licence?.type === lic) && (!t || b.name.toLowerCase().includes(t) || b.device_id.toLowerCase().includes(t)); }), [f, q, st, lic]);
  if (!f) return <main className="fp-page"><div className="fl">{err ? <div className="fp-card" role="alert"><p className="fp-msg err">{err}</p><button className="fp-btn" onClick={load}>RETRY</button></div> : <p className="fp-msg">Loading...</p>}</div></main>;
  const act = async (path: string, body?: unknown, method = "POST") => { setNote(""); try { await api(path, { method, json: body }); await load(); return true; } catch (e) { setNote(errText(e)); return false; } };
  const k = f.kpi, showCodes = st === "ALL" && lic === "ALL" && !q.trim();
  const licenceBtn = (b: { device_id: string; name: string; licence_known: boolean }) => b.licence_known
    ? <button className="fp-btn" style={{ flex: 1 }} onClick={() => go("/licences?device=" + encodeURIComponent(b.device_id))}>LICENCE</button>
    : <button className="fp-btn" style={{ flex: 1 }} onClick={() => go(`/licences?add=${encodeURIComponent(b.device_id)}&name=${encodeURIComponent(b.name)}`)}>ADD TO LICENCE MANAGEMENT</button>;
  return (
    <main className="fp-page"><div className="fl">
      <div className="fl-title"><span className="fp-cap">FARM-PILOT CORE · ONLINE</span><h2>CONNECTED BOXES</h2></div>
      <section className="fl-kpis" aria-label="Summary">
        <div className="fl-kpi"><span className="fp-cap">BOXES</span><b>{k.boxes}</b></div>
        <div className="fl-kpi"><span className="fp-cap"><Status shape="circle" tone="ok">ONLINE</Status></span><b>{k.online}</b></div>
        <div className="fl-kpi"><span className="fp-cap"><Status shape="triangle" tone="warn">LATE</Status></span><b>{k.late}</b></div>
        <div className="fl-kpi"><span className="fp-cap"><Status shape="square" tone="alarm">OFFLINE</Status></span><b>{k.offline}</b></div>
        <div className="fl-kpi" data-w={k.waiting > 0 ? 1 : 0}><span className="fp-cap">WAITING FOR APPROVAL</span><b>{k.waiting}</b></div>
      </section>
      {note && <p className="fp-msg err" role="alert">{note}</p>}
      <div className="fl-cols">
        <section className="fp-card" aria-label="Boxes">
          <div className="fl-tools">
            <input className="fp-input" aria-label="Search boxes" placeholder="Search name or Device ID" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="fp-input" aria-label="Status filter" value={st} onChange={(e) => setSt(e.target.value)}><option value="ALL">ALL STATUS</option>{(["ONLINE", "LATE", "OFFLINE", "NOT_ENROLLED", "REVOKED"] as BoxStatus[]).map((s) => <option key={s} value={s}>{BOX[s].word}</option>)}</select>
            <select className="fp-input" aria-label="Licence filter" value={lic} onChange={(e) => setLic(e.target.value)}><option value="ALL">ALL LICENCES</option>{LICENCES.map((l) => <option key={l} value={l}>{l}</option>)}</select>
          </div>
          <div className="fl-scroll"><table className="fl-table"><thead><tr><th>STATUS</th><th>BOX</th><th className="c-hide2">LICENCE</th><th className="c-hide">SOURCES</th><th className="c-hide">SENSORS</th><th className="c-hide">VERSION</th><th>LAST SEEN</th></tr></thead>
            <tbody>
              {rows.map((b) => { const S = BOX[b.status]; return <tr key={b.id} data-sel={b.id === sel ? 1 : 0}>
                <td><Status shape={S.shape} tone={S.tone}>{S.word}</Status></td>
                <td><button className="fl-rowbtn" aria-pressed={b.id === sel} aria-label={`${b.name} ${b.device_id}`} onClick={() => setSel(b.id)}><div className="fl-nm">{b.name}</div><div className="fl-id">{b.device_id}</div><div className="fl-narrow"><LicChip l={b.licence} /></div></button></td>
                <td className="c-hide2"><LicChip l={b.licence} /></td><td className="m c-hide">{lim(b.sources)}</td><td className="m c-hide">{lim(b.sensors)}</td><td className="m c-hide">{b.version ?? "·"}</td><td className="m" title={b.last_report_at ? dtstr(b.last_report_at) : undefined}>{seen(b.last_seen_s)}</td></tr>; })}
              {showCodes && f.codes.map((c) => <tr key={"c" + c.id} data-code="1"><td><Status shape="ring" tone="off">NOT ENROLLED</Status></td><td><div className="fl-nm">no box yet</div><div className="fl-id">code …{c.hint} · valid {Math.max(1, Math.round((c.expires_at - f.now) / 3600_000))} h</div></td><td className="m c-hide2">·</td><td className="m c-hide">·</td><td className="m c-hide">·</td><td className="m c-hide">·</td><td className="m">·</td></tr>)}
              {rows.length === 0 && !(showCodes && f.codes.length) && <tr><td colSpan={7}><p className="fp-msg fp-muted">{f.boxes.length === 0 ? "No box has reported yet. Press ADD BOX and enter the code on the box (SYSTEM, Server Connection)." : "No box matches the search or filters."}</p></td></tr>}
            </tbody></table></div>
          <div className="fp-row"><button className="fp-btn primary" onClick={() => setModal("add")}>ADD BOX (ENROLMENT CODE)</button><a className="fp-btn" href="/api/fleet/export.csv" download>EXPORT LIST (CSV)</a></div>
        </section>

        <div className="fl-side">
          {box && <section className="fp-card" aria-label="Box detail">
            <h3>BOX DETAIL</h3>
            <div><div className="fl-nm" style={{ fontSize: 18 }}>{box.name}</div><div className="fl-id">{box.device_id}</div></div>
            {[["STATE", <Status key="s" shape={BOX[box.status].shape} tone={BOX[box.status].tone}>{BOX[box.status].word}</Status>],
              ["LICENCE", box.licence ? `${box.licence.type} · ${box.licence.valid_until ? "until " + box.licence.valid_until.slice(0, 10) : "no expiry"}` : "--"], ["BUILD", box.build ?? "--"], ["SYSTEM", box.os ?? "--"], ["RUNS AS", box.runs_as ?? "--"], ["UPTIME", box.uptime_s !== null ? upFor(box.uptime_s) : "--"],
              ["LAST DATA FROM SENSORS", box.last_data_at ? ago(Date.parse(box.last_data_at), f.now) : "--"], ["LAST REPORT", box.last_report_at ? dtstr(box.last_report_at) : "never"], ["ACTIVE ALARMS", box.active_alarms ?? "--"], ["FIRST ENROLLED", dstr(box.first_enrolled_at)]].map(([a, b]) => <div className="sl-kv" key={String(a)}><span className="fp-cap">{a}</span><span className="fp-num">{b}</span></div>)}
            <div><div className="sl-kv"><span className="fp-cap">LAST 30 DAYS</span><span className="fl-pct">{hist?.percent_online_30d === null || hist === null ? "no history yet" : `${hist.percent_online_30d.toFixed(1)} % online in the last 30 days`}</span></div>
              <div className="fl-strip" role="img" aria-label={hist?.percent_online_30d != null ? `${hist.percent_online_30d.toFixed(1)} percent online in the last 30 days, one cell per day` : "no history yet"}>
                {(hist ? groupDays(fmtCfg.tz, hist.hours, f.now) : Array.from({ length: 30 }, () => ({ key: "", expected: 0, received: 0, pct: null as number | null }))).map((d, i) => { const c = cellOf(d.pct); return <span key={i} className="fl-cell" data-tone={c.tone} title={`${d.key ? d.key + ": " : ""}${d.pct === null ? "no data" : d.pct + " % (" + c.word + ")"}`}><ShapeLamp shape={c.shape} /></span>; })}</div>
              <p className="fp-cap" style={{ marginTop: 6 }}>one cell per day ({zoneOf(fmtCfg.tz)}, {zoneLabel(fmtCfg.tz, f.now)}), oldest left · ● 95 % or more · ▲ 50 to 95 % · ■ under 50 % · ○ no data</p></div>
            {hist && hist.events.length > 0 && <div><span className="fp-cap">STATUS CHANGES</span>{hist.events.slice(0, 6).map((e, i) => <div className="fl-ev" key={i}><span className="m">{dtstr(e.ts)}</span><span>{e.status}{e.note ? ` · ${e.note}` : ""}</span></div>)}</div>}
            <div className="sc-btns"><button className="fp-btn" style={{ flex: 1 }} onClick={() => setModal("rename")}>RENAME</button>{licenceBtn(box)}{box.state === "approved" && <button className="fp-btn danger" style={{ flex: 1 }} onClick={() => setModal("revoke")}>REVOKE</button>}</div>
          </section>}
          <section className="fp-card fl-wait" data-w={f.waiting.length > 0 ? 1 : 0} aria-label="Waiting for approval">
            <h3>WAITING FOR APPROVAL</h3>
            {f.waiting.length === 0 ? <p className="fp-msg fp-muted">No box is waiting.</p> : f.waiting.map((w) => <div key={w.id} className="fp-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <div><div className="fl-nm">{w.device_id}</div><div className="fp-num" style={{ fontSize: 13 }}>asked {seen(w.asked_s)} ago · box name "{w.name}"{w.version ? ` · v${w.version}` : ""}</div></div>
              <div className="sc-btns"><button className="fp-btn primary" style={{ flex: 1, minHeight: 44 }} onClick={() => act(`/fleet/boxes/${w.id}/approve`)}>APPROVE</button><button className="fp-btn" style={{ flex: 1 }} onClick={() => act(`/fleet/boxes/${w.id}/reject`)}>REJECT</button></div>
              {!w.licence_known && <button className="fp-btn small" onClick={() => go(`/licences?add=${encodeURIComponent(w.device_id)}&name=${encodeURIComponent(w.name)}`)}>ADD TO LICENCE MANAGEMENT</button>}</div>)}
          </section>
          <p className="sl-note">ONLINE while the last report is younger than 3 report intervals, LATE for up to 15 minutes more, then OFFLINE. Times are the server's. Boxes connect out to this server; it cannot reach or control them.</p>
        </div>
      </div>
      {modal === "add" && <AddBox onClose={() => setModal(null)} onMade={load} />}
      {modal === "rename" && box && <Rename box={box} onClose={() => setModal(null)} onDone={async (n) => { if (await act(`/fleet/boxes/${box.id}`, { name: n }, "PATCH")) setModal(null); }} />}
      {modal === "revoke" && box && <Modal title="Revoke access" onClose={() => setModal(null)}><p><b>{box.name}</b> ({box.device_id}) will no longer be accepted. Its next report fails and the box shows NOT REACHABLE (access revoked). It keeps working on site. Its 30-day history stays.</p>
        <div className="fp-row"><button className="fp-btn danger" onClick={async () => { if (await act(`/fleet/boxes/${box.id}/revoke`)) setModal(null); }}>REVOKE ACCESS</button><button className="fp-btn" onClick={() => setModal(null)}>CANCEL</button></div></Modal>}
    </div></main>
  );
}

function AddBox({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const [c, setC] = useState<{ code: string; expires_at: number } | null>(null), [err, setErr] = useState(""), [copied, setCopied] = useState(false);
  const make = async () => { setErr(""); try { setC(await api("/fleet/codes", { method: "POST", json: {} })); onMade(); } catch (e) { setErr(errText(e)); } };
  return <Modal title="Add box" onClose={onClose}>
    {!c ? <><p>Creates a one-time enrolment code, valid for 24 hours. Enter it on the box under SYSTEM, Server Connection, ENROL BOX. The code is shown once.</p>{err && <p className="fp-msg err" role="alert">{err}</p>}
      <div className="fp-row"><button className="fp-btn primary" onClick={make}>CREATE CODE</button><button className="fp-btn" onClick={onClose}>CANCEL</button></div></>
      : <><div className="fl-big" data-testid="enrol-code">{c.code}</div><p className="fp-msg">Valid until {dtstr(c.expires_at)}. One use only.</p>
        <div className="fp-row"><button className="fp-btn" onClick={async () => { setCopied(await copyText(c.code)); }}>COPY CODE</button>{copied && <span className="sl-st" data-tone="ok"><ShapeLamp shape="circle" />COPIED</span>}<button className="fp-btn primary" onClick={onClose}>DONE</button></div></>}
  </Modal>;
}
function Rename({ box, onClose, onDone }: { box: Box; onClose: () => void; onDone: (n: string) => void }) {
  const [n, setN] = useState(box.name);
  return <Modal title="Rename box" onClose={onClose}><label className="fp-field"><span className="fp-cap">NAME ON THIS PAGE</span><input className="fp-input" value={n} maxLength={64} onChange={(e) => setN(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && n.trim() && onDone(n.trim())} /></label>
    <p className="fp-cap">Only changes the name shown here. The box keeps its own name.</p><div className="fp-row"><button className="fp-btn primary" disabled={!n.trim()} onClick={() => onDone(n.trim())}>SAVE</button><button className="fp-btn" onClick={onClose}>CANCEL</button></div></Modal>;
}
