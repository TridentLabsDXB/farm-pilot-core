import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { audit } from "./db.js";
import { config } from "./config.js";

export type Role = "operator" | "admin";
export interface AuthUser { id: number; username: string; role: Role; }

export function hashPassword(pw: string): string {
  const salt = randomBytes(16); const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${h.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split("$"); if (alg !== "scrypt" || !s || !h) return false;
  const calc = scryptSync(pw, Buffer.from(s, "hex"), 64); const want = Buffer.from(h, "hex");
  return calc.length === want.length && timingSafeEqual(calc, want);
}
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// First boot only: create the Admin. Password from CORE_ADMIN_PASSWORD, else random, written ONCE to <dataDir>/initial-admin-password (mode 600).
export function ensureAdmin(db: Db) {
  const n = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c; if (n > 0) return;
  const pw = process.env.CORE_ADMIN_PASSWORD || randomBytes(9).toString("base64url");
  db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES('admin',?,'admin',?)").run(hashPassword(pw), Date.now());
  if (!process.env.CORE_ADMIN_PASSWORD) writeFileSync(join(config.dataDir, "initial-admin-password"), `admin / ${pw}\n`, { mode: 0o600 });
  audit(db, "system", "system", "user.bootstrap", { username: "admin" });
}

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(sha(token), userId, Date.now() + config.sessionHours * 3600_000);
  return token;
}
export function userFromToken(db: Db, token: string | undefined): AuthUser | null {
  if (!token) return null;
  const r = db.prepare("SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1").get(sha(token), Date.now()) as AuthUser | undefined;
  return r ?? null;
}
export const destroySession = (db: Db, token: string) => db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(token));
export const purgeSessions = (db: Db) => db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());

// Failed-login throttle, DB-backed so a restart does not reset it (Milestone 2).
// Two scopes: "ui" = username+ip, 5 failures in 5 min lock the pair for 5 min; "ip" = whole address, 20 failures in 5 min lock the IP for 10 min.
// A lockout writes one audit row (login.lockout). A successful login clears only the username+ip counter, never the IP-wide one.
const WINDOW = 300_000;
const RULES = { ui: { max: 5, lock: 300_000 }, ip: { max: 20, lock: 600_000 } } as const;
export type Scope = keyof typeof RULES;
export function throttled(db: Db, scope: Scope, key: string, now = Date.now()): number {
  const r = db.prepare("SELECT locked_until u FROM login_fail WHERE scope=? AND key=?").get(scope, key) as { u: number } | undefined;
  return r && r.u > now ? r.u : 0;
}
export function noteFail(db: Db, scope: Scope, key: string, now = Date.now()): boolean {
  const rule = RULES[scope];
  const r = db.prepare("SELECT n,first_ts f,locked_until u FROM login_fail WHERE scope=? AND key=?").get(scope, key) as { n: number; f: number; u: number } | undefined;
  let n = 1, f = now, u = 0;
  if (r && now - r.f <= WINDOW) { n = r.n + 1; f = r.f; u = r.u; }
  let locked = false;
  if (n >= rule.max && u <= now) { u = now + rule.lock; locked = true; }
  db.prepare("INSERT INTO login_fail(scope,key,n,first_ts,locked_until) VALUES(?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET n=excluded.n,first_ts=excluded.first_ts,locked_until=excluded.locked_until").run(scope, key, n, f, u);
  if (locked) audit(db, "system", "system", "login.lockout", { scope, key, until: u });
  return locked;
}
export const clearFails = (db: Db, scope: Scope, key: string) => db.prepare("DELETE FROM login_fail WHERE scope=? AND key=?").run(scope, key);
export const purgeFails = (db: Db, now = Date.now()) => db.prepare("DELETE FROM login_fail WHERE locked_until<? AND first_ts<?").run(now, now - WINDOW);
