import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, Modal, errText } from "./ui";

interface Z { id: number; name: string; type: string; } interface P { id: number; zone_id: number; serial: string; metric: string; role: string; unit: string; }
interface S { serial: string; label: string; slot: number; zoneId: number | null; type: string; } interface T { key: string; label: string; name: string; type: string; roles: string[]; }
const unitLabel = (u: string) => (u === "C" ? "°C" : u);
const ZTYPES: [string, string][] = [["climate", "Climate"], ["soil", "Soil"], ["water_storage", "Water storage"], ["irrigation", "Irrigation"], ["custom", "Custom"]];

export default function StructurePage({ reload }: { reload: () => void }) {
  const [d, setD] = useState<{ zones: Z[]; points: P[]; sensors: S[]; templates: T[] } | null>(null); const [sel, setSel] = useState<number | "new" | null>(null);
  const [name, setName] = useState(""); const [type, setType] = useState("climate"); const [msg, setMsg] = useState<{ t: string; s: string } | null>(null); const [pick, setPick] = useState(""); const [askT, setAskT] = useState<T | null>(null);
  const load = useCallback(() => api<any>("/structure").then(setD).catch((e) => setMsg({ t: "err", s: errText(e) })), []); useEffect(() => { load(); }, [load]);
  const zone = typeof sel === "number" ? d?.zones.find((z) => z.id === sel) ?? null : null;
  // The first zone is selected by default so its editor (points, add point, remove) is visible at once; "Add zone" switches to the new-zone form.
  useEffect(() => { if (d && sel === null && d.zones.length) setSel(d.zones[0].id); }, [d, sel]); useEffect(() => { if (zone) { setName(zone.name); setType(zone.type); } }, [zone?.id, zone?.name, zone?.type]);
  if (!d) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const run = async (f: () => Promise<any>, ok?: string) => { setMsg(null); try { const r = await f(); if (ok) setMsg({ t: "ok", s: ok }); await load(); reload(); return r; } catch (e) { setMsg({ t: "err", s: errText(e) }); } };
  const count = (id: number) => d.sensors.filter((s) => s.zoneId === id).length; const free = d.sensors.filter((s) => s.zoneId === null);
  const addZone = async (n: string, t: string) => { const r = await run(() => api<{ id: number }>("/zones", { method: "POST", json: { name: n, type: t } }), "Zone added."); if (r) setSel(r.id); };
  const mine = d.points.filter((p) => p.zone_id === sel);
  // Templates only fill the NAME and TYPE fields (they never create, change or delete points). If that would replace something already there
  // (a saved zone, typed text, or a zone that already has points) the Admin is asked first.
  const askTemplate = (t: T) => {
    const same = name === t.name && type === t.type;
    const hasSomething = zone !== null || name.trim() !== "";        // an existing zone, or text the Admin already typed
    if (same) return;
    if (!hasSomething) { setName(t.name); setType(t.type); } else setAskT(t);
  };

  return (<>
    <div className="fp-struct">
      <section className="fp-card"><h3>Farm</h3><div className="fp-tree fp-list">{d.zones.map((z) => <li key={z.id}><button className="fp-btn" style={sel === z.id ? { borderColor: "var(--fp-accent)", color: "var(--fp-accent)" } : undefined} aria-pressed={sel === z.id} onClick={() => setSel(z.id)}><span>{z.name}</span><span className="fp-cap">{ZTYPES.find(([k]) => k === z.type)?.[1]} · {count(z.id)} sensor{count(z.id) === 1 ? "" : "s"}</span></button></li>)}</div>
        {!d.zones.length && <p className="fp-msg fp-muted">No zones yet. Start from a template.</p>}
        <button className="fp-btn" onClick={() => { setSel("new"); setName(""); setType("climate"); }}>Add zone</button></section>
      <section className="fp-card"><h3>{zone ? `Zone: ${zone.name}` : "New zone"}</h3>
        <div className="fp-row"><span className="fp-cap">Templates</span>{d.templates.map((t) => <button key={t.key} className="fp-btn small" onClick={() => askTemplate(t)}>{t.label}</button>)}</div>
        <div className="fp-row"><label className="fp-field" style={{ flex: 1, minWidth: 200 }}><span className="fp-cap">Zone name</span><input className="fp-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="fp-field"><span className="fp-cap">Zone type</span><select className="fp-input" value={type} onChange={(e) => setType(e.target.value)}>{ZTYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label></div>
        <div className="fp-row">{zone ? <><button className="fp-btn primary" onClick={() => run(() => api(`/zones/${zone.id}`, { method: "PATCH", json: { name, type } }), "Saved.")}>Save zone</button>
          <button className="fp-btn danger" onClick={() => confirm(`Delete zone ${zone.name}? Its sensors stay, but leave the zone.`) && run(() => api(`/zones/${zone.id}`, { method: "DELETE" }).then(() => setSel(null)), "Zone deleted.")}>Delete zone</button></>
          : <button className="fp-btn primary" disabled={!name.trim()} onClick={() => addZone(name, type)}>Create zone</button>}</div>
        {zone && <><h3 style={{ fontSize: 18 }}>Points</h3>
          {!mine.length ? <p className="fp-msg fp-muted">No points. Add a sensor to place its temperature and humidity here.</p> : <ul className="fp-list">{mine.map((p) => { const s = d.sensors.find((x) => x.serial === p.serial); return <li key={p.id}>
            <span><b style={{ fontFamily: "var(--fp-head)", fontSize: 16 }}>{p.role}</b> <span className="fp-muted">·</span> {s?.label || <span className="fp-muted">No label</span>} <span className="fp-muted">· {p.serial} · slot {s?.slot ?? "--"} · {unitLabel(p.unit)}</span></span>
            <button className="fp-btn small danger" onClick={() => run(() => api(`/points/${p.id}`, { method: "DELETE" }))}>Remove</button></li>; })}</ul>}
          <div className="fp-row"><select className="fp-input" aria-label="Sensor to add" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Add point: choose a sensor...</option>{d.sensors.filter((s) => s.zoneId !== zone.id).map((s) => <option key={s.serial} value={s.serial}>{s.label ? `${s.label} (${s.serial})` : s.serial}</option>)}</select>
            <button className="fp-btn" disabled={!pick} onClick={() => run(() => api("/zones/assign", { method: "POST", json: { serial: pick, zoneId: zone.id } }).then(() => setPick("")))}>Add point</button></div></>}
      </section></div>
    <section className="fp-card"><h3>Sensors not in any zone</h3>
      {!free.length ? <Chip tone="ok">ALL SENSORS PLACED</Chip> : <ul className="fp-list">{free.map((s) => <li key={s.serial}><span>{s.label || <span className="fp-muted">No label</span>} <span className="fp-muted">· {s.serial} · slot {s.slot}</span></span>
        <select className="fp-input" aria-label={`Assign ${s.label || s.serial}`} value="" onChange={(e) => e.target.value && run(() => api("/zones/assign", { method: "POST", json: { serial: s.serial, zoneId: Number(e.target.value) } }), "Assigned.")}><option value="">Assign to zone...</option>{d.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></li>)}</ul>}
    </section>
    {msg && <p className={`fp-msg ${msg.t}`} role="status">{msg.s}</p>}
    {askT && <Modal title={`Apply template ${askT.label}?`} onClose={() => setAskT(null)}>
      <p className="fp-msg">This replaces the zone name and type in the form with <b>{askT.name}</b> / <b>{ZTYPES.find(([k]) => k === askT.type)?.[1]}</b>{zone ? ` (now ${zone.name} / ${ZTYPES.find(([k]) => k === zone.type)?.[1]})` : name.trim() ? ` (now "${name.trim()}")` : ""}.</p>
      {zone && mine.length > 0 && <p className="fp-msg">The zone's {mine.length} point{mine.length === 1 ? "" : "s"} are not changed. Nothing is saved until you press SAVE ZONE.</p>}
      <div className="fp-row"><button className="fp-btn primary" onClick={() => { setName(askT.name); setType(askT.type); setAskT(null); }}>Replace name and type</button><button className="fp-btn" onClick={() => setAskT(null)}>Keep what I have</button></div></Modal>}
  </>);
}
