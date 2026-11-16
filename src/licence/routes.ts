// Licence upload and removal. ADMIN ONLY (an Operator gets 403 before the body is looked at). Every success and every refusal is written to the audit log by the service.
import type { FastifyInstance } from "fastify";
import { multipartFile } from "./multipart.js";
import type { LicenceService } from "./service.js";

export function registerLicenceRoutes(app: FastifyInstance, lic: LicenceService, admin: any, push: () => void) {
  // Raw buffers for the upload (multipart/form-data from the page, or a plain file body from curl). The global limit is 64 KB; this route allows 40 KB (16 KB file + form overhead).
  app.addContentTypeParser(["multipart/form-data", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 40 * 1024 }, (_req, body, done) => done(null, body));
  app.post("/api/licence", { preHandler: admin, bodyLimit: 40 * 1024 }, async (req) => {
    const ct = String(req.headers["content-type"] ?? ""); let file: Buffer | null = null;
    if (Buffer.isBuffer(req.body)) file = /^multipart\/form-data/i.test(ct) ? multipartFile(ct, req.body, "file") : req.body;
    else if (req.body && typeof req.body === "object") file = Buffer.from(JSON.stringify(req.body));            // application/json body = the licence object itself
    const r = lic.install({ username: (req as any).user.username, role: "admin" }, file ?? Buffer.alloc(0)); push(); return r;       // no file / too large / not JSON: install() refuses with NOT_A_LICENCE and audits it
  });
  app.delete("/api/licence", { preHandler: admin }, async (req) => { const r = lic.remove({ username: (req as any).user.username, role: "admin" }); push(); return r; });
}
