// Branding strings for the About page (config/branding.yaml). Every key has a built-in default, so a missing or broken file never stops CORE.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Branding { product_name: string; tagline: string; credit_line: string; support_contact: string; }
export const BRANDING_DEFAULTS: Branding = {
  product_name: "FARM-PILOT CORE", tagline: "Greenhouse and farm control", credit_line: "Engineered in the UAE by Trident Labs",
  support_contact: "Support contact not set yet. Ask your installer or Trident Labs.",
};
export function loadBranding(path = process.env.BRANDING_FILE || "config/branding.yaml"): Branding {
  let raw: any = {}; try { raw = parse(readFileSync(path, "utf8")) ?? {}; } catch { /* no file or not YAML: defaults */ }
  const out = { ...BRANDING_DEFAULTS };
  for (const k of Object.keys(out) as (keyof Branding)[]) { const v = raw?.[k]; if (typeof v === "string" && v.trim() && v.length <= 300) out[k] = v.trim(); }
  return out;
}
