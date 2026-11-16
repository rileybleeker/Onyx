import type { APIRequestContext } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Smoke provenance (DEL-02). The smoke suite loads the production ALIAS, which moves to every newer
 * deployment, so a result only counts for a commit when production served exactly that commit and
 * deployment before AND after the run. auth.setup.ts records "before" right after signing in;
 * provenance.teardown.ts records "after" once every test has finished. The verdict is computed outside
 * the test code (tools/merge_train.py smoke-verdict, from the workflow's own commit).
 *
 * In CI the workflow sets SMOKE_PROVENANCE_DIR (where the two records go), SMOKE_EXPECTED_SHA and
 * SMOKE_EXPECTED_DEPLOYMENT. Locally none of them is set and nothing is recorded or checked.
 *
 * A record holds only the commit SHA and the deployment host from the signed-in /api/version, the HTTP
 * status and the time: no page content, cookie or URL.
 */

export type Phase = "before" | "after";

export interface ServedRevision {
  phase: Phase;
  status: number; // 0 = the request itself failed
  version: string | null; // 40-hex commit SHA, else null
  deployment: string | null; // the deployment's own host (VERCEL_URL), null when the build names none
  checkedAt: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

export function provenanceDir(): string | null {
  return process.env.SMOKE_PROVENANCE_DIR || null;
}

/** What production serves right now. Never throws: an unreadable answer is recorded as such. */
export async function readServedRevision(request: APIRequestContext, phase: Phase): Promise<ServedRevision> {
  let status = 0;
  let version: string | null = null;
  let deployment: string | null = null;
  try {
    const res = await request.get("/api/version", { maxRedirects: 0, failOnStatusCode: false });
    status = res.status();
    if (res.ok()) {
      const body = (await res.json().catch(() => null)) as { version?: unknown; deployment?: unknown } | null;
      if (body && typeof body.version === "string" && HEX40.test(body.version)) version = body.version;
      if (body && typeof body.deployment === "string") {
        const host = body.deployment.trim().toLowerCase();
        deployment = HOST.test(host) ? host : null;
      }
    }
  } catch {
    status = 0;
  }
  return { phase, status, version, deployment, checkedAt: new Date().toISOString() };
}

export function writeServedRevision(rec: ServedRevision): void {
  const dir = provenanceDir();
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.phase}.json`), JSON.stringify(rec));
}

function expectedHost(): string | null {
  const m = /^https:\/\/([^/?#:@\s]+)\/?$/.exec((process.env.SMOKE_EXPECTED_DEPLOYMENT || "").trim().toLowerCase());
  return m ? m[1] : null;
}

/**
 * Why this run is not testing the expected target, or null. Only a confirmed different commit or
 * deployment counts here (the run then stops at once: its results would belong to another deployment);
 * an unreadable answer is left to the verdict, which never counts it as a pass.
 */
export function staleTarget(rec: ServedRevision): string | null {
  const sha = process.env.SMOKE_EXPECTED_SHA || "";
  if (!HEX40.test(sha) || rec.version === null) return null;
  if (rec.version !== sha) {
    return `Production serves ${rec.version.slice(0, 7)}, not ${sha.slice(0, 7)}: the alias moved to another deployment, so this run would not test the expected commit (deferred, not a failure).`;
  }
  const host = expectedHost();
  if (host && rec.deployment && rec.deployment !== host) {
    return `Production serves ${rec.deployment}, another deployment of ${sha.slice(0, 7)}, not ${host} (deferred, not a failure).`;
  }
  return null;
}
