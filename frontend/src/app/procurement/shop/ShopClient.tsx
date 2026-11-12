"use client";
import { useState } from "react";
import type { SupplierCard } from "@/lib/punchout";

const card = "rounded-xl border border-border-subtle bg-surface-card p-5 space-y-3";
const button = "rounded border border-border-subtle px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed";

/** Supplier cards with the Shop button: starts a session server-side, then opens the supplier's StartPage. */
export default function ShopClient({ suppliers }: { suppliers: SupplierCard[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function shop(key: string) {
    setBusy(key);
    setError("");
    try {
      const res = await fetch("/api/procurement/punchout/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supplier: key }),
      });
      const body = (await res.json().catch(() => ({}))) as { startPage?: string; error?: string };
      if (!res.ok || !body.startPage) throw new Error(body.error || `Could not start (HTTP ${res.status}).`);
      window.location.assign(body.startPage);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the session.");
      setBusy(null);
    }
  }
  if (!suppliers.length) {
    return <p className="text-sm text-text-secondary">No PunchOut supplier is configured on this server.</p>;
  }
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {suppliers.map((s) => (
        <div key={s.key} className={card}>
          <h3 className="font-semibold">
            {s.name}
            <span className="ml-2 text-xs rounded bg-white/10 px-2 py-0.5">
              {s.source === "synthetic" ? "Synthetic test supplier" : s.mode === "test" ? "cXML, test mode" : "cXML, production"}
            </span>
          </h3>
          <p className="text-sm text-text-secondary">
            {s.source === "synthetic"
              ? "A pretend store hosted inside Onyx that speaks real cXML PunchOut. Use it to try the round trip; it is not a merchant and nothing can be bought."
              : "Opens the supplier's own site. Shop there, then use the supplier's return or checkout button to send the cart back to Onyx."}
          </p>
          <button className={button} disabled={busy !== null} onClick={() => shop(s.key)}>
            {busy === s.key ? "Starting session..." : "Shop"}
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="md:col-span-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
