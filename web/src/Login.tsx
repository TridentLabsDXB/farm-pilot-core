import { useEffect, useRef, useState } from "react";
import type { Me } from "./api";
import { Chip } from "./ui";

type Problem = { kind: "wrong" | "limit" | "down" | "other" } | null;
const SUBTITLE = "Greenhouse and farm control";

/** Public login page. Product logo (static file, same on every box), farm name from /api/branding when available, no external requests. */
export default function Login({ onLogin, theme, onToggleTheme }: { onLogin: (m: Me) => void; theme: "light" | "dark"; onToggleTheme: () => void }) {
  const [u, setU] = useState(""), [p, setP] = useState(""), [show, setShow] = useState(false), [caps, setCaps] = useState(false), [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null), [wait, setWait] = useState(0);
  const [farm, setFarm] = useState(""), [version, setVersion] = useState("");
  const timer = useRef<number>(0);
  useEffect(() => {
    fetch("/api/branding").then((r) => (r.ok ? r.json() : null)).then((b) => b?.farm_name && setFarm(String(b.farm_name))).catch(() => {});
    fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => h && setVersion([h.version && `v${h.version}`, h.build && h.build !== "unknown" && `build ${h.build}`].filter(Boolean).join(" · "))).catch(() => {});
  }, []);
  useEffect(() => { if (wait <= 0) return; timer.current = window.setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(timer.current); }, [wait]);
  const caps_ = (e: React.KeyboardEvent) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy || wait > 0 || !u || !p) return; setBusy(true); setProblem(null);
    try {
      const r = await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
      if (r.ok) return onLogin(await r.json());
      if (r.status === 429) { setWait(Math.max(1, Number(r.headers.get("retry-after")) || 60)); setProblem({ kind: "limit" }); }
      else if (r.status === 401) setProblem({ kind: "wrong" }); else setProblem({ kind: r.status >= 500 ? "down" : "other" });
    } catch { setProblem({ kind: "down" }); }
    setBusy(false);
  };
  const msg = problem?.kind === "wrong" ? "WRONG USER OR PASSWORD" : problem?.kind === "limit" ? (wait > 0 ? `TOO MANY ATTEMPTS, WAIT ${wait} s` : "YOU CAN TRY AGAIN NOW") : problem?.kind === "down" ? "CORE NOT REACHABLE" : problem ? "LOGIN FAILED, TRY AGAIN" : "";
  return (
    <div className="fp-login">
      <div className="fp-login-stack">
        <header className="fp-login-brand">
          {/* 2026-11-16 -- new round badge: "Farm Pilot" and "CORE" are part of the artwork, so there is no separate title. Transparent outside the circle (checked: 0 opaque white corner pixels), same file on light and dark. */}
          <picture><source type="image/webp" srcSet="/brand/farm-pilot-core-logo-512.webp 512w, /brand/farm-pilot-core-logo-1024.webp 1024w" sizes="(max-width: 767px) 180px, 220px" /><img className="fp-login-logo" src="/brand/farm-pilot-core-logo-512.png" alt="Farm Pilot CORE" width={220} height={220} /></picture>
          <p>{farm || SUBTITLE}</p>
        </header>
        <form className="fp-login-card" onSubmit={submit} noValidate>
          <h2 className="fp-cap">Sign in</h2>
          <label className="fp-field"><span className="fp-cap">User</span><input id="u" className="fp-input fp-login-input" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus aria-label="User" /></label>
          <label className="fp-field"><span className="fp-cap">Password</span>
            <span className="fp-login-pass"><input id="p" className="fp-input fp-login-input" type={show ? "text" : "password"} value={p} onChange={(e) => setP(e.target.value)} onKeyDown={caps_} onKeyUp={caps_} autoComplete="current-password" aria-label="Password" />
              <button type="button" className="fp-btn small" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? "Hide password" : "Show password"}>{show ? "HIDE" : "SHOW"}</button></span>
            {caps && <Chip tone="warn">CAPS LOCK IS ON</Chip>}</label>
          <button className="fp-btn primary fp-login-go" type="submit" disabled={busy || wait > 0 || !u || !p}>{busy ? <><span className="fp-spin" aria-hidden /> SIGNING IN</> : "LOG IN"}</button>
          <div className="fp-login-err" role="alert" aria-live="assertive">{msg && <Chip tone="alarm">{msg}</Chip>}</div>
        </form>
        {/* 2026-11-16 -- credit line: plain text, no link, no flag emoji (Windows does not draw them), no external request. Build label footer below is unchanged. */}
        <p className="fp-login-credit">Engineered in the UAE by <strong>Trident Labs</strong></p>
        <footer className="fp-login-foot">FARM-PILOT CORE{version ? ` · ${version}` : ""}</footer>
      </div>
      <button type="button" className="fp-btn small fp-login-theme" onClick={onToggleTheme} aria-label="Toggle dark theme" aria-pressed={theme === "dark"}>{theme === "dark" ? "LIGHT" : "DARK"}</button>
    </div>
  );
}
