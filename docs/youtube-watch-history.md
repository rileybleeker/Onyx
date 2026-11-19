# YouTube watch history (scheduled Google Takeout to OneDrive)

What it adds: what was watched on YouTube (time, title, video id, channel, music or ad flag). Screen Time already
has the minutes; this is the content. No watch duration exists in the export. Onyx holds no Google credential.

Why this route: YouTube has no API for watch history (Data API: none since 2016; Data Portability API: not offered to
US accounts), and a signed-in myactivity.google.com harvester would keep a live Google session on the PC that also
opens Gmail (the email-risk rule).

## One-time setup (Riley, about 3 minutes, once a year)

1. takeout.google.com, "Deselect all", tick **YouTube and YouTube Music**, click "All YouTube data included", keep
   only **history**, and under "Multiple formats" set history to **JSON**.
2. Next step: Destination **Add to OneDrive**, Frequency **Export every 2 months for 1 year**, file type .zip,
   size 2 GB. Create export.
3. Google asks to link OneDrive. **Before approving, read what it grants**: Takeout asks for write access to a
   Takeout folder; if the consent screen asks for access to all of OneDrive, decline and use Google Drive instead
   (then point `ONYX_YOUTUBE_TAKEOUT_DIR` at the synced Drive folder).
4. The first export arrives within hours to a day as `takeout-*.zip` under `OneDrive\Takeout`.

## On the PC (agent steps, already built)

- `sql/youtube_watch_history_schema.sql` creates `pds.youtube_watch_events` (applied).
- `tools/youtube_history/register-task.ps1` registers the daily task "Onyx YouTube History".
- `python tools/youtube_history/youtube_history.py --dry-run` prints counts only (never titles) for anything it finds.
- Search folders: `ONYX_YOUTUBE_TAKEOUT_DIR` if set, else `~/OneDrive/Takeout` (3 levels) and the top of `~/OneDrive`.
- Already-imported exports are remembered; re-importing is harmless (upsert on watched_at + video_id). Files recorded under the old fingerprint format (name|size|mtime) still count as imported; new imports record the content hash.
- Before each upsert the importer reads the stored rows for the export's time range and merges: known title/channel fields and true `is_music`/`is_ad` flags are never replaced by empty or false values, so a sparse export cannot erase what an earlier one knew.

## Status

`/status` card **YouTube History** (heartbeat `youtube|history`): partial = no export found yet, or the last import
is over 100 days old (the one-year schedule has ended: redo step 2). Red = the import failed (format changed:
the message names the type) or the PC has not run it for 4 days.

## Not built yet

Showing watched content on `/screen-time` and a HRV feature (late-night viewing) wait for the first real export, so
the page is designed against real data instead of guesses.
