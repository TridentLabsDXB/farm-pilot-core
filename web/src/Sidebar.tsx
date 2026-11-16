import { useEffect, useState } from "react";
import { api, type PublicProfile, type Scada } from "./api";
import { go } from "./App";
import { Chip, type Tone } from "./ui";

// Settings items (Admin only), in this order. Old paths (#/settings/gateway, /structure) redirect to the new ones.
export const TABS: [string, string][] = [["farm-profile", "FARM PROFILE"], ["farm-structure", "FARM STRUCTURE"], ["sensors-gateway", "SENSORS GATEWAY"], ["sensors", "SENSORS"], ["users", "USERS"], ["backup", "BACKUP"]];
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

/** Persistent left sidebar: logo and farm name on top, then SCADA, ALARMS and (Admin) the Settings items. Panel: always visible. Tablet: drawer. Phone: hidden (bottom nav). */
export default function Sidebar({ pub, cur, tab, admin, nAlarms, badges }: { pub: PublicProfile | null; cur: string; tab?: string; admin: boolean; nAlarms: number; badges: Record<string, Badge> }) {
  return (
    <nav className="fp-sb" aria-label="Main">
      <div className="fp-sb-brand">{pub?.logo_url && <img src={pub.logo_url} alt="" />}<span>{pub?.farm_name ?? ""}</span></div>
      <button className="fp-tab" aria-current={cur === "scada" ? "page" : undefined} onClick={() => go("/scada")}>SCADA</button>
      <button className="fp-tab" aria-current={cur === "alarms" ? "page" : undefined} onClick={() => go("/alarms")}><span>ALARMS</span>{nAlarms > 0 && <span className="fp-badge">{nAlarms}</span>}</button>
      {admin && <>
        <span className="fp-cap fp-sb-group">Settings</span>
        {TABS.map(([k, l]) => <button key={k} className="fp-tab" aria-current={cur === "settings" && tab === k ? "page" : undefined} onClick={() => go("/settings/" + k)}><span>{l}</span>{badges[k] && <Chip tone={badges[k]!.tone}>{badges[k]!.word}</Chip>}</button>)}
      </>}
    </nav>
  );
}
