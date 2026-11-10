"use client";

import { useEffect, useState } from "react";

/**
 * /install — over-the-air install page for the Onyx Screen Time iPhone app
 * (tools/screentime_ios). Reads the newest signed build from
 * /api/screen-time/build and shows its two install links. Open this page in
 * Safari on the iPhone itself: the itms-services links only work there.
 * Deliberately not in the nav — it is a setup utility, used a few times a year.
 */

interface Build {
  run_number: number | string;
  sha: string;
  built_at: string;
  links_expire_at: string;
  profile_expires: string | null;
  version: string;
  build: string;
  ipa_bytes: number;
  link_a: string;
  link_b: string;
  ipa_url: string;
}

function fmt(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }) + " ET";
}

function InstallLink({ label, hint, href }: { label: string; hint: string; href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <a
        href={href}
        className="block w-full text-center bg-accent hover:bg-accent/90 text-white font-medium py-2.5 rounded-[4px] text-sm transition-colors"
      >
        {label}
      </a>
      <div className="flex items-center justify-between gap-3">
        <p className="text-text-tertiary text-xs">{hint}</p>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(href);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          className="shrink-0 text-text-tertiary hover:text-text-secondary text-xs transition-colors"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export default function InstallPage() {
  const [build, setBuild] = useState<Build | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [reason, setReason] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    fetch("/api/screen-time/build", { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (json.build) {
          const next = json.build as Build;
          setBuild(next);
          setExpired(new Date(next.links_expire_at).getTime() < Date.now());
          setState("ready");
        } else {
          setReason(json.reason ?? "");
          setState(res.ok ? "none" : "error");
        }
      })
      .catch((e) => {
        setReason(String(e));
        setState("error");
      });
  }, []);

  return (
    <div className="min-h-screen bg-surface px-4 py-12">
      <div className="max-w-md mx-auto space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary mb-1">Onyx Screen Time</h1>
          <p className="text-text-tertiary text-sm">Install the iPhone app. Open this page in Safari on the iPhone.</p>
        </div>

        {state === "loading" && <p className="text-text-tertiary text-sm">Loading…</p>}

        {state === "none" && (
          <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6">
            <p className="text-text-secondary text-sm">No signed build has been published yet.</p>
            {reason && <p className="text-text-tertiary text-xs mt-2">{reason}</p>}
          </div>
        )}

        {state === "error" && (
          <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6">
            <p className="text-down text-sm">Couldn&apos;t load the build.</p>
            {reason && <p className="text-text-tertiary text-xs mt-2">{reason}</p>}
          </div>
        )}

        {state === "ready" && build && (
          <>
            <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 space-y-4">
              <div>
                <h2 className="text-base font-medium text-text-primary">
                  Version {build.version} ({build.build}) · build #{build.run_number}
                </h2>
                <p className="text-text-tertiary text-xs mt-1">
                  Built {fmt(build.built_at)} from {build.sha} · {(build.ipa_bytes / 1_048_576).toFixed(1)} MB
                </p>
              </div>

              {expired ? (
                <p className="text-down text-sm">
                  These links expired {fmt(build.links_expire_at)}. Run the “Screen Time iOS app” workflow again.
                </p>
              ) : (
                <>
                  <InstallLink label="Install" hint="Try this first." href={build.link_a} />
                  <InstallLink
                    label="Install (alternative link)"
                    hint="Use this if the first button does nothing."
                    href={build.link_b}
                  />
                  <p className="text-text-tertiary text-xs">Links expire {fmt(build.links_expire_at)}.</p>
                </>
              )}
              <p className="text-text-tertiary text-xs">
                The installed app keeps opening until its signing certificate and profile expire:{" "}
                {fmt(build.profile_expires)}.
              </p>
            </div>

            <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 space-y-2">
              <h2 className="text-base font-medium text-text-primary">After installing</h2>
              <ol className="list-decimal list-inside text-text-secondary text-sm space-y-1.5">
                <li>Tap the app icon. iOS says Developer Mode is required.</li>
                <li>Settings → Privacy &amp; Security → Developer Mode → turn on, then Restart.</li>
                <li>After the restart, unlock, tap Enable and enter your passcode.</li>
                <li>Open the app while online, tap Grant access, then paste the Onyx token and Sync.</li>
              </ol>
            </div>

            {!expired && (
              <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 space-y-2">
                <h2 className="text-base font-medium text-text-primary">USB fallback</h2>
                <p className="text-text-secondary text-sm">
                  If neither link installs, download the app file on the PC and install it over the cable.
                </p>
                <a href={build.ipa_url} className="text-accent hover:underline text-sm">
                  Download OnyxScreenTime.ipa
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
