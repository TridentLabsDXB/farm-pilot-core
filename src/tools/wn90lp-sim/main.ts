// WN90LP weather simulator process: Modbus TCP (MBAP) + RTU-over-TCP listeners and a loopback control API. Register layout is NOT verified (see sim.ts).
//   node dist/tools/wn90lp-sim/main.js
// Env: WN_MBAP_PORT (5040) WN_RTU_PORT (5041) WN_CTL_PORT (5050) WN_ADDRESS (144) SIM_BIND (127.0.0.1)
import { createServer as createHttp } from "node:http";
import { serveSim } from "../gateway-sim/server.js";
import { Wn90lpSim } from "./sim.js";

const bind = process.env.SIM_BIND || "127.0.0.1"; const sim = new Wn90lpSim(Number(process.env.WN_ADDRESS || 144));
serveSim(sim, Number(process.env.WN_MBAP_PORT || 5040), "mbap", bind);
serveSim(sim, Number(process.env.WN_RTU_PORT || 5041), "rtu", bind);
createHttp((req, res) => {
  const p = new URL(req.url || "/", "http://x").pathname; const ok = (v: unknown = { ok: true }) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
  if (p === "/state") return ok({ address: sim.address, silent: sim.silent, requests: sim.requests });
  if (p === "/stop") { sim.silent = true; return ok(); } if (p === "/start") { sim.silent = false; return ok(); }
  res.statusCode = 404; ok({ error: "not found" });
}).listen(Number(process.env.WN_CTL_PORT || 5050), "127.0.0.1", () => console.log("wn90lp-sim control on 127.0.0.1:" + (process.env.WN_CTL_PORT || 5050)));
