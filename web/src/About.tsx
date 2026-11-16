import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AboutInfo, type ComputerInfo, type LicenceInfo } from "./api";
import { go } from "./App";
import { Chip, Modal, errText, type Tone } from "./ui";
import "./about.css";

// 2026-11-16 -- ABOUT page, Option A (Identity card): left identity card, right LICENCE card above THIS COMPUTER (Admin). Every status is a lamp plus a word.
// Operators get the identity card and the licence summary with usage (read-only); the server sends them no Device ID and no host details at all.
const LIC_TONE: Record<LicenceInfo["state"], Tone> = { FREE: "info", LICENSED: "ok", EXPIRED: "warn", INVALID: "alarm" };
const bytes = (n: number | null | undefined) => (n === null || n === undefined ? "--" : n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`);
export const upFor = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`; };
const hms = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "--");

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context (plain HTTP on the hotspot): fall back */ }
  try { const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok; } catch { return false; }
}
function Tile({ k, v }: { k: string; v: string }) { return <div className="ab-tile"><span className="fp-cap">{k}</span><span className="ab-val">{v}</span></div>; }
function Bar({ label, n, max }: { label: string; n: number; max: number }) {
  const over = n > max, pct = max > 0 ? Math.min(100, (n / max) * 100) : over ? 100 : 0;
  return (<div className="ab-usage" data-over={over ? 1 : 0}>
    <div className="fp-row fp-spread"><span className="fp-cap">{label}</span><span className="fp-num">{n} of {max}{over && <Chip tone="warn">OVER LIMIT</Chip>}</span></div>
    <div className="ab-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={n}><i style={{ width: pct + "%" }} /></div>
  </div>);
}
function TextDialog({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  useEffect(() => { fetch(url).then((r) => (r.ok && !/html/.test(r.headers.get("content-type") ?? "") ? r.text() : Promise.reject(new Error("not available in this build")))).then(setTxt).catch((e) => setTxt("Not available: " + errText(e))); }, [url]);
  return <Modal title={title} onClose={onClose}><pre className="ab-text" tabIndex={0}>{txt ?? "Loading..."}</pre></Modal>;
}


/** Admin only: drop zone, CHOOSE FILE, APPLY LICENCE (disabled until the chosen file looks like a licence; the server checks everything again) and REMOVE LICENCE. */
function Upload({ lic, onDone }: { lic: LicenceInfo; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null), [look, setLook] = useState<string>(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null), [drag, setDrag] = useState(false), [rm, setRm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (f: File | null) => {
    setMsg(null); setFile(f); setLook(""); if (!f) return;
    if (f.size > 16 * 1024) return setLook("This file is larger than 16 KB. It is not a licence file.");
    try { const j = JSON.parse(await f.text()); if (!j || typeof j !== "object" || !("signature" in j) || !("device_id" in j)) setLook("This does not look like a licence file."); } catch { setLook("This does not look like a licence file."); }
  };
  const apply = async () => {
    if (!file || look || busy) return; setBusy(true); setMsg(null);
    try { const fd = new FormData(); fd.append("file", file); await api("/licence", { method: "POST", body: fd }); setMsg({ ok: true, text: "LICENCE APPLIED" }); setFile(null); onDone(); }
    catch (e: any) { setMsg({ ok: false, text: errText(e) }); }
    setBusy(false);
  };
  return (<div className="ab-upload">
    <div className="ab-drop" data-drag={drag ? 1 : 0} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void pick(e.dataTransfer.files?.[0] ?? null); }}>
      <span className="fp-cap">DROP LICENCE FILE HERE</span>
      <span className="fp-num" data-testid="chosen-file">{file ? `${file.name} (${file.size} bytes)` : "No file chosen"}</span>
      <input ref={input} type="file" accept=".fplic,application/json" hidden onChange={(e) => void pick(e.target.files?.[0] ?? null)} aria-label="Licence file" />
      <button className="fp-btn" onClick={() => input.current?.click()}>CHOOSE FILE</button>
    </div>
    {look && <p className="fp-msg err" role="status">{look}</p>}
    {msg && (msg.ok ? <Chip tone="ok">{msg.text}</Chip> : <p className="fp-msg err" role="alert">{msg.text}</p>)}
    <div className="fp-row">
      <button className="fp-btn primary ab-apply" disabled={!file || !!look || busy} onClick={apply}>{busy ? "APPLYING..." : "APPLY LICENCE"}</button>
      {lic.state !== "FREE" && <button className="fp-btn danger" onClick={() => setRm(true)}>REMOVE LICENCE</button>}
    </div>
    <p className="fp-cap ab-note">Admin only. One licence file works on one box. Every licence change is written to the audit log.</p>
    {rm && <Modal title="Remove licence" onClose={() => setRm(false)}><p>The box goes back to the FREE licence. Sensors that are already added keep running; only adding more is blocked while the box is over the limit.</p>
      <div className="fp-row"><button className="fp-btn danger" onClick={() => api("/licence", { method: "DELETE" }).then(() => { setRm(false); onDone(); }).catch((e) => setMsg({ ok: false, text: errText(e) }))}>REMOVE LICENCE</button><button className="fp-btn" onClick={() => setRm(false)}>Cancel</button></div></Modal>}
  </div>);
}

