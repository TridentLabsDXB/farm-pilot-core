// Minimal multipart/form-data reader for ONE small file field (the licence upload, at most a few KB). No dependency: the route has a tight body limit, so this never sees large input.
export function multipartFile(contentType: string, body: Buffer, field = "file"): Buffer | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType); if (!m) return null; const delim = Buffer.from("--" + (m[1] ?? m[2]));
  let pos = body.indexOf(delim); if (pos < 0) return null;
  for (;;) {
    pos += delim.length; if (body.subarray(pos, pos + 2).toString() === "--") return null;       // closing delimiter
    if (body.subarray(pos, pos + 2).toString() === "\r\n") pos += 2;
    const hEnd = body.indexOf("\r\n\r\n", pos); if (hEnd < 0) return null;
    const head = body.subarray(pos, hEnd).toString("latin1"), start = hEnd + 4, next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), start); if (next < 0) return null;
    if (new RegExp(`content-disposition:[^\\r\\n]*;\\s*name="${field}"`, "i").test(head)) return body.subarray(start, next);
    pos = next + 2;
  }
}
