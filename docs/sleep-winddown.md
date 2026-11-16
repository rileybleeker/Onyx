# Sleep wind-down streak (PROD-SLEEP-01)

Riley asked for an incentive to improve his sleep habits and chose **progress and streaks** (not rewards, not
reminders). This is the product behaviour as built. It is a product target and a habit tracker, not a medical
tool and not an experiment: it never claims that winding down improved sleep.

## What Riley sees

- **Log > Wind-down** (`frontend/src/app/log/sections/WindDown.tsx`). Opt-in: until it is set up it is one line
  with a **Set up** button, and Today shows nothing. Set up = pick an existing habit that means "I started winding
  down" (habits live in Notion; sleep questions are not offered, because they describe the night after it ended),
  a **target time** (empty until Riley picks one: no bedtime is suggested), and the goal (**5 of 7 nights** by
  default, editable, labelled as a starting target, not a medical threshold). **Start the streak** saves it.
- **The panel** (`frontend/src/components/sleep/WindDownPanel.tsx`), the same on Log and on Today ("Keep life
  moving"): the goal line, tonight's one action (**I started winding down**, with the target time), the last nights
  as a strip (wound down / not done / open / not answered / paused), wins against the goal this week, the current
  streak, the personal best and the all-time count, the two earlier nights that can still be answered (**Did it** /
  **Didn't**), and a next-morning line from WHOOP (time asleep, when he fell asleep, the week's onset range, with
  when WHOOP last synced). A short positive line appears at milestones (a new best, the goal met, 3 / 7 / 14 ... nights
  in a row, "A new streak can start tonight" after a miss). Nothing scolds.
- **Today's quiet view** lists one ordinary item, "Start winding down by 10:30 PM", from 3 hours before the target
  while tonight is open; it is never urgent, can be snoozed or hidden like any item, and disappears once tonight is
  answered anywhere. No notification, no new channel.
- **Goal, pauses and history** (Log, collapsed): change the goal (applies from tonight on; earlier nights keep the
  goal they had), plan a **pause** (from tonight or later, optional end; Resume ends it with last night), the full
  goal history (habit, target, goal, the zone it was set in), **Hide from Today** (and Show again on Log).

## The record and the rules (rule version 1)

- The record of a night is the chosen habit's row in `pds.habit_journal` for the **behavioral day the evening
  belongs to** (`cycle_date`; the −6 h rule, so 00:30 still belongs to the evening before). Yes = wound down,
  No = a confirmed miss, no row = not answered. The check-in, `/habits`, chat and the wind-down button all write
  that one row, so a night can never count twice and every surface shows the same answer.
- **Pending**: not answered while it can still be answered here (tonight and the two nights before, the check-in's
  window). **Unknown**: not answered after that. Neither is ever a win.
- **Current streak**: consecutive wins back from tonight. Pending and paused nights are skipped (they neither count
  nor break it). A confirmed miss ends it; an unknown night ends it too, labelled "not answered", never "missed".
  The week's wins, the all-time count and the personal best stay.
- **Paused** nights are labelled and left out of every count, even when the habit was answered Yes. A pause can only
  start tonight or later, and nights that passed keep their pause state (a database guard).
- **Goal versions** are append-only (`pds.sleep_winddown_rules`): each night is judged by the version in force on it
  (habit, target time, wins needed of N nights), so a changed goal never rewrites past success. The window size
  and target of the newest version set this week's progress.
- **Timing is shown, never counted.** A "Started" tap records the time (server clock, the local wall clock where
  Riley was) and shows on time / after the target of that night's version; a report the next morning counts the
  same as a tap and simply has no time.
- **Sleep data is feedback only.** WHOOP time asleep and onset are shown with their source and sync age; they never
  mark a night, earn nothing, and nothing compares them between nights that were won and missed.

## Saving

- Opening, scrolling, inspecting progress or new wearable data never writes. Only a tap does.
- One night at a time (`lib/use-winddown.ts`, `WindDownSaver` in `lib/sleep-winddown.ts`): shown at once; a network
  failure is retried with backoff and at once when the device comes back online (Retry now / Cancel on screen); a
  refusal is shown and the screen reloads. **Nothing unsaved is replaced:** while a tap is saving, waiting to retry
  or kept from an earlier visit, the answer buttons for the other nights wait (the line under them says why;
  Retry now / Cancel / Save it / Discard resolve it). A second tap for the same night merges into one tap from the
  answer the server last held.
- The tap is kept on the device until the server confirmed it; a tap from a closed tab is offered on the next visit
  (**Save it** / **Discard**), never sent on its own, and not offered at all when the goal changed since.
- Every tap carries the answer the screen showed (`expect`) and the goal version it showed (`rule_id`).
  `pds.sleep_winddown_set_night` (one locked transaction) refuses a screen from an earlier day (409 stale), a night
  outside the window, an answer that changed elsewhere since the screen showed it (409 changed; also when the check-in
  or Habits inserted that night's row in the meantime) and a goal that changed since the screen loaded (409
  goal_changed: an old tap can never complete a different habit). A repeated request is a no-op, so a retry after a
  lost answer cannot count twice.
- **Undo** puts the night back to the answer the screen showed when the tap was made, also after a retry that
  followed a lost answer.
- The start time is the moment of the tap that wrote the first answer for tonight. A replay, or a No corrected to
  Yes later ("I did wind down" on a night the check-in recorded as not done), keeps what is there and records no time.
- A wind-down save tells a check-in and the Habits page on the same screen to reload that answer; a check-in or
  `/habits` save refetches the panel (`writeInvalidates`). The panel is checked again whenever a page that shows it
  mounts, when the app comes back after a minute, and when the behavioral day turns over (06:00 on the device).
- The check-in's "No for the other N" can record tonight's wind-down as not done before the evening happened; the
  panel then offers **I did wind down** and Clear. Excluding the habit from that button would stop the day from
  counting as answered (it would hold the 21:30 card open), so it is left as it is.

## Storage and access

`sql/sleep_winddown.sql`: `pds.sleep_winddown_rules`, `pds.sleep_winddown_pauses`, `pds.sleep_winddown_starts` and
four functions. Service role only (RLS on, no policies, nothing granted to anon or authenticated). Hidden is the UI
preference `sleep.winddown` (`pds.ui_preferences`). Routes: `GET /api/sleep/winddown`, `POST
/api/sleep/winddown/night`, `POST /api/sleep/winddown/rule`, `POST|PATCH /api/sleep/winddown/pause`, all owner
session only (never in `isCiRoute()`), same-origin JSON, at most 1 KB; logs carry a step or a database code, never
a habit, an answer or a sleep value. Until the SQL is applied the GET answers `not_connected` and Log says so.

Rollback: revert the code; the tables are then unused (nothing else depends on them) and the habit rows the button
wrote stay ordinary habit answers.

## Not built / follow-ups

- Subjective restfulness is not paired in the next-morning line yet (no existing field fits without guessing).
- A 14-day opt-in usefulness follow-up (adherence on eligible nights and Riley's own feedback against the recorded
  baseline, which is unknown before the goal existed) is a separate task; shipping the panel proves nothing about
  sleep.
- Acceptance needs production observations and isolated mutation / recovery evidence at the deployed revision; never
  fabricate Riley's sleep or habit activity to test.

Tests (synthetic only): `frontend/tests/sleep-winddown.test.cjs`.
