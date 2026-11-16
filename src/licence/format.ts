// Licence file format v1 (FROZEN) and v2 (2026-11-17, see docs/licence-format.md). v2 adds format_version 2, limits reports_days and retention_days and null = unlimited; v1 files keep verifying unchanged. `.fplic` = UTF-8 JSON object, at most 16 KB, signed with Ed25519.
// Signed message = "farmpilot-licence-v1\n" + canonical JSON of the object WITHOUT `signature` (keys sorted at every level, no whitespace). `signature` = base64url, 64 bytes.
// The box only VERIFIES. `signLicence` exists for the issuing tool and the tests and needs a private key, which no box has.
import { createPublicKey, createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { DEVICE_ID_RE } from "./device.js";

export const MAX_LICENCE_BYTES = 16 * 1024;
export type LicenceErrorCode = "NOT_A_LICENCE" | "BAD_SIGNATURE" | "WRONG_DEVICE" | "EXPIRED" | "OLDER_LICENCE";
export class LicenceError extends Error { constructor(public code: LicenceErrorCode, message: string) { super(message); } }
/** v1: gateways and sensors (whole numbers). v2: all four, each a whole number or null (null = unlimited; retention_days null = never prune). */
export interface Limits { gateways: number | null; sensors: number | null; reports_days?: number | null; retention_days?: number | null; }
export interface LicencePayload { licence_id: string; type: string; licensed_to: string; device_id: string; limits: Limits; features: string[]; issued_at: string; valid_until: string | null; key_id: string; format_version?: 2; }
/** ENGINEERING: Trident machines only. v2, every limit null, no expiry. Shown as "ENGINEERING LICENCE". */
export const ENGINEERING = "ENGINEERING";
export interface LicenceFile extends LicencePayload { signature: string; }
export type KeyMap = Record<string, string | KeyObject>;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, FIELDS = ["licence_id", "type", "licensed_to", "device_id", "limits", "features", "issued_at", "valid_until", "key_id", "signature"], FIELDS_V2 = [...FIELDS, "format_version"];
export const LICENCE_ID_RE = /^FPL-\d{8}-\d{4}$/;            // fixed width, so "not older" is a plain string comparison
const isoMs = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) + "Z" === s ? t : NaN; };
export const expiryMs = (l: { valid_until: string | null }) => (l.valid_until === null ? Infinity : Date.parse(l.valid_until));

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const message = (p: LicencePayload) => Buffer.from(`farmpilot-licence-v${p.format_version === 2 ? 2 : 1}\n` + canonicalJson(p), "utf8");
const bad = (m: string) => new LicenceError("NOT_A_LICENCE", "This is not a Farm-Pilot CORE licence file: " + m);

