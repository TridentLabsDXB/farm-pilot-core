// PLC bench simulator process (see sim.ts). Not part of the normal start: run it by hand on the bench, then point the PLC page at 127.0.0.1:5502.
import { PlcSim } from "./sim.js";
const sim = new PlcSim(); setInterval(() => sim.tick(), 1000); sim.tick();
const port = await sim.listen(Number(process.env.PLC_SIM_PORT || 5502), process.env.PLC_SIM_BIND || "127.0.0.1");
console.log(`plc-sim (Modbus TCP, read only) on ${process.env.PLC_SIM_BIND || "127.0.0.1"}:${port}`);
