// `npm run a100-sim`: starts the fake A100 on 127.0.0.1:5503 (A100_SIM_PORT). Point a TCP port of RS-485 Ports at it (framing "rtu" = raw bytes). Bench only, never started by the app.
import { A100Sim, serveA100 } from "./sim.js";
const port = Number(process.env.A100_SIM_PORT ?? 5503); const sim = new A100Sim(); serveA100(sim, port); console.log(`fake A100 on 127.0.0.1:${port} (data frames are swallowed, nothing is sent anywhere)`);
setInterval(() => { if (sim.swallowed.length) { console.log(`swallowed ${sim.swallowed.length} data frame(s)`); sim.swallowed.length = 0; } }, 5000);
