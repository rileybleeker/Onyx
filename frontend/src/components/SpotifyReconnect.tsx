"use client";

import { useState } from "react";
import { SPOTIFY_REDIRECT_URI, formatReconnectDate, requestAuthorizeUrl, submitCallback } from "@/lib/spotify-reconnect";

// Reconnect control on the /status Spotify card. Shown when the sync error says the refresh token
// was rejected (Spotify expires it 180 days after authorization) and from day 165 as a warning.
//   1. "Reconnect Spotify" asks /api/spotify/auth-url for the authorize link and shows it; the link
//      opens Spotify in a new tab.
//   2. Spotify sends that tab to 127.0.0.1:8888, where nothing listens, so the tab shows a
//      "could not connect" page. Its address holds the code: paste it here and press Finish.
// The token exchange happens on the server; this component never sees a token.

type Result = { kind: "ok" | "error"; text: string } | null;

export default function SpotifyReconnect({ reconnectBy }: { reconnectBy?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<"link" | "finish" | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [done, setDone] = useState(false);

  async function start() {
    setBusy("link");
    setResult(null);
    const answer = await requestAuthorizeUrl(fetch);
    setBusy(null);
    if (!answer.ok) {
      setUrl(null);
      setResult({ kind: "error", text: answer.message });
      return;
    }
    setUrl(answer.url);
    setPasted("");
  }

  async function finish() {
    setBusy("finish");
    setResult(null);
    const answer = await submitCallback(fetch, pasted);
    setBusy(null);
    if (!answer.ok) {
      setResult({ kind: "error", text: answer.message });
      return;
    }
    setDone(true);
    setUrl(null);
    setPasted("");
    setResult({
      kind: "ok",
      text:
        "Spotify is reconnected." +
        (answer.reconnectBy ? ` Reconnect again by ${formatReconnectDate(answer.reconnectBy)}.` : "") +
        " This card turns green after the next hourly sync (:50).",
    });
  }

  return (
    <div className="mt-3 px-3 py-3 bg-amber-500/10 border border-amber-500/20 rounded-[4px]" data-testid="spotify-reconnect">
      {reconnectBy && !done && (
        <p className="text-[12px] text-amber-300 mb-2" data-testid="spotify-reconnect-warning">
          Spotify&apos;s authorization runs out soon. Reconnect by {formatReconnectDate(reconnectBy)} to keep the sync running.
        </p>
      )}

      {!done && (
        <button
          type="button"
          onClick={start}
          disabled={busy !== null}
          className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-primary border border-border-subtle rounded-[6px] hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          {busy === "link" ? "Getting the link…" : url ? "Start again" : "Reconnect Spotify"}
        </button>
      )}

      {url && !done && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] text-text-secondary">
            1.{" "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-source-spotify underline underline-offset-2"
              data-testid="spotify-authorize-link"
            >
              Open Spotify in a new tab
            </a>{" "}
            and approve if it asks. The tab then shows a page that fails to load. That is expected.
          </p>
          <label htmlFor="spotify-callback" className="block text-[12px] text-text-secondary">
            2. Paste the address of the page that failed to load ({SPOTIFY_REDIRECT_URI}?code=…)
          </label>
          <input
            id="spotify-callback"
            type="text"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={`${SPOTIFY_REDIRECT_URI}?code=…&state=…`}
            className="w-full bg-surface-raised border border-border-subtle rounded-[4px] px-3 py-2 text-[12px] font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={finish}
            disabled={busy !== null || !pasted.trim()}
            className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-primary border border-border-subtle rounded-[6px] hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            {busy === "finish" ? "Finishing…" : "Finish"}
          </button>
        </div>
      )}

      {result && (
        <p
          role="status"
          className={`mt-2 text-[12px] ${result.kind === "ok" ? "text-green-400" : "text-red-400"}`}
          data-testid="spotify-reconnect-result"
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
