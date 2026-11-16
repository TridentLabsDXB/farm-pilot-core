// Serial device names, per platform. Pure, no I/O. Linux: a node under /dev (see validate.ts DEVICE_PATH). Windows: COMn, with or without the \\.\ prefix.
import { isWin, type Platform } from "../platform.js";

/** COM1..COM999, optionally written as \\.\COM10 (the form Windows itself needs for COM10 and above). Case-insensitive. */
export const COM_PATH = /^(?:\\\\\.\\)?COM([1-9][0-9]{0,2})$/i;

/**
 * Canonical Windows name: bare upper-case "COM10". @serialport/bindings-cpp prepends \\.\ itself before CreateFile (src/serialport_win.cpp),
 * so COM10 and above work with the bare name, and passing \\.\COM10 would be prefixed twice and fail. Returns null if it is not a COM name.
 * On Linux the path is returned unchanged.
 */
export function canonicalSerialPath(path: string, platform: Platform = process.platform): string | null {
  if (!isWin(platform)) return path;
  const m = COM_PATH.exec(path.trim()); return m ? "COM" + Number(m[1]) : null;
}
/** Name to hand to SerialPort. Unknown shapes pass through unchanged so the driver reports its own error. */
export const serialOpenPath = (path: string, platform: Platform = process.platform) => (isWin(platform) ? canonicalSerialPath(path, platform) ?? path : path);
