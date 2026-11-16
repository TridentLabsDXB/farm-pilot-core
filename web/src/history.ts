// 2026-11-16 -- MONITORING charts: types, URL state and the CSV download (change request core-control-section-and-scada-charts.md, sections 3 and 4).
export type Range = "1h" | "24h" | "1w" | "1m";
export type Metric = "temperature" | "humidity";
export const RANGES: Range[] = ["1h", "24h", "1w", "1m"];
export type View = "cards" | "charts";
export interface HistSeries { key: string; label: string; status: string; points: [number, number | null][]; }
export interface History { zone: { id: number; name: string }; metric: Metric; unit: string; range: Range; from: number; to: number; updated_at: number; bucket_ms: number; sensors: HistSeries[]; average: { points: [number, number | null][] }; }
export interface ReportsMeta { reports_days: number | null; allowed_from: string | null; ranges: { range: Range; allowed: boolean }[]; export_max_rows: number; }
export const MAX_SERIES = 12;                                   // more series are listed in the legend but hidden until toggled
export const DEFAULT_RANGE: Range = "24h";

/** `#/monitoring?view=charts&range=24h` -> { view, range }. Anything unknown falls back to the defaults (cards, 24H). */
export function parseMonitoringQuery(q: string): { view: View; range: Range } {
  const p = new URLSearchParams(q.replace(/^\?/, "")), v = p.get("view"), r = p.get("range");
  return { view: v === "charts" ? "charts" : "cards", range: (RANGES as string[]).includes(r ?? "") ? (r as Range) : DEFAULT_RANGE };
}
export const monitoringQuery = (view: View, range: Range) => (view === "cards" ? "" : `?view=${view}&range=${range}`);
/** A range the licence does not allow falls back to 24H (a URL can ask for anything). `meta` null = not loaded yet, nothing is refused client side (the server still enforces it). */
export const effectiveRange = (r: Range, meta: ReportsMeta | null): Range => (meta && meta.ranges.some((x) => x.range === r && !x.allowed) ? DEFAULT_RANGE : r);
export const rangeLocked = (r: Range, meta: ReportsMeta | null) => !!meta && meta.ranges.some((x) => x.range === r && !x.allowed);

const KEY = "core_monitoring"; // per-browser convenience only, never needed for correctness
export const loadPref = (): Partial<{ view: View; range: Range }> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; } };
export const savePref = (view: View, range: Range) => { try { localStorage.setItem(KEY, JSON.stringify({ view, range })); } catch { /* private mode */ } };

/** Downloads the CSV through fetch so a refusal (licence range, too many rows, rate limit) is shown as a sentence instead of a JSON page. Returns an error text or null. */
export async function downloadCsv(zone: number | "all", range: Range): Promise<string | null> {
  try {
    const r = await fetch(`/api/history/export.csv?zone=${zone}&range=${range}`, { credentials: "same-origin" });
    if (!r.ok) { const b = await r.json().catch(() => ({})); return b.error || `The export failed (HTTP ${r.status}).`; }
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "farm-pilot-export.csv";
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch (e: any) { return String(e?.message ?? e); }
}
