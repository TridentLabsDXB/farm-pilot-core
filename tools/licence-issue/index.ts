// Licence issuing tool -- TRIDENT LABS ONLY, run OFF the box. Never ship this folder or any private key in a CORE bundle, a box or this repo.
//   npm run licence -- keygen --key-id prod-1 --out /secure/offline/folder
//   npm run licence -- sign --key /secure/offline/prod-1.private.pem --key-id prod-1 --device FP-XXXX-XXXX-XXXX --licensed-to "Al Maimoon Farms" --type FULL --gateways 2 --sensors 50 [--valid-until 2027-11-16] [--features a,b] [--licence-id FPL-20261116-0001 | --seq 7] [--out file.fplic]
//   npm run licence -- verify file.fplic [--device FP-XXXX-XXXX-XXXX] [--public-key <base64 SPKI> | --public-key-file key.public.txt]     (default: the keys built into this CORE version)
//   npm run licence -- batch --csv devices.csv --type PRO --key /secure/offline/prod-1.private.pem --key-id prod-1 --out ./licences/ [--zip] [--seq 1] [--gateways N --sensors N --reports-days N --retention-days N]
//       (also accepted: `-- --batch devices.csv ...`). CSV columns: device_id, licensed_to, valid_until (blank = no expiry), optional gateways, sensors, reports_days, retention_days (blank = the command line / type default, "unlimited" = null).
// New licences are FORMAT 2 (limits gateways, sensors, reports_days, retention_days; null = unlimited / never prune). Type ENGINEERING = Trident machines only: every limit null, no expiry; it takes no limit options.
// Formats: src/licence/format.ts + docs/licence-format.md (v1 frozen, v2 added 2026-11-17). The private key is read from its file; it is never printed or logged.
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLicence, ENGINEERING, expiryMs, LicenceError, LICENCE_ID_RE, signLicence, type LicencePayload } from "../../src/licence/format.js";
import { makeZip } from "../../src/about/zip.js";
import { DEVICE_ID_RE } from "../../src/licence/device.js";
import { LICENCE_PUBLIC_KEYS } from "../../src/licence/keys.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const inRepo = (p: string) => { const r = relative(REPO, resolve(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };      // different Windows drive: relative() returns an absolute path = outside
class Usage extends Error {}
function opts(argv: string[]) { const o: Record<string, string> = {}, rest: string[] = []; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Usage(`--${k} needs a value`); o[k] = v; i++; } else rest.push(argv[i]); } return { o, rest }; }
const need = (o: Record<string, string>, k: string) => { if (!o[k]) throw new Usage(`--${k} is required`); return o[k]; };
const int = (s: string, k: string) => { if (!/^\d+$/.test(s)) throw new Usage(`--${k} must be a whole number`); return Number(s); };
/** A limit: a whole number, or "unlimited" (also "null") for null. */
const lim = (s: string, k: string): number | null => (/^(unlimited|null)$/i.test(s.trim()) ? null : int(s.trim(), k));
const slugName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "licence";
const DEFAULT_DAYS = 365;             // PRO reports_days and retention_days unless given

