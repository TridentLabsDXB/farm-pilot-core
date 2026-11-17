// MQTT Payload source -- the ONE place that holds the placeholder defaults (2026-11-18).
// The real "MQTT Universal" payload format and topic scheme are NOT decided yet (docs: core-mqtt-payload-page.md, section OPEN). Everything below is a PLACEHOLDER
// taken from the approved mockup. When the owner supplies the real sample message, replace the values in this file only: the mapping engine (mapping.ts) is generic.
// These defaults are written into the database ONCE, when the MQTT tables are first created; after that the Admin edits them on the page.
import type { MapRule } from "./mapping.js";

export const DEFAULT_CONNECTION = {
  enabled: false,                     // never connects until an Admin presses ENABLE
  host: "mqtt.farm-pilot.com",        // PLACEHOLDER
  port: 8883,                         // PLACEHOLDER (TLS)
  tls: true,
  client_id: "",                      // empty = CORE generates one ("core-xxxxxxxx") and keeps it
  username: "",
  keepalive: 60,
};

/** PLACEHOLDER topic filters and QoS. */
export const DEFAULT_TOPICS: { filter: string; qos: 0 | 1 | 2 }[] = [{ filter: "fp/+/data", qos: 1 }, { filter: "fp/+/status", qos: 0 }];

/** PLACEHOLDER: where the device id and the timestamp sit in the JSON payload (dot path). */
export const DEFAULT_ID_PATH = "id";
export const DEFAULT_TS_PATH = "ts";

/** PLACEHOLDER field mapping: payload field path -> CORE measurement. value_in_core = payload_value * scale + offset. */
export const DEFAULT_RULES: MapRule[] = [
  { path: "t", name: "temperature", unit: "°C", scale: 1, offset: 0 },
  { path: "h", name: "humidity", unit: "%", scale: 1, offset: 0 },
  { path: "bat", name: "battery", unit: "%", scale: 1, offset: 0 },
  { path: "rssi", name: "rssi", unit: "dBm", scale: 1, offset: 0 },
];

/** Series topic under which every MQTT Payload reading is stored (series.topic); sensor_key = device id, metric = measurement name. Never listed by /api/state (that serves farmpilot/* only). */
export const SERIES_TOPIC = "mqtt/payload";
