import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Modal, errText } from "./ui";
import { copyText } from "./About";
import "./licences.css";

// 2026-11-17 -- LICENCE MANAGEMENT, Option B (list left, detail right). ONLINE build only (the route and the menu entry need /api/me online:true) and Admin only; the server answers 404 / 403 as well.
// RECORD ONLY: deployments, usage and "seen" are entered by hand; RENEW / ISSUE record a licence and a history row and sign nothing; DOWNLOAD .FPLIC stays disabled; there is no REVOKE (a box verifies its licence offline).
// Status, flags, term and effective limits all come from the server (src/deployments/calc.ts), computed from valid_until against the SERVER clock. Every status is a lamp SHAPE plus a WORD.
type Status = "active" | "expiring" | "expired" | "free"; type Flag = "ok" | "at_limit" | "over_limit";
interface Limits { gateways: number | null; sensors: number | null; reports_days: number | null; retention_days: number | null; }
interface Dep { id: number; name: string; deviceId: string; licensedTo: string | null; licenceId: string | null; type: "FREE" | "PRO" | "FULL" | "ENGINEERING"; issuedAt: string | null; validUntil: string | null; status: Status; daysLeft: number | null; termPct: number | null;
  limits: Limits; usage: { gateways: number; sensors: number }; effectiveLimits: Limits; usageFlags: { gateways: Flag; sensors: Flag }; lastSeen: number | null; }
/** The tier table comes from the server (src/deployments/tiers.ts, the one constant): the page never repeats the numbers. gateways = DATA SOURCES on screen. */
type Tiers = Record<"FREE" | "PRO" | "FULL" | "ENGINEERING", { gateways: number | null; sensors: number | null; reports_days: number | null; retention_days: number | null }>;
const tierWord = (t: Tiers[keyof Tiers]) => t.gateways === null ? "unlimited data sources, unlimited sensors" : `${t.gateways} data ${t.gateways === 1 ? "source" : "sources"}, ${t.sensors} sensors`;
const todayYmd = () => new Date().toISOString().slice(0, 10);
const addYear = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10); };
interface Hist { id: number | string; ts: number; event: string; note: string | null; }

