// Public keys the box trusts, by key_id (SPKI DER, base64). The PRIVATE keys are never in the repo, the bundle or any box: they stay with Trident Labs, offline.
// Rotation: add the new key here under a new key_id and issue new licences with it; old licences keep verifying until their key_id is removed in a later build.
// !! dev-1 is a DEVELOPMENT key (its private half lives on the build server only, outside the repo). Replace it with the production key before the first customer box ships.
export const LICENCE_PUBLIC_KEYS: Record<string, string> = {
  "dev-1": "MCowBQYDK2VwAyEAB3lIG4L9gQP6+Uu0oSD4UJQqWWt8/jvPwTv/JFxC5HY=",
};
