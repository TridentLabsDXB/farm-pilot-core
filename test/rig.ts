// Shared rig for HTTP-level tests that need the REAL app (buildApp) without a gateway: an in-memory database, an Admin and an Operator session, a `call` helper.
import "./isolate.js";
import type { AddressInfo } from "node:net";
import { openDb, type Db } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";

export async function rig(opts: { db?: Db; lic?: any } = {}) {
  const db = opts.db ?? openDb(":memory:"); const commands = new Commands(db, { publish() {} } as any, () => {});
  const built = await (buildApp as any)(db, new Ingest(db), commands, null, null, null, null, opts.lic);
  await built.app.listen({ port: 0, host: "127.0.0.1" }); const port = (built.app.server.address() as AddressInfo).port;
  const mk = (name: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(name, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return { id, cookie: "core_session=" + createSession(db, id) }; };
  const admin = mk("admin", "admin"), op = mk("op1", "operator");
  const call = async (who: { cookie: string } | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isBuf = Buffer.isBuffer(body); const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(who ? { cookie: who.cookie } : {}), ...(body && !isBuf ? { "content-type": "application/json" } : {}), ...headers }, body: body ? (isBuf ? (body as Buffer) : JSON.stringify(body)) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); const txt = buf.toString("utf8"); let json: any = null; try { json = JSON.parse(txt); } catch { /* not json */ } return { status: r.status, txt, json, buf, headers: r.headers };
  };
  return { db, app: built.app, routes: built.routes as { method: string; url: string }[], admin, op, call, port, close: () => built.app.close() };
}
