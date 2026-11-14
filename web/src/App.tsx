import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Cmd, type Me, type State, type Topic } from "./api";
import Login from "./Login";
import ScadaView from "./ScadaView";
import Settings from "./Settings";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<"scada" | "settings">("scada");
  const [state, setState] = useState<State | null>(null);
  const [live, setLive] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => { api<Me>("/me").then(setMe).catch(() => setMe(null)); }, []);

  const load = useCallback(() => api<State>("/state").then(setState).catch((e) => { if (e.status === 401) setMe(null); }), []);

  useEffect(() => {
    if (!me) return;
    let closed = false, timer: number;
    load();
    const connect = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.current = s;
      s.onopen = () => { setLive(true); load(); };           // reload a snapshot on every (re)connect so nothing is missed
      s.onclose = () => { setLive(false); if (!closed) timer = window.setTimeout(connect, 2000); };
      s.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "telemetry") setState((st) => st && { ...st, topics: [...st.topics.filter((t) => t.topic !== m.topic), { topic: m.topic, ts: m.ts, sensors: m.sensors } as Topic] });
        else if (m.type === "command") setState((st) => st && { ...st, commands: [m.command as Cmd, ...st.commands.filter((c) => c.id !== m.command.id)].sort((a, b) => b.created_at - a.created_at).slice(0, 10) });
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws.current?.close(); };
  }, [me, load]);

  if (me === undefined) return null;
  if (!me) return <Login onLogin={setMe} />;
  return (
    <div className="core core-app">
      <header className="core-top">
        <h1>FARM-PILOT CORE</h1>
        <nav>
          <button className="core-key" aria-pressed={page === "scada"} onClick={() => setPage("scada")}>SCADA</button>
          {me.role === "admin" && <button className="core-key" aria-pressed={page === "settings"} onClick={() => setPage("settings")}>Settings</button>}
        </nav>
        <span className="core-plate" data-state={live ? "run" : "nodata"}><span className="core-lamp" /><span className="core-word">{live ? "LIVE" : "OFFLINE"}</span></span>
        <span className="core-user">{me.username} · {me.role}</span>
        <button className="core-key" onClick={() => api("/logout", { method: "POST" }).finally(() => setMe(null))}>Logout</button>
      </header>
      {page === "settings" && me.role === "admin" ? <Settings state={state} onChanged={load} /> : <ScadaView state={state} reload={load} />}
    </div>
  );
}
