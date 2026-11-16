// Licence issuing tool -- TRIDENT LABS ONLY, run OFF the box. Never ship this folder or any private key in a CORE bundle, a box or this repo.
//   npm run licence -- keygen --key-id prod-1 --out /secure/offline/folder
//   npm run licence -- sign --key /secure/offline/prod-1.private.pem --key-id prod-1 --device FP-XXXX-XXXX-XXXX --licensed-to "Al Maimoon Farms" --type FULL --gateways 2 --sensors 50 [--valid-until 2027-11-16] [--features a,b] [--licence-id FPL-20261116-0001 | --seq 7] [--out file.fplic]
//   npm run licence -- verify file.fplic [--device FP-XXXX-XXXX-XXXX] [--public-key <base64 SPKI> | --public-key-file key.public.txt]     (default: the keys built into this CORE version)
// The file format is frozen: src/licence/format.ts + docs/licence-format.md.
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLicence, expiryMs, LicenceError, LICENCE_ID_RE, signLicence, type LicencePayload } from "../../src/licence/format.js";
import { DEVICE_ID_RE } from "../../src/licence/device.js";
import { LICENCE_PUBLIC_KEYS } from "../../src/licence/keys.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const inRepo = (p: string) => { const r = relative(REPO, resolve(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };      // different Windows drive: relative() returns an absolute path = outside
class Usage extends Error {}
function opts(argv: string[]) { const o: Record<string, string> = {}, rest: string[] = []; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Usage(`--${k} needs a value`); o[k] = v; i++; } else rest.push(argv[i]); } return { o, rest }; }
const need = (o: Record<string, string>, k: string) => { if (!o[k]) throw new Usage(`--${k} is required`); return o[k]; };
const int = (s: string, k: string) => { if (!/^\d+$/.test(s)) throw new Usage(`--${k} must be a whole number`); return Number(s); };

export function run(argv: string[], now = new Date(), log: (s: string) => void = console.log): number {
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
    const vu = o["valid-until"]; let valid_until: string | null = null; if (vu && vu !== "none") { valid_until = /^\d{4}-\d{2}-\d{2}$/.test(vu) ? vu + "T23:59:59Z" : vu; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(valid_until) || Number.isNaN(Date.parse(valid_until))) throw new Usage("--valid-until must be YYYY-MM-DD, a UTC time, or none"); }
    const p: LicencePayload = { licence_id: id, type: need(o, "type"), licensed_to: need(o, "licensed-to"), device_id: device, limits: { gateways: int(need(o, "gateways"), "gateways"), sensors: int(need(o, "sensors"), "sensors") }, features: o.features ? o.features.split(",").map((s) => s.trim()).filter(Boolean) : [], issued_at: now.toISOString().slice(0, 19) + "Z", valid_until, key_id: need(o, "key-id") };
    const text = signLicence(p, readFileSync(keyPath, "utf8")), out = resolve(o.out ?? `${p.licensed_to.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "licence"}-${device}.fplic`);
    // Prove the file before handing it out: it must verify against the matching public key and parse under the frozen rules.
    const pub = createPublicKey(readFileSync(keyPath, "utf8")); checkLicence(Buffer.from(text), { [p.key_id]: pub }, device); writeFileSync(out, text); log(`written ${out}\n${p.licence_id} ${p.type} for ${p.licensed_to}, ${device}, ${p.limits.gateways} gateway(s), ${p.limits.sensors} sensors, valid until ${p.valid_until ?? "no expiry"}`); return 0;
  }
  if (cmd === "verify") {
    const file = rest[0]; if (!file) throw new Usage("verify needs a file"); const buf = readFileSync(file);
    const pk = o["public-key"] ?? (o["public-key-file"] ? readFileSync(o["public-key-file"], "utf8").trim() : undefined);
    let keys: Record<string, string> = LICENCE_PUBLIC_KEYS; if (pk) { try { const j = JSON.parse(buf.toString("utf8")); keys = { [String(j.key_id)]: pk }; } catch { /* checkLicence reports it */ } }
    const device = o.device ?? (JSON.parse(buf.toString("utf8") || "{}").device_id ?? null);
    try { const f = checkLicence(buf, keys, device); const exp = expiryMs(f); log(`OK: ${f.licence_id} ${f.type} for ${f.licensed_to}\n  device ${f.device_id}${o.device ? " (matches)" : " (not checked against a box)"}\n  ${f.limits.gateways} gateway(s), ${f.limits.sensors} sensors, features [${f.features.join(", ")}]\n  issued ${f.issued_at}, ${exp === Infinity ? "no expiry" : (exp <= now.getTime() ? "EXPIRED " : "valid until ") + f.valid_until}, key ${f.key_id}`); return 0; }
    catch (e) { if (e instanceof LicenceError) { log(`${e.code}: ${e.message}`); return 1; } throw e; }
  }
  throw new Usage("commands: keygen | sign | verify (see the header of tools/licence-issue/index.ts)");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(run(process.argv.slice(2))); } catch (e) { console.error((e instanceof Usage ? "Usage: " : "Error: ") + String((e as Error).message)); process.exit(2); }
}
