"use client";

import { useEffect, useRef, useState } from "react";
import FocusUnlockSettings from "@/components/FocusUnlockSettings";
import { installTarget } from "@/lib/iphone-update";
import { useUpdateFlow } from "@/lib/use-update-flow";
import UpdateFlowPanel from "@/components/UpdateFlowPanel";
import { BUILD_VARIANTS, buildApiUrl, type BuildVariant } from "@/lib/install-builds";

/**
 * /install — over-the-air install page for the Onyx Screen Time iPhone app
 * (tools/screentime_ios). Reads the newest signed build from
 * /api/screen-time/build and shows its two install links, plus a second card
 * for the Focus development build (/api/screen-time/build?variant=focus).
 * Open this page in Safari on the iPhone itself: the itms-services links only
 * work there. In the nav as "iPhone app" (not in the continuous scroll); inside the home-screen app it shows an Open in Safari hand-off. Formerly not in the nav — it is a setup utility, used a few
 * times a year.
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
        className="block w-full text-center bg-accent hover:bg-accent/90 text-on-accent font-medium py-2.5 rounded-full text-sm transition-colors"
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

// Copies the Onyx CI token for the app's one-time setup. iOS Safari drops the
// tap's clipboard permission across an await, so the fetch goes INSIDE a
// ClipboardItem promise; if that still fails, the token is shown for a
// long-press copy.
function CopyTokenButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [shown, setShown] = useState<string | null>(null);
  const load = () =>
    fetch("/api/screen-time/token", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.token) throw new Error(j.error ?? "no token");
        return j.token as string;
      });
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ "text/plain": load().then((t) => new Blob([t], { type: "text/plain" })) }),
            ]);
            setState("copied");
          } catch {
            try {
              setShown(await load());
            } catch {
              /* shown stays null */
            }
            setState("failed");
          }
        }}
        className="block w-full text-center border border-border-subtle hover:bg-surface text-text-primary font-medium py-2.5 rounded-control text-sm transition-colors"
      >
        {state === "copied" ? "Token copied — paste it in the app" : "Copy Onyx token"}
      </button>
      {state === "failed" && shown && (
        <input
          readOnly
          value={shown}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-surface border border-border-subtle rounded-control px-2 py-1.5 text-xs text-text-secondary font-mono"
        />
      )}
      {state === "failed" && <p className="text-text-tertiary text-xs">Copy didn&apos;t work — tap the box above, then Copy.</p>}
    </div>
  );
}

/**
 * True inside the installed home-screen Onyx app (iOS sets navigator.standalone; other browsers report the
 * display-mode media query). Read after mount so the server render and first client render agree.
 */
function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandalone(nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches);
  }, []);
  return standalone;
}

/**
 * itms-services:// links (the over-the-air install) only work in Safari proper; the home-screen app is a
 * separate web-content view that ignores them. Inside it, offer a hand-off to Safari.
 *
 * How: the `x-safari-https://` scheme. iOS routes it to Safari for any https page and, unlike window.open or
 * target="_blank", it also works for an address inside the app's own scope (/install is in scope, so
 * window.open would just navigate within the standalone window). It is a long-stable but undocumented iOS
 * behavior (in-app browsers use it to escape to Safari) and has not been confirmed on iOS 26 from this page,
 * so the card also keeps a Copy link fallback to paste into Safari by hand.
 */
function SafariHandoff() {
  const [copied, setCopied] = useState(false);
  const here = typeof window === "undefined" ? "" : `${window.location.origin}/install`;
  return (
    <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6 space-y-3">
      <h2 className="text-base font-medium text-text-primary">Install from Safari</h2>
      <p className="text-text-secondary text-sm">
        The install buttons only work in Safari, not inside this app. Open this page in Safari, then tap Install there.
      </p>
      <a
        href={`x-safari-${here}`}
        className="block w-full text-center bg-accent hover:bg-accent/90 text-on-accent font-medium py-2.5 rounded-full text-sm transition-colors"
      >
        Open in Safari
      </a>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(here);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
        className="text-text-tertiary hover:text-text-secondary text-xs transition-colors"
      >
        {copied ? "Copied. Paste it in Safari." : "Nothing happened? Copy the link and paste it in Safari"}
      </button>
    </div>
  );
}

type LoadState = "loading" | "ready" | "none" | "error";

function useBuild(variant: BuildVariant) {
  const [build, setBuild] = useState<Build | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [reason, setReason] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    fetch(buildApiUrl(variant), { cache: "no-store" })
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
        console.error("Load install:", e);
        setReason("Couldn't load the install. Try again.");
        setState("error");
      });
  }, [variant]);

  return { build, state, reason, expired };
}

