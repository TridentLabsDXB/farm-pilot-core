// 2026-11-17 -- Licence Management, FARM-PILOT CORE ONLINE build only (config.online / FP_ONLINE=1). RECORD + DISPLAY: deployments, usage and "last seen" are entered by hand,
// RENEW / ISSUE only record a licence and a history row, nothing is signed, nothing can be revoked (a box verifies its .fplic offline). See docs/licence-management.md.
// A standalone build never calls registerDeploymentRoutes: no table, no route (404). ADMIN ONLY: Operators get 403 (the `admin` guard). Every change goes to audit_log.
//
//   GET   /api/licence-deployments                list, status computed now, sorted by expiry (no expiry last)
//   GET   /api/licence-deployments/attention      { count } = EXPIRING + EXPIRED (menu badge)
//   GET   /api/licence-deployments/:id            one deployment
//   POST  /api/licence-deployments                add a deployment (starts as FREE)
//   PATCH /api/licence-deployments/:id            edit name / Device ID / licensed to / usage / last seen
//   POST  /api/licence-deployments/:id/record     RENEW or ISSUE: sets the licence fields, appends an ISSUED / RENEWED row
//   GET   /api/licence-deployments/:id/history    newest first (+ a derived EXPIRED row once the term has ended)
//   POST  /api/licence-deployments/:id/history    append an INSTALLED / NOTE row
//   POST  /api/licence-deployments/:id/remove     REMOVE LICENCE: back to FREE + a REMOVED row
//   POST  /api/licence-deployments/:id/fplic        DOWNLOAD .FPLIC: signed with dev-1 only, verified with the box's verifier, audited + history
//   POST  /api/licence-deployments/:id/clear-expiry ENGINEERING only: clear the expiry so it can be signed
//   DELETE /api/licence-deployments/:id           delete the record and its history (body: the Device ID, typed)
import type { FastifyInstance } from "fastify";
import { audit, type Db } from "../db.js";
import { DEVICE_ID_RE } from "../licence/device.js";
import { LICENCE_ID_RE, ENGINEERING } from "../licence/format.js";
import { FplicError, fplicState, signDeploymentLicence, DEV_KEY_ID, type SigningOpts } from "./signing.js";
import { TIERS, isTier, PAID_TIERS, type Tier } from "./tiers.js";
import { FREE_LIMITS, deploymentStatus, effectiveLimits, needsAttention, sortByExpiry, termPct, usageFlag, type DeploymentLimits, type DeploymentUsage } from "./calc.js";

// Additive and idempotent, applied only when the Online build starts (there are no numbered migrations in this repo: every table is CREATE IF NOT EXISTS in db.ts; this one lives here so a standalone build never gets it).
export const SCHEMA_DEPLOYMENTS = `
CREATE TABLE IF NOT EXISTS licence_deployments (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, licensed_to TEXT, licence_id TEXT,
  type TEXT NOT NULL DEFAULT 'FREE' CHECK (type IN ('FREE','PRO','FULL','ENGINEERING')),
  issued_at TEXT, valid_until TEXT,                -- ISO UTC, valid_until NULL = no expiry
  limits TEXT NOT NULL, usage TEXT NOT NULL,       -- JSON: limits {gateways,sensors,reports_days,retention_days} (null = unlimited), usage {gateways,sensors}
  last_seen INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS licence_history (
  id INTEGER PRIMARY KEY, deployment_id INTEGER NOT NULL REFERENCES licence_deployments(id) ON DELETE CASCADE, ts INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('ISSUED','INSTALLED','RENEWED','REMOVED','DOWNLOADED','NOTE')), note TEXT, username TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_licence_history_dep ON licence_history(deployment_id, ts);
`;
export const TYPES = ["FREE", "PRO", "FULL", ENGINEERING] as const;
const SCHEMA_OLD_TYPE_CHECK = "'FREE','PRO','ENGINEERING'";

/** 2026-11-18: the first Online build (2026-11-17) created licence_deployments with CHECK (type IN FREE, PRO, ENGINEERING). SQLite cannot alter a CHECK, so a table that still has it is rebuilt once
 *  (SQLite's documented 12-step way: foreign keys off, copy, drop, rename). Rows and history are kept as they are. No-op on a new or already rebuilt table. */
