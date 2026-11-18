// 2026-11-19 -- Box API for SYSTEM > Server Connection. ADMIN ONLY (an Operator gets 403 on every route). The access key is never part of any answer.
import type { FastifyInstance } from "fastify";
import type { ServerLink } from "./client.js";

export function registerServerLinkRoutes(app: FastifyInstance, link: ServerLink, admin: any) {
  const A = { preHandler: admin }, who = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const bad = (reply: any, e: any) => reply.code(400).send({ error: String(e?.message ?? e) });
  app.get("/api/server-connection", A, async () => link.view());
  app.put<{ Body: any }>("/api/server-connection", A, async (req, reply) => { try { link.save(who(req), req.body ?? {}); return link.view(); } catch (e) { return bad(reply, e); } });
  app.post<{ Body: { code?: string } }>("/api/server-connection/enrol", A, async (req) => { const r = await link.enrol(who(req), req.body?.code); return { ...r, ...link.view() }; });
  app.post<{ Body: { address?: string } }>("/api/server-connection/test", A, async (req) => link.test(req.body?.address));
  app.post("/api/server-connection/send-now", A, async (req) => { const r = await link.sendNow(who(req)); return { ...r, ...link.view() }; });
}

/** The Admin-only part of GET /api/about. An Operator never gets this object (the About route leaves the field out). */
export function aboutServerLink(link: ServerLink) {
  const s = link.status(); return { state: s.state, reason: s.reason, host: s.host, last_contact_at: s.last_contact_at, round_trip_ms: s.round_trip_ms, enrolment: s.enrolment, reports_today: s.reports_today, clock_warning: s.clock_warning };
}
