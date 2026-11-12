/**
 * iPhone Messages integration: DISABLED scaffold (2026-11-11).
 *
 * Design and platform limits: docs/iphone-messages-disabled-design.md.
 *
 * What this file is: the gate every future Messages operation must go through.
 * What it is not: a way to read texts. iOS gives a third-party app no API for the
 * existing SMS/iMessage inbox, so NO adapter exists in this repo. Turning the flag
 * on does not change that; every operation then answers "no supported adapter".
 *
 * Rules this module enforces (and test-phone-messages.mjs proves with synthetic data):
 *   1. Off unless the flag is exactly "true". Missing, empty, "1", "TRUE", "yes" are all off.
 *   2. Disabled means the adapter is never created, opened or called, and nothing
 *      is fetched or read from disk. This file imports nothing and reads no
 *      process state: the caller passes the environment in.
 *   3. Reading and sending are separate switches. A read-only connection cannot send.
 *   4. An unsupported capability is "unavailable", never an empty inbox.
 *   5. Errors from an adapter are reduced to a fixed code. Message text, contact
 *      names and adapter error text never leave this module.
 *   6. The flag is read on every call, so switching it off stops the next call
 *      (revocation) without a restart.
 *
 * Keep this file free of imports, fetch, fs and process.env.
 */

export const PHONE_MESSAGES_FLAG = "ONYX_PHONE_MESSAGES_ENABLED";
export const PHONE_MESSAGES_SEND_FLAG = "ONYX_PHONE_MESSAGES_SEND_ENABLED";

export type PhoneMessagesEnv = Record<string, string | undefined>;

export interface PhoneMessagesCapabilities {
  historicalRead: boolean;
  incrementalRead: boolean;
  attachments: boolean;
  groupConversations: boolean;
  iMessage: boolean;
  smsMmsRcs: boolean;
  send: boolean;
}

export const NO_CAPABILITIES: PhoneMessagesCapabilities = Object.freeze({
  historicalRead: false,
  incrementalRead: false,
  attachments: false,
  groupConversations: false,
  iMessage: false,
  smsMmsRcs: false,
  send: false,
});

/** Opaque to this module: whatever a future approved adapter returns. */
export interface PhoneConversationSummary {
  id: string;
}
export interface PhoneMessage {
  id: string;
}

export interface ReadRequest {
  conversationId: string;
  /** "historical" = everything the source still holds; "incremental" = after `cursor`. */
  mode: "historical" | "incremental";
  cursor?: string;
}

export interface SendRequest {
  conversationId: string;
  recipient: string;
  body: string;
}

/** The exact message and destination Riley approved. Must equal the request. */
export interface SendApproval {
  conversationId: string;
  recipient: string;
  body: string;
}

export interface PhoneMessagesAdapter {
  capabilities: PhoneMessagesCapabilities;
  listConversations(): Promise<PhoneConversationSummary[]>;
  readMessages(request: ReadRequest): Promise<{ messages: PhoneMessage[]; cursor?: string }>;
  send(request: SendRequest): Promise<{ id: string }>;
}

export type RefusalReason =
  | "flag_off"
  | "send_flag_off"
  | "no_supported_adapter"
  | "capability_missing"
  | "approval_missing"
  | "adapter_error";

export type PhoneMessagesResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RefusalReason };

/** True only for the exact string "true". */
export function isFlagOn(env: PhoneMessagesEnv, name: string): boolean {
  return env[name] === "true";
}

export interface PhoneMessagesStatus {
  enabled: boolean;
  sendEnabled: boolean;
  adapterRegistered: boolean;
  /** Always all false while disabled or while no adapter exists. */
  capabilities: PhoneMessagesCapabilities;
  reason: RefusalReason | "ready";
}

export interface PhoneMessagesServiceOptions {
  /** Called on every operation, never cached, so switching the flag off takes effect at once. */
  getEnv: () => PhoneMessagesEnv;
  /**
   * Creates the adapter lazily, only after the flag check passes. There is no
   * production implementation: leave undefined.
   */
  createAdapter?: () => PhoneMessagesAdapter | null;
}

export interface PhoneMessagesService {
  status(): PhoneMessagesStatus;
  listConversations(): Promise<PhoneMessagesResult<PhoneConversationSummary[]>>;
  readMessages(
    request: ReadRequest,
  ): Promise<PhoneMessagesResult<{ messages: PhoneMessage[]; cursor?: string }>>;
  send(request: SendRequest, approval: SendApproval | null): Promise<PhoneMessagesResult<{ id: string }>>;
}

function sameSend(a: SendRequest, b: SendApproval): boolean {
  return a.conversationId === b.conversationId && a.recipient === b.recipient && a.body === b.body;
}

export function createPhoneMessagesService(options: PhoneMessagesServiceOptions): PhoneMessagesService {
  const refuse = <T>(reason: RefusalReason): PhoneMessagesResult<T> => ({ ok: false, reason });

  /** Flag first, then adapter. The adapter is only created when the flag is on. */
  function open(): { adapter: PhoneMessagesAdapter } | { reason: RefusalReason } {
    if (!isFlagOn(options.getEnv(), PHONE_MESSAGES_FLAG)) return { reason: "flag_off" };
    let adapter: PhoneMessagesAdapter | null = null;
    try {
      adapter = options.createAdapter ? options.createAdapter() : null;
    } catch {
      return { reason: "adapter_error" };
    }
    if (!adapter) return { reason: "no_supported_adapter" };
    return { adapter };
  }

  return {
    status() {
      const env = options.getEnv();
      const enabled = isFlagOn(env, PHONE_MESSAGES_FLAG);
      const sendEnabled = enabled && isFlagOn(env, PHONE_MESSAGES_SEND_FLAG);
      // Status never creates the adapter: asking "is it on" must not open a source.
      const adapterRegistered = enabled && Boolean(options.createAdapter);
      return {
        enabled,
        sendEnabled,
        adapterRegistered,
        capabilities: { ...NO_CAPABILITIES },
        reason: !enabled ? "flag_off" : !adapterRegistered ? "no_supported_adapter" : "ready",
      };
    },

    async listConversations() {
      const opened = open();
      if (!("adapter" in opened)) return refuse(opened.reason);
      try {
        return { ok: true, value: await opened.adapter.listConversations() };
      } catch {
        return refuse("adapter_error");
      }
    },

    async readMessages(request) {
      const opened = open();
      if (!("adapter" in opened)) return refuse(opened.reason);
      const caps = opened.adapter.capabilities;
      const supported = request.mode === "historical" ? caps.historicalRead : caps.incrementalRead;
      if (!supported) return refuse("capability_missing");
      try {
        return { ok: true, value: await opened.adapter.readMessages(request) };
      } catch {
        return refuse("adapter_error");
      }
    },

    async send(request, approval) {
      // Separate switch: reading being on never allows sending.
      if (!isFlagOn(options.getEnv(), PHONE_MESSAGES_FLAG)) return refuse("flag_off");
      if (!isFlagOn(options.getEnv(), PHONE_MESSAGES_SEND_FLAG)) return refuse("send_flag_off");
      const opened = open();
      if (!("adapter" in opened)) return refuse(opened.reason);
      if (!opened.adapter.capabilities.send) return refuse("capability_missing");
      if (!approval || !sameSend(request, approval)) return refuse("approval_missing");
      try {
        return { ok: true, value: await opened.adapter.send(request) };
      } catch {
        return refuse("adapter_error");
      }
    },
  };
}
