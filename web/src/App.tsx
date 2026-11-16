import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Cmd, type Me, type PublicProfile, type Scada, type State, type Topic } from "./api";
import Login from "./Login";
import ScadaView from "./ScadaView";
import Alarms from "./Alarms";
import ControlPage from "./ControlPage";
import type { ControlDevice } from "./control";
import Settings from "./Settings";
import About, { MorePage } from "./About";
import Sidebar, { useBadges } from "./Sidebar";
import { Chip, hhmm, setFmtCfg, useNow } from "./ui";

// Tiny hash router: #/scada, #/alarms, #/settings/<tab>[/<serial>]. No dependency, back button works.
function useHash() { const [h, setH] = useState(location.hash.slice(1) || "/scada"); useEffect(() => { const f = () => setH(location.hash.slice(1) || "/scada"); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []); return h; }
export const go = (p: string) => { location.hash = p; };
const getTheme = (): "light" | "dark" | null => { try { const t = localStorage.getItem("core_theme"); return t === "dark" || t === "light" ? t : null; } catch { return null; } };

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [state, setState] = useState<State | null>(null); const [scada, setScada] = useState<Scada | null>(null);
  const [drawer, setDrawer] = useState(false); const [live, setLive] = useState(false); const [themePref, setThemePref] = useState<"light" | "dark" | null>(getTheme()); const [control, setControl] = useState<ControlDevice[] | null>(null); const [controlErr, setControlErr] = useState<string | null>(null); const [pub, setPub] = useState<PublicProfile | null>(null); const [version, setVersion] = useState("");
  const theme = themePref ?? pub?.default_theme ?? "light";          // the Farm Profile default applies until someone picks a theme on this device
  const ws = useRef<WebSocket | null>(null); const hash = useHash(); const now = useNow(1000);
  const [, page, ...rest] = hash.split("/");

  useEffect(() => { api<Me>("/me").then(setMe).catch(() => setMe(null)); fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => h?.version && setVersion(String(h.version))).catch(() => {}); }, []);
  const load = useCallback(() => api<State>("/state").then(setState).catch((e) => { if (e.status === 401) setMe(null); }), []);
  const loadScada = useCallback(() => api<Scada>("/scada").then(setScada).catch((e) => { if (e.status === 401) setMe(null); }), []);

  const loadPub = useCallback(() => api<PublicProfile>("/farm-profile/public").then((p) => { setFmtCfg({ tz: p.timezone, dateFormat: p.date_format, timeFormat: p.time_format, tempUnit: p.temperature_unit }); setPub(p); }).catch(() => {}), []);

  // 2026-11-16 -- device list: static, loaded once; live state comes from `state`. A failure (404 from an old build, 401, network, 10 s timeout) is SHOWN with RETRY; it used to be swallowed, which left CONTROL on "Loading..." forever.
  const loadControl = useCallback(() => {
    setControlErr(null); const ac = new AbortController(); const t = window.setTimeout(() => ac.abort(), 10_000);
    api<{ devices: ControlDevice[] }>("/control", { signal: ac.signal }).then((c) => { if (!Array.isArray(c?.devices)) throw new Error("unexpected answer from the server"); setControl(c.devices); })
      .catch((e) => { if (e?.status === 401) setMe(null); else setControlErr(e?.name === "AbortError" ? "The server did not answer in 10 s." : e?.status === 404 ? "The server has no CONTROL route (it needs an update)." : String(e?.message ?? e)); }).finally(() => clearTimeout(t));
  }, []);
  useEffect(() => {
    if (!me) return; let closed = false, timer: number, debounce: number;
    load(); loadScada(); loadPub(); loadControl();
    const connect = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); ws.current = s;
      s.onopen = () => { setLive(true); load(); loadScada(); };           // snapshot on every (re)connect so nothing is missed
      s.onclose = () => { setLive(false); if (!closed) timer = window.setTimeout(connect, 2000); };
      s.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "telemetry") setState((st) => st && { ...st, topics: [...st.topics.filter((t) => t.topic !== m.topic), { topic: m.topic, ts: m.ts, sensors: m.sensors } as Topic] });
        else if (m.type === "command") setState((st) => st && { ...st, commands: [m.command as Cmd, ...st.commands.filter((c) => c.id !== m.command.id)].sort((a, b) => b.created_at - a.created_at).slice(0, 10) });
        else if (m.type === "scada") { clearTimeout(debounce); debounce = window.setTimeout(() => { loadScada(); loadPub(); }, 300); }
      };
    };
    connect(); const poll = setInterval(loadScada, 30_000);                // staleness is time-based: refresh even without events
    return () => { closed = true; clearTimeout(timer); clearTimeout(debounce); clearInterval(poll); ws.current?.close(); };
  }, [me, load, loadScada, loadPub, loadControl]);

  const toggleTheme = () => { const t = theme === "dark" ? "light" : "dark"; setThemePref(t); try { localStorage.setItem("core_theme", t); } catch { /* private mode */ } };
  useEffect(() => { if (me && me.role !== "admin" && page === "settings") go("/scada"); }, [me, page]);          // Operators never get Settings (the server answers 403 as well)
  const badges = useBadges(scada, rest[0], !!me && me.role === "admin");
  useEffect(() => { setDrawer(false); }, [hash]);                                       // the tablet drawer closes after every navigation
  useEffect(() => { if (!drawer) return; const f = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false); window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f); }, [drawer]);
  if (me === undefined) return null;
  if (!me) { const lt = themePref ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); return <div className="core fp-login-root" data-theme={lt}><Login onLogin={setMe} theme={lt} onToggleTheme={() => { const t = lt === "dark" ? "light" : "dark"; setThemePref(t); try { localStorage.setItem("core_theme", t); } catch { /* private mode */ } }} /></div>; }
  const admin = me.role === "admin"; const cur = page === "alarms" ? "alarms" : page === "control" ? "control" : page === "about" ? "about" : page === "more" ? "more" : page === "settings" && admin ? "settings" : "scada";
  const nAlarms = scada?.alarms.length ?? 0; const gw = scada?.gateway;
  const gwChip = !gw || !gw.enabled ? <Chip tone="off">NO GATEWAY</Chip> : gw.online ? <Chip tone="ok">GATEWAY ONLINE</Chip> : <Chip tone="alarm">GATEWAY OFFLINE</Chip>;
  const nav = (cls = "") => (<>
    <button className={`fp-navbtn ${cls}`} aria-current={cur === "scada" ? "page" : undefined} onClick={() => go("/scada")}>SCADA</button>
    <button className={`fp-navbtn ${cls}`} aria-current={cur === "control" ? "page" : undefined} onClick={() => go("/control")}>CONTROL</button>
    <button className={`fp-navbtn ${cls}`} aria-current={cur === "alarms" ? "page" : undefined} onClick={() => go("/alarms")}>ALARMS{nAlarms > 0 && <span className="fp-badge">{nAlarms}</span>}</button>
    {admin ? <button className={`fp-navbtn ${cls}`} aria-current={cur === "settings" || cur === "about" ? "page" : undefined} onClick={() => go("/settings")}>SETTINGS</button>
      : <button className={`fp-navbtn ${cls}`} aria-current={cur === "more" || cur === "about" ? "page" : undefined} onClick={() => go("/more")}>MORE</button>}
  </>);
  return (
    <div className="core" data-theme={theme} data-drawer={drawer ? "open" : "closed"}>
      <aside className="fp-sidebar" id="fp-sidebar"><Sidebar version={version} pub={pub} cur={cur} tab={rest[0]} admin={admin} nAlarms={nAlarms} badges={badges} /></aside>
      {drawer && <div className="fp-scrim" onClick={() => setDrawer(false)} aria-hidden />}
      <div className="fp-main">
        <header className="fp-top">
          <button className="fp-btn small fp-menu" aria-label="Open menu" aria-expanded={drawer} aria-controls="fp-sidebar" onClick={() => setDrawer(true)}>☰</button>
          <span className="fp-phone-title">{pub?.farm_name ?? ""}</span>
          <span className="fp-grow" />
          {gwChip}
          <span className="fp-meta hide-phone" title="Box time">{hhmm(now)}</span>
          <Chip tone="info">{admin ? "ADMIN" : "OPERATOR"}</Chip>
          <button className="fp-btn small hide-phone" onClick={toggleTheme} aria-label="Toggle dark theme" aria-pressed={theme === "dark"}>{theme === "dark" ? "LIGHT" : "DARK"}</button>
          <button className="fp-btn small" onClick={() => api("/logout", { method: "POST" }).finally(() => setMe(null))}>Logout</button>
        </header>
        {cur === "settings" ? <Settings tab={rest[0]} serial={rest[1]} focus={rest[2]} scada={scada} reload={() => { load(); loadScada(); }} onProfile={loadPub} badges={badges} />
          : cur === "about" ? <About admin={admin} from={admin ? "/settings" : "/more"} /> : cur === "more" ? <MorePage />
          : cur === "alarms" ? <Alarms scada={scada} /> : cur === "control" ? <ControlPage devices={control} error={controlErr} onRetry={loadControl} state={state} scada={scada} reload={() => { load(); loadScada(); }} /> : <ScadaView state={state} scada={scada} control={control} controlError={controlErr} onRetry={loadControl} />}
        <nav className="fp-bottom" aria-label="Main">{nav()}</nav>
      </div>
    </div>
  );
}