interface Row { device: string; licensedTo: string; validUntil: string | null; gateways?: string; sensors?: string; reports?: string; retention?: string; }
/** One licence payload (format 2). ENGINEERING: all limits null, no expiry, no limit options. Other types need gateways and sensors (number or unlimited); reports and retention default to 365 days. */
function payloadFor(type: string, r: Row, id: string, keyId: string, now: Date): LicencePayload {
  if (!DEVICE_ID_RE.test(r.device)) throw new Usage(`Device ID "${r.device}" must look like FP-XXXX-XXXX-XXXX (copy it from the About page)`);
  if (!r.licensedTo || r.licensedTo.length > 120 || r.licensedTo !== r.licensedTo.trim()) throw new Usage(`licensed_to for ${r.device} must be 1 to 120 characters without leading or trailing spaces`);
  let valid_until: string | null = null; const vu = r.validUntil; if (vu && vu !== "none") { valid_until = /^\d{4}-\d{2}-\d{2}$/.test(vu) ? vu + "T23:59:59Z" : vu; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(valid_until) || Number.isNaN(Date.parse(valid_until))) throw new Usage(`valid_until (--valid-until) for ${r.device} must be YYYY-MM-DD, a UTC time, or blank`); }
  let limits: LicencePayload["limits"];
  if (type === ENGINEERING) {
    if (r.gateways || r.sensors || r.reports || r.retention) throw new Usage("ENGINEERING takes no limits: every limit is unlimited"); if (valid_until) throw new Usage("ENGINEERING has no expiry: leave valid_until blank");
    limits = { gateways: null, sensors: null, reports_days: null, retention_days: null };
  } else {
    if (r.gateways === undefined || r.gateways === "" || r.sensors === undefined || r.sensors === "") throw new Usage(`gateways and sensors are required for ${r.device} (CSV columns or --gateways / --sensors; "unlimited" is allowed)`);
    limits = { gateways: lim(r.gateways, "gateways"), sensors: lim(r.sensors, "sensors"), reports_days: r.reports ? lim(r.reports, "reports-days") : DEFAULT_DAYS, retention_days: r.retention ? lim(r.retention, "retention-days") : DEFAULT_DAYS };
  }
  return { format_version: 2, licence_id: id, type, licensed_to: r.licensedTo, device_id: r.device, limits, features: [], issued_at: now.toISOString().slice(0, 19) + "Z", valid_until, key_id: keyId };
}
/** Signs and PROVES the file (verifies it against the matching public key under the box rules) before anything is written. */
function issue(p: LicencePayload, keyText: string): string { const text = signLicence(p, keyText); checkLicence(Buffer.from(text), { [p.key_id]: createPublicKey(keyText) }, p.device_id); return text; }
const fmtLim = (n: number | null | undefined) => (n === null ? "unlimited" : n === undefined ? "-" : String(n));
/** RFC 4180 reader for the batch CSV: quotes, doubled quotes, commas and line breaks inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false; const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === "") q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; } else cell += c; }
  if (q) throw new Usage("the CSV has an opening quote that is never closed"); row.push(cell); if (row.some((x) => x.trim() !== "")) rows.push(row); return rows;
}

export function run(argv: string[], now = new Date(), log: (s: string) => void = console.log): number {
  let zipFlag = false; argv = argv.filter((x) => (x === "--zip" ? ((zipFlag = true), false) : true));
  if (argv[0] === "--batch" || argv.includes("--batch")) { const i = argv.indexOf("--batch"); argv = ["batch", ...argv.slice(0, i), "--csv", argv[i + 1] ?? "", ...argv.slice(i + 2)]; }
  const [cmd, ...args] = argv; const { o, rest } = opts(args);
  if (cmd === "keygen") {
    const out = resolve(need(o, "out")), id = need(o, "key-id"); if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Usage("--key-id: lower-case letters, digits and - only");
    if (inRepo(out)) throw new Usage("refusing to write a private key inside the repository. Choose an offline folder outside it.");
    mkdirSync(out, { recursive: true, mode: 0o700 }); const priv = join(out, `${id}.private.pem`); if (existsSync(priv)) throw new Usage(`${priv} already exists, refusing to overwrite a key`);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); writeFileSync(join(out, `${id}.public.txt`), spki + "\n");
    log(`private key: ${priv}  (keep offline, back it up, never commit it)\npublic key line for src/licence/keys.ts:\n  "${id}": "${spki}",`); return 0;
  }
  if (cmd === "sign") {
    const keyPath = resolve(need(o, "key")); if (inRepo(keyPath)) throw new Usage("refusing to read a private key from inside the repository.");
    const device = need(o, "device"); if (!DEVICE_ID_RE.test(device)) throw new Usage("--device must look like FP-XXXX-XXXX-XXXX (copy it from the About page)");
    const date = now.toISOString().slice(0, 10).replaceAll("-", ""), id = o["licence-id"] ?? `FPL-${date}-${String(o.seq ? int(o.seq, "seq") : 1).padStart(4, "0")}`; if (!LICENCE_ID_RE.test(id)) throw new Usage("--licence-id must look like FPL-YYYYMMDD-NNNN");
    const type = need(o, "type"), vu = o["valid-until"];
    const row: Row = { device, licensedTo: need(o, "licensed-to"), validUntil: vu === undefined ? null : vu, gateways: o.gateways, sensors: o.sensors, reports: o["reports-days"], retention: o["retention-days"] };
    if (type !== ENGINEERING) { need(o, "gateways"); need(o, "sensors"); }
    const p = payloadFor(type, row, id, need(o, "key-id"), now); if (o.features) p.features = o.features.split(",").map((x) => x.trim()).filter(Boolean);
    const text = issue(p, readFileSync(keyPath, "utf8")), out = resolve(o.out ?? `${slugName(p.licensed_to)}-${device}.fplic`);
    writeFileSync(out, text); log(`written ${out}\n${p.licence_id} ${p.type} for ${p.licensed_to}, ${device}, gateways ${fmtLim(p.limits.gateways)}, sensors ${fmtLim(p.limits.sensors)}, reports ${fmtLim(p.limits.reports_days)} d, history kept ${fmtLim(p.limits.retention_days)} d, valid until ${p.valid_until ?? "no expiry"}`); return 0;
  }
  if (cmd === "batch") {
    const keyPath = resolve(need(o, "key")); if (inRepo(keyPath)) throw new Usage("refusing to read a private key from inside the repository.");
    const csvPath = resolve(o.csv ?? o.batch ?? need(o, "csv")), type = need(o, "type"), keyId = need(o, "key-id"), outDir = resolve(need(o, "out"));
    const table = parseCsv(readFileSync(csvPath, "utf8")); if (table.length < 2) throw new Usage("the CSV needs a header row and at least one device");
    const head = table[0].map((h) => h.trim().toLowerCase()), known = ["device_id", "licensed_to", "valid_until", "gateways", "sensors", "reports_days", "retention_days"];
    for (const h of head) if (!known.includes(h)) throw new Usage(`unknown CSV column "${h}" (allowed: ${known.join(", ")})`);
    for (const h of ["device_id", "licensed_to", "valid_until"]) if (!head.includes(h)) throw new Usage(`the CSV needs the column "${h}"`);
    if (new Set(head).size !== head.length) throw new Usage("a CSV column appears twice");
    const col = (r: string[], n: string) => { const i = head.indexOf(n); return i < 0 ? undefined : (r[i] ?? "").trim(); };
    const seen = new Map<string, number>(), date = now.toISOString().slice(0, 10).replaceAll("-", ""); let seq = o.seq ? int(o.seq, "seq") : 1; const issued: { file: string; text: string; p: LicencePayload }[] = [];
    const keyText = readFileSync(keyPath, "utf8");
    table.slice(1).forEach((r, i) => { const line = i + 2; if (r.length > head.length) throw new Usage(`CSV line ${line}: more cells than columns`);
      const dev = (col(r, "device_id") ?? "").toUpperCase(); if (!DEVICE_ID_RE.test(dev)) throw new Usage(`CSV line ${line}: Device ID "${col(r, "device_id")}" must look like FP-XXXX-XXXX-XXXX`);
      if (seen.has(dev)) throw new Usage(`CSV line ${line}: Device ID ${dev} is a duplicate of line ${seen.get(dev)}`); seen.set(dev, line);
      if (seq > 9999) throw new Usage("more than 9999 licences in one day"); const id = `FPL-${date}-${String(seq++).padStart(4, "0")}`;
      const row: Row = { device: dev, licensedTo: (col(r, "licensed_to") ?? ""), validUntil: col(r, "valid_until") || null, gateways: col(r, "gateways") || o.gateways, sensors: col(r, "sensors") || o.sensors, reports: col(r, "reports_days") || o["reports-days"], retention: col(r, "retention_days") || o["retention-days"] };
      let p: LicencePayload; try { p = payloadFor(type, row, id, keyId, now); } catch (e) { if (e instanceof Usage) throw new Usage(`CSV line ${line}: ${e.message}`); throw e; }
      if (p.valid_until && Date.parse(p.valid_until) <= now.getTime()) throw new Usage(`CSV line ${line}: valid_until ${p.valid_until} is already in the past`);
      issued.push({ file: `${slugName(p.licensed_to)}-${dev}.fplic`, text: issue(p, keyText), p }); });
    const names = issued.map((x) => x.file); if (new Set(names).size !== names.length) throw new Usage("two rows would write the same file name");
    mkdirSync(outDir, { recursive: true }); for (const x of issued) if (existsSync(join(outDir, x.file))) throw new Usage(`${join(outDir, x.file)} already exists, refusing to overwrite a licence`);
    for (const x of issued) writeFileSync(join(outDir, x.file), x.text);                // everything above validated and signed first: a bad row writes nothing
    let zipName = ""; if (zipFlag) { zipName = join(outDir, `licences-${date}-${type.toLowerCase()}.zip`); if (existsSync(zipName)) throw new Usage(`${zipName} already exists`); writeFileSync(zipName, makeZip(issued.map((x) => ({ name: x.file, data: x.text })))); }
    const cols = ["file", "licence_id", "device_id", "licensed_to", "type", "gateways", "sensors", "reports_d", "kept_d", "valid_until"];
    const lines = issued.map((x) => [x.file, x.p.licence_id, x.p.device_id, x.p.licensed_to, x.p.type, fmtLim(x.p.limits.gateways), fmtLim(x.p.limits.sensors), fmtLim(x.p.limits.reports_days), fmtLim(x.p.limits.retention_days), x.p.valid_until ?? "no expiry"]);
    const w = cols.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i].length))); const fmt = (l: string[]) => l.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
    log([`issued ${issued.length} licence(s) with key ${keyId} into ${outDir}`, fmt(cols), fmt(w.map((n) => "-".repeat(n))), ...lines.map(fmt), ...(zipName ? [`zip: ${zipName}`] : [])].join("\n")); return 0;
  }
  if (cmd === "verify") {
    const file = rest[0]; if (!file) throw new Usage("verify needs a file"); const buf = readFileSync(file);
    const pk = o["public-key"] ?? (o["public-key-file"] ? readFileSync(o["public-key-file"], "utf8").trim() : undefined);
    let keys: Record<string, string> = LICENCE_PUBLIC_KEYS; if (pk) { try { const j = JSON.parse(buf.toString("utf8")); keys = { [String(j.key_id)]: pk }; } catch { /* checkLicence reports it */ } }
    const device = o.device ?? (JSON.parse(buf.toString("utf8") || "{}").device_id ?? null);
    try { const f = checkLicence(buf, keys, device); const exp = expiryMs(f); log(`OK: ${f.licence_id} ${f.type} for ${f.licensed_to}\n  device ${f.device_id}${o.device ? " (matches)" : " (not checked against a box)"}\n  gateways ${fmtLim(f.limits.gateways)}, sensors ${fmtLim(f.limits.sensors)}${f.format_version === 2 ? `, reports ${fmtLim(f.limits.reports_days)} d, history kept ${fmtLim(f.limits.retention_days)} d` : " (format 1)"}, features [${f.features.join(", ")}]\n  issued ${f.issued_at}, ${exp === Infinity ? "no expiry" : (exp <= now.getTime() ? "EXPIRED " : "valid until ") + f.valid_until}, key ${f.key_id}`); return 0; }
    catch (e) { if (e instanceof LicenceError) { log(`${e.code}: ${e.message}`); return 1; } throw e; }
  }
  throw new Usage("commands: keygen | sign | batch | verify (see the header of tools/licence-issue/index.ts)");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error((e instanceof Usage ? "Usage: " : "Error: ") + String((e as Error).message)); process.exit(2); }
}
