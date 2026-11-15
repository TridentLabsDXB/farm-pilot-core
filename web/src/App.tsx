import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Cmd, type Me, type Scada, type State, type Topic } from "./api";
import Login from "./Login";
import ScadaView from "./ScadaView";
import Alarms from "./Alarms";
import Settings from "./Settings";
import { Chip, hhmm, useNow } from "./ui";

// Tiny hash router: #/scada, #/alarms, #/settings/<tab>[/<serial>]. No dependency, back button works.
function useHash() { const [h, setH] = useState(location.hash.slice(1) || "/scada"); useEffect(() => { const f = () => setH(location.hash.slice(1) || "/scada"); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []); return h; }
export const go = (p: string) => { location.hash = p; };
const getTheme = () => { try { return localStorage.getItem("core_theme") === "dark" ? "dark" : "light"; } catch { return "light"; } };

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [state, setState] = useState<State | null>(null); const [scada, setScada] = useState<Scada | null>(null);
  const [live, setLive] = useState(false); const [theme, setTheme] = useState<"light" | "dark">(getTheme());
  const ws = useRef<WebSocket | null>(null); const hash = useHash(); const now = useNow(1000);
  const [, page, ...rest] = hash.split("/");

  useEffect(() => { api<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);
  const load = useCallback(() => api<State>("/state").then(setState).catch((e) => { if (e.status === 401) setMe(null); }), []);
  const loadScada = useCallback(() => api<Scada>("/scada").then(setScada).catch((e) => { if (e.status === 401) setMe(null); }), []);

  useEffect(() => {
    if (!me) return; let closed = false, timer: number, debounce: number;
    load(); loadScada();
    const connect = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); ws.current = s;
      s.onopen = () => { setLive(true); load(); loadScada(); };           // snapshot on every (re)connect so nothing is missed
      s.onclose = () => { setLive(false); if (!closed) timer = window.setTimeout(connect, 2000); };
      s.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "telemetry") setState((st) => st && { ...st, topics: [...st.topics.filter((t) => t.topic !== m.topic), { topic: m.topic, ts: m.ts, sensors: m.sensors } as Topic] });
        else if (m.type === "command") setState((st) => st && { ...st, commands: [m.command as Cmd, ...st.commands.filter((c) => c.id !== m.command.id)].sort((a, b) => b.created_at - a.created_at).slice(0, 10) });
        else if (m.type === "scada") { clearTimeout(debounce); debounce = window.setTimeout(loadScada, 300); }
      };
    };
    connect(); const poll = setInterval(loadScada, 30_000);                // staleness is time-based: refresh even without events
    return () => { closed = true; clearTimeout(timer); clearTimeout(debounce); clearInterval(poll); ws.current?.close(); };
  }, [me, load, loadScada]);

  const toggleTheme = () => { const t = theme === "dark" ? "light" : "dark"; setTheme(t); try { localStorage.setItem("core_theme", t); } catch { /* private mode */ } };
  if (me === undefined) return null;
  if (!me) return <div className="core" data-theme={theme}><Login onLogin={setMe} /></div>;
  const admin = me.role === "admin"; const cur = page === "alarms" ? "alarms" : page === "settings" && admin ? "settings" : "scada";
  const nAlarms = scada?.alarms.length ?? 0; const gw = scada?.gateway;
  const gwChip = !gw || !gw.enabled ? <Chip tone="off">NO GATEWAY</Chip> : gw.online ? <Chip tone="ok">GATEWAY ONLINE</Chip> : <Chip tone="alarm">GATEWAY OFFLINE</Chip>;
  const nav = (cls = "") => (<>
    <button className={`fp-navbtn ${cls}`} aria-current={cur === "scada" ? "page" : undefined} onClick={() => go("/scada")}>SCADA</button>
    <button className={`fp-navbtn ${cls}`} aria-current={cur === "alarms" ? "page" : undefined} onClick={() => go("/alarms")}>ALARMS{nAlarms > 0 && <span className="fp-badge">{nAlarms}</span>}</button>
    {admin && <button className={`fp-navbtn ${cls}`} aria-current={cur === "settings" ? "page" : undefined} onClick={() => go("/settings/sensors")}>SETTINGS</button>}
  </>);
  return (
    <div className="core" data-theme={theme}>
      <header className="fp-top">
        <div className="fp-brand"><b>FARM-PILOT CORE</b><span>{(state?.farm ?? "").replace(/-/g, " ")}</span></div>
        <nav className="fp-nav" aria-label="Main">{nav()}</nav>
        {gwChip}
        <span className="fp-meta hide-phone" title="Box time">{hhmm(now)}</span>
        <Chip tone="info">{admin ? "ADMIN" : "OPERATOR"}</Chip>
        <button className="fp-btn small hide-phone" onClick={toggleTheme} aria-label="Toggle dark theme" aria-pressed={theme === "dark"}>{theme === "dark" ? "LIGHT" : "DARK"}</button>
        <button className="fp-btn small" onClick={() => api("/logout", { method: "POST" }).finally(() => setMe(null))}>Logout</button>
      </header>
      {cur === "settings" ? <Settings tab={rest[0] ?? "sensors"} serial={rest[1]} focus={rest[2]} scada={scada} reload={() => { load(); loadScada(); }} />
        : cur === "alarms" ? <Alarms scada={scada} /> : <ScadaView state={state} scada={scada} reload={() => { load(); loadScada(); }} />}
      <nav className="fp-bottom" aria-label="Main">{nav()}</nav>
    </div>
  );
}
