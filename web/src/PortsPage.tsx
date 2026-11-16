import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Chip, Modal, ago, errText, useNow, type Tone } from "./ui";

// Settings > RS-485 PORTS (Admin only). Two port cards (line settings, timing, status, TEST PORT, SAVE), then "Devices on ports" (which device sits on which port, at which address).
// Changes apply without restarting CORE. If a device that was online stops answering afterwards, a dialog asks to KEEP THESE SETTINGS; after 30 s CORE reverts by itself.
interface Port { id: number; label: string; enabled: boolean; transport: "serial" | "tcp"; device_path: string; tcp_host: string; tcp_port: number; tcp_framing: "rtu" | "mbap"; baud: number; data_bits: number; parity: string; stop_bits: number; timeout_ms: number; retries: number; turnaround_ms: number;
  status: "OPEN" | "CLOSED" | "ERROR" | "NOT FOUND"; lastError: string | null; counters: { requests: number; errors: number; lastOk: number | null }; devices: number; }
interface Dev { id: number; kind: string; model: string; port_id: number; modbus_address: number; poll_interval_s: number; enabled: boolean; state: "online" | "offline" | "not_connected" | "unknown"; lastOk: number | null; lastMs: number | null; }
interface View { ports: Port[]; devices: Dev[]; shared: number[]; sharedRules: string[]; pending: { deadline: number; ports: number[] } | null; revertWindowSec: number; bauds: number[]; defaults: Record<string, number | string>; }
interface Found { path: string; kind: string; target: string; accessible: boolean; }
interface TestRes { deviceId: number; model: string; address: number; result: string; ms: number | null; detail?: string; }

const PORT_TONE: Record<string, Tone> = { OPEN: "ok", CLOSED: "off", ERROR: "alarm", "NOT FOUND": "warn" };
const DEV_STATE: Record<string, [Tone, string]> = { online: ["ok", "ONLINE"], offline: ["alarm", "OFFLINE"], not_connected: ["off", "NOT CONNECTED"], unknown: ["info", "WAITING"] };
const TEST_WORD: Record<string, [Tone, string]> = { ok: ["ok", "OK"], no_answer: ["alarm", "NO ANSWER"], crc_error: ["alarm", "CRC ERROR"], error: ["alarm", "ERROR"], not_connected: ["off", "NOT CONNECTED"] };
const KIND_LABEL: Record<string, string> = { lora_gateway: "LoRa Sensor Gateway", weather: "Weather Station", fan_link: "Fan command link", io_module: "Modbus I/O module" };
const FIELDS = ["label", "enabled", "transport", "device_path", "tcp_host", "tcp_port", "tcp_framing", "baud", "data_bits", "parity", "stop_bits", "timeout_ms", "retries", "turnaround_ms"] as const;
const pick = (p: Port) => Object.fromEntries(FIELDS.map((k) => [k, p[k]]));
const same = (a: Port, b: Port) => FIELDS.every((k) => a[k] === b[k]);