// The Focus development build (.github/workflows/focus-ios-signed.yml). Same
// bundle ID as the Screen Time app, so installing it upgrades that app in place.
function FocusBuildCard() {
  const { build, state, reason, expired } = useBuild("focus");
  const meta = BUILD_VARIANTS.focus;
  return (
    <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6 space-y-4">
      <div>
        <h2 className="text-base font-medium text-text-primary">{meta.title}</h2>
        <p className="text-text-tertiary text-xs mt-1">
          Upgrades the Screen Time app in place; installing the plain build later replaces it again.
        </p>
      </div>
      {state === "loading" && <p className="text-text-tertiary text-sm">Loading…</p>}
      {state === "none" && <p className="text-text-secondary text-sm">No Focus build has been published yet.</p>}
      {state === "error" && (
        <>
          <p className="text-down text-sm">Couldn&apos;t load the Focus build.</p>
          {reason && <p className="text-text-tertiary text-xs">{reason}</p>}
        </>
      )}
      {state === "ready" && build && (
        <>
          <p className="text-text-tertiary text-xs">
            Version {build.version} ({build.build}) · build #{build.run_number} · built {fmt(build.built_at)} from{" "}
            {build.sha} · {(build.ipa_bytes / 1_048_576).toFixed(1)} MB
          </p>
          {expired ? (
            <p className="text-down text-sm">
              These links expired {fmt(build.links_expire_at)}. Run the “{meta.workflow}” workflow again.
            </p>
          ) : (
            <>
              <InstallLink label="Install with Focus" hint="Try this first." href={build.link_a} />
              <InstallLink
                label="Install with Focus (alternative link)"
                hint="Use this if the first button does nothing."
                href={build.link_b}
              />
              <p className="text-text-tertiary text-xs">Links expire {fmt(build.links_expire_at)}.</p>
            </>
          )}
          <p className="text-text-tertiary text-xs">Stops opening after {fmt(build.profile_expires)} (signing expires).</p>
        </>
      )}
    </div>
  );
}

/**
 * /install?auto=1 (opened in Safari by Today's Update everything button): as soon as the newest build is known
 * (Focus when published, else Screen Time) go straight to its install link so iOS shows its Install prompt. A big
 * button stays as the fallback in case the automatic navigation is blocked.
 */
function AutoInstall() {
  const d = useBuild("default");
  const f = useBuild("focus");
  const ready = (b: ReturnType<typeof useBuild>) => (b.state === "ready" && b.build && !b.expired ? b.build : null);
  const target = installTarget(ready(f), ready(d));
  const settled = d.state !== "loading" && f.state !== "loading";
  const link = target?.link_a ?? null;
  const label = target ? `${target.version} (${target.build})` : null;
  const flow = useUpdateFlow({ status: null, webChecked: true, webBehind: false, retryHref: "/install?auto=1" });
  const started = useRef(false);
  useEffect(() => {
    if (!link || started.current) return;
    started.current = true;
    // A fresh attempt for this build: record the prompt before iOS takes the page, so the steps read right when we come back.
    flow.begin(true, false, label);
    flow.markPrompt();
    window.location.href = link;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);
  if (flow.view.active && started.current) return <UpdateFlowPanel view={flow.view} />;
  if (!settled) return <p className="text-text-tertiary text-sm">Preparing the install…</p>;
  if (!link) return <p className="text-down text-sm">No installable build is available right now.</p>;
  return (
    <a
      href={link}
      className="block w-full text-center bg-accent hover:bg-accent/90 text-on-accent font-medium py-4 rounded-full text-lg transition-colors"
    >
      Install
    </a>
  );
}

export default function InstallPage() {
  const { build, state, reason, expired } = useBuild("default");
  const standalone = useStandalone();
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    setAuto(new URLSearchParams(window.location.search).get("auto") === "1");
  }, []);

  return (
    <div className="min-h-screen bg-surface px-4 py-12">
      <div className="max-w-md mx-auto space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary mb-1">Onyx Screen Time</h1>
          <p className="text-text-tertiary text-sm">Open this page in Safari on the iPhone.</p>
        </div>

        {standalone && <SafariHandoff />}
        {auto && !standalone && <AutoInstall />}

        {state === "loading" && <p className="text-text-tertiary text-sm">Loading…</p>}

        {state === "none" && (
          <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6">
            <p className="text-text-secondary text-sm">No signed build has been published yet.</p>
            {reason && <p className="text-text-tertiary text-xs mt-2">{reason}</p>}
          </div>
        )}

        {state === "error" && (
          <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6">
            <p className="text-down text-sm">Couldn&apos;t load the build.</p>
            {reason && <p className="text-text-tertiary text-xs mt-2">{reason}</p>}
          </div>
        )}

        {state === "ready" && build && (
          <>
            <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6 space-y-4">
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
              <p className="text-text-tertiary text-xs">Stops opening after {fmt(build.profile_expires)} (signing expires).</p>
            </div>

            <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6 space-y-2">
              <h2 className="text-base font-medium text-text-primary">After installing</h2>
              <ol className="list-decimal list-inside text-text-secondary text-sm space-y-1.5">
                <li>Tap the app icon. iOS says Developer Mode is required.</li>
                <li>Settings → Privacy &amp; Security → Developer Mode → turn on, then Restart.</li>
                <li>After the restart, unlock, tap Enable and enter your passcode.</li>
                <li>
                  Open the app while online and approve the Screen Time prompt (tap Grant access if it does not
                  appear), then paste the Onyx token and Sync.
                </li>
              </ol>
              <CopyTokenButton />
            </div>

            {!expired && (
              <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-6 space-y-2">
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

        <FocusBuildCard />
        <FocusUnlockSettings />
      </div>
    </div>
  );
}
