# Sign-ins: policy

Goal (Riley, 2026-11-17): work completes without manual sign-ins, and anything that does need him
is warned about early and batched into one short monthly list.

One registry, `frontend/src/lib/signin-registry.ts`, lists every credential Onyx depends on: what it
is, whether it renews itself, how Riley renews it, its lifetime rule and how its health is read
(card status keys from `/api/status`, plus a fixed or derived expiry date). `/api/status` returns a
`signins` block (label, state, renew-by date only; never a token, id or account) and `/status` shows
it as the **Sign-ins** card at the top. States: `ok`, `due_soon` (date within 21 days, or a Riley
credential whose sync is partial), `needs_riley` (date passed, or a Riley credential whose sync
failed), `unknown` (nothing readable, or not connected yet).

## Rules

1. **Preference order for a NEW source:** no-auth > API key / service token > OAuth with refresh
   (blob in `pds.ci_tokens`, newer-wins writes through a database function, a heartbeat that warns
   14+ days before any hard expiry) > app password / URL secret > scheduled export > email receipts >
   browser-session harvester. A browser-session harvester is the last resort and only with Riley's
   explicit opt-in per source, because it needs his sign-in each time the site ends the session.
2. **Every credential gets a registry entry in the same PR that adds it** (and a card on `/status`,
   per the status rule). A PR that adds a secret, token, session or certificate without an entry is
   incomplete.
3. **Renewals Riley must do are batched into the monthly checklist:** the Sign-ins card lists every
   Riley-renewed credential that is due within 45 days or needs him now, sorted by date, each with
   its one-line how-to. Do not add separate reminders, agent cards or alerts for a renewal.
4. **OAuth that needs periodic consent gets an in-app Reconnect flow** like Spotify's (`/status`
   card, owner-session routes, state cookie, store only after a check call), never a code pasted
   into a workflow input as the normal route.
5. A credential whose expiry cannot be derived says so (`expiry: none` in its entry) and relies on
   its heartbeat; give the heartbeat a message that names the cause, never the secret.

## Known gaps (no derivable expiry)

- Kindle / Amazon, Uber Eats, goPuff browser sessions: the site decides; only the failed heartbeat shows it.
- Gmail app passwords: no expiry; revocation shows as a partial or failed email heartbeat.
- YouTube Takeout: one year from creation, but the creation date is not recorded; the card goes
  partial when the last import is over 100 days old.
- SimpleFIN (about 2027-11-14) and Apple signing (2027-11-10) are fixed dates in the registry: update
  them when renewed.
- Twilio (sms-reminders) is out of scope here.
