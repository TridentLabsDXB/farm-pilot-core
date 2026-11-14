import { useState } from "react";
import { api, type Me } from "./api";
export default function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState(""), [p, setP] = useState(""), [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setErr(""); try { onLogin(await api<Me>("/login", { method: "POST", json: { username: u, password: p } })); } catch (x: any) { setErr(x.message); } };
  return (
    <div className="core core-login"><form className="core-card" onSubmit={submit}>
      <h2 className="core-title">FARM-PILOT CORE</h2>
      <label className="core-cap" htmlFor="u">User</label><input id="u" className="core-input" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
      <label className="core-cap" htmlFor="p">Password</label><input id="p" className="core-input" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
      <button className="core-key core-key-primary" type="submit">Log in</button>
      {err && <p className="core-msg" role="alert">{err}</p>}
    </form></div>
  );
}
