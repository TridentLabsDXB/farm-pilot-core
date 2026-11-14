import { useEffect, useState } from "react";
import { api, type State } from "./api";
interface U { id: number; username: string; role: string; active: number; }
export default function Settings({ state, onChanged }: { state: State | null; onChanged: () => void }) {
  const [users, setUsers] = useState<U[]>([]); const [msg, setMsg] = useState("");
  const [nu, setNu] = useState({ username: "", password: "", role: "operator" }); const [to, setTo] = useState(String(state?.commandTimeoutSec ?? 10));
  const load = () => api<U[]>("/users").then(setUsers);
  useEffect(() => { load(); }, []);
  useEffect(() => { if (state) setTo(String(state.commandTimeoutSec)); }, [state?.commandTimeoutSec]);
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(""); try { await f(); setMsg(ok); load(); onChanged(); } catch (e: any) { setMsg(e.message); } };
  return (
    <main className="core-main core-settings">
      <section className="core-card"><h3 className="core-name">USERS</h3>
        <table className="core-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th /></tr></thead><tbody>{users.map((u) => (
          <tr key={u.id}><td>{u.username}</td><td>{u.role}</td><td>{u.active ? "ACTIVE" : "DISABLED"}</td><td>
            <button className="core-key" onClick={() => { const p = prompt(`New password for ${u.username} (8+ characters)`); if (p) run(() => api(`/users/${u.id}`, { method: "POST", json: { password: p } }), "Password changed."); }}>Password</button>{" "}
            <button className="core-key" onClick={() => run(() => api(`/users/${u.id}`, { method: "POST", json: { active: !u.active } }), "Updated.")}>{u.active ? "Disable" : "Enable"}</button></td></tr>))}</tbody></table>
        <form className="core-row" onSubmit={(e) => { e.preventDefault(); run(() => api("/users", { method: "POST", json: nu }), "User added.").then(() => setNu({ username: "", password: "", role: "operator" })); }}>
          <input className="core-input" placeholder="username" aria-label="New username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
          <input className="core-input" placeholder="password (8+)" aria-label="New password" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <select className="core-input" aria-label="Role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}><option value="operator">Operator</option><option value="admin">Admin</option></select>
          <button className="core-key core-key-primary" type="submit">Add user</button></form>
      </section>
      <section className="core-card"><h3 className="core-name">COMMANDS</h3>
        <label className="core-cap" htmlFor="to">Acknowledgement timeout (seconds, 3-120)</label>
        <div className="core-row"><input id="to" className="core-input" value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" />
          <button className="core-key core-key-primary" onClick={() => run(() => api("/settings", { method: "PUT", json: { commandTimeoutSec: Number(to) } }), "Saved.")}>Save</button></div>
      </section>
      {msg && <p className="core-msg" role="status">{msg}</p>}
    </main>
  );
}
