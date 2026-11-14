import type { WriteReceipt } from "@/lib/chat-receipts";

/**
 * The box under a chat reply listing what Onyx actually wrote during that turn
 * (see lib/chat-receipts.ts). It is built from tool results on the server, never
 * from the reply text, so it only appears when a write tool really ran.
 */

const TONE: Record<WriteReceipt["status"], { mark: string; label: string; border: string; text: string }> = {
  saved: { mark: "✓", label: "Saved", border: "border-accent/40", text: "text-accent" },
  unchanged: { mark: "＝", label: "No change", border: "border-border-subtle", text: "text-text-tertiary" },
  not_saved: { mark: "✕", label: "Not saved", border: "border-amber-500/50", text: "text-amber-400" },
  unknown: { mark: "!", label: "Check this", border: "border-amber-500/50", text: "text-amber-400" },
};

export default function ChatReceipts({ receipts, heading = "Written to Onyx" }: { receipts: WriteReceipt[]; heading?: string }) {
  if (receipts.length === 0) return null;
  return (
    <section aria-label={heading} data-testid="chat-receipts" className="mt-2 rounded-xl border border-border-subtle bg-surface-card p-3 text-[13px] leading-relaxed">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{heading}</p>
      <ul className="space-y-2">
        {receipts.map((receipt, i) => {
          const tone = TONE[receipt.status] ?? TONE.unknown;
          return (
            <li key={i} data-status={receipt.status} className={`rounded-lg border ${tone.border} px-3 py-2`}>
              <p className="font-medium text-text-primary">
                <span aria-hidden="true" className={`mr-1.5 ${tone.text}`}>{tone.mark}</span>
                <span className="sr-only">{tone.label}: </span>
                {receipt.title}
              </p>
              <ul className="mt-1 space-y-0.5 text-text-secondary">
                {receipt.details.map((line, n) => <li key={n} className="break-words">{line}</li>)}
              </ul>
              {receipt.link && /^https:\/\//.test(receipt.link.href) && (
                <a href={receipt.link.href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-accent underline underline-offset-2">{receipt.link.label}</a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