/** Parses and checks the SHAPE only (no signature). Throws NOT_A_LICENCE. */
export function parseLicenceFile(buf: Buffer): LicenceFile {
  if (buf.length === 0) throw bad("the file is empty."); if (buf.length > MAX_LICENCE_BYTES) throw bad(`the file is larger than ${MAX_LICENCE_BYTES / 1024} KB.`);
  let j: any; try { j = JSON.parse(buf.toString("utf8")); } catch { throw bad("it is not readable text (JSON)."); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw bad("it is not a licence object.");
  if ("format_version" in j && j.format_version !== 2) throw bad('field "format_version" must be 2 (v1 files have none).');
  const v2 = j.format_version === 2, fields = v2 ? FIELDS_V2 : FIELDS;
  for (const k of Object.keys(j)) if (!fields.includes(k)) throw bad(`unknown field "${k.slice(0, 40)}".`);
  for (const k of fields) if (!(k in j)) throw bad(`field "${k}" is missing.`);
  const str = (k: string, re: RegExp, max = 200) => { if (typeof j[k] !== "string" || j[k].length > max || !re.test(j[k])) throw bad(`field "${k}" is not valid.`); };
  str("licence_id", LICENCE_ID_RE); str("type", /^[A-Z][A-Z0-9_]{1,15}$/); if (j.type === "FREE") throw bad("type FREE is built in and needs no file.");
  str("licensed_to", /^\S(?:.*\S)?$/, 120); str("device_id", DEVICE_ID_RE); str("key_id", /^[a-z0-9-]{1,32}$/); str("signature", /^[A-Za-z0-9_-]{86}$/, 86);
  if (typeof j.issued_at !== "string" || Number.isNaN(isoMs(j.issued_at))) throw bad('field "issued_at" must be a UTC time like 2026-11-16T10:00:00Z.');
  if (j.valid_until !== null && (typeof j.valid_until !== "string" || Number.isNaN(isoMs(j.valid_until)))) throw bad('field "valid_until" must be null or a UTC time like 2027-11-16T23:59:59Z.');
  const l = j.limits; const want = v2 ? "gateways,reports_days,retention_days,sensors" : "gateways,sensors";
  if (!l || typeof l !== "object" || Array.isArray(l) || Object.keys(l).sort().join() !== want) throw bad(v2 ? 'field "limits" needs exactly gateways, sensors, reports_days and retention_days.' : 'field "limits" needs exactly gateways and sensors.');
  for (const [k, lo, max] of [["gateways", 0, 1000], ["sensors", 0, 100000], ["reports_days", 1, 3650], ["retention_days", 1, 3650]] as const) {
    if (!(k in l)) continue; if (v2 && l[k] === null) continue;                                              // v2: null = unlimited
    if (!Number.isInteger(l[k]) || l[k] < lo || l[k] > max) throw bad(`limit "${k}" must be a whole number from ${lo} to ${max}${v2 ? " or null (unlimited)" : ""}.`);
  }
  if (j.type === ENGINEERING) { if (!v2 || Object.values(l).some((x) => x !== null) || j.valid_until !== null) throw bad("an ENGINEERING licence is format 2 with every limit null and no expiry."); }
  if (!Array.isArray(j.features) || j.features.length > 50 || j.features.some((f: unknown) => typeof f !== "string" || !/^[a-z0-9_]{1,40}$/.test(f))) throw bad('field "features" must be a list of short lower-case names.');
  return j as LicenceFile;
}
const toKey = (k: string | KeyObject) => (typeof k === "string" ? createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }) : k);
/** Checks the signature with the key named by key_id. Throws BAD_SIGNATURE (also for an unknown key_id). */
export function verifySignature(f: LicenceFile, keys: KeyMap) {
  const k = Object.prototype.hasOwnProperty.call(keys, f.key_id) ? keys[f.key_id] : undefined; if (!k) throw new LicenceError("BAD_SIGNATURE", "This licence was signed with a key this box does not know. Ask Trident Labs for a licence for this version.");
  const { signature, ...payload } = f; let ok = false; try { ok = verify(null, message(payload), toKey(k), Buffer.from(signature, "base64url")); } catch { ok = false; }
  if (!ok) throw new LicenceError("BAD_SIGNATURE", "The licence file is damaged or has been changed (the signature does not match).");
}
/** Full check for one file: shape, signature, device. Expiry is the caller's business (an expired licence is still a valid file, shown as EXPIRED). */
export function checkLicence(buf: Buffer, keys: KeyMap, deviceId: string | null): LicenceFile {
  const f = parseLicenceFile(buf); verifySignature(f, keys);
  if (!deviceId) throw new LicenceError("WRONG_DEVICE", "This box has no machine id, so no licence can be bound to it. Contact Trident Labs.");
  if (f.device_id !== deviceId) throw new LicenceError("WRONG_DEVICE", `This licence is for another box (${f.device_id}). This box is ${deviceId}.`);
  return f;
}
/** Issuing side: signs `payload` with an Ed25519 PRIVATE key (PEM or KeyObject). Returns the file text. */
export function signLicence(payload: LicencePayload, privateKey: string | KeyObject): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const file: LicenceFile = { ...payload, signature: sign(null, message(payload), key).toString("base64url") };
  return JSON.stringify(file, null, 2) + "\n";
}
