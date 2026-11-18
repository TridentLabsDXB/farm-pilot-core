import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, errText, hhmm, type Tone } from "./ui";
import { AccessBanner, LockedPage, type DsAccess } from "./DataSourceLock";

// The V-BOX tab of the MQTT Payload page (Data sources > V-BOX, PRO or higher; core-vbox-data-source-page.md, variant B). Cards in this order: V-BOX PRESET, V-BOX UNITS FOUND,
// PAYLOAD MAPPING · V-BOX TAGS, LATEST MESSAGES · V-BOX. V-BOX is a data source of its own (1 in the licence, not part of MQTT). The broker connection is the one on ALL MESSAGES.
// The real V-BOX payload is NOT known: every default (vbox/+/data, gh1_temp ...) is a placeholder from src/vbox/defaults.ts.
interface Tag { path: string; name: string; unit: string; scale: number | string; offset: number | string; maps_to: string; readings?: { unit: string; value: number; age_s: number }[] }
interface View {
  access: DsAccess; preset: { enabled: boolean; topic_filter: string; format: string; id_from: "topic" | "payload"; id_level: number; id_path: string; ts_path: string; status: string };
  units: { unit_id: string; state: "new" | "added" | "ignored"; first_seen: number; last_seen: number; msg_count: number; tag_count: number }[];
  farm_points: { value: string; label: string }[]; tags: Tag[]; unmapped: { field: string; count: number }[]; errors: number; messages: { ts: number; topic: string; payload: string; status: "ok" | "unmapped" | "error"; unit: string | null; notes: string[]; stored: boolean }[]; note: string;
}
const MSG: Record<string, [Tone, string]> = { ok: ["ok", "OK"], unmapped: ["warn", "UNMAPPED"], error: ["alarm", "ERROR"] };

