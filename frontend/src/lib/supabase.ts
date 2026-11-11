import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

// The anon (public) key ships in the site's JavaScript and the repo is public,
// so the anon role can read NOTHING in pds (2026-11-10, sql/pds_owner_only_read.sql).
//   Server (ISR prefetch, server components): the service-role key. It has no
//   NEXT_PUBLIC_ prefix, so Next never puts it in a browser bundle; every page
//   that renders this data is behind the middleware login check.
//   Browser: the signed-in session from the auth cookies, so reads run as the
//   owner account (role authenticated, owner-only RLS).
function serverClient() {
  return createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const supabase: ReturnType<typeof serverClient> =
  typeof window === "undefined"
    ? serverClient()
    : (createBrowserClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        db: { schema: "pds" },
      }) as unknown as ReturnType<typeof serverClient>);