function upgradeTypeCheck(db: Db) {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='licence_deployments'").get() as { sql: string } | undefined)?.sql ?? "";
  if (!sql.includes(SCHEMA_OLD_TYPE_CHECK)) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(SCHEMA_DEPLOYMENTS.split("CREATE TABLE IF NOT EXISTS licence_history")[0].replace("licence_deployments", "licence_deployments_new"));
      db.exec("INSERT INTO licence_deployments_new(id,device_id,name,licensed_to,licence_id,type,issued_at,valid_until,limits,usage,last_seen,created_at) SELECT id,device_id,name,licensed_to,licence_id,type,issued_at,valid_until,limits,usage,last_seen,created_at FROM licence_deployments");
      db.exec("DROP TABLE licence_deployments; ALTER TABLE licence_deployments_new RENAME TO licence_deployments");
      if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length) throw new Error("licence_deployments rebuild left a broken reference");
    })();
  } finally { db.pragma("foreign_keys = ON"); }
}

interface Row { id: number; device_id: string; name: string; licensed_to: string | null; licence_id: string | null; type: string; issued_at: string | null; valid_until: string | null; limits: string; usage: string; last_seen: number | null; }
const parse = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };

export function deploymentView(r: Row, now = Date.now(), so: SigningOpts = {}) {
  const limits = parse<DeploymentLimits>(r.limits, FREE_LIMITS), usage = parse<DeploymentUsage>(r.usage, { gateways: 0, sensors: 0 });
  const { status, daysLeft } = deploymentStatus(r.type, r.valid_until, now), eff = effectiveLimits(r.type, limits, status);
  return {
    id: r.id, name: r.name, deviceId: r.device_id, licensedTo: r.licensed_to, licenceId: r.licence_id, type: r.type, issuedAt: r.issued_at, validUntil: r.valid_until,
    status, daysLeft, termPct: termPct(r.issued_at, r.valid_until, now), limits, usage,
    effectiveLimits: eff,                                              // what the box runs with: the licence's own while valid, FREE when expired
    usageFlags: { gateways: usageFlag(usage.gateways, eff.gateways), sensors: usageFlag(usage.sensors, eff.sensors) },
    lastSeen: r.last_seen,
    fplic: fplicState(r, so),                                          // DOWNLOAD .FPLIC on / off and the reason when off (never any key information)
  };
}

