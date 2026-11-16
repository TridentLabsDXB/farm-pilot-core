// The built-in FREE licence. THE ONE PLACE for these numbers: nothing else in CORE may repeat 1 or 10 (About and licensing spec, "Licence model").
// Sensors are counted in total across all types (T/H, soil, light, any other). Pumps, fans, other control devices and the weather station (a bus device) are not counted.
export const FREE_LICENCE = { type: "FREE", gateways: 1, sensors: 10 } as const;
