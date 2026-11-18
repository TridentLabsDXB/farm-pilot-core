// What counts against a licence. Sensors: every registry sensor of every type (replaced ones are history, not sensors). Gateways: enabled LoRa gateway devices.
// 2026-11-18: DATA SOURCES (the `gateways` number) also count an enabled PLC source (1) and an enabled V-BOX source (1); V-BOX is NOT part of the MQTT source, which counts nothing for now (TODO in mqtt/service.ts).
// PLC points and V-BOX tags do NOT count toward sensors (owner proposal, open question 5: TODO(licence) until confirmed).
// NOT counted: pumps, fans and other control devices, and the weather station (a bus device, not a LoRa sensor). About spec, open question 1.
import type { Db } from "../db.js";

export interface Usage { gateways: number; sensors: number; }
export function usage(db: Db): Usage {
  const n = (sql: string) => { try { return (db.prepare(sql).get() as { c: number }).c; } catch { return 0; } };       // a table that does not exist yet (tests, first start) counts as 0
  return { sensors: n("SELECT COUNT(*) c FROM sensors WHERE replaced_by IS NULL"), gateways: n("SELECT COUNT(*) c FROM bus_devices WHERE kind='lora_gateway' AND enabled=1") + n("SELECT COUNT(*) c FROM plc_config WHERE enabled=1") + n("SELECT COUNT(*) c FROM vbox_config WHERE enabled=1") };
}
