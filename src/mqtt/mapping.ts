// MQTT Payload mapping engine: GENERIC. A rule says "the number at this JSON path is measurement X in unit U, value = raw * scale + offset".
// Nothing here knows the real payload format (see defaults.ts). It never throws: every problem becomes an entry in `errors`, `missing` or `unmapped`.
export interface MapRule { path: string; name: string; unit: string; scale: number; offset: number; }
export interface MapOptions { idPath: string; tsPath: string; rules: MapRule[]; }
export interface MapResult {
  status: "ok" | "unmapped" | "error";                 // error = invalid JSON, no device id or a wrong type; unmapped = fields no rule covers
  deviceId: string | null; ts: number | null;
  values: { name: string; unit: string; value: number }[];
  missing: string[];                                   // rule paths absent from this message (normal for a status message; informational)
  unmapped: string[];                                  // payload fields (leaf paths) that no rule, id path or ts path covers
  errors: string[];
}
export const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEPTH = 4, MAX_LEAVES = 200;

/** Reads "a.b.0.c" from a parsed JSON value. found=false when any step is absent. */
export function getPath(obj: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: any = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}
function leaves(v: unknown, prefix: string, out: string[], depth: number) {
  if (out.length >= MAX_LEAVES) return;
  if (v !== null && typeof v === "object" && depth < MAX_DEPTH) { for (const [k, x] of Object.entries(v as object)) leaves(x, prefix ? `${prefix}.${k}` : k, out, depth + 1); }
  else if (prefix) out.push(prefix);
}
/** Epoch seconds, epoch milliseconds or an ISO date string -> epoch ms; anything else -> null (the caller then uses the arrival time). */
export function parseTs(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v < 1e11 ? v * 1000 : v;
  else if (typeof v === "string" && v.length < 40 && Number.isFinite(Date.parse(v))) n = Date.parse(v);
  return n !== null && n > 946684800000 && n < 4102444800000 ? Math.round(n) : null;      // 2000..2100 only
}
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function mapPayload(raw: Buffer | string, o: MapOptions): MapResult {
  const res: MapResult = { status: "ok", deviceId: null, ts: null, values: [], missing: [], unmapped: [], errors: [] };
  const fail = (m: string) => { res.errors.push(m); res.status = "error"; return res; };
  const len = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (len > MAX_PAYLOAD_BYTES) return fail("payload too large");
  let p: unknown; try { p = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); } catch { return fail("invalid JSON"); }
  if (p === null || typeof p !== "object" || Array.isArray(p)) return fail("payload is not a JSON object");

  const id = getPath(p, o.idPath);
  if (!id.found) res.errors.push(`device id field "${o.idPath}" is missing`);
  else if ((typeof id.value === "string" || (typeof id.value === "number" && Number.isSafeInteger(id.value))) && DEVICE_ID.test(String(id.value))) res.deviceId = String(id.value);
  else res.errors.push(`device id field "${o.idPath}" has a wrong type or characters`);
  res.ts = parseTs(getPath(p, o.tsPath).value);

  const covered = new Set<string>([o.idPath, o.tsPath]);
  for (const r of o.rules) {
    covered.add(r.path);
    const f = getPath(p, r.path);
    if (!f.found) { res.missing.push(r.path); continue; }
    if (typeof f.value !== "number" || !Number.isFinite(f.value)) { res.errors.push(`field "${r.path}" must be a number`); continue; }
    const v = f.value * r.scale + r.offset;
    if (!Number.isFinite(v)) { res.errors.push(`field "${r.path}" gives no finite value`); continue; }
    res.values.push({ name: r.name, unit: r.unit, value: v });
  }
  const all: string[] = []; leaves(p, "", all, 0);
  res.unmapped = all.filter((l) => ![...covered].some((c) => l === c || l.startsWith(c + ".")));
  res.status = res.errors.length ? "error" : res.unmapped.length ? "unmapped" : "ok";
  return res;
}

/** Validates the rule list an Admin submits. Returns an error text or null. */
export function checkRules(rules: unknown, idPath: unknown, tsPath: unknown): string | null {
  const P = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
  if (typeof idPath !== "string" || !P.test(idPath) || idPath.length > 80) return "device id path must look like id or device.id";
  if (typeof tsPath !== "string" || !P.test(tsPath) || tsPath.length > 80) return "timestamp path must look like ts or meta.ts";
  if (!Array.isArray(rules)) return "rules must be a list";
  if (rules.length > 40) return "at most 40 mapping rows";
  const paths = new Set<string>(), names = new Set<string>();
  for (const [i, r] of rules.entries()) {
    const n = i + 1;
    if (!r || typeof r !== "object") return `row ${n}: invalid`;
    if (typeof r.path !== "string" || !P.test(r.path) || r.path.length > 80) return `row ${n}: field path must look like t or data.temp`;
    if (typeof r.name !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(r.name)) return `row ${n}: name must be lower case letters, digits or _ (max 32)`;
    if (typeof r.unit !== "string" || r.unit.length > 12) return `row ${n}: unit is at most 12 characters`;
    if (typeof r.scale !== "number" || !Number.isFinite(r.scale) || r.scale === 0 || Math.abs(r.scale) > 1e9) return `row ${n}: scale must be a number other than 0`;
    if (typeof r.offset !== "number" || !Number.isFinite(r.offset) || Math.abs(r.offset) > 1e9) return `row ${n}: offset must be a number`;
    if (paths.has(r.path)) return `row ${n}: field ${r.path} is mapped twice`; paths.add(r.path);
    if (names.has(r.name)) return `row ${n}: measurement ${r.name} is used twice`; names.add(r.name);
    if (r.path === idPath || r.path === tsPath) return `row ${n}: field ${r.path} is the device id or timestamp field`;
  }
  return null;
}

/** MQTT topic filter match (+ one level, # the rest). Pure. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/"), t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
/** Topic filter an Admin may add. Returns an error text or null. */
export function checkFilter(filter: unknown): string | null {
  if (typeof filter !== "string" || !filter.trim()) return "topic filter is empty";
  if (filter !== filter.trim()) return "topic filter has spaces at the start or end";
  if (filter.length > 200) return "topic filter is longer than 200 characters";
  if (/[\u0000-\u001f\u007f\s]/.test(filter)) return "topic filter must not contain spaces or control characters";
  if (filter.startsWith("$")) return "topic filters starting with $ are broker internals";
  const parts = filter.split("/");
  for (const [i, p] of parts.entries()) {
    if (p.includes("#") && (p !== "#" || i !== parts.length - 1)) return "# is allowed only as the last level, on its own";
    if (p.includes("+") && p !== "+") return "+ must be a whole level, like a/+/b";
  }
  return null;
}
