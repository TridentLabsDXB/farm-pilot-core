// Prints where to open CORE (this tablet and the LAN / hotspot addresses) and where the first-run password is. Called by start-core.cmd just before the server starts.
import os from "node:os"; import { existsSync, readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)); const env = { ...process.env };
let paths; try { const { defaultPaths } = await import(pathToFileURL(join(here, "dist", "platform.js")).href); paths = defaultPaths(); const f = paths.envFile; if (existsSync(f)) for (const l of readFileSync(f, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* program files missing: start-core.cmd reports it */ }
const port = Number(env.PORT || 4100), bind = env.HOST_BIND_IP || "127.0.0.1", lan = Object.entries(os.networkInterfaces()).flatMap(([n, l]) => (l ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ n, ip: a.address })));
console.log(`\n  Farm-Pilot CORE will listen on ${bind === "0.0.0.0" ? "all network interfaces" : bind}, port ${port}.`);
console.log(`  On this tablet:   http://127.0.0.1:${port}`);
if (bind === "0.0.0.0") { for (const a of lan) console.log(`  From a phone:     http://${a.ip}:${port}    (${a.n}${a.ip === "192.168.137.1" ? ", the Windows Mobile Hotspot address" : ""})`); if (!lan.length) console.log("  No network address found: turn on the tablet's Mobile Hotspot or connect to Wi-Fi, then start again."); }
if (paths) { const pw = join(paths.dataDir, "initial-admin-password"); console.log(existsSync(pw) ? `  Admin password:   in ${pw} (user: admin)` : "  First start: the admin password will be written to " + pw + " (user: admin)."); }
console.log("  Stop: Ctrl+C in this window (answer Y if Windows asks 'Terminate batch job'). Keep Windows from sleeping while the lab runs.\n");
