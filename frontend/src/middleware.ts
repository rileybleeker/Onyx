import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
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

  // If not logged in and not on login or auth callback, redirect to login
  if (
    !user &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/auth") &&
    !request.nextUrl.pathname.startsWith("/api/habits")
  ) {
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
  // credential-less, so auth can never succeed — it was being 307'd to /login),
  // api/habits (already exempt from the redirect logic above; excluding it here
  // stops the hourly GitHub Actions curl from running auth code at all), and
  // ico/woff2 assets. Do NOT exclude any other /api route — middleware is the
  // sole authentication boundary for the service-role API routes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|api/habits|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