export default function PortsPage({ reload }: { reload: () => void }) {
  const [v, setV] = useState<View | null>(null); const [found, setFound] = useState<Found[]>([]); const [drafts, setDrafts] = useState<Record<number, Port>>({}); const [devDrafts, setDevDrafts] = useState<Record<number, Dev>>({});
  const [msg, setMsg] = useState<Record<string, { t: string; s: string }>>({}); const [tests, setTests] = useState<Record<number, TestRes[]>>({}); const [busy, setBusy] = useState<string | null>(null); const now = useNow(500);
  const say = (k: string, t: string, s: string) => setMsg((m) => ({ ...m, [k]: { t, s } }));

  const load = useCallback(async (fresh = false) => {
    const x = await api<View>("/ports"); setV(x);
    setDrafts((d) => { const o: Record<number, Port> = {}; for (const p of x.ports) o[p.id] = fresh || !d[p.id] ? p : d[p.id]; return o; });
    setDevDrafts((d) => { const o: Record<number, Dev> = {}; for (const p of x.devices) o[p.id] = fresh || !d[p.id] ? p : d[p.id]; return o; }); return x;
  }, []);
  const refreshList = () => api<{ devices: Found[] }>("/ports/available").then((r) => setFound(r.devices)).catch(() => {});
  useEffect(() => { void load(true).catch(() => {}); void refreshList(); const i = setInterval(() => void load().catch(() => {}), 3000); return () => clearInterval(i); }, [load]);
  if (!v) return <section className="fp-card"><p className="fp-msg">Loading...</p></section>;

  const set = (id: number, patch: Partial<Port>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const num = (s: string) => (s === "" ? NaN : Number(s));
  const run = async (key: string, f: () => Promise<void>) => { setBusy(key); try { await f(); } catch (e) { say(key, "err", errText(e)); } finally { setBusy(null); } };
  const savePort = (p: Port) => run("p" + p.id, async () => {
    const r = await api<{ results: TestRes[]; pending: unknown; unchanged?: boolean }>("/ports/" + p.id, { method: "PUT", json: pick(drafts[p.id]) });
    setTests((t) => ({ ...t, [p.id]: r.results })); await load(true); reload();
    say("p" + p.id, r.pending ? "err" : "ok", r.unchanged ? "Nothing changed." : r.pending ? "Saved, but a device that was online is not answering. Keep or revert." : "Saved. The port was reopened and tested.");
  });
  const testPort = (p: Port) => run("t" + p.id, async () => { const r = await api<{ results: TestRes[] }>("/ports/" + p.id + "/test", { method: "POST" }); setTests((t) => ({ ...t, [p.id]: r.results })); await load(); say("t" + p.id, "ok", r.results.length ? "" : "No device is assigned to this port."); });
  const revert = (p: Port) => run("p" + p.id, async () => { const r = await api<{ results: TestRes[] }>("/ports/" + p.id + "/revert", { method: "POST" }); setTests((t) => ({ ...t, [p.id]: r.results })); await load(true); say("p" + p.id, "ok", "Reverted to the last working settings."); });
  const keep = () => run("keep", async () => { await api("/ports/1/keep", { method: "POST" }); await load(true); });
  const revertPending = () => run("keep", async () => { await api("/ports/" + (v.pending?.ports[0] ?? 1) + "/revert", { method: "POST" }); await load(true); });
  const saveDev = (d: Dev) => run("d" + d.id, async () => {
    const x = devDrafts[d.id]; const r = await api<{ results: TestRes[]; pending: unknown; unchanged?: boolean }>("/devices/" + d.id, { method: "PUT", json: { port_id: x.port_id, modbus_address: x.modbus_address, poll_interval_s: x.poll_interval_s, enabled: x.enabled } });
    await load(true); reload(); say("d" + d.id, r.pending ? "err" : "ok", r.unchanged ? "Nothing changed." : r.pending ? "Saved, but the device is not answering on this port. Keep or revert." : "Saved. Polling paused, applied, tested and resumed.");
  });

  const secs = v.pending ? Math.max(0, Math.ceil((v.pending.deadline - now) / 1000)) : 0;
  const withCur = (p: Port) => (p.device_path && !found.some((f) => f.path === p.device_path) ? [{ path: p.device_path, kind: "saved", target: "", accessible: true } as Found, ...found] : found);

  const portCard = (srv: Port) => {
    const p = drafts[srv.id] ?? srv; const changed = !same(p, srv); const t = tests[srv.id]; const m = msg["p" + srv.id]; const d = v.defaults;
    const timing = (k: "timeout_ms" | "retries" | "turnaround_ms", label: string, hint: string) => (
      <label className="fp-field"><span className="fp-cap">{label}</span><div className="fp-row" style={{ gap: 8, flexWrap: "nowrap" }}><input className="fp-input" inputMode="numeric" value={Number.isNaN(p[k]) ? "" : p[k]} onChange={(e) => set(p.id, { [k]: num(e.target.value) } as Partial<Port>)} aria-label={label} />
        <button className="fp-btn small" type="button" disabled={p[k] === d[k]} onClick={() => set(p.id, { [k]: d[k] } as Partial<Port>)}>Reset</button></div><span className="fp-hint">{hint} (default {String(d[k])})</span></label>);
    return (
      <section className="fp-card" key={srv.id} aria-label={`Port ${srv.id}`}>
        <div className="fp-row fp-spread"><h3>Port {srv.id}</h3><div className="fp-row" style={{ gap: 8 }}>{changed && <Chip tone="warn">CHANGED</Chip>}<Chip tone={PORT_TONE[srv.status]} title={srv.lastError ?? undefined}>{srv.status}</Chip></div></div>
        <div className="fp-form">
          <label className="fp-field"><span className="fp-cap">Name</span><input className="fp-input" value={p.label} maxLength={60} onChange={(e) => set(p.id, { label: e.target.value })} /></label>
          <label className="fp-field"><span className="fp-cap">Enabled</span><span className="fp-row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 24, height: 24 }} checked={p.enabled} onChange={(e) => set(p.id, { enabled: e.target.checked })} aria-label={`Port ${p.id} enabled`} />{p.enabled ? "ON" : "OFF"}</span></label>
          <label className="fp-field"><span className="fp-cap">Connection type</span><select className="fp-input" value={p.transport} onChange={(e) => set(p.id, { transport: e.target.value as Port["transport"] })}><option value="serial">Serial device</option><option value="tcp">TCP (RS-485 to Ethernet converter, bench simulator)</option></select></label>
          {p.transport === "serial" ? <>
            <label className="fp-field wide"><span className="fp-cap">Serial device</span>
              <div className="fp-row" style={{ gap: 8, flexWrap: "nowrap" }}><select className="fp-input" style={{ flex: 1 }} value={p.device_path} onChange={(e) => set(p.id, { device_path: e.target.value })}><option value="">Choose a device...</option>{withCur(p).map((f) => <option key={f.path} value={f.path}>{f.path}{f.accessible ? "" : "  (no permission)"}</option>)}</select>
                <button className="fp-btn small" type="button" onClick={() => void refreshList()}>Refresh list</button></div>
              <input className="fp-input" value={p.device_path} placeholder="/dev/serial/by-id/... (advanced: type a path)" onChange={(e) => set(p.id, { device_path: e.target.value.trim() })} aria-label="Serial device path" />
              <span className="fp-hint">Stable by-id names are listed first: ttyUSB numbers can change after a reboot.</span></label></> : <>
            <label className="fp-field"><span className="fp-cap">Host</span><input className="fp-input" value={p.tcp_host} onChange={(e) => set(p.id, { tcp_host: e.target.value.trim() })} placeholder="192.168.1.50" /></label>
            <label className="fp-field"><span className="fp-cap">TCP port</span><input className="fp-input" inputMode="numeric" value={Number.isNaN(p.tcp_port) ? "" : p.tcp_port} onChange={(e) => set(p.id, { tcp_port: num(e.target.value) })} /></label>
            <label className="fp-field"><span className="fp-cap">Framing</span><select className="fp-input" value={p.tcp_framing} onChange={(e) => set(p.id, { tcp_framing: e.target.value as Port["tcp_framing"] })}><option value="rtu">RTU over TCP (converter)</option><option value="mbap">Modbus TCP (bench simulator)</option></select></label></>}
          <span className="fp-cap wide">Line settings</span>
          <label className="fp-field"><span className="fp-cap">Baud rate</span><select className="fp-input" value={p.baud} onChange={(e) => set(p.id, { baud: Number(e.target.value) })}>{v.bauds.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
          <label className="fp-field"><span className="fp-cap">Data bits</span><select className="fp-input" value={8} disabled><option value={8}>8</option></select></label>
          <label className="fp-field"><span className="fp-cap">Parity</span><select className="fp-input" value={p.parity} onChange={(e) => set(p.id, { parity: e.target.value })}><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></label>
          <label className="fp-field"><span className="fp-cap">Stop bits</span><select className="fp-input" value={p.stop_bits} onChange={(e) => set(p.id, { stop_bits: Number(e.target.value) })}><option value={1}>1</option><option value={2}>2</option></select></label>
          {p.transport === "tcp" && <span className="fp-hint wide">Baud rate, parity and stop bits belong to the converter's own settings; CORE stores them for reference.</span>}
          <span className="fp-cap wide">Timing</span>
          {timing("timeout_ms", "Response timeout (ms)", "100 to 10000")}{timing("retries", "Retries", "0 to 5")}{timing("turnaround_ms", "Turnaround delay (ms)", "pause between requests")}
        </div>
        <ul className="fp-list"><li><span>Requests / errors</span><span className="fp-num">{srv.counters.requests} / {srv.counters.errors}</span></li><li><span>Last success</span><span>{ago(srv.counters.lastOk, now)}</span></li><li><span>Devices on this port</span><span className="fp-num">{srv.devices}</span></li></ul>
        {srv.lastError && srv.status !== "OPEN" && <p className="fp-msg err" role="status">{srv.lastError}</p>}
        <div className="fp-row"><button className="fp-btn" disabled={busy !== null} onClick={() => void testPort(srv)}>{busy === "t" + srv.id ? "Testing..." : "Test port"}</button>
          <button className="fp-btn primary" disabled={busy !== null || !changed} onClick={() => void savePort(srv)}>{busy === "p" + srv.id ? "Applying..." : "Save"}</button>
          <button className="fp-btn" disabled={busy !== null || !changed} onClick={() => set(srv.id, srv)}>Discard</button>
          <button className="fp-btn" disabled={busy !== null} onClick={() => void revert(srv)} title="Go back to the last settings that worked">Revert</button></div>
        {m && m.s && <p className={`fp-msg ${m.t}`} role="status">{m.s}</p>}
        {t && <TestList rows={t} />}
      </section>);
  };

  const devCard = (
    <section className="fp-card" aria-label="Devices on ports"><h3>Devices on ports</h3>
      <p className="fp-hint">Each bus device sits on one port at one Modbus address. Move a device with the Port menu: polling pauses, the change is applied and tested, then polling resumes.</p>
      {v.shared.length > 0 && <div className="fp-banner" data-tone="warn" role="status"><b>TWO DEVICES ON ONE PORT ({v.shared.map((i) => "Port " + i).join(", ")})</b><ul style={{ margin: "6px 0 0 18px", padding: 0 }}>{v.sharedRules.map((r) => <li key={r}>{r}</li>)}</ul></div>}
      <div className="fp-devs" role="table" aria-label="Device assignment">
        <div className="fp-devrow fp-devhead" role="row"><span className="fp-cap">Device</span><span className="fp-cap">Port</span><span className="fp-cap">Modbus address</span><span className="fp-cap">Poll (s)</span><span className="fp-cap">Status</span><span /></div>
        {v.devices.map((srv) => {
          const x = devDrafts[srv.id] ?? srv; const changed = x.port_id !== srv.port_id || x.modbus_address !== srv.modbus_address || x.poll_interval_s !== srv.poll_interval_s || x.enabled !== srv.enabled; const [tone, word] = DEV_STATE[srv.state]; const m = msg["d" + srv.id];
          const setD = (patch: Partial<Dev>) => setDevDrafts((d) => ({ ...d, [srv.id]: { ...x, ...patch } }));
          return (<div key={srv.id} role="row" style={{ display: "contents" }}>
            <div className="fp-devrow" role="row">
              <span role="cell"><b>{KIND_LABEL[srv.kind] ?? srv.kind}</b><br /><span className="fp-hint">{srv.model}</span>{srv.kind === "weather" && <><br /><span className="fp-hint">0x90 = 144 is probably the factory address</span></>}</span>
              <span role="cell"><select className="fp-input" value={x.port_id} aria-label={`${srv.model} port`} onChange={(e) => setD({ port_id: Number(e.target.value) })}>{v.ports.map((p) => <option key={p.id} value={p.id}>Port {p.id}</option>)}</select></span>
              <span role="cell"><input className="fp-input" inputMode="numeric" value={Number.isNaN(x.modbus_address) ? "" : x.modbus_address} aria-label={`${srv.model} Modbus address`} onChange={(e) => setD({ modbus_address: num(e.target.value) })} /></span>
              <span role="cell"><input className="fp-input" inputMode="numeric" value={Number.isNaN(x.poll_interval_s) ? "" : x.poll_interval_s} aria-label={`${srv.model} poll interval`} onChange={(e) => setD({ poll_interval_s: num(e.target.value) })} /></span>
              <span role="cell" className="fp-row" style={{ gap: 6 }}><Chip tone={tone}>{word}</Chip>{changed && <Chip tone="warn">CHANGED</Chip>}</span>
              <span role="cell" className="fp-row" style={{ gap: 6 }}><button className="fp-btn small primary" disabled={busy !== null || !changed} onClick={() => void saveDev(srv)}>{busy === "d" + srv.id ? "Applying..." : "Save"}</button>{changed && <button className="fp-btn small" onClick={() => setDevDrafts((d) => ({ ...d, [srv.id]: srv }))}>Discard</button>}</span>
            </div>{m && m.s && <p className={`fp-msg ${m.t}`} role="status" style={{ gridColumn: "1 / -1" }}>{m.s}</p>}</div>);
        })}
      </div>
      <span className="fp-hint">Addresses on one port must differ. The gateway address is never 0, 123, 160 or 255. A device whose port is off shows NOT CONNECTED and never blocks the other port.</span>
    </section>);

  return (<>
    <div className="fp-ports">{v.ports.map((p) => portCard(p))}</div>
    {devCard}
    {v.pending && <Modal title="Keep these port settings?" onClose={() => {}}>
      <p className="fp-msg err" role="alert">A device that was answering before the change is silent now. CORE goes back to the old settings by itself in <b className="fp-num">{secs} s</b> unless you keep these.</p>
      <div className="fp-row"><button className="fp-btn primary" disabled={busy === "keep"} onClick={() => void keep()}>Keep these settings</button><button className="fp-btn" disabled={busy === "keep"} onClick={() => void revertPending()}>Revert now</button></div>
      {msg.keep && <p className="fp-msg err" role="status">{msg.keep.s}</p>}</Modal>}
  </>);
}

function TestList({ rows }: { rows: TestRes[] }) {
  if (!rows.length) return null;
  return <ul className="fp-list" aria-label="Test result">{rows.map((r) => { const [tone, word] = TEST_WORD[r.result] ?? ["off", r.result.toUpperCase()]; return (
    <li key={r.deviceId}><span>{r.model} (address {r.address})</span><span className="fp-row" style={{ gap: 8 }}><Chip tone={tone} title={r.detail}>{word}</Chip><span className="fp-num">{r.ms === null ? "--" : r.ms + " ms"}</span></span></li>); })}</ul>;
}
