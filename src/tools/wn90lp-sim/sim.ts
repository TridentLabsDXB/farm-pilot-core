// WN90LP weather-station simulator (Modbus slave core), the second bench device for RS-485 Port 2. DEV / BENCH ONLY.
// The REGISTER LAYOUT IS NOT VERIFIED: the WN90LP manual is not in the project yet (open question 7). Every read inside 0..0x03FF answers with plausible
// slowly-moving values, so the bench exercises the second port, the address (default 144 = 0x90, probably the factory value), TEST PORT and the status lamp end to end.
// Nothing here may be used as a register map for a real driver.
import { exceptionPdu, MAX_READ_REGS, readRespPdu } from "../../drivers/modbus/frames.js";
import type { ModbusSlave } from "../gateway-sim/server.js";

export class Wn90lpSim implements ModbusSlave {
  silent = false; address: number; requests = 0;
  constructor(address = 144) { this.address = address; }
  handle(unit: number, pdu: Buffer): Buffer | null {
    if (this.silent || unit !== this.address) return null;
    this.requests++; const fc = pdu[0];
    try {
      if (fc !== 3 && fc !== 4) return exceptionPdu(fc, 1);
      const addr = pdu.readUInt16BE(1), n = pdu.readUInt16BE(3);
      if (n < 1 || n > MAX_READ_REGS) return exceptionPdu(fc, 3);
      if (addr + n > 0x400) return exceptionPdu(fc, 2);
      const t = Date.now() / 1000; const vals = Array.from({ length: n }, (_, i) => Math.round(2000 + 300 * Math.sin(t / 600 + (addr + i)) + (addr + i)) & 0xffff);
      return readRespPdu(fc, vals);
    } catch { return exceptionPdu(fc, 4); }
  }
}
