import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, errText } from "./ui";

interface Contact { id: number; name: string; role: string; phone: string; email: string; notify_gateway_offline: number; notify_no_update: number; notify_low_battery: number; notify_calibration_due: number; }
interface Profile {
  farm_name: string; site_name: string; owner_name: string; notes: string; address: string; latitude: number | null; longitude: number | null; timezone: string; language: string; temperature_unit: "C" | "F"; date_format: string; time_format: "12" | "24";
  low_voltage_by_type: Record<string, number>; rssi_good: number | null; rssi_weak: number | null; stale_multiplier: number | null; offline_multiplier: number | null; calibration_due_days: number | null; default_theme: "light" | "dark";
  has_logo: boolean; logo_url: string | null; placeholder: boolean; timezone_confirm_needed: boolean;
  defaults: { rssi_good: number; rssi_weak: number; stale_multiplier: number; offline_multiplier: number; low_voltage_by_type: Record<string, number> }; types: { key: string; label: string }[];
}
type Draft = Record<string, string>;
const ID_KEYS = ["farm_name", "site_name", "owner_name", "notes"], LOC_KEYS = ["address", "latitude", "longitude", "timezone", "language", "temperature_unit", "date_format", "time_format"];
const DEF_KEYS = ["rssi_good", "rssi_weak", "stale_multiplier", "offline_multiplier", "calibration_due_days", "default_theme"];
const NUMERIC = new Set(["latitude", "longitude", "rssi_good", "rssi_weak", "stale_multiplier", "offline_multiplier", "calibration_due_days"]);
const KINDS: [keyof Contact, string][] = [["notify_gateway_offline", "Gateway offline"], ["notify_no_update", "Sensor no update"], ["notify_low_battery", "Low battery"], ["notify_calibration_due", "Calibration due"]];
const zones = (): string[] => { try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return []; } };

