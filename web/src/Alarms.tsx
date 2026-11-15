import type { Scada } from "./api";
import { Chip, ago } from "./ui";
export default function Alarms({ scada }: { scada: Scada | null }) {
  if (!scada) return <main className="fp-page"><p className="fp-msg">Loading...</p></main>;
  const KIND: Record<string, string> = { gateway_offline: "GATEWAY OFFLINE", no_update: "NO UPDATE", low_battery: "LOW BATTERY", calibration_due: "CALIBRATION DUE" };
  return (
    <main className="fp-page"><section className="fp-card"><h3>Active alarms</h3>
      {!scada.alarms.length ? <Chip tone="ok">NO ACTIVE ALARMS</Chip> : <ul className="fp-list">{scada.alarms.map((a, i) => (
        <li key={i}><span className="fp-row"><Chip tone={a.severity === "alarm" ? "alarm" : "warn"}>{KIND[a.kind] ?? a.kind}</Chip><span style={{ fontFamily: "var(--fp-head)", fontSize: 16, fontWeight: 700 }}>{a.text}</span></span><span className="fp-muted">{a.since ? `since ${ago(a.since, scada.now)}` : ""}</span></li>))}</ul>}
    </section></main>
  );
}
