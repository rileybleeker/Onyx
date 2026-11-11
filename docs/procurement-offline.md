# Procurement: offline foundation

Route: `/procurement`. This is a planning preview, not a functioning purchasing integration.

## What works
- Navigation through the shared desktop/mobile/palette catalog.
- Honest disconnected subscription state, opt-in synthetic examples, generic buying checklist.
- In-memory USD order drafts with exact-cent validation, one-time/monthly commitment, removal and clear.
- No localStorage, database, merchant calls, account discovery, credential entry, or external product recommendations.
- Drafts disappear on reload. Provider management and ordering remain disabled. `executionReadiness()` always fails closed.

## Future execution boundary (not implemented)
An authenticated server must own every quote and authorization, never trust a client approval boolean. The immutable quote needs merchant identity, item/quantity, delivered total including all fees, currency, recurrence/renewal price, fulfillment destination/method, cancellation/refund restrictions, and opaque payment-method reference. Never store card numbers or secrets here.

Authorization must bind the owner, quote revision and exact terms, have a short expiry, and be revoked on any material change. Before execution, revalidate current quote, limits and provider connection. Enforce a server-side idempotency key and atomic execution lock. Record pending, confirmed, failed and unknown outcomes separately. After a timeout, reconcile the provider transaction before any retry. Maintain an audit trail without secrets. Require provider-specific cancellation confirmation and verify the effective date rather than presenting a local state change as cancellation. A draft is not authorization.

No live adapter or authorization endpoint exists in this patch; a UI flag cannot enable spending. Recommendation adapters must return evidence, price timestamps and availability, and distinguish stale, unavailable and empty data. Keep recommendations independent of checkout and label sponsored content if introduced.

Financials has a separate unmerged branch; this module neither reads its data nor claims a connection. Integrate later through an explicit reviewed contract, not a duplicate CSV parser or account scraper.

## Verification
Run from repository root:
- `node frontend/scripts/test-procurement.mjs`
- `node frontend/node_modules/typescript/bin/tsc --project frontend/tsconfig.json --noEmit --incremental false`
- `node frontend/scripts/test-procurement-ui.mjs`

The browser test copies only this module and styles into an isolated temporary Next fixture, supplies no secrets, binds localhost and blocks nonlocal browser requests. It does not weaken application authentication. The real Onyx shell/auth and production smoke suite are deliberately not exercised during the outage. No PR, push, deployment, migration or production-backed CI is part of this patch.
