import { useEffect, useState } from "react";
import { api, type PublicProfile, type Scada } from "./api";
import { go } from "./App";
import { Chip, type Tone } from "./ui";
import { BrandMark } from "./Brand";

// Menu groups (Admin only), decided 2026-11-17: SETTINGS describes the farm, DATA SOURCES says where data comes from, SYSTEM is about the box itself.
// Only the grouping in the menu changed; every route (#/settings/<key>) and API path is the same as before.
export const GROUPS: { title: string; tabs: [string, string][] }[] = [
  { title: "Settings", tabs: [["farm-profile", "FARM PROFILE"], ["farm-structure", "FARM STRUCTURE"]] },
  { title: "Data sources", tabs: [["rs485-ports", "RS-485 PORTS"], ["sensors-gateway", "SENSORS GATEWAY"], ["mqtt-payload", "MQTT PAYLOAD"], ["sensors", "SENSORS"]] },
  { title: "System", tabs: [["users", "USERS"], ["backup", "BACKUP"]] },
];
export const TABS: [string, string][] = GROUPS.flatMap((g) => g.tabs);
export const LEGACY: Record<string, string> = { gateway: "sensors-gateway", structure: "farm-structure", profile: "farm-profile" };
export type Badge = { tone: Tone; word: string } | undefined;

/** Attention badges (lamp + word) for the Settings items: gateway offline / sync failed, unsent changes, old backup, profile not set up. */
export function useBadges(scada: Scada | null, tab: string | undefined, enabled: boolean) {
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  useEffect(() => {
    if (!enabled) return; let live = true;
    Promise.all([api<any>("/gateway").catch(() => null), api<{ lastExportAt: number | null; warnDays: number }>("/backup/status").catch(() => null), api<any>("/farm-profile").catch(() => null)]).then(([gw, bk, pr]) => {
      if (!live) return; const b: Record<string, Badge> = {};
      if (gw?.enabled && !gw.online) b["sensors-gateway"] = { tone: "alarm", word: "OFFLINE" }; else if (gw?.lastSync && !gw.lastSync.ok) b["sensors-gateway"] = { tone: "alarm", word: "SYNC FAILED" };
      if (gw?.unsent) b.sensors = { tone: "warn", word: `${gw.unsent} NOT SENT` };
      if (bk && (!bk.lastExportAt || Date.now() - bk.lastExportAt > bk.warnDays * 86400000)) b.backup = { tone: "warn", word: bk.lastExportAt ? "OLD" : "NONE YET" };
      if (pr?.placeholder || pr?.timezone_confirm_needed) b["farm-profile"] = { tone: "warn", word: pr.timezone_confirm_needed ? "CHECK ZONE" : "SET UP" };
      setBadges(b);
    });
    return () => { live = false; };
  }, [scada, tab, enabled]);
  return badges;
}

/** Persistent left sidebar: logo and farm name on top, then ALARMS, MONITORING, CONTROL and (Admin) the groups SETTINGS, DATA SOURCES and SYSTEM. Panel: always visible. Tablet: drawer. Phone: hidden (bottom nav). */
export default function Sidebar({ version, pub, cur, tab, admin, nAlarms, badges, online = false, nLicences = 0 }: { version: string; pub: PublicProfile | null; cur: string; tab?: string; admin: boolean; nAlarms: number; badges: Record<string, Badge>; online?: boolean; nLicences?: number }) {
  return (
    <nav className="fp-sb" aria-label="Main">
      <div className="fp-sb-brand"><BrandMark pub={pub} /><span className="fp-sb-name">{pub?.farm_name ?? ""}</span></div>
      <button className="fp-tab" aria-current={cur === "alarms" ? "page" : undefined} onClick={() => go("/alarms")}><span>ALARMS</span>{nAlarms > 0 && <span className="fp-badge">{nAlarms}</span>}</button>
      <button className="fp-tab" aria-current={cur === "monitoring" ? "page" : undefined} onClick={() => go("/monitoring")}>MONITORING</button>
      <button className="fp-tab" aria-current={cur === "control" ? "page" : undefined} onClick={() => go("/control")}>CONTROL</button>
      {admin && GROUPS.filter((g) => g.tabs.length > 0).map((g) => <div key={g.title} className="fp-sb-grp" role="group" aria-label={g.title}>
        <span className="fp-cap fp-sb-group">{g.title}</span>
        {g.tabs.map(([k, l]) => <button key={k} className="fp-tab" aria-current={cur === "settings" && tab === k ? "page" : undefined} onClick={() => go("/settings/" + k)}><span>{l}</span>{badges[k] && <Chip tone={badges[k]!.tone}>{badges[k]!.word}</Chip>}</button>)}
        {/* 2026-11-17: Licence Management, Online build only (online comes from /api/me), Admin only (this block). Amber count of EXPIRING + EXPIRED deployments, hidden at 0. */}
        {g.title === "System" && online && <button className="fp-tab" aria-current={cur === "licences" ? "page" : undefined} onClick={() => go("/licences")}><span>LICENCE MANAGEMENT</span>{nLicences > 0 && <span className="fp-badge fp-badge-warn" aria-label={`${nLicences} need attention`}>{nLicences}</span>}</button>}
      </div>)}
      {!admin && <button className="fp-tab" aria-current={cur === "settings" && tab === "mqtt-payload" ? "page" : undefined} onClick={() => go("/settings/mqtt-payload")}>MQTT PAYLOAD</button>}   {/* Operators: read-only page, no group heading */}
      <div className="fp-sb-bottom">
        <button className="fp-tab" aria-current={cur === "about" ? "page" : undefined} onClick={() => go("/about")}>ABOUT</button>
        <span className="fp-cap fp-sb-ver">FARM-PILOT CORE{version ? ` · v${version}` : ""}</span>
      </div>
    </nav>
  );
}
