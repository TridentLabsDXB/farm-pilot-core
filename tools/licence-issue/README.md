# licence-issue (Trident Labs only)

Signs and checks `.fplic` licence files. **Not part of the CORE bundle.** It never ships to a box, and the private key never enters this repository.

- `npm run licence -- keygen --key-id prod-1 --out <offline folder>` makes a key pair (the tool refuses a folder inside the repo). Put only the **public** line into `src/licence/keys.ts`.
- `npm run licence -- sign ...` issues a licence for one Device ID (copied from the customer's About page). See the header of `index.ts` for all options.
- `npm run licence -- verify file.fplic [--device FP-...]` checks a file exactly the way a box does.

Re-issue for a replaced or cloned box is a manual support step: verify the customer, issue a new file with the next `--seq` for the new Device ID. Format: `docs/licence-format.md` (frozen).
