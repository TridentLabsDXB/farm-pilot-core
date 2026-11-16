import { createServer, type Server, type Socket } from "node:net";
import { mbapLength, rtuFrameLength, rtuUnwrap, rtuWrap } from "../../drivers/modbus/frames.js";
/** Anything that answers Modbus requests: the gateway simulator and the weather-station simulator. */
export interface ModbusSlave { handle(unit: number, pdu: Buffer): Buffer | null; }

export function serveSim(sim: ModbusSlave, port: number, framing: "mbap" | "rtu", bind = "127.0.0.1"): Server {
  return createServer((s: Socket) => {
    let buf = Buffer.alloc(0); s.on("error", () => {});
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (framing === "mbap") {
          const n = mbapLength(buf); if (!n || buf.length < n) return; const f = buf.subarray(0, n); buf = buf.subarray(n);
          const res = sim.handle(f[6], f.subarray(7)); if (!res) continue;
          const o = Buffer.alloc(7 + res.length); f.copy(o, 0, 0, 4); o.writeUInt16BE(res.length + 1, 4); o[6] = f[6]; res.copy(o, 7); s.write(o);
        } else {
          const n = rtuFrameLength(buf, "req"); if (n < 0) { buf = Buffer.alloc(0); return; } if (!n || buf.length < n) return;
          const f = buf.subarray(0, n); buf = buf.subarray(n); const u = rtuUnwrap(f); if (!u) continue;
          const res = sim.handle(u.unit, u.pdu); if (res) s.write(rtuWrap(u.unit, res));
        }
      }
    });
  }).listen(port, bind, () => console.log(`modbus-sim ${framing} on ${bind}:${port}`));
}
