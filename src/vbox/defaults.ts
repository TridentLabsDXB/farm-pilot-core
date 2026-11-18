// V-BOX data source -- the ONE place that holds the placeholder defaults (2026-11-18, same rule as mqtt/defaults.ts).
// The real V-BOX payload (topic scheme, tag names, sample message) is NOT known yet (spec core-vbox-data-source-page.md, Open 1). Everything below is a PLACEHOLDER from the approved mockup.
// The mapping engine (service.ts) is generic: "the number at this payload path is measurement X". When the owner sends the real format, replace the values here only.
export const VBOX_DEFAULT_FILTER = "vbox/+/data";
export const VBOX_DEFAULT_FORMAT = "V-BOX JSON (tag: value)";                 // placeholder label; the engine reads any flat or nested JSON object
export const VBOX_DEFAULT_ID = { from: "topic" as "topic" | "payload", level: 2, path: "id" };   // device (V-BOX unit) id = topic level 2 (1-based), or the payload field `path`
export const VBOX_DEFAULT_TAGS: { path: string; name: string; unit: string; scale: number; offset: number }[] = [
  { path: "gh1_temp", name: "gh1_temp", unit: "°C", scale: 1, offset: 0 },
  { path: "gh1_hum", name: "gh1_hum", unit: "%", scale: 1, offset: 0 },
  { path: "tank_level", name: "tank_level", unit: "%", scale: 1, offset: 0 },
];
/** Series topic of every V-BOX reading (sensor_key = V-BOX unit id, metric = tag name). */
export const VBOX_SERIES_TOPIC = "vbox/tags";
