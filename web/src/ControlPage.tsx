import type { Scada, State } from "./api";
import { useNow } from "./ui";
import ControlCard from "./ControlCard";
import { GROUPS, controlLoadState, type ControlDevice } from "./control";

// 2026-11-16 -- CONTROL page (/control): devices grouped WATER PUMPS / FANS (EXHAUST and MIXING sub-label on the card) / VALVES AND ACTUATORS / OTHER.
// Only groups that have devices are drawn. When only pumps exist, one muted line says where fans and the rest will appear.
export default function ControlPage({ devices, error, onRetry, state, scada, reload }: { devices: ControlDevice[] | null; error: string | null; onRetry: () => void; state: State | null; scada: Scada | null; reload: () => void }) {
  const now = useNow(1000);
  const load = controlLoadState(devices, error, !!state);
  if (load === "error") return <main className="fp-page"><div className="fp-card" role="alert" data-testid="control-error"><h3>CONTROL could not be loaded</h3><p className="fp-msg err">{error}</p><button className="fp-btn" style={{ minHeight: 56 }} onClick={onRetry}>RETRY</button></div></main>;
  if (load === "loading" || !devices || !state) return <main className="fp-page"><p className="fp-msg" data-testid="control-loading">Loading...</p></main>;
  const zoneName = (id: number | null) => (id === null ? null : scada?.zones.find((z) => z.id === id)?.name ?? null);
  const groups = GROUPS.map((g) => ({ ...g, items: devices.filter((d) => g.kind.includes(d.kind)) })).filter((g) => g.items.length);
  const onlyPumps = devices.every((d) => d.kind === "pump");
  return (
    <main className="fp-page">
      {groups.map((g) => (
        <section key={g.title} aria-label={g.title}>
          <h2 className="fp-cap" style={{ margin: "0 0 10px" }}>{g.title}</h2>
          <div className="fp-grid">{g.items.map((d) => <ControlCard key={d.id} device={d} state={state} zoneName={zoneName(d.zoneId)} now={now} reload={reload} />)}</div>
        </section>
      ))}
      {onlyPumps && <p className="fp-msg fp-muted" data-testid="control-empty">Fans, valves and other actuators will appear here when they are configured</p>}
    </main>
  );
}