const WORD: Record<Status, string> = { active: "ACTIVE", expiring: "EXPIRING", expired: "EXPIRED", free: "FREE" };
export function Lamp({ status }: { status: Status }) {          // circle = ACTIVE, triangle = EXPIRING, square = EXPIRED, ring = FREE (shape AND word, never colour alone)
  return <svg className="lm-lamp" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    {status === "active" && <circle cx="9" cy="9" r="7" fill="currentColor" />}{status === "expiring" && <path d="M9 2 L17 16 H1 Z" fill="currentColor" />}
    {status === "expired" && <rect x="2" y="2" width="14" height="14" fill="currentColor" />}{status === "free" && <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" />}</svg>;
}
const St = ({ s }: { s: Status }) => <span className="lm-st lm-word" data-s={s}><Lamp status={s} />{WORD[s]}</span>;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "--");
const lim = (n: number | null) => (n === null ? "unlimited" : String(n));
const ago = (ts: number | null) => { if (!ts) return "never"; const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const F = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="lm-f"><span className="fp-cap" style={{ display: "block" }}>{label}</span>{children}</label>;

function DeploymentForm({ initial, tiers, onClose, onSaved, onChangeType }: { initial?: Dep; tiers: Tiers; onClose: () => void; onSaved: (d: Dep) => void; onChangeType?: () => void }) {
  const [v, setV] = useState({ name: initial?.name ?? "", deviceId: initial?.deviceId ?? "", licensedTo: initial?.licensedTo ?? "", gw: String(initial?.usage.gateways ?? 0), sn: String(initial?.usage.sensors ?? 0), seen: "" });
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try {
      const body: Record<string, unknown> = { name: v.name, deviceId: v.deviceId, licensedTo: v.licensedTo || null, usedGateways: Number(v.gw), usedSensors: Number(v.sn) };
      if (v.seen === "now") body.lastSeen = Date.now();
      const r = initial ? await api<{ deployment: Dep }>("/licence-deployments/" + initial.id, { method: "PATCH", json: body }) : await api<{ deployment: Dep }>("/licence-deployments", { method: "POST", json: body });
      onSaved(r.deployment);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return <Modal title={initial ? "Edit deployment" : "Add deployment"} onClose={onClose}>
    <F label="Name"><input className="fp-input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></F>
    <F label="Device ID"><input className="fp-input" placeholder="FP-XXXX-XXXX-XXXX" value={v.deviceId} onChange={(e) => setV({ ...v, deviceId: e.target.value.toUpperCase() })} /></F>
    <F label="Licensed to"><input className="fp-input" value={v.licensedTo} onChange={(e) => setV({ ...v, licensedTo: e.target.value })} /></F>
    <div className="lm-grid2"><F label="Data sources in use"><input className="fp-input" type="number" min={0} value={v.gw} onChange={(e) => setV({ ...v, gw: e.target.value })} /></F>
      <F label="Sensors in use"><input className="fp-input" type="number" min={0} value={v.sn} onChange={(e) => setV({ ...v, sn: e.target.value })} /></F></div>
    {initial && <div className="lm-f"><span className="fp-cap" style={{ display: "block" }}>Licence type</span><div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}><span className="lm-mono" style={{ fontSize: 18 }}>{initial.type === "ENGINEERING" ? "ENGINEERING LICENCE" : initial.type}</span>{onChangeType && <button className="fp-btn small" type="button" onClick={onChangeType}>CHANGE TYPE</button>}</div></div>}
    <F label="Last seen"><select className="fp-input" value={v.seen} onChange={(e) => setV({ ...v, seen: e.target.value })}><option value="">{initial ? "KEEP AS IT IS" : "NEVER"}</option><option value="now">SET TO NOW</option></select></F>
    {!initial && <p className="lm-note">A new deployment starts as FREE ({tierWord(tiers.FREE)}). Use ISSUE LICENCE to record a licence. Usage and last seen are entered by hand.</p>}
    {err && <div className="lm-err" role="alert">{err}</div>}
    <button className="fp-btn primary" disabled={busy || !v.name.trim()} onClick={save}>{busy ? "SAVING" : "SAVE"}</button>
  </Modal>;
}

function RecordForm({ d, tiers, onClose, onSaved }: { d: Dep; tiers: Tiers; onClose: () => void; onSaved: (d: Dep) => void }) {
  const issue = d.type === "FREE", types = ["FREE", "PRO", "FULL", "ENGINEERING"] as ("FREE" | "PRO" | "FULL" | "ENGINEERING")[];
  // Defaults (owner decision 2026-11-18): issued today, valid until one year after it (editable, "no expiry" allowed). Limits are fixed by the type, never typed.
  const [v, setV] = useState({ type: (issue ? "PRO" : d.type) as "FREE" | "PRO" | "FULL" | "ENGINEERING", licenceId: "", issuedAt: todayYmd(), validUntil: addYear(todayYmd()), untilTouched: false, noExpiry: d.type === "ENGINEERING", note: "" });
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false), free = v.type === "FREE", lim = tiers[v.type];
  const setIssued = (x: string) => setV((o) => ({ ...o, issuedAt: x, validUntil: !o.untilTouched && /^\d{4}-\d{2}-\d{2}$/.test(x) ? addYear(x) : o.validUntil }));
  async function save() {
    setBusy(true); setErr("");
    try {
      const body = free ? { type: "FREE", note: v.note || null } : { type: v.type, licenceId: v.licenceId.trim(), issuedAt: v.issuedAt || undefined, validUntil: v.noExpiry ? null : v.validUntil || null, note: v.note || null };
      onSaved((await api<{ deployment: Dep }>(`/licence-deployments/${d.id}/record`, { method: "POST", json: body })).deployment);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return <Modal title={issue ? "Issue licence" : "Renew licence"} onClose={onClose}>
    <p className="lm-note">Records the licence on this page only. The .fplic file is signed with the offline Trident Labs tool; nothing is signed or sent to the box here.</p>
    <fieldset className="lm-types" role="radiogroup" aria-label="Licence type" style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
      <legend className="fp-cap">Type</legend>
      {types.map((t) => <label key={t} className="lm-type" data-on={v.type === t ? 1 : 0}><input type="radio" name="lm-type" checked={v.type === t} onChange={() => setV({ ...v, type: t, noExpiry: t === "ENGINEERING" ? true : v.type === "ENGINEERING" ? false : v.noExpiry })} /><b>{t}</b><span className="lm-sub">{tierWord(tiers[t])}{t === "ENGINEERING" ? ", no expiry by default" : ""}</span></label>)}
    </fieldset>
    {free ? <p className="lm-note">FREE has no licence ID, issue date or expiry. Saving clears them from this deployment and writes a history row.</p> : <>
      <div className="lm-grid2">
        <F label="Licence ID"><input className="fp-input" placeholder="FPL-YYYYMMDD-NNNN" value={v.licenceId} onChange={(e) => setV({ ...v, licenceId: e.target.value })} /></F>
        <F label="Issued"><input className="fp-input" type="date" value={v.issuedAt} onChange={(e) => setIssued(e.target.value)} /></F>
        <F label="Valid until"><input className="fp-input" type="date" disabled={v.noExpiry} value={v.noExpiry ? "" : v.validUntil} onChange={(e) => setV({ ...v, validUntil: e.target.value, untilTouched: true })} /></F>
        <label className="lm-f" style={{ alignSelf: "end", minHeight: 44, display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={v.noExpiry} onChange={(e) => setV({ ...v, noExpiry: e.target.checked })} />NO EXPIRY</label>
      </div>
      {lim && <p className="lm-note">Limits are fixed by the type: {tierWord(lim)}.{v.type === "FULL" ? " Reports reach and history kept for FULL are to be confirmed (shown like PRO)." : ""}</p>}
    </>}
    <F label="Notes (optional)"><input className="fp-input" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></F>
    {err && <div className="lm-err" role="alert">{err}</div>}
    <button className="fp-btn primary" disabled={busy || (!free && !v.licenceId.trim())} onClick={save}>{busy ? "SAVING" : free ? "SET TO FREE" : "RECORD"}</button>
  </Modal>;
}

const CONSEQUENCE: Record<Flag, string> = { ok: "", at_limit: "Adding more is blocked until a new licence is applied.", over_limit: "Over the limit: adding more is blocked until a new licence is applied. Monitoring, alarms and commands keep running." };
function UsageBar({ label, used, limit, flag }: { label: string; used: number; limit: number | null; flag: Flag }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)), tone = flag === "over_limit" ? "alarm" : flag === "at_limit" ? "warn" : undefined;
  return <div className="lm-panel">
    <div className="fp-cap">{label}</div>
    <div className="lm-mono" style={{ fontSize: 22, marginTop: 4 }}>{used} of {lim(limit)}{flag !== "ok" && <span className="lm-flag" data-t={tone}><Lamp status={flag === "over_limit" ? "expired" : "expiring"} />{flag === "over_limit" ? "OVER LIMIT" : "AT LIMIT"}</span>}</div>
    <div className="lm-bar" data-t={tone} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit ?? undefined} aria-valuenow={used}><i style={{ width: pct + "%" }} /></div>
    {flag !== "ok" && <div className="lm-note">{CONSEQUENCE[flag]}</div>}
  </div>;
}

export default function Licences({ onChange }: { onChange: () => void }) {
  const [tiers, setTiers] = useState<Tiers | null>(null), [all, setAll] = useState<Dep[] | null>(null), [err, setErr] = useState(""), [q, setQ] = useState(""), [filter, setFilter] = useState<"ALL" | Status>("ALL");
  const [selId, setSelId] = useState<number | null>(null), [detail, setDetail] = useState(false), [hist, setHist] = useState<Hist[]>([]), [modal, setModal] = useState<null | "add" | "edit" | "record">(null), [copied, setCopied] = useState(false);
  const load = useCallback(async (keep?: number) => {
    try { const r = await api<{ deployments: Dep[]; tiers: Tiers }>("/licence-deployments"); setAll(r.deployments); setTiers(r.tiers); setSelId((cur) => keep ?? (cur !== null && r.deployments.some((d) => d.id === cur) ? cur : (r.deployments.find((d) => d.status === "expiring" || d.status === "expired") ?? r.deployments[0])?.id ?? null)); setErr(""); onChange(); }
    catch (e) { setErr(errText(e)); }
  }, [onChange]);
  useEffect(() => { void load(); }, []);       // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (all ?? []).filter((d) => { const t = q.trim().toLowerCase(); return (filter === "ALL" || d.status === filter) && (!t || d.name.toLowerCase().includes(t) || d.deviceId.toLowerCase().includes(t)); }), [all, q, filter]);
  const sel = all?.find((d) => d.id === selId) ?? null;
  useEffect(() => { if (!sel) { setHist([]); return; } let live = true; api<{ history: Hist[] }>(`/licence-deployments/${sel.id}/history`).then((r) => live && setHist(r.history)).catch(() => live && setHist([])); return () => { live = false; }; }, [sel?.id, sel?.validUntil, sel?.licenceId, sel?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  const saved = (d: Dep) => { setModal(null); void load(d.id); };
  const copy = async () => { if (sel && (await copyText(sel.deviceId))) { setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  return <main className="fp-page lm">
    <div className="lm-title"><div className="fp-cap">FARM-PILOT CORE</div><h2>Licence Management</h2></div>
    {err && <div className="lm-err" role="alert">{err}</div>}
    {(all === null || tiers === null) && !err && <div className="lm-note">Loading...</div>}
    {all && tiers && <div className="lm-layout" data-detail={detail && sel ? 1 : 0}>
      <div className="fp-card lm-list">
        <div className="lm-listhead"><div><div style={{ fontSize: 18, fontWeight: 700 }}>{all.length} {all.length === 1 ? "DEPLOYMENT" : "DEPLOYMENTS"}</div><div className="fp-cap">sorted by expiry</div></div><button className="fp-btn small" onClick={() => setModal("add")}>+ ADD</button></div>
        <div className="lm-filters">
          <input className="fp-input" placeholder="Search name or Device ID" aria-label="Search by name or Device ID" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="fp-input" aria-label="Status" value={filter} onChange={(e) => setFilter(e.target.value as "ALL" | Status)}><option value="ALL">ALL STATUSES</option><option value="active">ACTIVE</option><option value="expiring">EXPIRING (30 DAYS OR LESS)</option><option value="expired">EXPIRED</option><option value="free">FREE</option></select>
        </div>
        <div role="list">
          {rows.map((d) => <button key={d.id} role="listitem" className="lm-row" aria-pressed={d.id === selId} onClick={() => { setSelId(d.id); setDetail(true); }}>
            <span className="lm-st" data-s={d.status}><Lamp status={d.status} /></span>
            <span style={{ minWidth: 0 }}><div className="lm-nm">{d.name}</div><div className="lm-sub">{d.deviceId}</div></span>
            <span className="lm-right"><div className="lm-mono">{d.type === "FREE" ? "No licence" : d.validUntil ? day(d.validUntil) : "No expiry"}</div><div className="lm-st lm-word" data-s={d.status}>{WORD[d.status]}</div></span>
          </button>)}
          {rows.length === 0 && <div className="lm-note" style={{ padding: 12 }}>{all.length === 0 ? "No deployments yet. Add the first one." : "Nothing matches."}</div>}
        </div>
      </div>

      {sel && <div className="lm-col lm-detail">
        <button className="fp-btn lm-back" onClick={() => setDetail(false)}>&larr; BACK TO LIST</button>
        <div className="fp-card lm-head">
          <div><div className="lm-name">{sel.name}</div><div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}><span className="lm-chip lm-st" data-s={sel.status}><Lamp status={sel.status} />{WORD[sel.status]}</span><span className="fp-cap">seen {ago(sel.lastSeen)}</span></div></div>
          <div className="lm-btns">
            <button className="fp-btn" onClick={() => setModal("edit")}>EDIT</button>
            <button className="fp-btn" disabled title={sel.type === "FREE" ? "No licence file on a FREE box" : "Licence files are signed offline with the Trident Labs tool"}>DOWNLOAD .FPLIC</button>
            <button className="fp-btn primary" onClick={() => setModal("record")}>{sel.type === "FREE" ? "ISSUE LICENCE" : "RENEW LICENCE"}</button>
          </div>
        </div>
        <div className="fp-card"><div className="fp-cap">Device</div>
          <div className="lm-panel" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}><div><div className="fp-cap">Device ID</div><div className="lm-devid">{sel.deviceId}</div></div><button className="fp-btn" onClick={copy}>{copied ? "COPIED" : "COPY"}</button></div>
          <div className="lm-kv"><div><div className="fp-cap">Licensed to</div><div className="v">{sel.licensedTo ?? "Not activated"}</div></div><div><div className="fp-cap">Last seen</div><div className="v">{ago(sel.lastSeen)}</div></div></div>
        </div>
        <div className="fp-card"><div className="fp-cap">Licence</div>
          <div className="lm-kv">
            <div><div className="fp-cap">Type</div><div className="v lm-mono">{sel.type === "ENGINEERING" ? "ENGINEERING LICENCE" : sel.type}</div></div>
            <div><div className="fp-cap">Licence ID</div><div className="v lm-mono">{sel.licenceId ?? "--"}</div></div>
            <div><div className="fp-cap">Issued</div><div className="v">{day(sel.issuedAt)}</div></div>
            <div><div className="fp-cap">Valid until</div><div className="v">{sel.type === "FREE" ? "--" : sel.validUntil ? day(sel.validUntil) : "No expiry"}</div></div>
            <div><div className="fp-cap">Data sources / sensors</div><div className="v">{sel.effectiveLimits.gateways ?? "unlimited"} / {sel.effectiveLimits.sensors ?? "unlimited"}{sel.status === "expired" ? " (FREE, expired)" : ""}</div></div>
            <div><div className="fp-cap">Reports reach</div><div className="v">{sel.type === "FREE" ? `${sel.effectiveLimits.reports_days} days (FREE)` : sel.limits.reports_days === null ? "unlimited" : `${sel.limits.reports_days} days`}</div></div>
            <div><div className="fp-cap">History kept</div><div className="v">{sel.type === "FREE" ? `${sel.effectiveLimits.retention_days} days (FREE)` : sel.limits.retention_days === null ? "never pruned" : `${sel.limits.retention_days} days`}</div></div>
          </div>
          {sel.termPct !== null && sel.daysLeft !== null && <div><div className="lm-bar" data-t={sel.status === "expired" ? "alarm" : sel.status === "expiring" ? "warn" : undefined} role="progressbar" aria-label="Licence term used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={sel.termPct}><i style={{ width: sel.termPct + "%" }} /></div>
            <div className="lm-mono lm-note">{sel.termPct}% of term used, {sel.daysLeft >= 0 ? `${sel.daysLeft} days left` : `expired ${-sel.daysLeft} days ago`}</div></div>}
          {sel.status === "expired" && <div className="lm-note">The box falls back to FREE limits ({sel.effectiveLimits.gateways} data {sel.effectiveLimits.gateways === 1 ? "source" : "sources"}, {sel.effectiveLimits.sensors} sensors). Monitoring, alarms and pump commands keep running; only adding sensors is blocked.</div>}
        </div>
        <div className="lm-grid2">
          <UsageBar label="Data sources" used={sel.usage.gateways} limit={sel.effectiveLimits.gateways} flag={sel.usageFlags.gateways} />
          <UsageBar label="Sensors (all types)" used={sel.usage.sensors} limit={sel.effectiveLimits.sensors} flag={sel.usageFlags.sensors} />
        </div>
        <div className="fp-card"><div className="fp-cap">History</div>
          {hist.length === 0 && <div className="lm-note">No events yet.</div>}
          {hist.map((h) => <div className="lm-hist" key={h.id}><span className="lm-mono">{new Date(h.ts).toISOString().slice(0, 10)}</span><b>{h.event}</b><span>{h.note ?? ""}</span></div>)}
        </div>
        <div className="lm-note">Licence files are checked on the box without internet. Usage and last seen are entered by hand. Features list: reserved, empty for now.</div>
      </div>}
    </div>}
    {modal === "add" && tiers && <DeploymentForm tiers={tiers} onClose={() => setModal(null)} onSaved={saved} />}
    {modal === "edit" && sel && tiers && <DeploymentForm initial={sel} tiers={tiers} onClose={() => setModal(null)} onSaved={saved} onChangeType={() => setModal("record")} />}
    {modal === "record" && sel && tiers && <RecordForm d={sel} tiers={tiers} onClose={() => setModal(null)} onSaved={saved} />}
  </main>;
}
