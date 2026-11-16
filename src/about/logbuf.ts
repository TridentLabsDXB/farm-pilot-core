// In-memory ring of the last log lines and the last errors, for diagnostics and the support bundle. Nothing is written to disk. Lines are SANITISED when they are stored:
// session cookies, tokens, passwords and password hashes never enter the buffer (and so never reach a bundle).
const MAX_LINES = 500, MAX_ERRORS = 20, MAX_LEN = 600;
const lines: string[] = [], errors: string[] = [];

const RULES: [RegExp, string][] = [
  [/(core_session=)[^;\s"']+/gi, "$1[removed]"],
  [/("(?:pass_?hash|token_?hash|password|passwd|secret|token|cookie|set-cookie|authorization|signature)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"'],
  [/\b(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\n,}]+/gi, "$1: [removed]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [removed]"],
  [/\bscrypt\$[0-9a-f]+\$[0-9a-f]+/gi, "[password hash removed]"],
  [/\b(password|passwd|secret|token)=\S+/gi, "$1=[removed]"],
  [/\b[0-9a-f]{40,}\b/gi, "[hex removed]"],                                            // token hashes, digests, keys: never useful in a support log
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{43}\b/g, "[token removed]"],   // a bare 32-byte base64url session token
];
export function sanitizeLine(s: string): string { let t = s.slice(0, MAX_LEN * 4); for (const [re, to] of RULES) t = t.replace(re, to); return t.slice(0, MAX_LEN); }

const isError = (raw: string, stderr: boolean) => stderr || /"level":(5\d|6\d)\b/.test(raw) || /\b(ERROR|FATAL)\b/.test(raw.slice(0, 80));
export function pushLog(raw: string, stderr = false) {
  for (const part of raw.split(/\r?\n/)) {
    if (!part.trim()) continue; const clean = sanitizeLine(part);
    lines.push(clean); if (lines.length > MAX_LINES) lines.shift();
    if (isError(part, stderr)) { errors.push(clean); if (errors.length > MAX_ERRORS) errors.shift(); }
  }
}
export const recentLines = () => [...lines];
export const recentErrors = () => [...errors];
export const clearLogsForTests = () => { lines.length = 0; errors.length = 0; };

let installed = false;
/** Wraps stdout and stderr once at start: output still goes where it did (journald, console), a sanitised copy is kept. */
export function installLogCapture() {
  if (installed) return; installed = true;
  for (const [stream, isErr] of [[process.stdout, false], [process.stderr, true]] as const) {
    const orig = stream.write.bind(stream);
    (stream as any).write = (chunk: any, ...rest: any[]) => { try { pushLog(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"), isErr); } catch { /* never break logging */ } return orig(chunk, ...rest); };
  }
}
