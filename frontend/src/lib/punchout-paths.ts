// PunchOut URL shapes shared by middleware.ts (Edge runtime) and the PunchOut server code.
// Edge-safe: no node imports.

/** Session id (32 hex) "." URL secret (32 random bytes, base64url = 43 chars). */
export const RETURN_TOKEN_RE = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
export const RETURN_PATH_PREFIX = "/api/procurement/punchout/public/return/";
export const TEST_SUPPLIER_SETUP_PATH = "/api/procurement/punchout/public/test-supplier/setup";

/**
 * The only PunchOut paths reachable without an Onyx session (middleware carve-out, 2026-11-11):
 *  - the BrowserFormPost return: the supplier's page posts the cart back cross-site, so the SameSite=Lax
 *    session cookie is not sent; the route authenticates the single-use, expiring secret in the path;
 *  - the synthetic test supplier's setup endpoint, called server-to-server by /start; it authenticates
 *    the cXML Sender SharedSecret like a real supplier would.
 */
export const PUNCHOUT_PUBLIC_RE =
  /^\/api\/procurement\/punchout\/public\/(?:return\/[0-9a-f]{32}\.[A-Za-z0-9_-]{43}|test-supplier\/setup)$/;

export function returnPath(sessionId: string, secret: string): string {
  return `${RETURN_PATH_PREFIX}${sessionId}.${secret}`;
}
