// REST API for CONTROL DEVICES > Ashining A100. ADMIN ONLY on every route of the page (Operators get 403 and never see ports, addresses or radio settings).
// The one exception is POST /api/control/a100/:id/command: Operators and Admin command devices from the CONTROL page, as they do for the pump.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../gateway/registry.js";
import type { A100Service } from "./service.js";

export function registerA100Routes(app: FastifyInstance, svc: A100Service, admin: any) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, "bad id"); return n; };
  const body = (req: any) => (req.body ?? {}) as Record<string, unknown>;
  app.get("/api/a100", { preHandler: admin }, async () => svc.view());
  app.put("/api/a100/link", { preHandler: admin }, async (req) => svc.setLink(A(req), body(req)));
  app.post("/api/a100/read", { preHandler: admin }, async (req) => svc.readFromUnit(A(req)));
  app.post("/api/a100/test", { preHandler: admin }, async (req) => svc.testLink(A(req)));
  app.post("/api/a100/write", { preHandler: admin }, async (req) => svc.writeToUnit(A(req), body(req)));
  app.post("/api/a100/revert", { preHandler: admin }, async (req) => svc.revert(A(req), body(req)));
  app.post("/api/a100/key", { preHandler: admin }, async (req) => svc.setKey(A(req), body(req)));
  app.post("/api/a100/reset", { preHandler: admin }, async (req) => svc.resetUnit(A(req), body(req)));
  app.post("/api/a100/devices", { preHandler: admin }, async (req) => svc.saveDevice(A(req), null, body(req)));
  app.put<{ Params: { id: string } }>("/api/a100/devices/:id", { preHandler: admin }, async (req) => svc.saveDevice(A(req), num(req.params.id), body(req)));
  app.delete<{ Params: { id: string } }>("/api/a100/devices/:id", { preHandler: admin }, async (req) => svc.deleteDevice(A(req), num(req.params.id)));
  app.post<{ Params: { id: string } }>("/api/control/a100/:id/command", async (req) => { const c = body(req).command; if (typeof c !== "string") throw new HttpError(400, "command is required"); return svc.command(A(req), num(req.params.id), c); });
}
