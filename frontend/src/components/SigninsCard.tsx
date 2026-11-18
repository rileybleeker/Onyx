"use client";

import Link from "next/link";
import InfoHint from "@/components/InfoHint";
import {
  SIGNIN_REGISTRY,
  checklistFromStatuses,
  type SigninState,
  type SigninStatus,
} from "@/lib/signin-registry";
import { formatReconnectDate } from "@/lib/spotify-reconnect";

const STATE_WORD: Record<SigninState, string> = {
  ok: "OK",
  due_soon: "Due soon",
  needs_riley: "Needs you",
  unknown: "Unknown",
};

const STATE_COLOR: Record<SigninState, string> = {
  ok: "text-up",
  due_soon: "text-mid",
  needs_riley: "text-down",
  unknown: "text-text-tertiary",
};

/**
 * Sign-ins card at the top of /status: how many credentials renew themselves, how many need Riley,
 * and the one short checklist of what is due. The registry (lib/signin-registry.ts) holds the
 * how-to text; /api/status supplies only each entry's state and renew-by date.
 */
export default function SigninsCard({ signins }: { signins: SigninStatus[] }) {
  const byId = new Map(signins.map((s) => [s.id, s]));
  const live = SIGNIN_REGISTRY.filter((e) => e.live !== false);
  const selfCount = live.filter((e) => e.renewal === "self").length;
  const rileyCount = live.length - selfCount;

  const items = checklistFromStatuses(SIGNIN_REGISTRY, signins, Date.now()).items;
  const problems = live.filter((e) => e.renewal === "self" && (byId.get(e.id)?.state === "due_soon" || byId.get(e.id)?.state === "needs_riley"));

  return (
    <section data-testid="signins-card" className="rounded-card bg-surface-card shadow-card p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-medium text-text-primary">Sign-ins</h3>
        <InfoHint label="sign-ins">
          Every credential Onyx depends on. Self-renewing ones refresh on their own; the others are
          batched here when they are due within 45 days. Policy: docs/signins.md.
        </InfoHint>
      </div>
      <p className="mt-1 font-mono text-[13px] text-text-secondary">
        {selfCount} renew themselves · {rileyCount} need you
      </p>
      {items.length === 0 && problems.length === 0 ? (
        <p className="mt-2 text-[13px] text-up">Nothing due in the next 45 days</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li key={it.id} className="text-[13px]">
              <span className={STATE_COLOR[it.state]}>{STATE_WORD[it.state]}</span>
              <span className="text-text-primary"> · {it.label}</span>
              {it.renewBy && <span className="text-text-tertiary"> · by {formatReconnectDate(it.renewBy)}</span>}
              <div className="text-text-secondary">
                {it.link ? <Link href={it.link} className="underline">{it.howTo}</Link> : it.howTo}
              </div>
            </li>
          ))}
          {problems.map((e) => (
            <li key={e.id} className="text-[13px]">
              <span className="text-mid">Check</span>
              <span className="text-text-primary"> · {e.label}</span>
              <div className="text-text-secondary">{e.howTo}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
