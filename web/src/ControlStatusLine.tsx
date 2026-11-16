import type { State } from "./api";
import { go } from "./App";
import { Chip } from "./ui";
import { deviceState, statusLabel, type ControlDevice } from "./control";

// 2026-11-16 -- read-only control status line on SCADA (under the alarm banner): lamp + word per control device, no buttons.
// Uses deviceState() on the same `state` CONTROL uses (no second request). More than 6 devices collapse to "N of M running".
export default function ControlStatusLine({ devices, state, now, error, onRetry }: { devices: ControlDevice[] | null; state: State; now: number; error?: string | null; onRetry?: () => void }) {
  if (error && !devices) return <div className="fp-ctl-line" role="status" data-testid="control-status-line"><span className="fp-ctl-item"><span className="fp-cap">CONTROL</span><Chip tone="off">UNKNOWN</Chip></span><span className="fp-msg">Control status unavailable: {error}</span>{onRetry && <button className="fp-btn small" onClick={onRetry}>RETRY</button>}</div>;
  if (!devices?.length) return null;
  const st = devices.map((d) => deviceState(d, state, now)); const running = st.filter((s) => s === "on").length;
  return (
    <div className="fp-ctl-line" role="status" aria-label="Control status" data-testid="control-status-line">
      {devices.length > 6
        ? <span className="fp-ctl-item"><Chip tone={running ? "ok" : "off"}>{running} OF {devices.length} RUNNING</Chip>{st.includes("unknown") && <Chip tone="off">{st.filter((s) => s === "unknown").length} UNKNOWN</Chip>}</span>
        : devices.map((d, i) => <span key={d.id} className="fp-ctl-item"><span className="fp-cap">{statusLabel(d, devices)}</span><Chip tone={st[i] === "on" ? "ok" : "off"}>{st[i].toUpperCase()}</Chip></span>)}
      <a className="fp-ctl-link" href="#/control" onClick={(e) => { e.preventDefault(); go("/control"); }}>Open CONTROL</a>
    </div>
  );
}
