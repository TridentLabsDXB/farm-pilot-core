import { useCallback, useState } from "react";
import { api, type Scada, type AdminSensor, type TypeInfo } from "./api";
import { go } from "./App";
import Scan, { scanSupported } from "./Scan";
import { Battery, Chip, CommissioningBanner, Modal, Signal, SYNC, StatusChip, dur, mdur, errText } from "./ui";
import { ConfirmModal, SendBar, useSync } from "./Sync";

export default function SensorsPage({ scada, reload }: { scada: Scada | null; reload: () => void }) {
  const S = useSync(scada, reload); const { list, gw, load, ok, fail } = S; const [adding, setAdding] = useState(false);
  if (!list || !gw) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;
  const th = list.types.find((t) => t.key === "th"); const sensors = list.sensors;
  // Intervals are in the gateway's unit (minutes for T/H, 5..240). Presets are offered; a custom whole number inside min..max is accepted too. The server validates.
  const setInterval_ = async (s: AdminSensor, v: string) => { try { await api(`/sensors/${s.serial}`, { method: "PATCH", json: { interval: Number(v) } }); load(); } catch (e) { fail(e); } };
  const presets = (s: AdminSensor) => { const t = list.types.find((x) => x.key === s.type)!; return [...new Set([...t.presets, s.interval])].sort((a, b) => a - b); };   // a stored value that is no longer allowed is still shown, and flagged
  const setCommissioning = async (on: boolean) => { try { await api("/gateway/settings", { method: "PUT", json: { commissioning: on } }); load(); } catch (e) { fail(e); } };
  const interval = (s: AdminSensor) => (
    <span className="stack"><select className="fp-input" aria-label={`Interval for ${s.label}`} value={s.interval} onChange={(e) => setInterval_(s, e.target.value)}>{presets(s).map((p) => <option key={p} value={p}>{mdur(p)}{s.intervalOk || p !== s.interval ? "" : " (not allowed)"}</option>)}</select><input className="fp-input" style={{ width: 72 }} type="number" inputMode="numeric" aria-label={`Custom interval in minutes for ${s.label}`} placeholder="custom" min={list.types.find((x) => x.key === s.type)?.min} max={list.types.find((x) => x.key === s.type)?.max} onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLInputElement).value) { setInterval_(s, (e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ""; } }} />{!s.intervalOk && <Chip tone="warn" title="This stored value is outside the allowed range. Choose an allowed interval.">NOT ALLOWED</Chip>}{s.applying && <Chip tone="info">APPLYING</Chip>}</span>);
  return (<>
    {!!th?.commissioningPresets.length && th?.commissioning && <CommissioningBanner until={scada?.commissioning?.until ?? null} onOff={() => setCommissioning(false)} />}
    <section className="fp-card">
      <div className="fp-row fp-spread"><h3>Sensors</h3><button className="fp-btn small" onClick={() => go("/settings/sensors-gateway")}>Open Sensors Gateway</button></div>
      <SendBar s={S} />
    </section>
    <section className="fp-card">
      <div className="fp-row fp-spread"><h3>Sensors</h3><div className="fp-row"><button className="fp-btn" onClick={() => setAdding(true)}>Add sensors</button>{scanSupported() && <button className="fp-btn" onClick={() => setAdding(true)}>Scan QR</button>}</div></div>
      <span className="fp-hint">Click a row to open the sensor: label, zone, calibration, replace and remove are all on its page.</span>
      {!!th?.commissioningPresets.length ? <label className="fp-row fp-cap" style={{ textTransform: "none", letterSpacing: ".02em" }}><input type="checkbox" checked={!!th?.commissioning} onChange={(e) => setCommissioning(e.target.checked)} /> Commissioning mode (switches off by itself after 8 hours): also allow {th.commissioningPresets.map(mdur).join(", ")} (short intervals reduce battery life).</label>
        : <span className="fp-cap" style={{ textTransform: "none", letterSpacing: ".02em" }}>Reporting interval: {th ? `${th.min} to ${th.max} ${th.unit}` : ""}, default {th ? mdur(th.defaultInterval) : ""}. A short interval reduces battery life. 30 s and 1 min are not possible on this gateway.</span>}
      <div className="fp-gt" role="table" aria-label="Sensors">
        <div className="fp-gr head" role="row"><span>Slot</span><span>Serial</span><span>Label / zone</span><span>Interval</span><span>Battery / signal</span><span>State</span><span /></div>
        {sensors.map((s) => (
          <div key={s.serial} role="row" className="fp-gr click" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
            <span>{s.slot ?? "--"}</span><span>{s.serial}</span>
            <span className="stack"><span className="nm">{s.labelSet ? s.label : <span className="fp-muted" style={{ fontWeight: 500 }}>No label</span>}</span><span className="fp-muted">{list.zones.find((z) => z.id === s.zoneId)?.name ?? "No zone"}</span></span>
            <span onClick={(e) => e.stopPropagation()}>{interval(s)}</span>
            <span className="stack"><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /></span>
            <span className="stack"><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip><StatusChip status={s.status} />{s.calDue && <Chip tone="warn">CAL DUE</Chip>}</span>
            <button className="fp-btn small" aria-label={`Calibrate ${s.label}`} onClick={(e) => { e.stopPropagation(); go(`/settings/sensors/${s.serial}/calibrate`); }}>Calibrate</button>
          </div>))}
      </div>
      <div className="fp-cards">{sensors.map((s) => (
        <div key={s.serial} className="fp-srow" data-warn={s.syncState === "in_gateway" ? 0 : 1} onClick={() => go(`/settings/sensors/${s.serial}`)}>
          <span className="l">{s.labelSet ? s.label : "No label"}</span><Chip tone={SYNC[s.syncState][0]}>{SYNC[s.syncState][1]}</Chip>
          <span className="m"><span>slot {s.slot ?? "--"}</span><span>{s.serial}</span><span>{list.zones.find((z) => z.id === s.zoneId)?.name ?? "no zone"}</span></span>
          <span className="m" onClick={(e) => e.stopPropagation()}>{interval(s)}</span><span className="m"><StatusChip status={s.status} /><Battery v={s.voltage} low={s.lowVoltage} /><Signal rssi={s.rssi} band={s.rssiBand} /></span>
          <span className="m" onClick={(e) => e.stopPropagation()}><button className="fp-btn small" onClick={() => go(`/settings/sensors/${s.serial}/calibrate`)}>Calibrate</button><button className="fp-btn small" onClick={() => go(`/settings/sensors/${s.serial}`)}>Details</button></span></div>))}</div>
      {!sensors.length && <p className="fp-msg fp-muted">No sensors yet. Press ADD SENSORS and type or paste the serials.</p>}
    </section>
    {adding && <AddModal types={list.types} pattern={list.pattern} existing={sensors.map((s) => s.serial)} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); ok(`${n} sensor(s) added. Press SEND TO GATEWAY to push them.`); load(); reload(); }} />}
    <ConfirmModal s={S} />
  </>);
}