const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
const text = (v: unknown, max: number, what: string): string | null => { if (v === null || v === undefined || v === "") return null; if (typeof v !== "string" || v.trim().length > max) throw bad(`${what} is not valid`); return v.trim(); };
const count = (v: unknown, what: string): number => { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100000) throw bad(`${what} must be a whole number from 0 to 100000`); return v as number; };
const limit = (v: unknown, what: string, min: number, max: number): number | null => { if (v === null) return null; if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${what} must be a whole number from ${min} to ${max}, or empty for unlimited`); return v as number; };
/** Accepts 2027-11-16 (= end of that day for a valid-until, start of the day for an issue date) or a full UTC time 2027-11-16T23:59:59Z. */
function when(v: unknown, what: string, endOfDay: boolean): string | null {
  if (v === null || v === undefined || v === "") return null; if (typeof v !== "string") throw bad(`${what} is not valid`);
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : v;
  const t = Date.parse(s); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) + "Z" !== s) throw bad(`${what} must be a date like 2027-11-16`);
  return s;
}
const deviceId = (v: unknown) => { const s = typeof v === "string" ? v.trim().toUpperCase() : ""; if (!DEVICE_ID_RE.test(s)) throw bad("Device ID must look like FP-XXXX-XXXX-XXXX"); return s; };

/** 2026-11-18: REMOVED and DOWNLOADED join the history events. Same one-time rebuild as above for a licence_history created before it (nothing references that table, so no foreign-key juggling is needed). */
function upgradeHistoryEvents(db: Db) {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='licence_history'").get() as { sql: string } | undefined)?.sql ?? "";
  if (!sql || sql.includes("'DOWNLOADED'")) return;
  db.transaction(() => {
    db.exec(SCHEMA_DEPLOYMENTS.slice(SCHEMA_DEPLOYMENTS.indexOf("CREATE TABLE IF NOT EXISTS licence_history"), SCHEMA_DEPLOYMENTS.indexOf("CREATE INDEX")).replace("licence_history", "licence_history_new"));
    db.exec("INSERT INTO licence_history_new(id,deployment_id,ts,event,note,username) SELECT id,deployment_id,ts,event,note,username FROM licence_history; DROP TABLE licence_history; ALTER TABLE licence_history_new RENAME TO licence_history; CREATE INDEX IF NOT EXISTS idx_licence_history_dep ON licence_history(deployment_id, ts)");
  })();
}

export function registerDeploymentRoutes(app: FastifyInstance, db: Db, admin: (req: any, reply: any) => Promise<unknown>, now: () => number = Date.now, sg: SigningOpts = {}) {
  db.exec(SCHEMA_DEPLOYMENTS); upgradeTypeCheck(db); upgradeHistoryEvents(db);
  const view = (r: Row) => deploymentView(r, now(), sg);
  const A = { preHandler: admin }, U = (req: any) => ({ u: req.user.username as string, r: req.user.role as string });
  const all = () => (db.prepare("SELECT * FROM licence_deployments").all() as Row[]).map((r) => view(r));
  const one = (id: unknown) => db.prepare("SELECT * FROM licence_deployments WHERE id=?").get(Number(id)) as Row | undefined;
  const wrap = (fn: (req: any, reply: any) => unknown) => async (req: any, reply: any) => { try { return await fn(req, reply); } catch (e: any) { if (e?.status === 400) return reply.code(400).send({ error: e.message }); if (/UNIQUE/.test(String(e?.message))) return reply.code(409).send({ error: "A deployment with this Device ID already exists" }); throw e; } };

  app.get("/api/licence-deployments", A, async () => ({ deployments: sortByExpiry(all()), now: now(), tiers: TIERS }));
  app.get("/api/licence-deployments/attention", A, async () => ({ count: all().filter((d) => needsAttention(d.status)).length }));
  app.get<{ Params: { id: string } }>("/api/licence-deployments/:id", A, async (req, reply) => { const r = one(req.params.id); return r ? { deployment: view(r) } : reply.code(404).send({ error: "not found" }); });

  app.post<{ Body: any }>("/api/licence-deployments", A, wrap(async (req, reply) => {
    const b = req.body ?? {}, name = text(b.name, 200, "Name"); if (!name) throw bad("Name is required");
    const usage = { gateways: count(b.usedGateways ?? 0, "Gateways in use"), sensors: count(b.usedSensors ?? 0, "Sensors in use") }, seen = b.lastSeen === undefined || b.lastSeen === null ? null : Number(b.lastSeen);
    if (seen !== null && !Number.isFinite(seen)) throw bad("Last seen is not valid");
    const id = Number(db.prepare("INSERT INTO licence_deployments(device_id,name,licensed_to,type,limits,usage,last_seen,created_at) VALUES(?,?,?,'FREE',?,?,?,?)")
      .run(deviceId(b.deviceId), name, text(b.licensedTo, 200, "Licensed to"), JSON.stringify(FREE_LIMITS), JSON.stringify(usage), seen, now()).lastInsertRowid);
    const { u, r } = U(req); audit(db, u, r, "licence_deployment.create", { id, device_id: deviceId(b.deviceId), name });
    return reply.code(201).send({ deployment: view(one(id)!) });
  }));

  app.patch<{ Params: { id: string }; Body: any }>("/api/licence-deployments/:id", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    const b = req.body ?? {}, sets: string[] = [], vals: unknown[] = [], put = (c: string, v: unknown) => { sets.push(`${c}=?`); vals.push(v); };
    if ("name" in b) { const n = text(b.name, 200, "Name"); if (!n) throw bad("Name is required"); put("name", n); }
    if ("deviceId" in b) put("device_id", deviceId(b.deviceId));
    if ("licensedTo" in b) put("licensed_to", text(b.licensedTo, 200, "Licensed to"));
    if ("usedGateways" in b || "usedSensors" in b) { const u0 = parse<DeploymentUsage>(cur.usage, { gateways: 0, sensors: 0 }); put("usage", JSON.stringify({ gateways: "usedGateways" in b ? count(b.usedGateways, "Gateways in use") : u0.gateways, sensors: "usedSensors" in b ? count(b.usedSensors, "Sensors in use") : u0.sensors })); }
    if ("lastSeen" in b) { const s = b.lastSeen === null ? null : Number(b.lastSeen); if (s !== null && !Number.isFinite(s)) throw bad("Last seen is not valid"); put("last_seen", s); }
    if (!sets.length) throw bad("Nothing to change");
    db.prepare(`UPDATE licence_deployments SET ${sets.join(",")} WHERE id=?`).run(...vals, cur.id);
    const { u, r } = U(req); audit(db, u, r, "licence_deployment.update", { id: cur.id, fields: Object.keys(b) });
    return { deployment: view(one(cur.id)!) };
  }));

  // RENEW (box already has a licence) or ISSUE (box is FREE): records the licence and appends a history row. Signs nothing.
  // 2026-11-18: the type decides the limits (TIERS). The API refuses limits that do not match the tier; a limit left out is filled from the tier. Type FREE clears licence ID, issue date and expiry.
  app.post<{ Params: { id: string }; Body: any }>("/api/licence-deployments/:id/record", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    const b = req.body ?? {}, type = b.type as string, { u, r } = U(req), tierWord = (t: Tier) => `${TIERS[t].gateways ?? "unlimited"} data sources, ${TIERS[t].sensors ?? "unlimited"} sensors`;
    const sameTier = (t: Tier) => {
      for (const [k, key] of [["limitDataSources", "gateways"], ["limitSensors", "sensors"], ["limitReportsDays", "reports_days"], ["limitRetentionDays", "retention_days"]] as const)
        if (k in b && b[k] !== undefined && b[k] !== TIERS[t][key]) throw bad(`${t} has ${tierWord(t)}: the limits are fixed by the type`);
    };
    if (type === "FREE") {
      sameTier("FREE");
      db.transaction(() => {
        db.prepare("UPDATE licence_deployments SET type='FREE', licence_id=NULL, issued_at=NULL, valid_until=NULL, limits=? WHERE id=?").run(JSON.stringify(TIERS.FREE), cur.id);
        db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), "NOTE", text(b.note, 500, "Note") ?? `Set to FREE, ${tierWord("FREE")}`, u);
        audit(db, u, r, "licence_deployment.free", { id: cur.id, was: cur.type, licence_id: cur.licence_id });
      })();
      return { deployment: view(one(cur.id)!) };
    }
    if (!isTier(type)) throw bad("Type must be FREE, PRO, FULL or ENGINEERING");
    const lid = text(b.licenceId, 200, "Licence ID"); if (!lid || !LICENCE_ID_RE.test(lid)) throw bad("Licence ID must look like FPL-20261117-0001");
    const issued = when(b.issuedAt, "Issued", false) ?? new Date(now()).toISOString().slice(0, 10) + "T00:00:00Z", until = when(b.validUntil, "Valid until", true);
    if (until && Date.parse(until) <= Date.parse(issued)) throw bad("Valid until must be after the issue date");
    sameTier(type); const limits: DeploymentLimits = { ...TIERS[type] };    // ENGINEERING: every limit null = unlimited; no expiry unless one is given (the dialog defaults to none)
    const event = cur.type === "FREE" ? "ISSUED" : "RENEWED", licensedTo = text(b.licensedTo, 200, "Licensed to") ?? cur.licensed_to;
    const until_ = until ? `until ${new Date(Date.parse(until)).getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][new Date(Date.parse(until)).getUTCMonth()]} ${new Date(Date.parse(until)).getUTCFullYear()}` : "no expiry";
    const extra = text(b.note, 500, "Note"), note = `${type}, ${tierWord(type)}, ${until_}${extra ? `. ${extra}` : ""}`;   // "ISSUED" + "PRO, 5 data sources, 50 sensors, until 18 Nov 2027"
    db.transaction(() => {
      db.prepare("UPDATE licence_deployments SET type=?, licence_id=?, licensed_to=?, issued_at=?, valid_until=?, limits=? WHERE id=?").run(type, lid, licensedTo, issued, until, JSON.stringify(limits), cur.id);
      db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), event, note, u);
      audit(db, u, r, `licence_deployment.${event.toLowerCase()}`, { id: cur.id, type, licence_id: lid, valid_until: until });
    })();
    return { deployment: view(one(cur.id)!) };
  }));

  // REMOVE LICENCE: back to FREE (licence ID, issue date and expiry cleared) and a REMOVED history row. Records only: nothing is signed, nothing reaches the box.
  app.post<{ Params: { id: string } }>("/api/licence-deployments/:id/remove", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    if (cur.type === "FREE") throw bad("This deployment is already FREE");
    const { u, r } = U(req);
    db.transaction(() => {
      db.prepare("UPDATE licence_deployments SET type='FREE', licence_id=NULL, issued_at=NULL, valid_until=NULL, limits=? WHERE id=?").run(JSON.stringify(TIERS.FREE), cur.id);
      db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), "REMOVED", "back to FREE", u);
      audit(db, u, r, "licence_deployment.removed", { id: cur.id, device_id: cur.device_id, was: cur.type, licence_id: cur.licence_id, valid_until: cur.valid_until });
    })();
    return { deployment: view(one(cur.id)!) };
  }));

  // DELETE DEPLOYMENT: the record and its history. The body must repeat the Device ID (the page asks the person to type it). The audit row keeps what was deleted.
  app.delete<{ Params: { id: string }; Body: any }>("/api/licence-deployments/:id", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    if (typeof req.body?.deviceId !== "string" || req.body.deviceId.trim().toUpperCase() !== cur.device_id) throw bad("Type the Device ID of this deployment to delete it");
    const { u, r } = U(req);
    db.transaction(() => {
      const n = (db.prepare("SELECT COUNT(*) c FROM licence_history WHERE deployment_id=?").get(cur.id) as { c: number }).c;
      audit(db, u, r, "licence_deployment.delete", { id: cur.id, device_id: cur.device_id, name: cur.name, type: cur.type, licence_id: cur.licence_id, valid_until: cur.valid_until, history_rows: n });
      db.prepare("DELETE FROM licence_history WHERE deployment_id=?").run(cur.id); db.prepare("DELETE FROM licence_deployments WHERE id=?").run(cur.id);
    })();
    return { ok: true };
  }));

  // DOWNLOAD .FPLIC: signs with the dev-1 key (signing.ts), verifies with the box's own verifier, then offers the file. Every download is audited and written to the history. Nothing is stored.
  app.post<{ Params: { id: string } }>("/api/licence-deployments/:id/fplic", A, async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    let out: { text: string; fileName: string };
    try { out = signDeploymentLicence({ ...cur, limits: parse(cur.limits, FREE_LIMITS) }, sg); }
    catch (e) { if (e instanceof FplicError) return reply.code(e.status).send({ error: e.message, code: e.code }); throw e; }
    const { u, r } = U(req);
    db.transaction(() => {
      db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), "DOWNLOADED", `.FPLIC ${out.fileName}, key ${DEV_KEY_ID}`, u);
      audit(db, u, r, "licence_deployment.fplic_downloaded", { id: cur.id, device_id: cur.device_id, licence_id: cur.licence_id, type: cur.type, key_id: DEV_KEY_ID });
    })();
    return reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="${out.fileName}"`).header("cache-control", "no-store").send(out.text);
  });

  // ENGINEERING with an expiry cannot be signed (the signed format has none). This clears it, audited, with a history row.
  app.post<{ Params: { id: string } }>("/api/licence-deployments/:id/clear-expiry", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    if (cur.type !== "ENGINEERING" || !cur.valid_until) throw bad("Only an ENGINEERING licence with an expiry has one to clear");
    const { u, r } = U(req);
    db.transaction(() => {
      db.prepare("UPDATE licence_deployments SET valid_until=NULL WHERE id=?").run(cur.id);
      db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), "NOTE", `Expiry cleared (was ${cur.valid_until!.slice(0, 10)})`, u);
      audit(db, u, r, "licence_deployment.expiry_cleared", { id: cur.id, was: cur.valid_until });
    })();
    return { deployment: view(one(cur.id)!) };
  }));

  app.get<{ Params: { id: string } }>("/api/licence-deployments/:id/history", A, async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    const rows = (db.prepare("SELECT id,ts,event,note FROM licence_history WHERE deployment_id=? ORDER BY ts DESC, id DESC").all(cur.id) as { id: number; ts: number; event: string; note: string | null }[]);
    const out: { id: string | number; ts: number; event: string; note: string | null }[] = [...rows];
    // EXPIRED is derived, never stored: shown once the term has ended.
    if (deploymentStatus(cur.type, cur.valid_until, now()).status === "expired" && cur.valid_until) out.unshift({ id: "derived-expired", ts: Date.parse(cur.valid_until), event: "EXPIRED", note: "Fell back to FREE limits" });
    return { history: out };
  });

  app.post<{ Params: { id: string }; Body: any }>("/api/licence-deployments/:id/history", A, wrap(async (req, reply) => {
    const cur = one(req.params.id); if (!cur) return reply.code(404).send({ error: "not found" });
    const b = req.body ?? {}; if (b.event !== "INSTALLED" && b.event !== "NOTE") throw bad("Event must be INSTALLED or NOTE");
    const { u, r } = U(req); db.prepare("INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES(?,?,?,?,?)").run(cur.id, now(), b.event, text(b.note, 500, "Note"), u);
    audit(db, u, r, "licence_deployment.history", { id: cur.id, event: b.event });
    return reply.code(201).send({ ok: true });
  }));
}
