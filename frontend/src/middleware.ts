import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Constant-time string comparison (Edge-runtime safe — no node:crypto). Keeps
// the CI shared-secret check from leaking the token via compare timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function middleware(request: NextRequest) {
  // CI shared-secret carve-out for /api/habits/*. The hourly habits-sync
  // GitHub Action authenticates server-to-server with the x-onyx-ci-token
  // header (it has no Supabase session). This is the ONLY non-session path past
  // the auth boundary; browser calls from the /habits page carry a session
  // cookie and fall through to the getClaims() check below. Fail-closed: if
  // ONYX_CI_TOKEN is unset in the environment, this branch never matches and a
  // valid session is required.
  if (request.nextUrl.pathname.startsWith("/api/habits")) {
    const ciToken = process.env.ONYX_CI_TOKEN;
    const provided = request.headers.get("x-onyx-ci-token");
    if (ciToken && provided && safeEqual(provided, ciToken)) {
      return NextResponse.next({ request });
    }
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Local JWT verification instead of a network getUser() round trip. The
  // project signs session tokens with ES256 (verified 2026-06-11: JWKS at
  // /auth/v1/.well-known/jwks.json carries the matching kid), so getClaims()
  // verifies the signature locally via a module-global JWKS cache (10-min TTL)
  // — ~0.5ms vs ~50-150ms per request, on EVERY page nav, RSC prefetch, and
  // /api call. Expired tokens still refresh over the network through
  // getSession() and the refreshed cookies propagate via setAll above. An
  // HS256 token (shouldn't exist anymore) falls back to a network getUser()
  // inside getClaims. Trade-off: a revoked-but-unexpired token stays valid
  // until exp (≤1h) — acceptable for a single-operator app.
  // try/catch: getClaims rethrows non-AuthError exceptions (malformed JWK,
  // bad alg) — treat any throw as logged-out rather than 500ing.
  let user: unknown = null;
  try {
    const { data } = await supabase.auth.getClaims();
    user = data?.claims ?? null;
  } catch {
    user = null;
  }

  // If not logged in and not on login or auth callback, reject. /api/habits is
  // no longer exempt here — the CI carve-out above is the only unauthenticated
  // way in. An unauthenticated /api/habits request gets a 401 JSON rather than
  // a 307 to the HTML login page, which a non-browser caller (curl without -L)
  // would silently treat as success and mask the auth failure.
  if (
    !user &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/auth")
  ) {
    if (request.nextUrl.pathname.startsWith("/api/habits")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // If logged in and on login page, redirect to status
  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/status";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  // Excluded beyond Next statics: manifest.json (the PWA manifest is fetched
  // credential-less, so auth can never succeed — it was being 307'd to /login)
  // and ico/woff2 assets. api/habits is INTENTIONALLY NOT excluded anymore:
  // middleware must run on it to enforce the session-or-CI-token check (the CI
  // curl now sends x-onyx-ci-token, handled at the top of middleware()). Do NOT
  // exclude any /api route — middleware is the sole authentication boundary for
  // the service-role API routes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
