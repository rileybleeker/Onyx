# Onyx rewards harvester

Runs on the collector PC every 12 h ("Onyx Rewards Harvest" in Task Scheduler). It opens each loyalty
program's account page in a persistent Chrome profile (`%LOCALAPPDATA%\Onyx\rewards-harvest-profile`,
window parked off-screen), reads the site's own JSON responses (visible-text patterns as a fallback)
and upserts one row per program into `pds.rewards_balances`, then writes one `rewards|balances`
heartbeat to `pds.sync_log` (`success`; `partial` naming each program whose sign-in is missing/expired or
whose page could not be read; `failed` on a crash). It writes with the service key in
`~/.onyx_supabase_secret` (same file the PC activity logger uses).

Programs: `amex_mr`, `delta_skymiles`, `hilton_honors`, `marriott_bonvoy`, `uber_cash`, `uber_one`
(`uber_one`: balance 1 = member, 0 = not, renewal date in `expires_on`).

**Privacy.** Only allow-listed fields are read (`lib.mjs`): a balance, a tier word, progress numbers and an
expiry/renewal date. Never a member number, name, email, address, phone or card number. Logs and
heartbeats name programs and causes, never values. No passwords or codes are typed by the script, and
there are no stealth flags: if a site blocks the off-screen window, that program reports the cause.

## Signing in (Riley, once per site, then again when a site ends the session)

For each program, run (on the PC), sign in yourself, then CLOSE the Chrome window:

```
cd C:\Users\riley\Onyx\tools\rewards_harvest
node harvest.mjs --login amex_mr
node harvest.mjs --login delta_skymiles
node harvest.mjs --login hilton_honors
node harvest.mjs --login marriott_bonvoy
node harvest.mjs --login uber_cash      # one Uber sign-in covers uber_one as well
```

Tick "keep me signed in / remember me" where the site offers it. Check afterwards with
`node harvest.mjs --dry-run` (prints which programs are readable; writes nothing).

## Fixing an adapter

The account pages were built blind (no signed-in session was available when this was written). If a
program reports "balance could not be read": run `node harvest.mjs --probe --only <program>`, open
`%LOCALAPPDATA%\Onyx\rewards-harvest\probe.json`. The probe is read-only (no upsert, no heartbeat unless
you add `--save`). It holds a fixed endpoint label instead of the address, key names/types only for
allow-listed keys (`PROBE_KEYS` in `lib.mjs`), and a count of every other key, never its name. If the
balance key you need is not on the list, the count tells you it exists: add its name to the program's
list in `lib.mjs` (and `PROBE_KEYS` follows). Add the right key name to that program's list in `lib.mjs`. Add a synthetic case to `lib.test.mjs`.

## Commands

`node harvest.mjs` scheduled run - `--dry-run` - `--probe` - `--only <program>` - `--headed` - `--login <program>`.
Register the task: `pwsh -File register-task.ps1`. Log: `%LOCALAPPDATA%\Onyx\rewards-harvest\harvest.log`.
Install once: `npm install` in this folder.
