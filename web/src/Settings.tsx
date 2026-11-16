import { useEffect, useState } from "react";
import { api, type Scada } from "./api";
import { go } from "./App";
import SensorsPage from "./SensorsPage";
import SensorDetail from "./SensorDetail";
import StructurePage from "./StructurePage";
import GatewayPage from "./GatewayPage";
import PortsPage from "./PortsPage";
import FarmProfilePage from "./FarmProfilePage";
import { Chip, Modal, dt, errText } from "./ui";
import { LEGACY, TABS, type Badge } from "./Sidebar";

const useMedia = (q: string) => { const [m, setM] = useState(() => window.matchMedia(q).matches); useEffect(() => { const l = window.matchMedia(q); const f = () => setM(l.matches); l.addEventListener("change", f); return () => l.removeEventListener("change", f); }, [q]); return m; };

export default function Settings({ tab, serial, focus, scada, reload, onProfile, badges }: { tab?: string; serial?: string; focus?: string; scada: Scada | null; reload: () => void; onProfile: () => void; badges: Record<string, Badge> }) {
  const phone = useMedia("(max-width: 767px)"); const redirect = tab ? LEGACY[tab] : undefined; const known = TABS.some(([k]) => k === tab);
  useEffect(() => { if (redirect) go("/settings/" + redirect); else if ((!tab && !phone) || (tab && !known)) go("/settings/farm-profile"); }, [redirect, tab, phone, known]);
  const t = known ? tab! : undefined;
  const body = t === "sensors" ? (serial ? <SensorDetail serial={serial} focus={focus} scada={scada} reload={reload} /> : <SensorsPage scada={scada} reload={reload} />)
    : t === "farm-structure" ? <StructurePage reload={reload} /> : t === "rs485-ports" ? <PortsPage reload={reload} /> : t === "sensors-gateway" ? <GatewayPage scada={scada} reload={reload} /> : t === "farm-profile" ? <FarmProfilePage onChanged={onProfile} /> : t === "users" ? <UsersPage /> : t === "backup" ? <BackupPage reload={reload} /> : null;
  const label = (k: string, l: string) => <>{l}{badges[k] && <Chip tone={badges[k]!.tone}>{badges[k]!.word}</Chip>}</>;
  if (phone && !t) return (<main className="fp-page"><h2 style={{ fontFamily: "var(--fp-head)", margin: 0 }}>Settings</h2><ul className="fp-list">{TABS.map(([k, l]) => <li key={k} style={{ padding: 0 }}><button className="fp-tab" style={{ width: "100%", minHeight: 56, display: "flex", justifyContent: "space-between", alignItems: "center" }} onClick={() => go("/settings/" + k)}>{label(k, l)}<span aria-hidden>›</span></button></li>)}</ul></main>);
  return (
    <main className="fp-page"><div className="fp-settings">
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{phone && <button className="fp-btn" style={{ alignSelf: "flex-start", minHeight: 44 }} onClick={() => go(serial ? "/settings/sensors" : "/settings")} aria-label="Back">← {serial ? "Sensors" : "Settings"}</button>}{body}</div>
    </div></main>
  );
}

interface U { id: number; username: string; role: string; active: number; }
function UsersPage() {
  const [users, setUsers] = useState<U[]>([]); const [msg, setMsg] = useState("");
  const [nu, setNu] = useState({ username: "", password: "", role: "operator" });
  const load = () => api<U[]>("/users").then(setUsers); useEffect(() => { load(); }, []);
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(""); try { await f(); setMsg(ok); load(); } catch (e) { setMsg(errText(e)); } };
  return (<>
    <section className="fp-card"><h3>Users</h3>
      <table className="fp-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th /></tr></thead><tbody>{users.map((u) => (
        <tr key={u.id}><td className="h">{u.username}</td><td>{u.role}</td><td>{u.active ? "ACTIVE" : "DISABLED"}</td><td><div className="fp-row">
          <button className="fp-btn small" onClick={() => { const p = prompt(`New password for ${u.username} (8+ characters)`); if (p) run(() => api(`/users/${u.id}`, { method: "POST", json: { password: p } }), "Password changed."); }}>Password</button>
          <button className="fp-btn small" onClick={() => run(() => api(`/users/${u.id}`, { method: "POST", json: { active: !u.active } }), "Updated.")}>{u.active ? "Disable" : "Enable"}</button>
          <button className="fp-btn small danger" onClick={() => confirm(`Delete user ${u.username}? Their past actions stay in the audit log.`) && run(() => api(`/users/${u.id}`, { method: "DELETE" }), "User deleted.")}>Delete</button></div></td></tr>))}</tbody></table>
      <form className="fp-row" onSubmit={(e) => { e.preventDefault(); run(() => api("/users", { method: "POST", json: nu }), "User added.").then(() => setNu({ username: "", password: "", role: "operator" })); }}>
        <input className="fp-input" placeholder="username" aria-label="New username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
        <input className="fp-input" placeholder="password (8+)" aria-label="New password" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
        <select className="fp-input" aria-label="Role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}><option value="operator">Operator</option><option value="admin">Admin</option></select>
        <button className="fp-btn" type="submit">Add user</button></form>
    </section>
    {msg && <p className="fp-msg" role="status">{msg}</p>}
  </>);
}

function BackupPage({ reload }: { reload: () => void }) {
  const [msg, setMsg] = useState(""); const [pending, setPending] = useState<any>(null);
  const exp = async () => { try { const r = await fetch("/api/backup", { credentials: "same-origin" }); if (!r.ok) throw new Error("export failed"); const url = URL.createObjectURL(await r.blob()); const a = document.createElement("a"); a.href = url; a.download = `farmpilot-core-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); setMsg("Backup downloaded."); } catch (e) { setMsg(errText(e)); } };
  const pick = async (f: File | undefined) => { if (!f) return; try { setPending(JSON.parse(await f.text())); setMsg(""); } catch { setMsg("That file is not valid JSON."); } };
  return (<>
    <section className="fp-card"><h3>Backup</h3><p className="fp-msg">Exports sensors (with slots and intervals), calibrations, farm structure, the Farm Profile (with logo and contacts) and settings. History is not included.</p><div className="fp-row"><button className="fp-btn primary" onClick={exp}>Download backup</button></div></section>
    <section className="fp-card"><h3>Restore</h3><p className="fp-msg">Replaces the sensor list, calibrations, structure, Farm Profile and contacts on this box. Afterwards confirm the time zone in Farm Profile. After a restore every sensor shows NOT SENT: press SEND TO GATEWAY (Settings, Sensors) to push the groups and intervals to a new or factory-reset gateway.</p>
      <input type="file" className="fp-file" accept="application/json,.json" aria-label="Backup file" onChange={(e) => pick(e.target.files?.[0])} /></section>
    {msg && <p className="fp-msg" role="status">{msg}</p>}
    {pending && <Modal title="Restore backup?" onClose={() => setPending(null)}><p className="fp-msg">This replaces {pending.sensors?.length ?? "?"} sensors, {pending.zones?.length ?? "?"} zones and {pending.calibrations?.length ?? "?"} calibration rows on this box.</p>
      <div className="fp-row"><button className="fp-btn danger" onClick={async () => { try { await api("/backup/restore", { method: "POST", json: pending }); setMsg("Restored. Now press SEND TO GATEWAY."); setPending(null); reload(); } catch (e) { setMsg(errText(e)); setPending(null); } }}>Replace and restore</button><button className="fp-btn" onClick={() => setPending(null)}>Cancel</button></div></Modal>}
  </>);
}
