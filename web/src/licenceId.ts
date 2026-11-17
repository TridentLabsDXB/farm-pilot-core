// 2026-11-18 -- Licence ID helpers for the ISSUE / RENEW dialog (pure, no DOM, tested from test/deployments.test.ts). The format is the one of signed licences (src/licence/format.ts LICENCE_ID_RE): FPL-YYYYMMDD-NNNN.
export const LICENCE_ID_FORMAT = /^FPL-\d{8}-\d{4}$/;
const DEVICE_ID_FORMAT = /^FP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
export const LICENCE_ID_HELP = "Format FPL-YYYYMMDD-NNNN, for example FPL-20261117-0001.";
export const DEVICE_ID_MSG = "That looks like a Device ID. The Device ID goes in Edit deployment; the Licence ID looks like FPL-20261117-0001.";

/** FPL-<issued date as YYYYMMDD>-<next free 4-digit number for that date>; "next free" = highest number already recorded for that date + 1 (any deployment), starting at 0001. null for a date that is not YYYY-MM-DD. */
export function nextLicenceId(issuedYmd: string, existing: (string | null | undefined)[]): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issuedYmd); if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  const prefix = `FPL-${m[1]}${m[2]}${m[3]}-`; let max = 0;
  for (const e of existing) if (e && LICENCE_ID_FORMAT.test(e) && e.startsWith(prefix)) max = Math.max(max, Number(e.slice(prefix.length)));
  return max >= 9999 ? null : prefix + String(max + 1).padStart(4, "0");
}
/** null = fine, otherwise the sentence to show under the field. */
export function licenceIdError(value: string): string | null {
  const v = value.trim(); if (v === "") return "Licence ID is required. " + LICENCE_ID_HELP;
  if (DEVICE_ID_FORMAT.test(v.toUpperCase())) return DEVICE_ID_MSG;
  return LICENCE_ID_FORMAT.test(v) ? null : "That is not a Licence ID. " + LICENCE_ID_HELP;
}
