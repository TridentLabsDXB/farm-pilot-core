// REST API for Data sources > PLC. ADMIN ONLY on every route, reads included (Operators never see addresses or raw values: they get 403). Writes, READ ZONE NOW and TEST are refused with 403 on FREE (tier message).
import type { FastifyInstance } from "fastify";
import { HttpError } from "../gateway/registry.js";
import type { PlcService } from "./service.js";

export function registerPlcRoutes(app: FastifyInstance, svc: PlcService, admin: any) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, "bad id"); return n; };
  app.get("/api/plc", { preHandler: admin }, async () => svc.view());
  app.put<{ Body: Record<string, unknown> }>("/api/plc/config", { preHandler: admin }, async (req) => svc.saveConfig(A(req), req.body ?? {}));
  app.post<{ Body: { enabled?: unknown } }>("/api/plc/enabled", { preHandler: admin }, async (req) => svc.setEnabled(A(req), req.body?.enabled));
  app.post("/api/plc/test", { preHandler: admin }, async (req) => svc.test(A(req)));
  app.post<{ Body: Record<string, unknown> }>("/api/plc/zones", { preHandler: admin }, async (req) => svc.saveZone(A(req), null, req.body ?? {}));
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/plc/zones/:id", { preHandler: admin }, async (req) => svc.saveZone(A(req), num(req.params.id), req.body ?? {}));
  app.delete<{ Params: { id: string } }>("/api/plc/zones/:id", { preHandler: admin }, async (req) => svc.deleteZone(A(req), num(req.params.id)));
  app.post<{ Params: { id: string } }>("/api/plc/zones/:id/read", { preHandler: admin }, async (req) => svc.readNow(A(req), num(req.params.id)));
}