export default function FarmProfilePage({ onChanged }: { onChanged: () => void }) {
  const [p, setP] = useState<Profile | null>(null); const [d, setD] = useState<Draft>({}); const [msg, setMsg] = useState<Record<string, { t: "ok" | "err"; s: string }>>({});
  const [contacts, setContacts] = useState<Contact[]>([]); const [nc, setNc] = useState<Draft>({ name: "", role: "", phone: "", email: "" }); const [ncf, setNcf] = useState<Record<string, boolean>>({}); const [cmsg, setCmsg] = useState<{ t: "ok" | "err"; s: string } | null>(null);
  const draftOf = (x: Profile): Draft => { const o: Draft = {}; for (const k of [...ID_KEYS, ...LOC_KEYS, ...DEF_KEYS]) { const v = (x as any)[k]; o[k] = v === null || v === undefined ? "" : String(v); } for (const t of x.types) o["lv_" + t.key] = x.low_voltage_by_type[t.key] === undefined ? "" : String(x.low_voltage_by_type[t.key]); return o; };
  const load = useCallback(() => api<Profile>("/farm-profile").then((x) => { setP(x); setD(draftOf(x)); }).catch((e) => setMsg({ id: { t: "err", s: errText(e) } })), []);
  const loadC = useCallback(() => api<Contact[]>("/farm-contacts").then(setContacts).catch(() => {}), []);
  useEffect(() => { load(); loadC(); }, [load, loadC]);
  if (!p) return <section className="fp-card"><p className="fp-msg">{msg.id?.s ?? "Loading..."}</p></section>;
  const base = draftOf(p); const changed = (keys: string[]) => keys.some((k) => d[k] !== base[k]);
  const set = (k: string, v: string) => setD({ ...d, [k]: v });
  const body = (keys: string[]) => { const o: Record<string, unknown> = {}; for (const k of keys) { if (k.startsWith("lv_")) continue; o[k] = NUMERIC.has(k) ? (d[k] === "" ? null : Number(d[k])) : d[k]; } if (keys.includes("rssi_good")) o.low_voltage_by_type = Object.fromEntries(p.types.filter((t) => d["lv_" + t.key] !== "").map((t) => [t.key, Number(d["lv_" + t.key])])); return o; };
  const save = (card: string, keys: string[]) => api<Profile>("/farm-profile", { method: "PUT", json: body(keys) }).then((x) => { setP(x); setD(draftOf(x)); setMsg({ ...msg, [card]: { t: "ok", s: "Saved." } }); onChanged(); }).catch((e) => setMsg({ ...msg, [card]: { t: "err", s: errText(e) } }));
  const fld = (k: string, label: string, o: { type?: string; hint?: string; inputMode?: "decimal" | "numeric"; ph?: string } = {}) => <label className="fp-field"><span className="fp-cap">{label}</span><input className="fp-input" type={o.type} inputMode={o.inputMode} placeholder={o.ph} value={d[k] ?? ""} onChange={(e) => set(k, e.target.value)} />{o.hint && <span className="fp-hint">{o.hint}</span>}</label>;
  const sel = (k: string, label: string, opts: [string, string][]) => <label className="fp-field"><span className="fp-cap">{label}</span><select className="fp-input" value={d[k] ?? ""} onChange={(e) => set(k, e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  const dflt = (k: string, label: string, def: number, unit: string, o: { whole?: boolean } = {}) => <div className="fp-field"><label className="fp-cap" htmlFor={"d_" + k}>{label}</label><div className="fp-row"><input id={"d_" + k} className="fp-input" inputMode={o.whole ? "numeric" : "decimal"} placeholder={String(def)} value={d[k] ?? ""} onChange={(e) => set(k, e.target.value)} style={{ maxWidth: 140 }} />
    <button type="button" className="fp-btn small" onClick={() => set(k, "")} disabled={d[k] === ""}>Reset</button></div><span className="fp-hint">Built-in default: {def} {unit}{d[k] === "" ? " (in use)" : ""}</span></div>;
  const head = (title: string, keys: string[]) => <div className="fp-row fp-spread"><h3>{title}</h3>{changed(keys) && <Chip tone="warn">CHANGED</Chip>}</div>;
  const foot = (card: string, keys: string[]) => <><div className="fp-row"><button className="fp-btn primary" disabled={!changed(keys)} onClick={() => save(card, keys)}>Save</button>{changed(keys) && <button className="fp-btn" onClick={() => setD({ ...d, ...Object.fromEntries(keys.map((k) => [k, base[k]])) })}>Discard</button>}</div>{msg[card] && <p className={`fp-msg ${msg[card].t}`} role="status">{msg[card].s}</p>}</>;
  const upload = async (f: File | undefined) => {
    if (!f) return; try { const r = await fetch("/api/farm-profile/logo", { method: "POST", credentials: "same-origin", headers: { "content-type": f.type }, body: f }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setP(j); setMsg({ ...msg, id: { t: "ok", s: "Logo saved." } }); onChanged(); }
    catch (e) { setMsg({ ...msg, id: { t: "err", s: errText(e) } }); }
  };
  const addContact = () => api("/farm-contacts", { method: "POST", json: { ...nc, ...Object.fromEntries(KINDS.map(([k]) => [k, !!ncf[k]])) } }).then(() => { setNc({ name: "", role: "", phone: "", email: "" }); setNcf({}); setCmsg({ t: "ok", s: "Contact added." }); loadC(); }).catch((e) => setCmsg({ t: "err", s: errText(e) }));
  const flag = (c: Contact, k: keyof Contact) => api(`/farm-contacts/${c.id}`, { method: "PUT", json: { [k]: !c[k] } }).then(loadC).catch((e) => setCmsg({ t: "err", s: errText(e) }));
  const tzs = zones(); const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" };
  return (<>
    {p.placeholder && <p className="fp-msg" role="status"><Chip tone="info">FIRST START</Chip> Fill in the farm name and the time zone below. The rest of CORE keeps working meanwhile.</p>}
    {p.timezone_confirm_needed && <section className="fp-card" style={{ borderColor: "var(--fp-warn)" }}><div className="fp-row fp-spread"><span><Chip tone="warn">CONFIRM TIME ZONE</Chip> The profile was restored from a backup. Check the time zone ({p.timezone}) matches this box, then confirm.</span>
      <button className="fp-btn primary" onClick={() => api("/farm-profile", { method: "PUT", json: { timezone: d.timezone || p.timezone } }).then(() => { load(); onChanged(); }).catch((e) => setMsg({ ...msg, loc: { t: "err", s: errText(e) } }))}>Confirm {d.timezone || p.timezone}</button></div></section>}
    <div style={grid}>
      <section className="fp-card">{head("Identity", ID_KEYS)}
        <div className="fp-form">{fld("farm_name", "Farm name (shown under the logo in the sidebar)")}{fld("site_name", "Site name (root of the Farm Structure tree)", { hint: "Empty = the farm name." })}{fld("owner_name", "Owner / operator")}
          <div className="fp-field wide"><span className="fp-cap">Logo (PNG or SVG, up to 256 KB)</span><div className="fp-row">{p.logo_url ? <img src={p.logo_url} alt="Farm logo" style={{ maxHeight: 56, maxWidth: 160 }} /> : <span className="fp-muted">No logo</span>}
            <label className="fp-btn small" style={{ cursor: "pointer" }}>Upload<input type="file" accept="image/png,image/svg+xml" style={{ display: "none" }} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
            {p.has_logo && <button className="fp-btn small" onClick={() => api<Profile>("/farm-profile/logo", { method: "DELETE" }).then((x) => { setP(x); onChanged(); }).catch((e) => setMsg({ ...msg, id: { t: "err", s: errText(e) } }))}>Remove</button>}</div></div>
          <label className="fp-field wide"><span className="fp-cap">Notes</span><textarea className="fp-input" rows={3} value={d.notes ?? ""} onChange={(e) => set("notes", e.target.value)} /></label></div>
        {foot("id", ID_KEYS)}</section>
      <section className="fp-card">{head("Location and time", LOC_KEYS)}
        <div className="fp-form">{fld("address", "Address")}<span />{fld("latitude", "Latitude (optional)", { inputMode: "decimal", ph: "25.2048" })}{fld("longitude", "Longitude (optional)", { inputMode: "decimal", ph: "55.2708" })}
          <label className="fp-field"><span className="fp-cap">Time zone (IANA)</span><input className="fp-input" list="fp-tz" value={d.timezone ?? ""} onChange={(e) => set("timezone", e.target.value)} placeholder="Asia/Dubai" /><datalist id="fp-tz">{tzs.map((z) => <option key={z} value={z} />)}</datalist><span className="fp-hint">The header time and all shown times follow it. Stored history stays UTC.</span></label>
          {sel("language", "Language", [["en", "English"]])}{sel("temperature_unit", "Temperature unit (display only)", [["C", "°C"], ["F", "°F"]])}
          {sel("date_format", "Date format", [["D Mon YYYY", "16 Nov 2026"], ["YYYY-MM-DD", "2026-11-16"], ["DD/MM/YYYY", "16/11/2026"], ["MM/DD/YYYY", "11/16/2026"]])}{sel("time_format", "Time format", [["24", "24 hour"], ["12", "12 hour"]])}</div>
        {foot("loc", LOC_KEYS)}</section>
      <section className="fp-card">{head("Defaults and thresholds", [...DEF_KEYS, ...p.types.map((t) => "lv_" + t.key)])}
        <div className="fp-form"><span className="fp-cap wide">Battery</span>{p.types.map((t) => <div key={t.key}>{dflt("lv_" + t.key, `${t.label} low voltage`, p.defaults.low_voltage_by_type[t.key] ?? 0, "V")}</div>)}
          <span className="fp-cap wide">Signal (dBm)</span>{dflt("rssi_good", "Good above", p.defaults.rssi_good, "dBm")}{dflt("rssi_weak", "Poor below", p.defaults.rssi_weak, "dBm")}
          <span className="fp-cap wide">Timing</span>{dflt("stale_multiplier", "No update after (intervals)", p.defaults.stale_multiplier, "intervals", { whole: true })}{dflt("offline_multiplier", "Offline after (intervals)", p.defaults.offline_multiplier, "intervals", { whole: true })}
          <span className="fp-cap wide">Calibration and theme</span>{dflt("calibration_due_days", "Default calibration due (days)", 0, "days (0 = no default due date)", { whole: true })}{sel("default_theme", "Default theme", [["light", "Light"], ["dark", "Dark"]])}</div>
        {foot("def", [...DEF_KEYS, ...p.types.map((t) => "lv_" + t.key)])}</section>
      <section className="fp-card"><h3>Contacts and alarms</h3><span className="fp-hint">Shown on the alarm detail as "who to inform". CORE sends nothing by itself in this version.</span>
        {!contacts.length ? <p className="fp-msg fp-muted">No contacts yet.</p> : <ul className="fp-list">{contacts.map((c) => <li key={c.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="fp-row fp-spread"><span><b>{c.name}</b>{c.role ? ` · ${c.role}` : ""}<span className="fp-muted"> · {[c.phone, c.email].filter(Boolean).join(" · ")}</span></span><button className="fp-btn small" onClick={() => api(`/farm-contacts/${c.id}`, { method: "DELETE" }).then(loadC).catch((e) => setCmsg({ t: "err", s: errText(e) }))}>Delete</button></div>
          <div className="fp-row" style={{ flexWrap: "wrap" }}>{KINDS.map(([k, l]) => <label key={k} className="fp-row fp-cap" style={{ textTransform: "none", minHeight: 44 }}><input type="checkbox" checked={!!c[k]} onChange={() => flag(c, k)} /> {l}</label>)}</div></li>)}</ul>}
        <div className="fp-form"><span className="fp-cap wide">Add contact</span>{(["name", "role", "phone", "email"] as const).map((k) => <label key={k} className="fp-field"><span className="fp-cap">{k}</span><input className="fp-input" value={nc[k]} onChange={(e) => setNc({ ...nc, [k]: e.target.value })} /></label>)}
          <div className="fp-row wide" style={{ flexWrap: "wrap" }}>{KINDS.map(([k, l]) => <label key={k} className="fp-row fp-cap" style={{ textTransform: "none", minHeight: 44 }}><input type="checkbox" checked={!!ncf[k]} onChange={(e) => setNcf({ ...ncf, [k]: e.target.checked })} /> {l}</label>)}</div></div>
        <div className="fp-row"><button className="fp-btn primary" disabled={!nc.name.trim()} onClick={addContact}>Add contact</button></div><span className="fp-hint">A phone number or an email is required.</span>{cmsg && <p className={`fp-msg ${cmsg.t}`} role="status">{cmsg.s}</p>}</section>
    </div>
  </>);
}
