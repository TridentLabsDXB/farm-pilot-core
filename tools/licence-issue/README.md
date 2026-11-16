# licence-issue (Trident Labs only)

Signs and checks `.fplic` licence files. **Not part of the CORE bundle.** It never ships to a box, and the private key never enters this repository.
The private key is read from its file (`--key`) and is never printed, logged or copied. The tool refuses a key path inside the repository.

## Commands
- `npm run licence -- keygen --key-id prod-1 --out <offline folder>` makes a key pair (the tool refuses a folder inside the repo). Put only the **public** line into `src/licence/keys.ts` (see `docs/licence-production-keys.md`).
- `npm run licence -- sign ...` issues ONE licence for one Device ID (copied from the customer's About page). Options in the header of `index.ts`.
- `npm run licence -- batch ...` (or `-- --batch devices.csv ...`) issues many at once, see below.
- `npm run licence -- verify file.fplic [--device FP-...]` checks a file exactly the way a box does.

New licences are **format 2** (`docs/licence-format.md`): limits `gateways`, `sensors`, `reports_days`, `retention_days`; a limit of **null / "unlimited"** means unlimited, `retention_days` null means history is never pruned.

## Licence types
- **PRO** (and any other customer type): needs `gateways` and `sensors` (a number or `unlimited`); `reports_days` and `retention_days` default to 365. FREE is built into the box and never has a file.
- **ENGINEERING**: **Trident machines only** (the bench, development and demo boxes). Every limit is null, no expiry, and the tool refuses limit options or an expiry for this type. The box shows it as **ENGINEERING LICENCE** (header chip and About), never as PRO. Do not issue it to a customer.

## Batch mode
```bash
npm run licence -- batch --csv devices.csv --type PRO --key /secure/offline/prod-1.private.pem --key-id prod-1 \
  --out ./licences/ [--zip] [--seq 1] [--gateways 2 --sensors 50 --reports-days 365 --retention-days 365]
# same thing:  npm run licence -- --batch devices.csv --type PRO --key ... --key-id prod-1 --out ./licences/ --zip
```
`devices.csv` has a header row. Columns: `device_id`, `licensed_to`, `valid_until` (blank = no expiry; `YYYY-MM-DD` = end of that day UTC), and optional `gateways`, `sensors`, `reports_days`, `retention_days` (blank = the command-line value or the default; `unlimited` = null). RFC 4180 quoting works (`"Al Maimoon, Farm A"`).

- Every Device ID must look like `FP-XXXX-XXXX-XXXX`; duplicates are refused (also when only the letter case differs).
- One file per row: `<licensed_to>-<device_id>.fplic` in `--out`. Licence ids are `FPL-YYYYMMDD-NNNN`, counting up from `--seq` (use a `--seq` higher than any licence already issued the same day).
- Everything is validated and signed (and each file is verified against the matching public key) **before anything is written**: one bad row writes nothing. An existing file is never overwritten.
- It prints a table of what was issued (file, licence id, device, customer, type, limits, expiry). `--zip` also writes `licences-<date>-<type>.zip` with the same files.

Re-issue for a replaced or cloned box is a manual support step: verify the customer, issue a new file with the next `--seq` for the new Device ID.
