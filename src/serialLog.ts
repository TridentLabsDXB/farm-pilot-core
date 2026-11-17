// Serial-port log lines (2026-11-17, Windows lab: "OPEN" was shown while nothing had ever been opened and nothing was logged).
// open / close / errors always go to the console at INFO (errors as ERROR on stderr, so the About page error list sees them); start-core.cmd log appends the console to logs\core.log.
// Hex request and response frames are written only when LOG_MODBUS=1 (read on every call, so it can be switched in core.env and with a restart, or by tests).
const stamp = () => new Date().toISOString();
export const serialInfo = (msg: string) => console.log(`${stamp()} INFO serial: ${msg}`);
export const serialError = (msg: string) => console.error(`${stamp()} ERROR serial: ${msg}`);
export const modbusTraceOn = () => process.env.LOG_MODBUS === "1";
export const hex = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
/** dir: "TX" (request sent) or "RX" (bytes received). */
export function modbusTrace(dir: "TX" | "RX", path: string, b: Buffer) { if (modbusTraceOn()) console.log(`${stamp()} INFO modbus ${dir} ${path} ${b.length}B ${hex(b)}`); }
