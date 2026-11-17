// 2026-11-18 -- DOWNLOAD .FPLIC on the Licence Management page (owner decision, core-licence-file-download.md): the Online server signs a licence file with the DEV-1 key ONLY.
// The production private key never goes on this server. Rules enforced here, not in the page:
//   * the key is a server secret read from the file named by FP_LICENCE_SIGNING_KEY_FILE (outside the repo and the container image); its text is never logged, never returned by any API, never put in an error message;
//   * only dev-1 signs: the key id written into the file is the constant DEV_KEY_ID, and the configured key is accepted only when its PUBLIC half equals the built-in dev-1 public key (DEV_KEYS["dev-1"]).
//     A key that matches a production key, or any other key, is refused whatever its file is called;
//   * every file is verified with the box's OWN verifier (checkLicence, the dev-1 public key, the deployment's Device ID) before it is offered; a failure offers nothing;
//   * not for FREE (no file), not for FULL (the box does not know FULL yet), ENGINEERING only without an expiry (the signed format requires it), and a release build never signs (it does not trust dev-1).
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readBuild } from "../about/build.js";
import { checkLicence, ENGINEERING, LicenceError, signLicence, type LicencePayload } from "../licence/format.js";
import { DEV_KEYS, PROD_KEYS } from "../licence/keys.js";

export const DEV_KEY_ID = "dev-1";
export const KEY_ENV = "FP_LICENCE_SIGNING_KEY_FILE";
export interface SigningOpts { keyFile?: string | null; devKeys?: Record<string, string>; prodKeys?: Record<string, string>; release?: boolean; }
export type FplicCode = "OK" | "FREE" | "FULL" | "NO_KEY" | "ENGINEERING_EXPIRY" | "NO_LICENSED_TO" | "RELEASE_BUILD" | "NO_LICENCE";
export interface FplicState { available: boolean; code: FplicCode; reason: string | null; }

const spki = (k: KeyObject) => (k.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
let cache: { file: string; mtime: number; key: KeyObject | null; pub: string } | null = null;
/** The configured private key as a KeyObject, or null when it is not configured / unreadable / not an Ed25519 key. Cached by file and mtime. Nothing about the key content ever leaves this function. */
function loadKey(file: string | null | undefined): { key: KeyObject; pub: string } | null {
  if (!file) return null;
  try {
    const m = statSync(file).mtimeMs; if (cache && cache.file === file && cache.mtime === m) return cache.key ? { key: cache.key, pub: cache.pub } : null;
    let key: KeyObject | null = null, pub = ""; try { const k = createPrivateKey(readFileSync(file, "utf8")); if (k.asymmetricKeyType === "ed25519") { key = k; pub = spki(createPublicKey(k)); } } catch { key = null; }
    cache = { file, mtime: m, key, pub }; return key ? { key, pub } : null;
  } catch { return null; }
}
/** The key to sign with, or a reason. dev-1 only. */
function signingKey(o: SigningOpts): { key: KeyObject } | { code: "NO_KEY" | "RELEASE_BUILD"; reason: string } {
  const NO = { code: "NO_KEY" as const, reason: "No signing key on this server" };
  if (o.release ?? readBuild().release) return { code: "RELEASE_BUILD", reason: "This is a release build: it does not trust the dev-1 key, so it cannot sign with it" };
  const k = loadKey(o.keyFile); if (!k) return NO;
  const prod = Object.values(o.prodKeys ?? PROD_KEYS); if (prod.includes(k.pub)) return NO;               // a production key is never accepted here
  const dev = (o.devKeys ?? DEV_KEYS)[DEV_KEY_ID]; if (!dev || dev !== k.pub) return NO;                   // only the dev-1 key pair
  return { key: k.key };
}

interface DepLike { type: string; licence_id: string | null; licensed_to: string | null; valid_until: string | null; }
/** Whether DOWNLOAD .FPLIC is on for a deployment, and the reason when it is off. */
export function fplicState(d: DepLike, o: SigningOpts): FplicState {
  const off = (code: FplicCode, reason: string): FplicState => ({ available: false, code, reason });
  if (d.type === "FREE") return off("FREE", "FREE has no licence file");
  if (d.type === "FULL") return off("FULL", "The box does not accept FULL yet");
  if (d.type === ENGINEERING && d.valid_until) return off("ENGINEERING_EXPIRY", "The signed ENGINEERING format has no expiry. Clear the expiry to download");
  if (!d.licence_id) return off("NO_LICENCE", "This deployment has no licence ID");
  if (!d.licensed_to) return off("NO_LICENSED_TO", "Licensed to is empty: add it in Edit deployment");
  const k = signingKey(o); if ("code" in k) return off(k.code, k.reason);
  return { available: true, code: "OK", reason: null };
}

export class FplicError extends Error { constructor(public code: FplicCode | "VERIFY_FAILED", message: string, public status = 409) { super(message); } }
interface SignInput extends DepLike { device_id: string; issued_at: string | null; limits: { gateways: number | null; sensors: number | null; reports_days: number | null; retention_days: number | null }; }
/** Builds the payload exactly as the box's verifier expects (format 2), signs it with dev-1, verifies it with the box's own checkLicence, and only then returns the text. */
export function signDeploymentLicence(d: SignInput, o: SigningOpts): { text: string; fileName: string } {
  const st = fplicState(d, o); if (!st.available) throw new FplicError(st.code, st.reason!);
  const k = signingKey(o); if ("code" in k) throw new FplicError(k.code, k.reason);
  const payload: LicencePayload = { format_version: 2, licence_id: d.licence_id!, type: d.type, licensed_to: d.licensed_to!, device_id: d.device_id, limits: d.limits, features: [], issued_at: d.issued_at!, valid_until: d.valid_until, key_id: DEV_KEY_ID };
  try {
    const text = signLicence(payload, k.key);
    checkLicence(Buffer.from(text, "utf8"), { [DEV_KEY_ID]: (o.devKeys ?? DEV_KEYS)[DEV_KEY_ID] }, d.device_id);          // the same verifier the box runs
    return { text, fileName: `${d.licence_id}.fplic` };
  } catch (e) {
    throw new FplicError("VERIFY_FAILED", e instanceof LicenceError ? `The signed file did not pass the box's own check: ${e.message}` : "The licence file could not be signed", 500);   // never e.message of a crypto error: keep key material out of every message
  }
}
