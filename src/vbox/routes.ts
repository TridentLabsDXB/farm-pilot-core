// REST API for Data sources > V-BOX. ADMIN ONLY on every route (Operators do not see DATA SOURCES: 403). Writes are refused with 403 on FREE (tier message); stored data stays readable.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../gateway/registry.js";
import type { VboxSource } from "./service.js";

export function registerVboxRoutes(app: FastifyInstance, svc: VboxSource, admin: any) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const id = (v: string) => { if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(v)) throw new HttpError(400, "bad V-BOX id"); return v; };
  app.get("/api/vbox", { preHandler: admin }, async () => svc.view());
  app.put<{ Body: Record<string, unknown> }>("/api/vbox/preset", { preHandler: admin }, async (req) => svc.savePreset(A(req), req.body ?? {}));
  app.post<{ Body: { enabled?: unknown } }>("/api/vbox/enabled", { preHandler: admin }, async (req) => svc.setEnabled(A(req), req.body?.enabled));
  app.post<{ Params: { id: string } }>("/api/vbox/units/:id/add", { preHandler: admin }, async (req) => svc.setUnit(A(req), id(req.params.id), "add"));
  app.post<{ Params: { id: string } }>("/api/vbox/units/:id/ignore", { preHandler: admin }, async (req) => svc.setUnit(A(req), id(req.params.id), "ignore"));
  app.delete<{ Params: { id: string } }>("/api/vbox/units/:id", { preHandler: admin }, async (req) => svc.setUnit(A(req), id(req.params.id), "remove"));
  app.put<{ Body: { tags?: unknown; ts_path?: unknown } }>("/api/vbox/tags", { preHandler: admin }, async (req) => svc.saveTags(A(req), req.body?.tags, req.body?.ts_path));
}
