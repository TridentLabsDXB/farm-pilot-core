// 2026-11-17 -- READ GATEWAY T/H SECTION / READ GATEWAY SOIL SECTION (Admin only: the whole Gateway page is). Read-only: one FC04 read of the type's config groups through the normal request queue.
// Shows what the gateway holds next to what CORE knows. IMPORT INTO CORE only adds "Only in gateway" sensors to CORE; nothing is ever written to the gateway from here.
// A failed read (soil is not verified on hardware yet) is a plain message; it never changes the gateway state.
import { useState } from "react";
import { api } from "./api";
import { Chip, Modal, dt, errText, hhmm } from "./ui";

interface Slot { slot: number; serial: string | null; interval: number | null; control: number | null; state: "CONFIGURED" | "EMPTY"; match: "in_core" | "only_gateway" | "slot_mismatch" | null; coreSlot: number | null; }
interface Read { section: string; label: string; ok: boolean; at: number; tookMs: number; address: number; count: number; bytes: number; hex: string; used: number; total: number; slots: Slot[];
  onlyInCore: { serial: string; slot: number | null; label: string }[]; importable: boolean; importNote: string | null; error: string | null; }

function Section({ section, button, title, reload }: { section: string; button: string; title: string; reload: () => void }) {
  const [r, setR] = useState<Read | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ t: string; s: string } | null>(null); const [ask, setAsk] = useState(false);
  const read = async () => { setBusy(true); setMsg(null); try { setR(await api<Read>(`/gateway/read-section/${section}`, { method: "POST" })); } catch (e) { setR(null); setMsg({ t: "err", s: errText(e) }); } finally { setBusy(false); } };
  const imp = async () => { setAsk(false); setBusy(true); try { const x = await api<{ added: string[]; skipped: { serial: string; reason: string }[] }>(`/gateway/import-section/${section}`, { method: "POST" });
    setMsg({ t: "ok", s: `${x.added.length} sensor${x.added.length === 1 ? "" : "s"} added to CORE${x.skipped.length ? `, ${x.skipped.length} skipped (${x.skipped.map((k) => `${k.serial}: ${k.reason}`).join("; ")})` : ""}. Nothing was written to the gateway.` }); reload(); setR(await api<Read>(`/gateway/read-section/${section}`, { method: "POST" })); }
    catch (e) { setMsg({ t: "err", s: errText(e) }); } finally { setBusy(false); } };
  const onlyGw = r?.slots.filter((s) => s.match === "only_gateway") ?? [];
  return (<div className="fp-field" style={{ gap: 8 }}>
    <div className="fp-row"><button className="fp-btn" disabled={busy} onClick={read}>{busy ? "READING..." : button}</button></div>
    {msg && <p className={"fp-msg" + (msg.t === "err" ? " err" : "")} role="status">{msg.s}</p>}
    {r && !r.ok && <p className="fp-msg err" role="status">{r.error}</p>}
    {r?.ok && <>
      <p className="fp-msg"><b className="fp-num">{r.used} of {r.total}</b> slots used, read at <span className="fp-num">{hhmm(r.at)}</span></p>
      <div style={{ overflowX: "auto" }}><table className="fp-table" aria-label={title}><thead><tr><th>Slot</th><th>Serial</th><th>Interval (min)</th><th>Control</th><th>State</th><th>CORE</th></tr></thead><tbody>
        {r.slots.map((s) => (<tr key={s.slot} data-warn={s.match === "slot_mismatch" ? "1" : undefined}><td>{s.slot}</td><td>{s.serial ?? "--"}</td><td>{s.interval ?? "--"}</td><td>{s.control ?? "--"}</td>
          <td>{s.state === "CONFIGURED" ? <Chip tone="ok">CONFIGURED</Chip> : <Chip tone="off">EMPTY</Chip>}</td>
          <td>{s.match === "in_core" ? <Chip tone="ok">In CORE</Chip> : s.match === "only_gateway" ? <Chip tone="info">Only in gateway</Chip> : s.match === "slot_mismatch" ? <Chip tone="warn" title="Same serial, different slot">Slot mismatch: CORE has slot {s.coreSlot ?? "--"}</Chip> : "--"}</td></tr>))}</tbody></table></div>
      {r.onlyInCore.length > 0 && <div><span className="fp-cap">Only in CORE (not in gateway)</span><ul className="fp-list">{r.onlyInCore.map((s) => <li key={s.serial}><span className="fp-num">{s.serial}{s.label ? ` (${s.label})` : ""}</span><span>slot {s.slot ?? "--"}</span></li>)}</ul></div>}
      {r.importable ? <div className="fp-row"><button className="fp-btn" disabled={busy || !onlyGw.length} onClick={() => setAsk(true)}>IMPORT INTO CORE</button>{!onlyGw.length && <span className="fp-msg fp-muted">Nothing to import: every configured slot is already in CORE.</span>}</div>
        : <p className="fp-msg fp-muted">{r.importNote}</p>}
      <details><summary className="fp-cap">Details</summary><p className="fp-msg fp-muted">FC04, address 0x{r.address.toString(16).padStart(4, "0")}, {r.count} registers: {r.bytes} bytes in {r.tookMs} ms ({dt(r.at)})</p><code className="fp-num" style={{ wordBreak: "break-all", fontSize: 12 }}>{r.hex || "--"}</code></details>
    </>}
    {ask && <Modal title="Import into CORE?" onClose={() => setAsk(false)}><p className="fp-msg">{onlyGw.length} sensor{onlyGw.length === 1 ? "" : "s"} that the gateway holds and CORE does not will be added to CORE with the gateway's slot and interval. Nothing is written to the gateway. The import is written to the audit log.</p>
      <div className="fp-row"><button className="fp-btn" onClick={imp}>Import</button><button className="fp-btn" onClick={() => setAsk(false)}>Cancel</button></div></Modal>}
  </div>);
}

export function SectionReads({ reload }: { reload: () => void }) {
  return (<section className="fp-card"><h3>Read from gateway</h3><p className="fp-msg fp-muted">Read-only. Shows what the gateway holds and compares it with CORE. Nothing is written to the gateway.</p>
    <Section section="th" button="READ GATEWAY T/H SECTION" title="T/H slots in the gateway" reload={reload} />
    <Section section="soil" button="READ GATEWAY SOIL SECTION" title="Soil slots in the gateway" reload={reload} /></section>);
}
