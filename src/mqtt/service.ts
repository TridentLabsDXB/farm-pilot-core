// MQTT Payload source (Data sources > MQTT Payload). CORE is a read-only CLIENT of an external broker (it does not run one; the loopback Aedes broker is a different thing).
// Settings live in SQLite, the password is encrypted at rest and never leaves this class except to the broker. Reconnect uses exponential backoff (own timer, mqtt.js auto-reconnect is off).
// Nothing here can block or crash the rest of CORE: connect errors and bad messages are caught, counted and shown on the page.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import mqtt from "mqtt";
import type { Db } from "../db.js";
import { audit } from "../db.js";
import type { Ingest } from "../ingest.js";
import { HttpError } from "../gateway/registry.js";
import { DEFAULT_CONNECTION, DEFAULT_ID_PATH, DEFAULT_RULES, DEFAULT_TOPICS, DEFAULT_TS_PATH, SERIES_TOPIC } from "./defaults.js";
import { checkFilter, checkRules, mapPayload, topicMatches, type MapRule, type MapResult } from "./mapping.js";
import { decryptSecret, encryptSecret } from "./secret.js";
import { SCHEMA_MQTT } from "./schema.js";
import type { VboxSource } from "../vbox/service.js";

export type MqttState = "connected" | "connecting" | "disconnected" | "disabled";
export interface ConnInput { host?: unknown; port?: unknown; tls?: unknown; client_id?: unknown; username?: unknown; password?: unknown; keepalive?: unknown; }
type Actor = { username: string; role: string };
interface Msg { ts: number; topic: string; raw: string; status: MapResult["status"]; device: string | null; notes: string[]; stored: boolean; vbox?: boolean; }
const RING = 20, RAW_CAP = 2000, FLUSH_MS = 30_000;
export const backoffMs = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));    // 1 s, 2, 4, 8, 16, 32, 60, 60 ...

export class MqttSourceService extends EventEmitter {
  private client: mqtt.MqttClient | null = null; private state: MqttState = "disabled"; private lastError: string | null = null;
  private attempt = 0; private retryTimer: NodeJS.Timeout | null = null; private nextRetryAt: number | null = null; private flushTimer: NodeJS.Timeout | null = null; private emitTimer: NodeJS.Timeout | null = null;
  private connectedAt: number | null = null; private lastMessageAt: number | null = null; private recent: number[] = [];
  private topicCount = new Map<string, { n: number; at: number | null }>(); private devDelta = new Map<string, { n: number; at: number }>();
  private unmapped = new Map<string, number>(); private errorCount = 0; private messages: Msg[] = []; private testing = false; private stopped = true;
  private vbox: VboxSource | null = null; private vboxFilter: string | null = null;
  /** 2026-11-18 -- V-BOX data source: it rides on THIS broker connection. It adds its own subscription (its topic filter) and takes the messages that match its preset; everything else stays with MQTT Payload. */
  attachVbox(v: VboxSource) {
    this.vbox = v;
    v.on("resubscribe", () => { const c = this.client, old = this.vboxFilter, now = v.subscription(); this.vboxFilter = now; if (!c) return; if (old && old !== now && !this.topics().some((t) => t.filter === old)) c.unsubscribe(old, () => {}); if (now) c.subscribe(now, { qos: 1 }, () => {}); });
    v.on("update", () => this.changed());
  }
  /** Injectable for tests (backoff delay) and for faking the clock. */
  constructor(private db: Db, private ingest: Ingest, private opts: { backoff?: (attempt: number) => number } = {}) {
    super(); db.exec(SCHEMA_MQTT); this.seed();
  }

