// Farm Profile thresholds, read straight from the database on every call so a change applies without a restart.
// Precedence (per the change request): register-map built-in default < Farm Profile value. NULL / missing in the profile = use the map default.
import type { Db } from "../db.js";

export interface ProfileThresholds { lowVoltageByType: Record<string, number>; rssiGood: number | null; rssiWeak: number | null; staleMultiplier: number | null; offlineMultiplier: number | null; calibrationDueDays: number | null; }
export function profileThresholds(db: Db): ProfileThresholds {
  const r = db.prepare("SELECT low_voltage_by_type l, rssi_good g, rssi_weak w, stale_multiplier sm, offline_multiplier om, calibration_due_days cd FROM farm_profile WHERE id=1").get() as
    { l: string; g: number | null; w: number | null; sm: number | null; om: number | null; cd: number | null } | undefined;
  let lv: Record<string, number> = {}; try { lv = JSON.parse(r?.l ?? "{}"); } catch { /* unreadable: ignore */ }
  return { lowVoltageByType: lv, rssiGood: r?.g ?? null, rssiWeak: r?.w ?? null, staleMultiplier: r?.sm ?? null, offlineMultiplier: r?.om ?? null, calibrationDueDays: r?.cd ?? null };
}
