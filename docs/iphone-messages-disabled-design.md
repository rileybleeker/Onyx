# iPhone Messages integration: disabled design

Status: disabled scaffold plus design. The only code is a switch-off gate (`frontend/src/lib/phone-messages.ts`) and a read-only status route. There is no connector, message collection, background job, permission request, provider account, or working send path, and no way to read an iPhone inbox exists in this repo. Nothing here has been run against a real phone.

## What is built (all disabled)

- `frontend/src/lib/phone-messages.ts`: the gate every future operation must pass. Off unless `ONYX_PHONE_MESSAGES_ENABLED` is exactly `true`. When off, no adapter is created or opened and nothing is fetched. Reading and sending are separate switches (`ONYX_PHONE_MESSAGES_SEND_ENABLED` for send); a send also needs the adapter's send capability and an approval equal to the exact recipient, thread and text. An unsupported capability returns a refusal code, never an empty inbox. Adapter errors collapse to `adapter_error` so message text never escapes. The flag is read on every call, so switching it off stops the next call.
- `GET /api/phone-messages/status` (browser session only): reports `enabled`, `sendEnabled`, `adapterRegistered`, all-false `capabilities` and a reason. Even with the flag on it answers `no_supported_adapter`, because no adapter exists. It has no read or send endpoint and never creates an adapter.
- `frontend/scripts/test-phone-messages.mjs`: synthetic tests (`node scripts/test-phone-messages.mjs`, auto-run by CI). They prove disabled calls touch no adapter and no network, flag values other than `true` stay off, send is separate and approval-bound, revocation works, errors leak nothing, and the module has no imports, fetch, fs or process access. They say nothing about whether any real source works.
- Production default: the variable is unset, so the integration is off. Do not set it until an adapter is chosen and approved.

## Product boundary

The intended source is the owner's existing iPhone Messages conversations, including iMessage and carrier texts. Onyx agent conversations (`agents-api.ts`, the Cloudflare bridge's `/onyx/messages` and `/onyx/send`) are a separate system. Their existence does not grant access to the phone inbox. A new SMS number, WhatsApp, or another provider is not a substitute.

Do not add a working-looking inbox or enable switch until a supported source and its permissions are verified. Do not promise access to all history. No existing messages were inspected to prepare this design.

## Feasibility checked 2026-11-11

- Apple MessageUI provides user-facing composition interfaces. It is not an inbox/history API: https://developer.apple.com/documentation/MessageUI
- Apple's TelephonyMessagingKit supports SMS/MMS/RCS for an entitled default carrier messaging app, with EU account and location eligibility. It does not establish iMessage or unrestricted historical-inbox access: https://developer.apple.com/documentation/TelephonyMessagingKit
- Windows Phone Link for iPhone shows messages sent/received during its paired, connected session, not full historical conversations. Its documented history disappears when Bluetooth disconnects: https://support.microsoft.com/en-us/windows/apps/phonelink/send-and-receive-text-messages-from-your-pc and https://support.microsoft.com/en-us/windows/apps/phonelink/troubleshooting-for-messages-in-the-phone-link
- Apple supports syncing Messages across a Mac and iPhone using the same Apple Account. This is a potential future source, not an existing Onyx adapter or authorization to read its database: https://support.apple.com/en-au/guide/icloud/mm0de0d4528d/icloud

## What iOS allows, and what is not yet verified

- Supported and Apple-documented: a Shortcuts personal automation with a Message trigger (filter by sender or by a phrase the message contains; all filters must match). It fires on newly received messages only, runs on the phone, and needs the user to build it and, for no prompt, turn off Ask Before Running. Apple's page does not say whether the Message trigger can run without confirmation. Source: https://support.apple.com/en-au/guide/shortcuts/apdd711f9dff/ios
- Apple's release notes name Messages actions "Find Message" and "Find Conversation" (iOS 26) and say Find Message can filter by sender (iOS 27 notes), plus Send Message to group chats: https://support.apple.com/en-us/125148 and https://support.apple.com/en-us/149045. The notes do not say how far back Find Message reads or whether it runs unattended inside an automation. Unverified on Riley's phone.
- So a Shortcuts route is the only phone-side path that needs no entitlement: Riley's own shortcut would push selected texts to an Onyx endpoint, like the existing Screen Time shortcut. That endpoint does not exist and is not built here. It would cover new or selected messages, not the whole inbox, and every message pushed leaves the phone, so scope (which senders or phrases) must be approved first.
- Needs an Apple entitlement and replaces Messages as default: TelephonyMessagingKit (SMS/MMS/RCS only, limited regions). Not iMessage, not suitable.
- Not available: a third-party app reading the existing SMS/iMessage inbox (see next section).
- To verify the Shortcuts route later, on the phone: Shortcuts, Automation, new Message trigger with one test sender, an action that shows the text, Don't Ask enabled, then text yourself and see whether it runs while the phone is locked. Record the result before any Onyx endpoint is designed.

