# iPhone Messages integration: disabled design

Status: design only. No connector, message collection, background job, permission request, provider account, or send path is enabled or created by this document.

## Product boundary

The intended source is the owner's existing iPhone Messages conversations, including iMessage and carrier texts. Onyx agent conversations (`agents-api.ts`, the Cloudflare bridge's `/onyx/messages` and `/onyx/send`) are a separate system. Their existence does not grant access to the phone inbox. A new SMS number, WhatsApp, or another provider is not a substitute.

Do not add a working-looking inbox or enable switch until a supported source and its permissions are verified. Do not promise access to all history. No existing messages were inspected to prepare this design.

## Feasibility checked 2026-11-11

- Apple MessageUI provides user-facing composition interfaces. It is not an inbox/history API: https://developer.apple.com/documentation/MessageUI
- Apple's TelephonyMessagingKit supports SMS/MMS/RCS for an entitled default carrier messaging app, with EU account and location eligibility. It does not establish iMessage or unrestricted historical-inbox access: https://developer.apple.com/documentation/TelephonyMessagingKit
- Windows Phone Link for iPhone shows messages sent/received during its paired, connected session, not full historical conversations. Its documented history disappears when Bluetooth disconnects: https://support.microsoft.com/en-us/windows/apps/phonelink/send-and-receive-text-messages-from-your-pc and https://support.microsoft.com/en-us/windows/apps/phonelink/troubleshooting-for-messages-in-the-phone-link
- Apple supports syncing Messages across a Mac and iPhone using the same Apple Account. This is a potential future source, not an existing Onyx adapter or authorization to read its database: https://support.apple.com/en-au/guide/icloud/mm0de0d4528d/icloud

## Proposed architecture, only after separate enablement

1. Read-only local adapter on a specifically approved device. Keep source acquisition separate from the Onyx agent-message store. Capability flags must distinguish historical read, incremental read, attachments, group conversations, iMessage, SMS/MMS/RCS, and sending. Unsupported means unavailable, never a fabricated empty inbox.
2. A connection starts disabled. Enabling requires a specific source/device, read scope (selected conversations or date range), retention policy, destination, and permission decisions. Do not create a persistent credential or grant broad access before those choices are authorized. Initial review should use synthetic fixtures only.
3. Local preview and selective import first. Avoid uploading a whole personal message archive by default. Summaries and forwarding to an external AI service require separately defined data/recipient scope. Exclude authentication secrets and one-time codes from ordinary indexing; never put content in logs or public repository fixtures.
4. Preserve source identifiers, sender/direction, timestamp and timezone, conversation membership, edits/deletions, attachment availability, import cursor, and last successful read. Make ingestion idempotent. Distinguish complete history, partial sync, inaccessible attachment, disconnected device, and permission denied.
5. Sending is a separately disabled capability. A read-only connection cannot send, react, mark read, delete, or change source conversations. No automatic replies. A future send flow must verify recipient and thread and obtain the required approval for the exact message and destination.
6. Store any authorized data behind the existing owner boundary with explicit retention/deletion behavior. Do not rely on a UI toggle alone: both worker and server must reject disabled operations before opening a source or making a network call. Revocation must stop future collection and invalidate adapter authority.

## Acceptance gates before any enablement

- Confirm a supported adapter on the selected device and document its actual coverage; do not use private APIs or bypass OS protections.
- Synthetic tests prove disabled read/send/import operations perform zero source, filesystem-database, and network access.
- Test interrupted/repeated sync, duplicate messages, missing history, deleted/edited messages, unavailable attachments, and revoked permissions.
- Verify no message bodies, contacts, credentials, or attachment contents enter diagnostics or public telemetry.
- Obtain explicit approval for the chosen access and data flow. Only then validate a narrowly selected conversation, report gaps, and consider broader history import.

No user-facing surface is added yet: an unavailable fake inbox would add clutter without providing a supported integration. The next implementation decision is the source adapter, not a different messaging provider.
