// Farm Profile and contacts API. Everything is Admin only except the public subset and the alarm "who to inform" view.
import type { FastifyInstance } from "fastify";
import { HttpError } from "./registry.js";
import { LOGO_MAX, type ProfileService } from "./profile.js";

export function registerProfileRoutes(app: FastifyInstance, prof: ProfileService, admin: any, push: () => void) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  app.addContentTypeParser(["image/png", "image/svg+xml"], { parseAs: "buffer", bodyLimit: LOGO_MAX + 1 }, (_req, body, done) => done(null, body));
  app.get("/api/farm-profile/public", async () => prof.publicInfo());
  app.get("/api/farm-profile", { preHandler: admin }, async () => prof.get());
  app.put("/api/farm-profile", { preHandler: admin }, async (req) => { const r = prof.update(A(req), req.body); push(); return r; });
  app.get("/api/farm-profile/logo", async (_req, reply) => {
    const l = prof.logo(); if (!l) throw new HttpError(404, "no logo");
    reply.header("content-type", l.type).header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").header("cache-control", "private, max-age=3600"); return l.data;
  });
  app.post("/api/farm-profile/logo", { preHandler: admin, bodyLimit: LOGO_MAX + 1 }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "send the image as the request body with content-type image/png or image/svg+xml");
    const r = prof.setLogo(A(req), req.body, String(req.headers["content-type"]).split(";")[0].trim()); push(); return r;
  });
  app.delete("/api/farm-profile/logo", { preHandler: admin }, async (req) => { const r = prof.deleteLogo(A(req)); push(); return r; });
  app.get("/api/farm-contacts", { preHandler: admin }, async () => prof.contacts());
  app.post("/api/farm-contacts", { preHandler: admin }, async (req) => prof.addContact(A(req), req.body));
  app.put<{ Params: { id: string } }>("/api/farm-contacts/:id", { preHandler: admin }, async (req) => prof.updateContact(A(req), Number(req.params.id), req.body));
  app.delete<{ Params: { id: string } }>("/api/farm-contacts/:id", { preHandler: admin }, async (req) => { prof.deleteContact(A(req), Number(req.params.id)); return { ok: true }; });
  app.get("/api/farm-contacts/alarm-view", async () => prof.alarmView());
}
