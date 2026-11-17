# Synthetic consulting case pilot (PROD-T09, 2026-11-17)

Status: **case and rubric defined, no code.** The Reading UI stage is built later, on top of PROD-T07 (source versions and attempt receipts) and PROD-T08 (sourced retrieval session in Reading), which other lanes own. This file is the part of PROD-T09 that does not depend on them: the case, the rubric and the stage plan, so the build is a plain data + form job when T07/T08 land.

Purpose: practise applied Business Central consulting judgment on a made-up case. It is a pilot, not homework: optional, about 10 minutes a week, never a daily assignment, no notification, no score about readiness, ability or promotion.

## Rules (these are the acceptance criteria)

- **Synthetic, permanently.** The case is invented. Its first line in every view says "Synthetic case". No client name, real figure, real process, email, journal text or document is ever used as input, and the app never offers a place to paste one.
- **One artifact, three stages.** The same artifact is revisited at day 0, day 30-ish and day 90-ish (30 / 60 / 90 day stages, each optional). Each stage is a new dated version of the same fields; older versions stay readable.
- **Feedback is manual first.** Self-rating against the rubric. Optional human feedback means Riley chooses to show the artifact to a person himself; no agent or job contacts anyone. No automated grading in the pilot.
- **Outcome measured:** applied-case performance (rubric rating by stage) and Riley's own "was this useful / how much effort" answer. Never readiness, IQ, a streak or an XP reward.
- **Stop rule (from the audit):** stop and remove the feature if it duplicates real professional practice or feels like homework without a useful artifact.

## The case (synthetic)

"Harbor Lane Supply" is an invented mid-size wholesale distributor of marine parts, 140 staff, moving from a legacy ERP to Dynamics 365 Business Central. Facts given to the learner:

- Sales orders are taken by phone and email; about 15 % need a manual price override agreed with the account manager.
- Purchase receipts are partial and frequent; invoices from suppliers arrive before goods about once a week.
- Two warehouses; stock transfers are done on paper and keyed the next day.
- Month-end close takes 9 working days; finance wants 4.
- Go-live is fixed in 6 months; the budget allows no custom extension longer than 3 weeks of build.

## Artifact fields (same at every stage)

1. **Discovery:** questions asked and the answers assumed, each marked fact, assumption or unknown.
2. **Process map:** order-to-cash and procure-to-pay as steps with owners, in plain lists.
3. **Fit-gap:** per requirement, standard BC / configuration / extension / process change, with a one-line reason.
4. **Tradeoffs:** at least two real options for the largest gap, with cost, risk and what is given up.
5. **Risk:** top three risks, likelihood, impact, mitigation, owner.
6. **Recommendation:** what to do first, what to defer, and what would change the answer.

## Rubric (four separate dimensions, each rated 0-3 and never summed)

| Dimension | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| Factual accuracy | Wrong about BC standard behaviour in a way that changes the advice | Mostly right, one material error | Right, small gaps | Right and states where behaviour depends on version or setup |
| Evidence | No basis given | Basis stated, not checked | Cites case facts for each claim | Cites facts, separates fact / assumption / unknown, names what to verify |
| Tradeoffs | One option only | Options listed, no costs | Costs and risks per option | Also names what each option gives up and who bears it |
| Communication | Hard to follow | Understandable with effort | Clear to a finance lead | Clear to a finance lead and a developer, with a decision they could act on |

Each rating has a free-text "why" box. The rubric is a reflection aid: ratings are not totalled, averaged or compared between people.

## Stage plan

- **Stage 0 (start):** fill the six fields from the case facts. About 10 minutes per sitting, saves as it goes (autosave rule).
- **Stage 30:** one changed scenario is revealed, once, on the artifact: "Finance now requires approval workflow on every purchase invoice over a threshold, and the second warehouse is dropped." Update the same artifact; rate again.
- **Stage 90:** read the original and the stage-30 versions, note what was wrong or missing, and write a short "what I would do differently". Rate again.

A stage is offered on the page only when its date is reached and only as an unread row Riley can open; it never sends a notification and nothing happens if it is ignored.

## Build plan (later, one PR, 2-6 hours)

Depends on PROD-T07 and PROD-T08; do not start before both are Done.

- `frontend/src/lib/learning-cases.ts` (new, pure): case text, field list, rubric and stage dates, typed; no I/O.
- Additive tables only (artifact, artifact_version with `stage`, `fields` jsonb and `ratings` jsonb, `rubric_version`); service-role, owner session routes only, never in `isCiRoute()`; reuse T07's attempt-receipt idea for the version row.
- A collapsed "Case practice (optional)" section in Reading, off by default behind a preference Riley turns on (no new notification setting).
- Rollback: turn the preference off or revert the isolated code; keep the tables read-only.
- Tests (synthetic only, run after deploy): stage gating by date, version immutability, day boundary (ET), autosave retry, keyboard and screen-reader access of the rubric table, refusal of any non-synthetic label change.

## Decisions taken (so nobody has to ask)

- Theme is Business Central process consulting because that is Riley's work and the only domain where answers can be checked against product behaviour.
- Rating scale 0-3 with four separate dimensions, not a total.
- 30 / 60 / 90 days is implemented as three stages (start, about 30, about 90); the 60-day mark is a free revisit, not a required stage.
- No automated grading in the pilot; revisit only after a month of manual use shows it is wanted.
