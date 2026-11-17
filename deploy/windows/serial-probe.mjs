// Farm-Pilot CORE serial probe (2026-11-17). Standalone: no web app, no database, no CORE running. Same Node and same bundled serialport module as CORE.
//   serial-probe.cmd COM11 [address=7] [baud=9600]
// It lists the COM ports, opens the port 9600 8N1 (or the given baud), asks the gateway the way the vendor tool does and prints every byte sent (TX) and received (RX) in hex with a time stamp.
// Close every other program that uses the COM port first (the vendor tool, a serial monitor, CORE itself): Windows lets only ONE program open a COM port.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function crc16(b) { let crc = 0xffff; for (const x of b) { crc ^= x; for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; } return crc; }
export function rtu(unit, pdu) { const b = Buffer.alloc(pdu.length + 3); b[0] = unit; Buffer.from(pdu).copy(b, 1); b.writeUInt16LE(crc16(b.subarray(0, b.length - 2)), b.length - 2); return b; }
const readPdu = (fc, addr, count) => { const b = Buffer.alloc(5); b[0] = fc; b.writeUInt16BE(addr, 1); b.writeUInt16BE(count, 3); return b; };
export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const stamp = (now) => { const d = new Date(now()); const p = (n, w = 2) => String(n).padStart(w, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };

/** "COM11", "com11" and "\\.\COM11" all mean COM11. serialport adds the \\.\ prefix itself on Windows, so the bare name is what it must be given. Other names (Linux /dev paths) pass through. */
export function bareName(p) { const m = /^(?:\\\\\.\\)?COM([0-9]+)$/i.exec(String(p).trim()); return m ? "COM" + Number(m[1]) : String(p).trim(); }

/** One complete RTU reply for a read, or whatever arrived when the line went quiet. Returns { bytes, frame } where frame = { unit, fc, data, exception } if a frame with a good CRC is there. */
function parse(buf) {
  if (buf.length < 5) return null; const fc = buf[1];
  const total = fc & 0x80 ? 5 : fc === 3 || fc === 4 ? 5 + buf[2] : 0; if (!total || buf.length < total) return null;
  const f = buf.subarray(0, total); if (crc16(f.subarray(0, total - 2)) !== f.readUInt16LE(total - 2)) return { bad: true };
  return fc & 0x80 ? { unit: f[0], fc: fc & 0x7f, exception: f[2] } : { unit: f[0], fc, data: f.subarray(3, total - 2) };
}

export async function runProbe({ args = [], SerialPort, out = (l) => console.log(l), now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 1000, tries = 3 }) {
  const say = (l = "") => out(l);
  const path = args[0] ? bareName(args[0]) : ""; const address = args[1] !== undefined ? Number(args[1]) : 7; const baud = args[2] !== undefined ? Number(args[2]) : 9600;
  if (!path || !Number.isInteger(address) || address < 1 || address > 254 || !Number.isInteger(baud)) { say("Usage: serial-probe.cmd COM11 [address=7] [baud=9600]"); return { pass: false, usage: true }; }
  say(`FARM-PILOT CORE SERIAL PROBE   port ${path}, gateway address ${address}, ${baud} 8N1`);
  say("Close every other program that uses this COM port first (vendor tool, serial monitor, CORE).");

  say(""); say("1) COM ports on this computer");
  try {
    const list = await SerialPort.list();
    if (!list.length) say("   none found. The adapter is not plugged in, or its driver is not installed (Device Manager > Ports (COM & LPT)).");
    for (const p of list) say(`   ${p.path}   ${p.friendlyName || p.manufacturer || "(no description)"}   VID:PID ${p.vendorId ?? "----"}:${p.productId ?? "----"}   serial ${p.serialNumber ?? "--"}`);
    if (list.length && !list.some((p) => bareName(p.path).toUpperCase() === path.toUpperCase())) say(`   NOTE: ${path} is not in this list. Windows may have given the adapter another COM number.`);
  } catch (e) { say(`   could not list the ports: ${e?.message ?? e}`); }

  say(""); say(`2) Opening ${path} (the operating system sees it as \\\\.\\${path}) at ${baud} 8N1`);
  const port = new SerialPort({ path, baudRate: baud, dataBits: 8, parity: "none", stopBits: 1, autoOpen: false });
  try { await new Promise((r, j) => port.open((e) => (e ? j(e) : r()))); } catch (e) {
    say(`   FAILED to open ${path}: ${e?.message ?? e}${e?.code ? " (" + e.code + ")" : ""}`);
    if (/access denied|EACCES|EPERM/i.test(String(e?.message))) say("   Access denied = another program has the port open. Close it (the vendor tool, a serial monitor, a running CORE) and run this again.");
    else if (/file not found|cannot find|ENOENT/i.test(String(e?.message))) say("   File not found = no such COM port. Check the number in step 1 and in Device Manager.");
    say(""); say("FAIL: the port could not be opened, so nothing was sent."); return { pass: false, opened: false };
  }
  say("   opened OK");
  let rx = Buffer.alloc(0); port.on("data", (d) => { rx = Buffer.concat([rx, d]); }); port.on("error", (e) => say(`   port error: ${e?.message ?? e}`));

  let sent = 0, answered = false;
  /** Send one frame up to `tries` times; return the first reply that parses. `want` decides when a reply is complete. */
  async function ask(label, unit, pdu, onReply) {
    const frame = rtu(unit, pdu);
    for (let t = 1; t <= tries; t++) {
      rx = Buffer.alloc(0); sent++; say(`   [${stamp(now)}] TX (try ${t}/${tries}) ${hex(frame)}`);
      await new Promise((r, j) => port.write(frame, (e) => (e ? j(e) : port.drain((e2) => (e2 ? j(e2) : r()))))).catch((e) => say(`   write failed: ${e?.message ?? e}`));
      const t0 = now(); let seen = 0, reply = null;
      while (now() - t0 < timeoutMs * (label.includes("0x0100") ? 2 : 1)) {
        await sleep(20); if (rx.length !== seen) { seen = rx.length; say(`   [${stamp(now)}] RX ${hex(rx)}`); }
        const r = parse(rx); if (r) { reply = r; break; }
      }
      if (reply?.bad) { say("   reply has a bad CRC (noise, wrong baud rate or parity?)"); continue; }
      if (reply) return reply;
      if (rx.length) say(`   incomplete or unreadable reply (${rx.length} bytes)`); else say(`   no answer within ${timeoutMs} ms`);
    }
    return null;
  }

  say(""); say("3) Gateway check as the vendor tool does it: broadcast ID 00, FC04, address 0, count 0");
  const r3 = await ask("broadcast", 0, readPdu(4, 0, 0));
  if (r3) { answered = true; say(r3.exception !== undefined ? `   the gateway answered with exception code ${r3.exception}` : `   reply: unit ${r3.unit}, FC${String(r3.fc).padStart(2, "0")}, ${r3.data.length} data bytes${r3.data.length ? " = " + hex(r3.data) : ""}`); }
  else say("   (a broadcast is normally never answered; the vendor tool shows the gateway's own reply if the gateway sends one. Steps 4 and 5 decide PASS or FAIL.)");

  say(""); say(`4) FC04 address 0x0001 count 1 to slave ${address} (the PID / group address)`);
  const r4 = await ask("pid", address, readPdu(4, 1, 1));
  if (r4 && r4.unit === address) { answered = true; if (r4.exception !== undefined) say(`   the gateway answered with exception code ${r4.exception}`); else { const v = r4.data.readUInt16BE(0); say(`   value = ${v} (0x${v.toString(16).padStart(4, "0")})`); } }
  else if (r4) say(`   a reply came from unit ${r4.unit}, not ${address}`);

  say(""); say(`5) FC04 address 0x0100 count 120 to slave ${address} (the T/H sensor configuration groups, 30 groups of 4 registers)`);
  const r5 = await ask("config 0x0100", address, readPdu(4, 0x0100, 120));
  if (r5 && r5.unit === address) {
    answered = true;
    if (r5.exception !== undefined) say(`   the gateway answered with exception code ${r5.exception}`);
    else {
      const n = r5.data.length / 2; say(`   ${n} registers came back (120 expected)`);
      for (let g = 0; g < Math.min(8, Math.floor(n / 4)); g++) {
        const hi = r5.data.readUInt16BE(g * 8), lo = r5.data.readUInt16BE(g * 8 + 2), serial = ((hi << 16) | lo) >>> 0, interval = r5.data.readUInt16BE(g * 8 + 4), control = r5.data.readUInt16BE(g * 8 + 6);
        say(`   slot ${String(g + 1).padStart(2)}: ${serial === 0xffffffff || serial === 0 ? "(empty)" : "serial " + serial + " (0x" + serial.toString(16).padStart(8, "0") + ")"}   interval ${interval === 0xffff ? "--" : interval + " min"}   control ${control === 0xffff ? "--" : control}`);
      }
    }
  }

  say("");
  await new Promise((r) => port.close(() => r()));
  say(`   ${path} closed`);
  if (answered) { say("PASS: gateway answered"); return { pass: true, opened: true, sent }; }
  say(`FAIL: no answer after ${sent} tries, check wiring A/B (swap the two wires if unsure), the address (${address}), the baud rate (${baud}) and that no other program has the port.`);
  return { pass: false, opened: true, sent };
}

// Run from the command line (serial-probe.cmd); importing the module for tests does not start anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let SerialPort; try { ({ SerialPort } = createRequire(import.meta.url)("serialport")); } catch (e) { console.log("The serialport module could not be loaded: " + (e?.message ?? e)); process.exit(2); }
  const r = await runProbe({ args: process.argv.slice(2), SerialPort }); process.exit(r.pass ? 0 : 1);
}