export default function VboxTab() {
  const [v, setV] = useState<View | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<{ t: "ok" | "err"; s: string } | null>(null);
  const [p, setP] = useState<{ topic_filter: string; format: string; id_from: string; id_level: string; id_path: string; dirty: boolean } | null>(null);
  const [tags, setTags] = useState<{ rows: Tag[]; dirty: boolean } | null>(null);
  const load = useCallback(async (fresh = false) => {
    try { const x = await api<View>("/vbox"); setV(x); setErr("");
      setP((d) => (fresh || !d || !d.dirty ? { topic_filter: x.preset.topic_filter, format: x.preset.format, id_from: x.preset.id_from, id_level: String(x.preset.id_level), id_path: x.preset.id_path, dirty: false } : d));
      setTags((d) => (fresh || !d || !d.dirty ? { rows: x.tags.map((t) => ({ ...t })), dirty: false } : d)); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(true); const i = setInterval(() => void load(), 3000); return () => clearInterval(i); }, [load]);
  if (err && !v) return <section className="fp-card"><p className="fp-msg err">{err}</p></section>;
  if (!v || !p || !tags) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  if (v.access.state === "locked") return <LockedPage title="V-BOX" message={v.access.message ?? ""} />;
  const frozen = v.access.state === "stopped", on = v.preset.enabled;
  const run = async (k: string, f: () => Promise<void>) => { setBusy(k); setMsg(null); try { await f(); } catch (e) { setMsg({ t: "err", s: errText(e) }); } finally { setBusy(null); } };
  const unit = (id: string, a: "add" | "ignore" | "remove") => run("u", async () => { setV(a === "remove" ? await api<View>(`/vbox/units/${encodeURIComponent(id)}`, { method: "DELETE" }) : await api<View>(`/vbox/units/${encodeURIComponent(id)}/${a}`, { method: "POST", json: {} })); });
  const setRow = (i: number, q: Partial<Tag>) => setTags((d) => d && { dirty: true, rows: d.rows.map((r, j) => (j === i ? { ...r, ...q } : r)) });
  const fresh = v.units.filter((u) => u.state === "new"), shown = v.units.filter((u) => u.state !== "new");
  const Msg = () => (msg ? <p className={"fp-msg" + (msg.t === "err" ? " err" : "")} role="status">{msg.s}</p> : null);
  return (
    <fieldset className="mq" data-testid="vbox-tab" disabled={frozen}>
      <AccessBanner a={v.access} />
      <section className="fp-card" aria-label="V-BOX preset"><h3>V-BOX PRESET <Chip tone={on ? "ok" : "off"}>{v.preset.status}</Chip></h3>
        <p className="fp-msg">V-BOX data arrives over the broker connection on ALL MESSAGES. This source counts as 1 data source in the licence.</p>
        <div className="mq-form">
          <label>Topic filter<input className="fp-input" value={p.topic_filter} onChange={(e) => setP({ ...p, topic_filter: e.target.value, dirty: true })} /></label>
          <label>Payload format<input className="fp-input" value={p.format} onChange={(e) => setP({ ...p, format: e.target.value, dirty: true })} /></label>
          <label>Device ID from<select className="fp-input" value={p.id_from} onChange={(e) => setP({ ...p, id_from: e.target.value, dirty: true })}><option value="topic">Topic level</option><option value="payload">Payload field</option></select></label>
          {p.id_from === "topic" ? <label>Topic level (1 = first)<input className="fp-input" inputMode="numeric" value={p.id_level} onChange={(e) => setP({ ...p, id_level: e.target.value, dirty: true })} /></label>
            : <label>Payload field<input className="fp-input" value={p.id_path} onChange={(e) => setP({ ...p, id_path: e.target.value, dirty: true })} /></label>}
        </div>
        <div className="fp-row mq-btns">
          <button className="fp-btn primary" disabled={busy !== null || !p.dirty} onClick={() => run("p", async () => { setV(await api<View>("/vbox/preset", { method: "PUT", json: { topic_filter: p.topic_filter.trim(), format: p.format, id_from: p.id_from, id_level: Number(p.id_level), id_path: p.id_path.trim() } })); setP({ ...p, dirty: false }); })}>SAVE PRESET</button>
          <button className={"fp-btn " + (on ? "stop" : "go")} aria-pressed={on} disabled={busy !== null} onClick={() => run("e", async () => setV(await api<View>("/vbox/enabled", { method: "POST", json: { enabled: !on } })))}>{on ? "REMOVE V-BOX SOURCE" : "ENABLE V-BOX SOURCE"}</button>
        </div><Msg />
      </section>

      <section className="fp-card" aria-label="V-BOX units found"><h3>V-BOX UNITS FOUND {fresh.length > 0 && <Chip tone="warn">{fresh.length} NOT ADDED</Chip>}</h3>
        {v.units.length === 0 ? <p className="fp-msg">No V-BOX seen yet. A unit appears here when a message arrives on the preset topic.</p> : <ul className="fp-list mq-list">
          {fresh.map((u) => <li key={u.unit_id}><span><strong className="mq-num">{u.unit_id}</strong> <span className="fp-cap">first seen {hhmm(u.first_seen)}</span></span><span className="fp-row"><button className="fp-btn small" disabled={busy !== null} onClick={() => unit(u.unit_id, "add")}>ADD</button><button className="fp-btn small" disabled={busy !== null} onClick={() => unit(u.unit_id, "ignore")}>IGNORE</button></span></li>)}
          {shown.map((u) => <li key={u.unit_id}><span><strong className="mq-num">{u.unit_id}</strong> <span className="fp-cap">{u.tag_count} tags · {u.msg_count} messages · last {hhmm(u.last_seen)}</span></span><span className="fp-row"><Chip tone={u.state === "added" ? "ok" : "off"}>{u.state === "added" ? "ADDED" : "IGNORED"}</Chip><button className="fp-btn small" disabled={busy !== null} onClick={() => unit(u.unit_id, "remove")}>REMOVE</button></span></li>)}
        </ul>}
      </section>

      <section className="fp-card" aria-label="Payload mapping V-BOX tags"><h3>PAYLOAD MAPPING · V-BOX TAGS {tags.dirty && <Chip tone="warn">CHANGED</Chip>}</h3>
        <p className="fp-msg">Placeholder tags until the real V-BOX payload is known. Value in CORE = tag value × scale + offset.</p>
        <div className="mq-scroll"><table className="fp-table"><thead><tr><th>TAG</th><th>MEASUREMENT</th><th>UNIT</th><th>SCALE</th><th>OFFSET</th><th>V-BOX · VALUE · AGE</th><th>MAPS TO</th><th /></tr></thead><tbody>
          {tags.rows.map((r, i) => <tr key={i}>{(["path", "name", "unit", "scale", "offset"] as const).map((k) => <td key={k}><input className="fp-input mq-cell" aria-label={`${k} row ${i + 1}`} value={String(r[k])} onChange={(e) => setRow(i, { [k]: e.target.value })} /></td>)}
            <td className="mq-num">{r.readings?.length ? r.readings.map((x) => `${x.unit} · ${Number(x.value.toFixed(2))} · ${x.age_s} s`).join("; ") : "--"}</td>
            <td><select className="fp-input mq-cell" aria-label={`maps to row ${i + 1}`} value={r.maps_to} onChange={(e) => setRow(i, { maps_to: e.target.value })}><option value="">not mapped</option>{v.farm_points.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></td>
            <td><button className="fp-btn small" aria-label={`Remove row ${i + 1}`} onClick={() => setTags({ dirty: true, rows: tags.rows.filter((_, j) => j !== i) })}>REMOVE</button></td></tr>)}
        </tbody></table></div>
        <div className="fp-row mq-add"><button className="fp-btn" onClick={() => setTags({ dirty: true, rows: [...tags.rows, { path: "", name: "", unit: "", scale: 1, offset: 0, maps_to: "" }] })}>ADD ROW</button>
          <button className="fp-btn primary" disabled={busy !== null || !tags.dirty} onClick={() => run("t", async () => { setV(await api<View>("/vbox/tags", { method: "PUT", json: { tags: tags.rows.map((r) => ({ ...r, scale: Number(r.scale), offset: Number(r.offset), readings: undefined })) } })); setTags({ ...tags, dirty: false }); setMsg({ t: "ok", s: "Mapping saved." }); })}>SAVE</button></div>
        <div className="mq-split"><div><span className="fp-cap">UNMAPPED TAGS</span>{v.unmapped.length === 0 ? <p className="fp-msg">None seen.</p> : <ul className="mq-chips">{v.unmapped.map((u) => <li key={u.field}><Chip tone="warn">{u.field} × {u.count}</Chip></li>)}</ul>}</div><div><span className="fp-cap">PARSE ERRORS</span><p className="mq-num">{v.errors}</p></div></div>
      </section>

      <section className="fp-card" aria-label="Latest messages V-BOX"><h3>LATEST MESSAGES · V-BOX</h3>
        {v.messages.length === 0 ? <p className="fp-msg">No V-BOX messages received yet.</p> : <ol className="mq-msgs">{v.messages.map((m, i) => { const [tone, word] = MSG[m.status]; return <li key={m.ts + ":" + i}>
          <div className="fp-row mq-mh"><span className="mq-num">{hhmm(m.ts)}</span><span className="mq-num">{m.topic}</span><Chip tone={tone}>{word}</Chip>{m.unit && <span className="fp-cap">{m.unit}</span>}</div>
          {m.notes.length > 0 && <p className="fp-cap mq-notes">{m.notes.join(" · ")}</p>}<pre className="mq-raw">{m.payload}</pre></li>; })}</ol>}
      </section>
    </fieldset>
  );
}
