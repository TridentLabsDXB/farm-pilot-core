import { useState } from "react";
import { api, type Me } from "./api";
export default function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [u, setU] = useState(""), [p, setP] = useState(""), [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setErr(""); try { onLogin(await api<Me>("/login", { method: "POST", json: { username: u, password: p } })); } catch (x: any) { setErr(x.message); } };
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}><form className="fp-card" style={{ width: "min(380px,100%)" }} onSubmit={submit}>
      <h3>FARM-PILOT CORE</h3>
      <label className="fp-cap" htmlFor="u">User</label><input id="u" className="fp-input" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
      <label className="fp-cap" htmlFor="p">Password</label><input id="p" className="fp-input" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
      <button className="fp-btn primary" type="submit">Log in</button>
      {err && <p className="fp-msg err" role="alert">{err}</p>}
    </form></div>
  );
}
