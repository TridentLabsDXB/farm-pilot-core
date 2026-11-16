# Licence file format v1 (FROZEN) and format 2 (2026-11-17)

Spec: About page and licensing (Option A). Code: `src/licence/format.ts`. The signature of a fixed test licence is pinned in `test/licence.test.ts`, so any change to this format fails a test. A change needs a new format version, not an edit.

## File
`*.fplic`, UTF-8 JSON object, at most **16 KB**. Exactly these fields (unknown or missing fields = `NOT_A_LICENCE`):

| field | type | rule |
|---|---|---|
| `licence_id` | string | `FPL-YYYYMMDD-NNNN` (fixed width). Compared as text: a licence older than the installed one is refused (`OLDER_LICENCE`); the same id again is accepted. |
| `type` | string | `[A-Z][A-Z0-9_]{1,15}`, not `FREE` (FREE is built in and needs no file). Example `FULL`. |
| `licensed_to` | string | 1 to 120 characters, no leading or trailing space. |
| `device_id` | string | `FP-XXXX-XXXX-XXXX` (upper-case hex). Must equal this box (`WRONG_DEVICE`). |
| `limits` | object | exactly `gateways` (0..1000) and `sensors` (0..100000), whole numbers. Sensors count all types together. |
| `features` | string[] | up to 50 lower-case names `[a-z0-9_]{1,40}`. Empty for now. |
| `issued_at` | string | UTC, `YYYY-MM-DDTHH:MM:SSZ`. |
| `valid_until` | string or null | same format, or `null` = no expiry. Checked against the box clock (`EXPIRED`). |
| `key_id` | string | `[a-z0-9-]{1,32}`: which public key verifies this file (rotation). |
| `signature` | string | base64url of the 64-byte Ed25519 signature. |

## Signature
Message = the ASCII line `farmpilot-licence-v1` + `\n` + the **canonical JSON** of the object without `signature`: object keys sorted (by UTF-16 code unit) at every level, no whitespace, arrays in order, numbers and strings as `JSON.stringify` writes them. Signed with Ed25519 (`crypto.sign(null, message, privateKey)`). The box holds only public keys (`src/licence/keys.ts`, SPKI DER base64, by `key_id`).

## Device ID
`FP-` + first 12 hex characters of SHA-256(`"farmpilot-core|"` + machine id, trimmed and lower-cased), upper-case, in groups of 4. Machine id: Linux `/etc/machine-id` (fallback `/var/lib/dbus/machine-id`); Windows registry `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`.

## Check order on the box
size and shape (`NOT_A_LICENCE`), signature (`BAD_SIGNATURE`; unknown `key_id` too), device (`WRONG_DEVICE`), expiry (`EXPIRED`), age (`OLDER_LICENCE`). An expired licence already on the box stays visible as EXPIRED and the FREE limits apply.

## On the box
`<data folder>/licence/current.fplic` (owner-only) plus the parsed copy in table `licence`. At start and once a day the file is read and verified again, and it must match the stored record (SHA-256). A file that fails (changed, another box, key removed, missing) shows INVALID and the FREE limits apply. A licence only ever limits ADDING sensors and gateways.

## Keys
`dev-1` in `src/licence/keys.ts` is a development key. Production: Trident Labs generates the real pair offline, adds only the public half here under a new `key_id`, and issues with `tools/licence-issue`. The private key never enters the repo, a bundle or a box.

## Format 2 (added 2026-11-17)
v1 above is unchanged and still verifies. Format 2 adds what v1 had no room for. A box that predates it refuses a format 2 file (`NOT_A_LICENCE`), so update the box first.

- New field `format_version` = `2`. A v1 file has no such field. Any other value is `NOT_A_LICENCE`.
- `limits` has exactly `gateways`, `sensors`, `reports_days`, `retention_days`. Each is a whole number or **`null` = unlimited** (`retention_days` null = never prune history). Ranges: gateways 0..1000, sensors 0..100000, reports_days 1..3650, retention_days 1..3650.
  - `reports_days`: how far back charts, CSV export and Reports reach. `retention_days`: how long history (raw and hourly rows) is kept; the retention job reads it at every run.
- Signed message prefix is `farmpilot-licence-v2` + `\n` (v1 keeps `farmpilot-licence-v1`); the rest of the rule is the same. `format_version` and every limit are inside the signature.
- A v1 licence on a box means reports unlimited inside retention and history kept 365 days. FREE (built in, also EXPIRED and INVALID): 1 gateway, 10 sensors, reports 7 days, history kept 90 days.
- **ENGINEERING** is a type that must be format 2 with every limit null and `valid_until` null (anything else is `NOT_A_LICENCE`). It is for Trident machines only and is shown as "ENGINEERING LICENCE".
- Retention note: when a licence expires or is removed the FREE numbers apply again, and the next retention run removes history older than 90 days. There is no grace period yet.
