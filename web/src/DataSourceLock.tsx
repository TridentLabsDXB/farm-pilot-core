import { api } from "./api";
import { go } from "./App";
import { Chip } from "./ui";

/** Licence access of the PLC and V-BOX data sources (GET /api/data-sources/access). tier rule: PRO or higher (src/deployments/tiers.ts, the server decides; the web only shows it). */
export interface DsAccess { tier: string; state: "allowed" | "grace" | "stopped" | "locked"; run: boolean; message: string | null; graceEnds: string | null; }
export const LOCK_WORD = "LOCKED";
export const loadAccess = () => api<DsAccess>("/data-sources/access");

/** The locked page of FREE: one plain message and a link to About (where a licence is uploaded). Stored data stays readable elsewhere; this page shows no editor. */
export function LockedPage({ title, message }: { title: string; message: string }) {
  return (
    <section className="fp-card" aria-label={`${title} locked`} data-testid="ds-locked">
      <h3>{title}</h3>
      <p className="fp-msg"><Chip tone="off">LOCKED</Chip> {message}</p>
      <button className="fp-btn primary" onClick={() => go("/about")}>GO TO ABOUT</button>
    </section>
  );
}
/** Grace or stopped: a visible warning above the page. */
export const AccessBanner = ({ a }: { a: DsAccess }) => (a.state === "grace" || a.state === "stopped" ? <p className={"fp-msg" + (a.state === "stopped" ? " err" : "")} role="status" data-testid="ds-warn"><Chip tone={a.state === "stopped" ? "alarm" : "warn"}>{a.state === "stopped" ? "STOPPED" : "GRACE"}</Chip> {a.message}</p> : null);
