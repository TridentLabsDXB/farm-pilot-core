#!/usr/bin/env python3
"""Static checks of Windows PE files, run on Linux by make-lab-bundle.sh (nothing can be executed here). Prints machine type, imported DLLs and the count of
VZEROUPPER (C5 F8 77) instructions: a compiler emits it wherever it generated AVX code, so 0 in a small addon means the addon does not use AVX.
usage: verify-pe.py FILE... ; exit 1 if a file is not a PE32+ x86-64 image."""
import struct, sys

def sections(d, pe, nsec, optsize):
    base = pe + 24 + optsize; out = []
    for i in range(nsec):
        name, vsize, va, rsize, raw = struct.unpack_from("<8sIIII", d, base + i * 40); out.append((va, max(vsize, rsize), raw))
    return out
def rva2off(secs, rva):
    for va, size, raw in secs:
        if va <= rva < va + size: return rva - va + raw
    return None
def cstr(d, off):
    e = d.index(b"\0", off); return d[off:e].decode("latin1")

def check(path):
    d = open(path, "rb").read()
    if d[:2] != b"MZ": raise SystemExit(f"{path}: not a PE file")
    pe = struct.unpack_from("<I", d, 0x3C)[0]
    if d[pe:pe + 4] != b"PE\0\0": raise SystemExit(f"{path}: no PE signature")
    machine, nsec = struct.unpack_from("<HH", d, pe + 4); optsize = struct.unpack_from("<H", d, pe + 20)[0]; magic = struct.unpack_from("<H", d, pe + 24)[0]
    if machine != 0x8664 or magic != 0x20B: raise SystemExit(f"{path}: not x86-64 PE32+ (machine {machine:#x}, magic {magic:#x})")
    secs = sections(d, pe, nsec, optsize); imp_rva = struct.unpack_from("<I", d, pe + 24 + 112 + 8)[0]; dlls = []
    off = rva2off(secs, imp_rva) if imp_rva else None
    while off is not None:
        _, _, _, name_rva, _ = struct.unpack_from("<IIIII", d, off)
        if name_rva == 0: break
        no = rva2off(secs, name_rva); dlls.append(cstr(d, no)); off += 20
    return {"machine": "x86-64", "imports": sorted(set(dlls), key=str.lower), "vzeroupper": d.count(b"\xc5\xf8\x77"), "napi": b"napi_module_register" in d or b"node_api_module_get_api_version_v1" in d, "size": len(d)}

if __name__ == "__main__":
    for f in sys.argv[1:]:
        r = check(f); print(f"{f}\n  machine {r['machine']}, {r['size']} bytes, N-API addon: {r['napi']}, VZEROUPPER count: {r['vzeroupper']}\n  imports: {', '.join(r['imports'])}")
