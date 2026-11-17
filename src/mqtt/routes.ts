// REST API for Data sources > MQTT Payload. READ (GET /api/mqtt) is open to every logged-in user (owner decision 2026-11-18: Operators can read the page); every WRITE and TEST is Admin only. The password is never in any response.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../gateway/registry.js";
import type { MqttSourceService } from "./service.js";

export function registerMqttRoutes(app: FastifyInstance, svc: MqttSourceService, admin: any) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, "bad id"); return n; };
  const dev = (v: string) => { if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(v)) throw new HttpError(400, "bad device id"); return v; };
  app.get("/api/mqtt", async () => svc.view());        // read: every logged-in user (Operators too); the view never holds the password
  app.put<{ Body: Record<string, unknown> }>("/api/mqtt/config", { preHandler: admin }, async (req) => svc.saveConfig(A(req), req.body ?? {}));
  app.post<{ Body: { enabled?: unknown } }>("/api/mqtt/enabled", { preHandler: admin }, async (req) => svc.setEnabled(A(req), req.body?.enabled));
  app.post<{ Body: Record<string, unknown> }>("/api/mqtt/test", { preHandler: admin }, async (req) => svc.test(req.body ?? {}));
  app.post<{ Body: { filter?: unknown; qos?: unknown } }>("/api/mqtt/topics", { preHandler: admin }, async (req) => svc.addTopic(A(req), req.body?.filter, req.body?.qos));
  app.delete<{ Params: { id: string } }>("/api/mqtt/topics/:id", { preHandler: admin }, async (req) => svc.removeTopic(A(req), num(req.params.id)));
  app.put<{ Body: { id_path?: unknown; ts_path?: unknown; rules?: unknown } }>("/api/mqtt/mapping", { preHandler: admin }, async (req) => svc.saveMapping(A(req), req.body?.id_path, req.body?.ts_path, req.body?.rules));
  app.post<{ Params: { id: string }; Body: { label?: unknown } }>("/api/mqtt/devices/:id/add", { preHandler: admin }, async (req) => svc.setDevice(A(req), dev(req.params.id), "add", req.body?.label));
  app.post<{ Params: { id: string } }>("/api/mqtt/devices/:id/ignore", { preHandler: admin }, async (req) => svc.setDevice(A(req), dev(req.params.id), "ignore"));
}
