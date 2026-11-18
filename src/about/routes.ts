// About page API. GET /api/about answers every role; the Device ID and the host details are Admin only (an Operator never receives them).
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { config } from "../config.js";
import type { ProfileService } from "../gateway/profile.js";
import { thisDeviceId } from "../licence/device.js";
import { freeSummary, type LicenceSummary } from "../licence/summary.js";
import { loadBranding, type Branding } from "./branding.js";
import { readBuild } from "./build.js";
import { computerInfo, listSerialNames } from "./host.js";

export interface AboutDeps { db: Db; admin: any; prof: ProfileService; licence?: () => LicenceSummary; deviceId?: () => string | null; branding?: Branding; serialPorts?: () => Promise<string[]>; serverLink?: () => unknown; }

export function registerAboutRoutes(app: FastifyInstance, d: AboutDeps) {
  const branding = d.branding ?? loadBranding(), licence = d.licence ?? (() => freeSummary(d.db)), deviceId = d.deviceId ?? (() => thisDeviceId());
  const computer = () => computerInfo(d.db, { dataDir: config.dataDir, dbPath: config.dbPath, timezone: d.prof.publicInfo().timezone }, { serialPorts: d.serialPorts ?? (() => listSerialNames()) });
  app.get("/api/about", async (req) => {
    const b = readBuild(), isAdmin = (req as any).user?.role === "admin";
    const base = { product: branding.product_name, tagline: branding.tagline, credit_line: branding.credit_line, support_contact: branding.support_contact, version: b.version, build: b.build, released: b.released, label: b.label, licence: isAdmin ? licence() : { ...licence(), grace: undefined }, uptime_s: Math.round(process.uptime()) };
    return isAdmin ? { ...base, device_id: deviceId(), computer: await computer(), ...(d.serverLink ? { server_link: d.serverLink() } : {}) } : base;      // 2026-11-19: server_link is Admin only; for an Operator the field does not exist
  });
  app.get("/api/about/computer", { preHandler: d.admin }, async () => computer());
}
