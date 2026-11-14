export interface Me { username: string; role: "operator" | "admin"; }
export interface Sensor { key: string; readings: Record<string, number>; }
export interface Topic { topic: string; ts: number; sensors: Sensor[]; }
export interface Cmd { id: string; pump: string; action: "on" | "off"; status: "sent" | "confirmed" | "timeout"; username: string; created_at: number; resolved_at: number | null; note: string | null; }
export interface State { farm: string; now: number; topics: Topic[]; commands: Cmd[]; commandTimeoutSec: number; }

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch("/api" + path, { credentials: "same-origin", ...init, headers: init?.json ? { "content-type": "application/json" } : undefined, body: init?.json ? JSON.stringify(init.json) : init?.body });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
  return body as T;
}
