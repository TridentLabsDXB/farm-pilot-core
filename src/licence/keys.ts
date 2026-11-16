// Public keys the box trusts, by key_id (SPKI DER, base64). The PRIVATE keys are never in the repo, the bundle or any box: they stay with Trident Labs, offline.
// Rotation: add the new key here under a new key_id and issue new licences with it; old licences keep verifying until their key_id is removed in a later build.
//
// 2026-11-17 -- TWO sets:
//   PROD_KEYS  trusted by EVERY build. Empty until the production key pair exists: generate it OFFLINE (docs/licence-production-keys.md), then add ONE line here, for example
//              "prod-1": "MCowBQYDK2VwAyEA...=",
//   DEV_KEYS   dev-1 is a DEVELOPMENT key (its private half lives on the build server only, outside the repo). It verifies ONLY in builds that are not stamped as a release,
//              so a customer build (./deploy.sh --release, dist/BUILD.json "released") accepts prod keys only. `./deploy.sh --release` refuses to build while PROD_KEYS is empty.
import { readBuild } from "../about/build.js";

export const PROD_KEYS: Record<string, string> = {
};
export const DEV_KEYS: Record<string, string> = {
  "dev-1": "MCowBQYDK2VwAyEAB3lIG4L9gQP6+Uu0oSD4UJQqWWt8/jvPwTv/JFxC5HY=",
};
/** The keys a build trusts: production keys always, dev keys only when the build is not a release (`released` is null in dist/BUILD.json). */
export const trustedKeys = (released: string | null): Record<string, string> => ({ ...PROD_KEYS, ...(released === null ? DEV_KEYS : {}) });
export const LICENCE_PUBLIC_KEYS: Record<string, string> = trustedKeys(readBuild().released);