  // ---------- storage ----------
  private seed() {
    if (this.db.prepare("SELECT 1 FROM mqtt_config").get()) return;
    const d = DEFAULT_CONNECTION;
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO mqtt_config(id,enabled,host,port,tls,client_id,username,keepalive,id_path,ts_path) VALUES(1,?,?,?,?,?,?,?,?,?)").run(d.enabled ? 1 : 0, d.host, d.port, d.tls ? 1 : 0, d.client_id, d.username, d.keepalive, DEFAULT_ID_PATH, DEFAULT_TS_PATH);
      for (const t of DEFAULT_TOPICS) this.db.prepare("INSERT INTO mqtt_topics(filter,qos) VALUES(?,?)").run(t.filter, t.qos);
      DEFAULT_RULES.forEach((r, i) => this.db.prepare("INSERT INTO mqtt_rules(path,name,unit,scale,offset,sort) VALUES(?,?,?,?,?,?)").run(r.path, r.name, r.unit, r.scale, r.offset, i));
    })();
  }
  private cfg() { return this.db.prepare("SELECT * FROM mqtt_config WHERE id=1").get() as any; }
  private topics() { return this.db.prepare("SELECT id,filter,qos FROM mqtt_topics ORDER BY id").all() as { id: number; filter: string; qos: 0 | 1 | 2 }[]; }
  private rules(): MapRule[] { return this.db.prepare("SELECT path,name,unit,scale,offset FROM mqtt_rules ORDER BY sort,id").all() as MapRule[]; }
  private password(): string | null { const c = this.cfg(); return c.password_enc ? decryptSecret(c.password_enc) : null; }

  // ---------- connection ----------
  start() { this.stopped = false; this.flushTimer ??= setInterval(() => this.flush(), FLUSH_MS); this.flushTimer.unref?.(); if (this.cfg().enabled) this.connect(); else this.setState("disabled"); }
  async stop() {
    this.stopped = true; this.clearRetry(); if (this.flushTimer) clearInterval(this.flushTimer); this.flushTimer = null; if (this.emitTimer) clearTimeout(this.emitTimer); this.emitTimer = null;
    await this.drop(); this.flush(); this.setState(this.cfg().enabled ? "disconnected" : "disabled");
  }
  private setState(s: MqttState) { if (this.state !== s) { this.state = s; if (s !== "connected") this.connectedAt = null; } this.changed(); }
  private changed() { if (this.emitTimer) return; this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit("update"); }, 500); this.emitTimer.unref?.(); }
  private clearRetry() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.nextRetryAt = null; }
  private async drop() { const c = this.client; this.client = null; if (c) { c.removeAllListeners(); c.on("error", () => {}); await new Promise<void>((r) => c.end(true, {}, () => r())); } }

  private clientId(c: any): string {
    if (c.client_id) return c.client_id as string;
    const id = "core-" + randomBytes(4).toString("hex"); this.db.prepare("UPDATE mqtt_config SET client_id=? WHERE id=1").run(id); return id;
  }
  private connOptions(c: any, password: string | null, clientId: string, extra: mqtt.IClientOptions = {}): { url: string; o: mqtt.IClientOptions } {
    return { url: `${c.tls ? "mqtts" : "mqtt"}://${c.host}:${c.port}`, o: { clientId, username: c.username || undefined, password: password ?? undefined, keepalive: c.keepalive, clean: true, reconnectPeriod: 0, connectTimeout: 10_000, protocolVersion: 4, ...extra } };
  }
  private connect() {
    if (this.stopped || this.client) return;
    const c = this.cfg(); if (!c.enabled) return;
    this.clearRetry(); this.setState("connecting");
    let cl: mqtt.MqttClient;
    try { const { url, o } = this.connOptions(c, this.password(), this.clientId(c)); cl = mqtt.connect(url, o); }
    catch (e) { this.lastError = friendly(e, c); this.scheduleRetry(); return; }
    this.client = cl;
    cl.on("connect", () => {
      this.attempt = 0; this.lastError = null; this.connectedAt = Date.now(); this.setState("connected");
      const subs = Object.fromEntries(this.topics().map((t) => [t.filter, { qos: t.qos }]));
      this.vboxFilter = this.vbox?.subscription() ?? null; if (this.vboxFilter) subs[this.vboxFilter] = { qos: 1 };
      if (Object.keys(subs).length) cl.subscribe(subs, (err) => { if (err) { this.lastError = "subscribe failed: " + friendly(err, c); this.changed(); } });
    });
    cl.on("message", (topic, payload) => { try { this.onMessage(topic, payload); } catch (e) { this.errorCount++; console.error("mqtt payload: message handler", e); } });
    cl.on("error", (e) => { this.lastError = friendly(e, this.cfg()); this.changed(); });
    cl.on("close", () => { if (this.client !== cl) return; this.client = null; cl.removeAllListeners(); cl.on("error", () => {}); this.setState("disconnected"); this.scheduleRetry(); });
  }
  private scheduleRetry() {
    if (this.stopped || !this.cfg().enabled || this.retryTimer) return;
    const d = (this.opts.backoff ?? backoffMs)(this.attempt++); this.nextRetryAt = Date.now() + d;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.nextRetryAt = null; this.connect(); }, d); this.retryTimer.unref?.(); this.changed();
  }
  /** Drop the connection and connect again with the stored settings (after SAVE while enabled). */
  private async reconnect() { this.clearRetry(); await this.drop(); this.attempt = 0; if (this.cfg().enabled && !this.stopped) this.connect(); else this.setState(this.cfg().enabled ? "disconnected" : "disabled"); }

  // ---------- incoming messages ----------
  private onMessage(topic: string, payload: Buffer, now = Date.now()) {
    this.lastMessageAt = now; this.recent.push(now); while (this.recent.length && this.recent[0] < now - 60_000) this.recent.shift();
    for (const t of this.topics()) if (topicMatches(t.filter, topic)) { const x = this.topicCount.get(t.filter) ?? { n: 0, at: null }; x.n++; x.at = now; this.topicCount.set(t.filter, x); }
    if (this.vbox?.matches(topic)) {          // V-BOX preset: handled by its own rules, never by the MQTT Payload mapping (OTHER DEVICES = what does not match)
      const r = this.vbox.handle(topic, payload, now);
      this.messages.unshift({ ts: now, topic, raw: payload.toString("utf8").slice(0, RAW_CAP), status: r.status, device: r.device, notes: r.notes, stored: r.stored, vbox: true }); if (this.messages.length > RING) this.messages.length = RING;
      this.changed(); return;
    }
    const m = mapPayload(payload, { idPath: this.cfg().id_path, tsPath: this.cfg().ts_path, rules: this.rules() });
    const notes = [...m.errors]; if (m.missing.length) notes.push("missing: " + m.missing.join(", ")); if (m.unmapped.length) notes.push("unmapped: " + m.unmapped.slice(0, 8).join(", ") + (m.unmapped.length > 8 ? " ..." : ""));
    if (m.status === "error") this.errorCount++;
    for (const u of m.unmapped) { if (this.unmapped.size < 100 || this.unmapped.has(u)) this.unmapped.set(u, (this.unmapped.get(u) ?? 0) + 1); }
    let stored = false;
    if (m.deviceId) {
      const row = this.db.prepare("SELECT state FROM mqtt_devices WHERE device_id=?").get(m.deviceId) as { state: string } | undefined;
      if (!row) this.db.prepare("INSERT INTO mqtt_devices(device_id,state,first_seen,last_seen,msg_count) VALUES(?, 'new', ?, ?, 0)").run(m.deviceId, now, now);
      const d = this.devDelta.get(m.deviceId) ?? { n: 0, at: now }; d.n++; d.at = now; this.devDelta.set(m.deviceId, d);
      // Only devices an Admin has ADDED are stored. New devices wait on the page, ignored ones are dropped.
      // TODO(licence, owner decision open): an MQTT source does NOT change licence counting for now (no gateway, no sensor is counted). Decide whether it is 1 data source / how added devices count.
      if (row?.state === "added" && m.values.length) { this.ingest.record(SERIES_TOPIC, m.deviceId, Object.fromEntries(m.values.map((v) => [v.name, v.value])), m.ts ?? now); stored = true; }
      else if (row?.state === "added") notes.push("no value stored");
      else notes.push(row?.state === "ignored" ? "device ignored" : "device not added yet");
    }
    this.messages.unshift({ ts: now, topic, raw: payload.toString("utf8").slice(0, RAW_CAP), status: m.status, device: m.deviceId, notes, stored });
    if (this.messages.length > RING) this.messages.length = RING;
    this.changed();
  }
  private flush() {
    if (!this.devDelta.size) return;
    const up = this.db.prepare("UPDATE mqtt_devices SET msg_count=msg_count+?, last_seen=? WHERE device_id=?");
    try { this.db.transaction(() => { for (const [id, d] of this.devDelta) up.run(d.n, d.at, id); })(); this.devDelta.clear(); } catch (e) { console.error("mqtt payload: flush", e); }
  }

  // ---------- API (all called from routes.ts, Admin only) ----------
  view() {
    this.flush(); const c = this.cfg(), now = Date.now(); this.recent = this.recent.filter((t) => t >= now - 60_000);
    const disabled = !c.enabled, state: MqttState = disabled ? "disabled" : this.state;
    return {
      config: { enabled: !!c.enabled, host: c.host, port: c.port, tls: !!c.tls, client_id: c.client_id, username: c.username, keepalive: c.keepalive, has_password: !!c.password_enc && this.password() !== null, password_unreadable: !!c.password_enc && this.password() === null },   // NEVER the password
      status: { state, host: c.host, port: c.port, lastError: disabled ? null : this.lastError, lastMessageAt: this.lastMessageAt, perMinute: this.recent.length, connectedAt: this.connectedAt, nextRetryAt: this.nextRetryAt, attempt: this.attempt },
      topics: this.topics().map((t) => ({ ...t, count: this.topicCount.get(t.filter)?.n ?? 0, lastAt: this.topicCount.get(t.filter)?.at ?? null })),
      devices: (this.db.prepare("SELECT device_id,state,label,first_seen,last_seen,msg_count FROM mqtt_devices ORDER BY first_seen").all() as any[]).map((d) => ({ ...d, msg_count: d.msg_count })),
      mapping: { id_path: c.id_path, ts_path: c.ts_path, rules: this.rules(), unmapped: [...this.unmapped].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count).slice(0, 20), errors: this.errorCount },
      messages: this.messages.map(({ raw, ...m }) => ({ ...m, payload: raw })),
    };
  }
  private validate(i: ConnInput, cur: any) {
    const host = i.host === undefined ? cur.host : i.host, port = i.port === undefined ? cur.port : i.port, ka = i.keepalive === undefined ? cur.keepalive : i.keepalive;
    const tls = i.tls === undefined ? !!cur.tls : i.tls, cid = i.client_id === undefined ? cur.client_id : i.client_id, user = i.username === undefined ? cur.username : i.username;
    if (typeof host !== "string" || !/^[A-Za-z0-9._:-]{1,253}$/.test(host.trim())) throw new HttpError(400, "broker host must be a host name or IP address");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "port must be 1 to 65535");
    if (typeof tls !== "boolean") throw new HttpError(400, "TLS must be on or off");
    if (typeof cid !== "string" || cid.length > 64 || !/^[\x21-\x7e]*$/.test(cid)) throw new HttpError(400, "client ID: up to 64 characters, no spaces (empty = automatic)");
    if (typeof user !== "string" || user.length > 128) throw new HttpError(400, "user name is at most 128 characters");
    if (!Number.isInteger(ka) || ka < 5 || ka > 3600) throw new HttpError(400, "keep-alive must be 5 to 3600 seconds");
    if (i.password !== undefined && (typeof i.password !== "string" || i.password.length > 256)) throw new HttpError(400, "password is at most 256 characters");
    return { host: host.trim(), port: port as number, tls, client_id: cid, username: user, keepalive: ka as number };
  }
  /** SAVE. password: omitted = keep the stored one, "" = remove it, text = replace it. Reconnects when enabled. */
  async saveConfig(a: Actor, i: ConnInput) {
    const cur = this.cfg(), v = this.validate(i, cur);
    const pw = i.password === undefined ? cur.password_enc : i.password === "" ? null : encryptSecret(i.password as string);
    this.db.prepare("UPDATE mqtt_config SET host=?,port=?,tls=?,client_id=?,username=?,keepalive=?,password_enc=?,updated_at=?,updated_by=? WHERE id=1").run(v.host, v.port, v.tls ? 1 : 0, v.client_id, v.username, v.keepalive, pw, Date.now(), a.username);
    audit(this.db, a.username, a.role, "mqtt.config", { host: v.host, port: v.port, tls: v.tls, username: v.username, keepalive: v.keepalive, password: i.password === undefined ? "unchanged" : i.password === "" ? "removed" : "changed" });   // never the password itself
    await this.reconnect(); return this.view();
  }
  async setEnabled(a: Actor, on: unknown) {
    if (typeof on !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const c = this.cfg(); if (on && !c.host) throw new HttpError(400, "enter a broker host first");
    this.db.prepare("UPDATE mqtt_config SET enabled=? WHERE id=1").run(on ? 1 : 0); audit(this.db, a.username, a.role, on ? "mqtt.enable" : "mqtt.disable", {});
    if (!on) { this.lastError = null; this.recent = []; }
    await this.reconnect(); return this.view();
  }
  /** TEST CONNECTION: a separate short-lived client with the form values (stored password when none typed). Does not touch the running connection. */
  async test(i: ConnInput): Promise<{ ok: boolean; message: string }> {
    if (this.testing) throw new HttpError(409, "a test is already running");
    const cur = this.cfg(); let v; try { v = this.validate(i, cur); } catch (e: any) { return { ok: false, message: e.message }; }
    const pw = i.password === undefined || i.password === null ? this.password() : (i.password as string) || null;
    this.testing = true;
    try {
      const { url, o } = this.connOptions({ ...v, tls: v.tls }, pw, `${v.client_id || "core"}-test-${randomBytes(2).toString("hex")}`, { connectTimeout: 5000 });
      return await new Promise((resolve) => {
        let done = false, cl: mqtt.MqttClient | null = null;
        const fin = (r: { ok: boolean; message: string }) => { if (done) return; done = true; clearTimeout(tm); if (cl) { cl.removeAllListeners(); cl.on("error", () => {}); cl.end(true); } resolve(r); };
        const tm = setTimeout(() => fin({ ok: false, message: `No answer from ${v.host}:${v.port} within 6 seconds.` }), 6000);
        try { cl = mqtt.connect(url, o); } catch (e) { return fin({ ok: false, message: friendly(e, v) }); }
        cl.on("connect", () => fin({ ok: true, message: `Connected to ${v.host}:${v.port}${v.tls ? " (TLS)" : ""}.` }));
        cl.on("error", (e) => fin({ ok: false, message: friendly(e, v) }));
        cl.on("close", () => fin({ ok: false, message: `The broker at ${v.host}:${v.port} closed the connection.` }));
      });
    } finally { this.testing = false; }
  }
  addTopic(a: Actor, filter: unknown, qos: unknown) {
    const bad = checkFilter(filter); if (bad) throw new HttpError(400, bad);
    if (qos !== 0 && qos !== 1 && qos !== 2) throw new HttpError(400, "QoS must be 0, 1 or 2");
    if ((this.db.prepare("SELECT COUNT(*) c FROM mqtt_topics").get() as { c: number }).c >= 50) throw new HttpError(400, "at most 50 topic filters");
    if (this.db.prepare("SELECT 1 FROM mqtt_topics WHERE filter=?").get(filter)) throw new HttpError(409, "this topic filter is already in the list");
    this.db.prepare("INSERT INTO mqtt_topics(filter,qos) VALUES(?,?)").run(filter, qos); audit(this.db, a.username, a.role, "mqtt.topic.add", { filter, qos });
    this.client?.subscribe(filter as string, { qos: qos as 0 | 1 | 2 }, () => {}); this.changed(); return this.view();
  }
  removeTopic(a: Actor, id: number) {
    const t = this.db.prepare("SELECT filter FROM mqtt_topics WHERE id=?").get(id) as { filter: string } | undefined; if (!t) throw new HttpError(404, "topic not found");
    this.db.prepare("DELETE FROM mqtt_topics WHERE id=?").run(id); this.topicCount.delete(t.filter); audit(this.db, a.username, a.role, "mqtt.topic.remove", { filter: t.filter });
    this.client?.unsubscribe(t.filter, () => {}); this.changed(); return this.view();
  }
  saveMapping(a: Actor, idPath: unknown, tsPath: unknown, rules: unknown) {
    const bad = checkRules(rules, idPath, tsPath); if (bad) throw new HttpError(400, bad);
    const rs = (rules as MapRule[]);
    this.db.transaction(() => {
      this.db.prepare("UPDATE mqtt_config SET id_path=?, ts_path=? WHERE id=1").run(idPath, tsPath); this.db.prepare("DELETE FROM mqtt_rules").run();
      rs.forEach((r, i) => this.db.prepare("INSERT INTO mqtt_rules(path,name,unit,scale,offset,sort) VALUES(?,?,?,?,?,?)").run(r.path, r.name, r.unit, r.scale, r.offset, i));
    })();
    this.unmapped.clear(); this.errorCount = 0; audit(this.db, a.username, a.role, "mqtt.mapping", { id_path: idPath, ts_path: tsPath, rules: rs.length }); this.changed(); return this.view();
  }
  /** NEW DEVICES FOUND: ADD AS SENSOR / IGNORE. "Add" makes CORE store this device's mapped values. It does NOT create a row on the Sensors page yet (open decision, see docs). */
  setDevice(a: Actor, id: string, action: "add" | "ignore", label?: unknown) {
    this.flush(); const d = this.db.prepare("SELECT state FROM mqtt_devices WHERE device_id=?").get(id); if (!d) throw new HttpError(404, "device not found");
    if (label !== undefined && (typeof label !== "string" || label.length > 64)) throw new HttpError(400, "label is at most 64 characters");
    this.db.prepare("UPDATE mqtt_devices SET state=?, label=COALESCE(?, label) WHERE device_id=?").run(action === "add" ? "added" : "ignored", typeof label === "string" ? label.trim() : null, id);
    audit(this.db, a.username, a.role, action === "add" ? "mqtt.device.add" : "mqtt.device.ignore", { device: id }); this.changed(); return this.view();
  }
}

/** Short plain sentence for a connection error. Never includes the password (mqtt.js errors do not carry it, and only host/port are interpolated). */
export function friendly(e: unknown, c: { host: string; port: number }): string {
  const x = e as any, code = String(x?.code ?? ""), msg = String(x?.message ?? e ?? "");
  const at = `${c.host}:${c.port}`;
  if (code === "ECONNREFUSED") return `Connection refused: nothing is listening on ${at}.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Host name ${c.host} was not found.`;
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(msg)) return `No answer from ${at}.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${at} cannot be reached from this computer.`;
  if (/not authorized|bad user name or password|5$/i.test(msg) && (/refused/i.test(msg) || x?.code === 4 || x?.code === 5)) return "The broker refused the user name or password.";
  if (/CERT|certificate|self.signed|SSL|TLS/i.test(code + " " + msg)) return "TLS problem: the broker certificate was not accepted.";
  if (/Connection refused/i.test(msg)) return "The broker refused the connection: " + msg.replace(/^.*Connection refused:?\s*/i, "");
  return "Connection problem: " + msg.slice(0, 120);
}