export default function About({ admin, from }: { admin: boolean; from: string }) {
  const [info, setInfo] = useState<AboutInfo | null>(null), [err, setErr] = useState(""), [at, setAt] = useState(0), [dlg, setDlg] = useState<"notes" | "notices" | null>(null), [copied, setCopied] = useState("");
  const load = useCallback(() => api<AboutInfo>("/about").then((i) => { setInfo(i); setErr(""); setAt(Date.now()); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);            // automatic refresh every 10 s while the page is open
  const flash = async (key: string, text: string) => { const ok = await copyText(text); setCopied(ok ? key : "!" + key); setTimeout(() => setCopied(""), 2500); };
  if (!info) return <main className="fp-page ab">{err ? <div className="fp-card" role="alert"><p className="fp-msg err">{err}</p><button className="fp-btn" onClick={load}>RETRY</button></div> : <p className="fp-msg">Loading...</p>}</main>;
  const lic = info.licence, c: ComputerInfo | undefined = info.computer;
  return (
    <main className="fp-page ab">
      <header className="ab-head">
        <button className="fp-btn ab-back" onClick={() => go(from)} aria-label="Back">← {from === "/more" ? "More" : "Settings"}</button>
        <span className="fp-cap">{info.product}</span><h1>ABOUT</h1>
      </header>
      <div className="ab-grid">
        <section className="fp-card ab-id" aria-label="Product">
          <picture><source type="image/webp" srcSet="/brand/farm-pilot-core-logo-512.webp 512w, /brand/farm-pilot-core-logo-1024.webp 1024w" sizes="230px" /><img className="ab-logo" src="/brand/farm-pilot-core-logo-512.png" alt="Farm Pilot CORE logo" width={230} height={230} /></picture>
          <h2>{info.product}</h2><p className="fp-muted">{info.tagline}</p>
          <div className="ab-tiles"><Tile k="VERSION" v={info.version ? `v${info.version}` : "--"} /><Tile k="BUILD" v={info.build} /><Tile k="RELEASED" v={day(info.released)} /></div>
          <p className="fp-cap ab-label" data-testid="build-label">{info.product} · {info.label}</p>
          <hr />
          <p className="ab-credit">{info.credit_line.replace(/Trident Labs$/, "")}{/Trident Labs$/.test(info.credit_line) ? <strong>Trident Labs</strong> : null}</p>
          <p className="fp-muted ab-support">{info.support_contact}</p>
          <div className="fp-row ab-btns"><button className="fp-btn" onClick={() => setDlg("notes")}>RELEASE NOTES</button><button className="fp-btn" onClick={() => setDlg("notices")}>NOTICES</button></div>
          <p className="fp-cap">Running for {upFor(info.uptime_s)}</p>
        </section>
        <div className="ab-right">
          <section className="fp-card" aria-label="Licence">
            <div className="fp-row fp-spread"><h3>LICENCE</h3><Chip tone={LIC_TONE[lic.state]}>{lic.state === "LICENSED" ? lic.type : lic.state}</Chip></div>
            <dl className="ab-fields">
              <div><dt className="fp-cap">TYPE</dt><dd>{lic.type}</dd></div>
              <div><dt className="fp-cap">LICENSED TO</dt><dd>{lic.licensed_to ?? "Not activated"}</dd></div>
              <div><dt className="fp-cap">VALID UNTIL</dt><dd>{lic.valid_until ? day(lic.valid_until) : "No expiry"}</dd></div>
              {admin && <div className="ab-dev"><dt className="fp-cap">DEVICE ID</dt><dd><code className="fp-num" data-testid="device-id">{info.device_id ?? "--"}</code>{info.device_id && <button className="fp-btn small" onClick={() => flash("dev", info.device_id!)}>COPY</button>}{copied === "dev" && <Chip tone="ok">COPIED</Chip>}{copied === "!dev" && <Chip tone="warn">SELECT AND COPY BY HAND</Chip>}</dd></div>}
            </dl>
            {lic.reason && <p className="fp-msg err" role="status">{lic.reason}</p>}
            {admin && <Upload lic={lic} onDone={load} />}
            <div className="ab-usages"><Bar label="GATEWAYS" n={lic.usage.gateways} max={lic.limits.gateways} /><Bar label="SENSORS (ALL TYPES)" n={lic.usage.sensors} max={lic.limits.sensors} /></div>
          </section>
          {admin && c && (
            <section className="fp-card" aria-label="This computer">
              <div className="fp-row fp-spread"><h3>THIS COMPUTER</h3><span className="fp-cap" data-testid="refreshed">refreshed {hms(at)}</span></div>
              <div className="ab-comp">
                <Tile k="COMPUTER NAME" v={c.computer_name} /><Tile k="OPERATING SYSTEM" v={c.operating_system} /><Tile k="CPU" v={c.cpu} /><Tile k="MEMORY (USED / TOTAL)" v={`${bytes(c.memory_used_bytes)} / ${bytes(c.memory_total_bytes)}`} />
                <Tile k="DISK FREE (DATA VOLUME)" v={`${bytes(c.disk_free_bytes)}${c.disk_total_bytes ? ` of ${bytes(c.disk_total_bytes)}` : ""}`} /><Tile k="UPTIME" v={upFor(c.uptime_s)} /><Tile k="IP ADDRESS" v={c.ip_addresses.length ? c.ip_addresses.slice(0, 3).join(", ") + (c.ip_addresses.length > 3 ? ` +${c.ip_addresses.length - 3} more` : "") : "--"} /><Tile k="TIME ZONE" v={c.time_zone} />
                <Tile k="NODE.JS" v={c.node_version} /><Tile k="SQLITE" v={c.sqlite_version || "--"} /><Tile k="DATABASE SIZE" v={bytes(c.database_bytes)} /><Tile k="SERIAL PORTS" v={c.serial_ports.length ? `${c.serial_ports.length}: ${c.serial_ports.slice(0, 4).join(", ")}${c.serial_ports.length > 4 ? "..." : ""}` : "None found"} />
              </div>
              <div className="ab-folder"><span className="fp-cap">DATA FOLDER</span><code className="fp-num">{c.data_folder}</code></div>
              <div className="fp-row ab-btns2">
                <button className="fp-btn" onClick={async () => { try { const d = await api<unknown>("/diagnostics"); await flash("diag", JSON.stringify(d, null, 2)); } catch (e) { setCopied("!diag"); setErr(errText(e)); } }}>COPY DIAGNOSTICS</button>
                <a className="fp-btn" href="/api/support-bundle" download>SUPPORT BUNDLE</a>
                {copied === "diag" && <Chip tone="ok">COPIED</Chip>}{copied === "!diag" && <Chip tone="warn">COULD NOT COPY</Chip>}
              </div>
            </section>)}
        </div>
      </div>
      {dlg === "notes" && <TextDialog title="Release notes" url="/CHANGELOG.md" onClose={() => setDlg(null)} />}
      {dlg === "notices" && <TextDialog title="Notices" url="/THIRD-PARTY-NOTICES.txt" onClose={() => setDlg(null)} />}
    </main>
  );
}

/** Phone, Operator: the MORE list of the 4-item bottom navigation. */
export function MorePage() {
  return <main className="fp-page"><h2 style={{ fontFamily: "var(--fp-head)", margin: 0 }}>More</h2><ul className="fp-list"><li style={{ padding: 0 }}><button className="fp-tab" style={{ width: "100%", minHeight: 56, display: "flex", justifyContent: "space-between", alignItems: "center" }} onClick={() => go("/about")}>ABOUT<span aria-hidden>›</span></button></li></ul></main>;
}