function AddModal({ types, pattern, existing, onClose, onDone }: { types: TypeInfo[]; pattern: string; existing: string[]; onClose: () => void; onDone: (n: number) => void }) {
  const [type, setType] = useState(types[0]?.key ?? "th"); const [text, setText] = useState(""); const [err, setErr] = useState(""); const [scan, setScan] = useState(false);
  const t = types.find((x) => x.key === type)!; const serials = text.split(/[\s,;]+/).filter(Boolean); const re = new RegExp(pattern);
  const badOnes = serials.filter((s) => !re.test(s) || /^0/.test(s) || Number(s) > 0xfffffffe); const dup = serials.length !== new Set(serials).size; const already = [...new Set(serials.filter((s) => existing.includes(s)))];
  const onCode = useCallback((c: string) => setText((x) => (x.toUpperCase().includes(c.trim().toUpperCase()) ? x : (x ? x + "\n" : "") + c.trim())), []);
  return (
    <Modal title="Add sensors" onClose={onClose}>
      <label className="fp-field"><span className="fp-cap">Sensor type</span><select className="fp-input" value={type} onChange={(e) => setType(e.target.value)}>{types.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label>
      <label className="fp-field"><span className="fp-cap">Serials, one per line (paste a list or type)</span><textarea className="fp-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="112600310" spellCheck={false} /></label>
      {scanSupported() ? (scan ? <Scan onCode={onCode} onClose={() => setScan(false)} /> : <button className="fp-btn" onClick={() => setScan(true)}>Scan QR / barcode</button>) : <span className="fp-cap" style={{ textTransform: "none" }}>Camera scan is not available in this browser: type or paste the serials.</span>}
      <span className="fp-num">{t.label}: {t.used} of {t.groups} slots used, adding {serials.length}</span>
      {badOnes.length > 0 && <p className="fp-msg err">Not a valid serial (the plain decimal number printed on the label, 7 to 10 digits): {badOnes.slice(0, 3).join(", ")}{badOnes.length > 3 ? "..." : ""}</p>}{dup && <p className="fp-msg err">The list contains duplicates.</p>}{already.length > 0 && <p className="fp-msg err">Already in CORE: {already.slice(0, 3).join(", ")}{already.length > 3 ? "..." : ""}</p>}
      {t.used + serials.length > t.groups && <p className="fp-msg err">This would exceed {t.groups} slots.</p>}{err && <p className="fp-msg err" role="alert">{err}</p>}
      <div className="fp-row"><button className="fp-btn primary" disabled={!serials.length || badOnes.length > 0 || dup || already.length > 0 || t.used + serials.length > t.groups} onClick={() => api("/sensors", { method: "POST", json: { type, serials } }).then(() => onDone(serials.length)).catch((e) => setErr(errText(e)))}>Add {serials.length || ""} sensor{serials.length === 1 ? "" : "s"}</button><button className="fp-btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
