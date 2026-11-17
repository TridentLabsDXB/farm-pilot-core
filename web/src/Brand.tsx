import type { PublicProfile } from "./api";

// 2026-11-18 -- farm mark for the shared shell: the farm logo (round, object-fit: contain) or, with no logo set, a round placeholder with the farm's initials, SAME size. 104 px in the sidebar, 36 px in the phone header.
// Layout lives in core.css (.fp-sb-brand, .fp-brand-*), guarded by test/shell-brand.test.ts so it cannot regress.
export const initials = (name: string | null | undefined) => {
  const w = (name ?? "").trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)); if (!w.length) return "FP";
  const first = (x: string) => (x.match(/[\p{L}\p{N}]/u) ?? [""])[0].toUpperCase();
  return (w.length === 1 ? Array.from(w[0].replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2).join("").toUpperCase() : first(w[0]) + first(w[1])) || "FP";
};
export function BrandMark({ pub }: { pub: PublicProfile | null }) {
  return pub?.logo_url ? <img className="fp-brand-mark" src={pub.logo_url} alt="" /> : <span className="fp-brand-mark fp-brand-ph" aria-hidden="true">{initials(pub?.farm_name)}</span>;
}
