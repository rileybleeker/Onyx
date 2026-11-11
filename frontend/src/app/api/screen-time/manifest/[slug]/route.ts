import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const dynamic = "force-dynamic";

const SLUG = /^[0-9a-f]{32}$/;

/**
 * GET /api/screen-time/manifest/<slug>
 *
 * Serves the over-the-air install manifest (manifest.plist) of the Onyx Screen
 * Time iPhone app as text/xml. It exists because Supabase Storage serves every
 * XML object as text/plain (anti-XSS), which the iPhone installer does not
 * accept. publish_build.py writes the manifest to the PRIVATE bucket at
 * screentime/manifests/<slug>.plist, with <slug> = 32 random hex characters.
 *
 * PUBLIC on purpose (middleware isPublicRoute): iOS fetches the manifest with
 * no cookies and no headers. What it reveals is a signed link to a
 * development-signed .ipa that only installs on the iPhone in its profile and
 * carries no secret (the CI token is typed into the app, not built in).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG.test(slug)) return new NextResponse("Not found", { status: 404 });
  const { data, error } = await supabase.storage.from("ios-builds").download(`screentime/manifests/${slug}.plist`);
  if (error || !data) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(await data.text(), {
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}
