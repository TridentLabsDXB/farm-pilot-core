// The built-in FREE licence. THE ONE PLACE for these numbers: nothing else in CORE may repeat 1 or 10 (About and licensing spec, "Licence model").
// Sensors are counted in total across all types (T/H, soil, light, any other). Pumps, fans, other control devices and the weather station (a bus device) are not counted.
// retentionDays: how long history is kept (raw and hourly rows).
// reportsDays: how far back charts, CSV export and Reports may reach (see licence/range.ts). PRO = unlimited inside the kept history.
export const FREE_LICENCE = { type: "FREE", gateways: 1, sensors: 10, reportsDays: 7, retentionDays: 90 } as const;
