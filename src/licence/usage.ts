// What counts against a licence. Sensors: every registry sensor of every type (replaced ones are history, not sensors). Gateways: enabled LoRa gateway devices.
// NOT counted: pumps, fans and other control devices, and the weather station (a bus device, not a LoRa sensor). About spec, open question 1.
import type { Db } from "../db.js";

export interface Usage { gateways: number; sensors: number; }
export function usage(db: Db): Usage {
  const n = (sql: string) => { try { return (db.prepare(sql).get() as { c: number }).c; } catch { return 0; } };       // a table that does not exist yet (tests, first start) counts as 0
  return { sensors: n("SELECT COUNT(*) c FROM sensors WHERE replaced_by IS NULL"), gateways: n("SELECT COUNT(*) c FROM bus_devices WHERE kind='lora_gateway' AND enabled=1") };
}
