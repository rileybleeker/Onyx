import { createSupabaseBrowser } from "@/lib/supabase-browser";

/**
 * Client for the Agents chat. The backend is the sms-reminders Cloudflare Worker (Riley's personal-agents
 * bridge); it verifies the caller's Supabase access token against this project's JWKS, so there is no shared
 * secret here. Public URL, not a secret.
 */
export const AGENTS_API = "https://sms-reminders.rileybleeklm.workers.dev";

export interface AgentCard {
  code: string;
  agent: string;
  type: string;
  name: string;
  details: string;
  link: string;
  expires: string | null;
  updated: boolean;
}

export interface AgentMessage {
  id: number;
  role: "user" | "assistant";
  body: string;
  cards: AgentCard[] | null;
  created_at: string; // UTC "YYYY-MM-DD HH:MM:SS"
}

export interface MessagesResponse {
  messages: AgentMessage[];
  lastRead: number;
  typing: boolean;
}

export class AuthError extends Error {}

let supabase: ReturnType<typeof createSupabaseBrowser> | null = null;
function client() {
  if (!supabase) supabase = createSupabaseBrowser();
  return supabase;
}

async function accessToken(forceRefresh = false): Promise<string | null> {
  const sb = client();
  if (forceRefresh) {
    const { data } = await sb.auth.refreshSession();
    return data.session?.access_token ?? null;
  }
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await accessToken(retried);
  const headers: Record<string, string> = { ...(init.body ? { "Content-Type": "application/json" } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${AGENTS_API}${path}`, { ...init, headers, cache: "no-store" });
  if (res.status === 401) {
    if (!retried) return call<T>(path, init, true);
    throw new AuthError("Session expired");
  }
  if (!res.ok) throw new Error(`Agents API ${res.status}`);
  return (await res.json()) as T;
}

export const agentsApi = {
  messages: (q: { after?: number; before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.after) p.set("after", String(q.after));
    if (q.before) p.set("before", String(q.before));
    if (q.limit) p.set("limit", String(q.limit));
    return call<MessagesResponse>(`/onyx/messages?${p}`);
  },
  send: (text: string) => call<{ message: AgentMessage }>("/onyx/send", { method: "POST", body: JSON.stringify({ text }) }),
  read: (id: number) => call<{ ok: boolean }>("/onyx/read", { method: "POST", body: JSON.stringify({ id }) }),
  subscribe: (sub: PushSubscriptionJSON) => call<{ ok: boolean; pushed: number }>("/onyx/subscribe", { method: "POST", body: JSON.stringify(sub) }),
  config: async (): Promise<{ vapidPublicKey: string | null }> => {
    const res = await fetch(`${AGENTS_API}/onyx/config`, { cache: "no-store" });
    return res.json();
  },
};

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "===".slice((base64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export type PushState = "unsupported" | "needs-install" | "default" | "denied" | "granted";

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function pushState(): PushState {
  if (typeof window === "undefined") return "unsupported";
  if (isIOS() && !isStandalone()) return "needs-install"; // iOS only allows web push from a home-screen app
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission as PushState;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/** Must run inside a tap handler (iOS requires a user gesture for the permission prompt). */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission as PushState;
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const { vapidPublicKey } = await agentsApi.config();
  if (!vapidPublicKey) throw new Error("Push is not configured on the server");
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource }));
  await agentsApi.subscribe(sub.toJSON());
  return "granted";
}

/** Re-send the existing subscription (iOS can rotate it); harmless when nothing changed. */
export async function refreshPushSubscription(): Promise<void> {
  if (pushState() !== "granted") return;
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await agentsApi.subscribe(sub.toJSON()).catch(() => {});
}
