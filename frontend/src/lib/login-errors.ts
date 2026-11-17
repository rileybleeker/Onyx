// Plain next-step copy for a failed sign-in. The auth library's own message is service wording,
// so the login page never shows it: it maps the error to one of a few fixed sentences instead.
// Pure function, no imports, so tests can call it with a plain object.

export type LoginError = { message?: string; status?: number; code?: string };

export function loginErrorCopy(error: LoginError | null | undefined): string {
  if (!error) return COPY.other;
  const text = `${error.message ?? ""} ${error.code ?? ""}`.toLowerCase();

  if (text.includes("invalid login credentials") || text.includes("invalid_credentials")) return COPY.credentials;
  if (error.status === 429 || text.includes("rate limit") || text.includes("too many")) return COPY.rateLimit;
  if (text.includes("email not confirmed")) return COPY.notConfirmed;
  if (text.includes("network") || text.includes("fetch")) return COPY.network;
  return COPY.other;
}

const COPY = {
  credentials: "That email and password don't match. Check them and try again.",
  rateLimit: "Too many tries. Wait a few minutes, then try again.",
  notConfirmed: "Confirm your email first. Open the link we sent, then sign in.",
  network: "Couldn't reach the sign-in service. Check your connection and try again.",
  other: "Couldn't sign you in right now. Try again in a moment.",
} as const;
