import { useEffect, useRef, useState } from "react";
// Camera QR/barcode scan with the browser BarcodeDetector API (Chrome/Android). No library; where it is missing the user types or pastes.
export const scanSupported = () => typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
export default function Scan({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const v = useRef<HTMLVideoElement>(null); const [err, setErr] = useState("");
  useEffect(() => {
    let stop = false, stream: MediaStream | undefined, timer: number;
    (async () => {
      try {
        const Det = (window as any).BarcodeDetector; const det = new Det({ formats: ["qr_code", "code_128", "code_39", "ean_13", "data_matrix"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); if (!v.current) return; v.current.srcObject = stream; await v.current.play();
        const tick = async () => { if (stop) return; try { const r = await det.detect(v.current); if (r[0]?.rawValue) onCode(String(r[0].rawValue)); } catch { /* frame not ready */ } timer = window.setTimeout(tick, 400); }; tick();
      } catch (e: any) { setErr(e?.name === "NotAllowedError" ? "Camera permission was denied. Type or paste the serial instead." : "Camera not available. Type or paste the serial instead."); }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return <div className="fp-field"><video ref={v} className="fp-video" muted playsInline aria-label="Camera preview" />{err && <p className="fp-msg err">{err}</p>}<button className="fp-btn" onClick={onClose}>Stop scanning</button></div>;
}
