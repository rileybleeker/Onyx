"use client";

import { AutosaveRefused, messageOf } from "@/lib/autosave";
import { useAutosave, type UseAutosave } from "@/lib/use-autosave";

/** The finance pages' write runner: runs fn, shows its error text, then re-reads the page (router.refresh / onChanged). */
export type FinanceRun = (fn: () => Promise<string | null>) => void;

/**
 * Autosave for the finance editors (forecast drivers, budgets, category rules; Riley 2026-11-15, lib/autosave.ts).
 * `send` writes the value the way the page's own put() does and answers null or the server's error text
 * ("network error" when Onyx could not be reached, which is retried on its own). After a save the page re-reads its
 * data through `run`, exactly as the old Save buttons did. Nothing here reads or logs the values.
 */
export function useFinanceAutosave<T>(
  name: string,
  run: FinanceRun,
  send: (v: T) => Promise<string | null>,
  opts: { ready?: (v: T) => string | null; baseline?: T; delayMs?: number } = {},
): UseAutosave<T> {
  return useAutosave<T>(
    name,
    {
      delayMs: opts.delayMs ?? 1200,
      describeError: messageOf,
      ready: opts.ready,
      save: async (v) => {
        const err = await send(v);
        if (err === "network error") throw new Error("Couldn't reach Onyx.");
        if (err) throw new AutosaveRefused(err);
        run(async () => null); // re-read the page, as after a Save
      },
    },
    opts.baseline,
  );
}
