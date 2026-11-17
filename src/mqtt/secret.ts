// Encrypts the broker password at rest (AES-256-GCM). The key comes from MQTT_SECRET_KEY (64 hex characters) or from <DATA_DIR>/mqtt-secret.key,
// created once with mode 600. The password is NEVER returned by the API; the key file is not part of the JSON backup (restore on a new box = enter the password again).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

let key: Buffer | null = null;
function loadKey(): Buffer {
  if (key) return key;
  const env = process.env.MQTT_SECRET_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) return (key = Buffer.from(env, "hex"));
  const file = join(config.dataDir, "mqtt-secret.key");
  if (existsSync(file)) { const k = Buffer.from(readFileSync(file, "utf8").trim(), "hex"); if (k.length === 32) return (key = k); }
  mkdirSync(config.dataDir, { recursive: true });
  const k = randomBytes(32); writeFileSync(file, k.toString("hex") + "\n", { mode: 0o600 }); return (key = k);
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
/** null = unreadable (wrong or missing key, damaged value). The caller treats that as "no password stored". */
export function decryptSecret(blob: string): string | null {
  try {
    const [v, iv, tag, ct] = blob.split(":"); if (v !== "v1") return null;
    const d = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64")); d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch { return null; }
}
