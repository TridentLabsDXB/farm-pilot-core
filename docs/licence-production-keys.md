# Production licence keys: generate offline, publish only the public half

Who: Trident Labs only. Why: every box trusts the public keys listed in `src/licence/keys.ts`. Whoever holds a matching private key can issue licences, so that key must never touch a networked machine, this repository, a bundle or a box. `dev-1` is a development key (its private half sits on the build server); a box that trusts it must not go to a customer.

## 1. Generate the key pair on an offline machine
Use a laptop or small PC that is never connected to a network while the private key exists on it (disconnect it, or boot a live USB system). It needs Node 22 and a copy of this repository (a USB copy is fine; no `npm install` is needed for keygen beyond the repo's `node_modules`, so copy those too, or run `npm ci` once beforehand while still online).

```bash
cd farmpilot-core
npm run licence -- keygen --key-id prod-1 --out /media/usb-keys/farmpilot
```

- `--key-id` is a lower-case name you will never reuse (`prod-1`, later `prod-2`). It is written into every licence it signs.
- The tool refuses a folder inside the repository and refuses to overwrite an existing key.
- It writes `prod-1.private.pem` (owner-only) and `prod-1.public.txt`, and prints the exact line for `keys.ts`.

## 2. Store the private key
- Keep at least two encrypted copies on separate offline media (for example two USB sticks in two places). Losing the key means no new licences can be issued under that `key_id`; a leaked key means every licence is forgeable, and you must rotate (step 5).
- Write the key id, the creation date and the public key SHA-256 (`sha256sum prod-1.public.txt`) in the key register.

## 3. Put the public key into CORE
Copy only the printed line (never the `.pem`) from the offline machine, for example by typing or by copying `prod-1.public.txt` to a USB stick, into `src/licence/keys.ts`:

```ts
export const LICENCE_PUBLIC_KEYS: Record<string, string> = {
  "prod-1": "MCowBQYDK2VwAyEA...=",
};
```

`keys.ts` has two sets: `PROD_KEYS` (trusted by every build, put the prod line there) and `DEV_KEYS` (`dev-1`). **`dev-1` is trusted only by builds that are not a release**: a build made with `./deploy.sh --release` writes `released` into `dist/BUILD.json` and then accepts production keys only. `./deploy.sh --release` also refuses to run while `PROD_KEYS` has no `prod-N` line. Commit, then build with `./deploy.sh --release`. Check on a test box: a licence signed with the new key installs; a licence signed with `dev-1` is refused with BAD_SIGNATURE.

## 4. Issue a licence (offline machine again)
1. The customer opens About and sends the Device ID (`FP-XXXX-XXXX-XXXX`, use COPY).
2. On the offline machine:
   ```bash
   npm run licence -- sign --key /media/usb-keys/farmpilot/prod-1.private.pem --key-id prod-1 \
     --device FP-XXXX-XXXX-XXXX --licensed-to "Customer Name" --type PRO \
     --gateways 2 --sensors 50 --valid-until 2027-12-31 --seq 1 --out customer.fplic
   # many at once: npm run licence -- batch --csv devices.csv --type PRO --key /media/usb-keys/farmpilot/prod-1.private.pem --key-id prod-1 --out ./licences/ --zip --gateways 2 --sensors 50
   npm run licence -- verify customer.fplic --device FP-XXXX-XXXX-XXXX --public-key-file /media/usb-keys/farmpilot/prod-1.public.txt
   ```
3. `--seq` rises with every licence issued the same day for any customer (the licence id is `FPL-YYYYMMDD-NNNN` and a box refuses an older id than the one installed). A re-issue for a replaced or cloned box is a new licence for the new Device ID after you have verified the customer.
4. Send the `.fplic` file; the customer's Admin uploads it on the About page.

## 5. Rotation or a leaked key
Generate `prod-2` the same way, add its public line to `keys.ts` next to `prod-1`, ship a CORE update, then issue new licences with `prod-2`. Existing `prod-1` licences keep working until a later build removes the `prod-1` line (that is also how to revoke a leaked key). Never reuse a `key_id`.

## Checks that protect you
`test/licence-issue.test.ts` fails if any private key appears in a repository file, and the tool refuses to read or write a key inside the repository. `tools/` is excluded from the build (`tsconfig`) and from `git archive` (`.gitattributes`); keep it out of any hand-made bundle too.

## Exact commands for the production key (run on the OFFLINE machine, never on the bench)
```bash
# 1. offline laptop, network disabled, Node 22 and a USB copy of this repository (with node_modules)
cd farmpilot-core
npm run licence -- keygen --key-id prod-1 --out /media/usb-keys/farmpilot
sha256sum /media/usb-keys/farmpilot/prod-1.public.txt        # write this into the key register
# 2. copy ONLY prod-1.public.txt to a networked machine (the .pem never leaves the offline media)
# 3. on the development machine: add the single line printed by keygen to PROD_KEYS in src/licence/keys.ts
#      "prod-1": "<contents of prod-1.public.txt>",
# 4. commit, then: ./deploy.sh --release        (refuses if PROD_KEYS is empty or the tree is dirty)
# 5. on a test box: install a licence signed with prod-1 (works) and one signed with dev-1 (BAD_SIGNATURE)
```
