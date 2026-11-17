// REST API for RS-485 Ports and device assignment. ADMIN ONLY (every route has the admin guard): Operators never see ports, devices or addresses.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../gateway/registry.js";
import type { PortManager } from "./manager.js";
import { BAUDS, PORT_DEFAULTS } from "./validate.js";

export function registerPortRoutes(app: FastifyInstance, ports: PortManager, admin: any, push: () => void) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  const id = (req: any) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new HttpError(400, "bad id"); return n; };
  ports.on("update", push);

  app.get("/api/ports", { preHandler: admin }, async () => { await ports.refreshSerial(); return { ...ports.view(), bauds: BAUDS, defaults: PORT_DEFAULTS }; });
  app.get("/api/ports/available", { preHandler: admin }, async () => ({ devices: await ports.available() }));
  app.put<{ Params: { id: string }; Body: Record<string, any> }>("/api/ports/:id", { preHandler: admin }, async (req) => ports.applyPort(A(req), id(req), req.body ?? {}));
  app.post<{ Params: { id: string }; Body: Record<string, any> | undefined }>("/api/ports/:id/test", { preHandler: admin }, async (req) => ports.test(id(req), (req.body ?? undefined) as any));
  app.post<{ Params: { id: string } }>("/api/ports/:id/revert", { preHandler: admin }, async (req) => ports.revert(A(req), id(req)));
  app.post<{ Params: { id: string } }>("/api/ports/:id/keep", { preHandler: admin }, async (req) => { id(req); return ports.keep(A(req)); });
  app.get("/api/devices", { preHandler: admin }, async () => ports.view().devices);
  app.put<{ Params: { id: string }; Body: Record<string, any> }>("/api/devices/:id", { preHandler: admin }, async (req) => ports.applyDevice(A(req), id(req), req.body ?? {}));
}