## Can this read all existing texts?

Not through a supported iPhone inbox API. Apple Developer Technical Support explicitly confirmed in September 2026 that a third-party app cannot fetch the existing SMS/iMessage conversations while Messages remains the default: https://developer.apple.com/forums/thread/848299. TelephonyMessagingKit would replace the default carrier app and does not solve this requirement.

A separately approved Mac with completed Messages sync is a possible research path for retained history. Reading its local database would depend on an undocumented format, not an Apple Messages API; OS version, sync completeness, retention settings, attachments, and deleted history can limit coverage. Before choosing it, verify a dedicated minimal read-only helper and any required OS permissions. Do not grant broad disk access to a general shell or runtime. No Mac adapter is implemented or approved by this design.

A local iPhone backup on a PC is another possible point-in-time research source, not live sync or guaranteed complete history. Apple explicitly excludes data already synced/stored in iCloud, including iMessages/SMS/MMS, from computer backups: https://support.apple.com/en-us/108771. Do not disable iCloud sync to populate a backup. Backups contain much more than messages; any later import needs specific approval, selective extraction, minimum temporary storage, and a defined cleanup policy. Never put backup passwords in Onyx, logs, or repository files. Unsupported-format parsing needs its own feasibility review and explicit approval; none is authorized or implemented here.

## Proposed architecture, only after separate enablement

1. Read-only local adapter on a specifically approved device. Keep source acquisition separate from the Onyx agent-message store. Capability flags must distinguish historical read, incremental read, attachments, group conversations, iMessage, SMS/MMS/RCS, and sending. Unsupported means unavailable, never a fabricated empty inbox.
2. A connection starts disabled. Enabling requires a specific source/device, read scope (selected conversations or date range), retention policy, destination, and permission decisions. Do not create a persistent credential or grant broad access before those choices are authorized. Initial review should use synthetic fixtures only.
3. Local preview and selective import first. Avoid uploading a whole personal message archive by default. Messages include correspondents' private content and identities too. Summaries and forwarding to an external AI service require separately defined data/recipient scope covering that content. Exclude authentication secrets and one-time codes from ordinary indexing; never put content in logs or public repository fixtures.
4. Preserve source identifiers, sender/direction, timestamp and timezone, conversation membership, edits/deletions, attachment availability, import cursor, and last successful read. Make ingestion idempotent. Distinguish complete history, partial sync, inaccessible attachment, disconnected device, and permission denied.
5. Sending is a separately disabled capability. A read-only connection cannot send, react, mark read, delete, or change source conversations. No automatic replies. A future send flow must verify recipient and thread and obtain the required approval for the exact message and destination.
6. Store any authorized data behind the existing owner boundary with explicit retention/deletion behavior. Do not rely on a UI toggle alone: both worker and server must reject disabled operations before opening a source or making a network call. Revocation must stop future collection and invalidate adapter authority; previously imported data must be deleted or retained only according to the explicitly chosen retention policy.

## Acceptance gates before any enablement

- Confirm a supported adapter on the selected device and document its actual coverage; do not call private APIs or bypass OS protections. Any user-authorized local database/backup parsing uses an unsupported data format and must be explicitly reviewed and approved as such.
- Synthetic tests prove disabled read/send/import operations perform zero source, filesystem-database, and network access.
- Test interrupted/repeated sync, duplicate messages, missing history, deleted/edited messages, unavailable attachments, and revoked permissions.
- Verify no message bodies, contacts, credentials, or attachment contents enter diagnostics or public telemetry.
- Obtain explicit approval for the chosen access and data flow. Only then validate a narrowly selected conversation, report gaps, and consider broader history import.

No user-facing page is added: an unavailable fake inbox would add clutter without providing a supported integration. The only route is the read-only status check above. The next implementation decision is the source adapter (Shortcuts push, approved Mac helper, or backup import), not a different messaging provider.
