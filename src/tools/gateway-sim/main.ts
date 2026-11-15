// Gateway simulator process: Modbus TCP (MBAP) + RTU-over-TCP listeners and a small loopback HTTP control API for failure injection.
//   node dist/tools/gateway-sim/main.js [--replay dump.json]
// Env: SIM_MBAP_PORT (5020) SIM_RTU_PORT (5021) SIM_CTL_PORT (5030) SIM_BIND (127.0.0.1) SIM_MAP (config path) SIM_PRECONFIG (0)
// Optional virtual serial pair to exercise real RTU framing without hardware (documented, not required):
//   socat -d -d pty,raw,echo=0,link=/tmp/ttyGW pty,raw,echo=0,link=/tmp/ttyCORE   (then bridge /tmp/ttyGW to SIM_RTU_PORT with: socat tcp:127.0.0.1:5021 /tmp/ttyGW,raw,echo=0)
import { createServer as createHttp } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRegMap } from "../../drivers/modbus/regmap.js";
import { GatewaySim } from "./sim.js";
import { serveSim } from "./server.js";

const bind = process.env.SIM_BIND || "127.0.0.1";
const map = loadRegMap(process.env.SIM_MAP || fileURLToPath(new URL("../../../config/gateway-thingsend.yaml", import.meta.url)));
export const sim = new GatewaySim(map);
const pre = Number(process.env.SIM_PRECONFIG || 0);
for (let i = 0; i < pre; i++) sim.preconfigure("th", i, [...sim.phys.keys()][i], 300);
const ra = process.argv.indexOf("--replay"); if (ra > 0) sim.loadReplay(JSON.parse(readFileSync(process.argv[ra + 1], "utf8")));

serveSim(sim, Number(process.env.SIM_MBAP_PORT || 5020), "mbap", bind);
serveSim(sim, Number(process.env.SIM_RTU_PORT || 5021), "rtu", bind);
setInterval(() => sim.tick(), 1000);

createHttp((req, res) => {
  const u = new URL(req.url || "/", "http://x"); const q = u.searchParams; const serial = (q.get("serial") || "").toUpperCase();
  let body = ""; req.on("data", (d) => { body += d; if (body.length > 5e6) req.destroy(); });
  req.on("end", () => {
    const ok = (v: unknown = { ok: true }) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
    const bad = (m: string) => { res.statusCode = 400; ok({ error: m }); };
    switch (u.pathname) {
      case "/state": return ok(sim.state());
      case "/freeze": return sim.freeze(serial, true) ? ok() : bad("unknown serial");
      case "/unfreeze": return sim.freeze(serial, false) ? ok() : bad("unknown serial");
      case "/zero": return sim.zero(serial) ? ok() : bad("unknown or unconfigured serial");
      case "/unzero": return sim.unzero(serial) ? ok() : bad("unknown serial");
      case "/voltage": return sim.setVoltage(serial, q.get("v") === null ? null : Number(q.get("v"))) ? ok() : bad("unknown serial");
      case "/stop": sim.silent = true; return ok();
      case "/start": sim.silent = false; return ok();
      case "/reject": { const on = q.get("on") !== "0"; if (serial) { on ? sim.rejectSerials.add(serial) : sim.rejectSerials.delete(serial); } else sim.rejectAll = on; return ok(); }
      case "/preconfig": try { sim.preconfigure(q.get("type") || "th", Number(q.get("slot")), serial, Number(q.get("interval") || 300)); return ok(); } catch (e: any) { return bad(e.message); }
      case "/replay": try { sim.loadReplay(JSON.parse(body)); return ok(); } catch (e: any) { return bad(e.message); }
      default: res.statusCode = 404; return ok({ error: "not found" });
    }
  });
}).listen(Number(process.env.SIM_CTL_PORT || 5030), "127.0.0.1", () => console.log("gateway-sim control on 127.0.0.1:" + (process.env.SIM_CTL_PORT || 5030)));
