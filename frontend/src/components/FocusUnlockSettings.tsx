"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  describeStatus,
  FOCUS_RULES,
  FOCUS_RULE_TEXT,
  MAX_FOCUS_HABITS,
  type FocusUnlockRule,
  type FocusUnlockStatus,
} from "@/lib/focus-unlock";

/**
 * Settings card on /install: which Onyx habits unlock the iPhone Focus block, and the rule.
 * Reads and writes /api/focus/config (owner session); the habit list comes from /api/habits/list
 * (active habits in Notion); "Today" shows the same answer the phone gets from
 * /api/focus/unlock-status. Default (nothing chosen) = the phone's time-only rule, as before.
 */

interface Option {
  id: string;
  name: string;
  /** false = chosen earlier, but no longer an active habit in Notion. */
  active: boolean;
}

type Load = "loading" | "ready" | "error";

export default function FocusUnlockSettings() {
  const [load, setLoad] = useState<Load>("loading");
  const [loadError, setLoadError] = useState("");
  const [listError, setListError] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [rule, setRule] = useState<FocusUnlockRule>("or");
  const [selected, setSelected] = useState<string[]>([]);
  const [saved, setSaved] = useState<{ rule: FocusUnlockRule; ids: string[] }>({ rule: "or", ids: [] });
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState<FocusUnlockStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/focus/unlock-status", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as FocusUnlockStatus);
      setStatusFailed(false);
    } catch {
      setStatus(null);
      setStatusFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const configRes = await fetch("/api/focus/config", { cache: "no-store" });
        const config = await configRes.json();
        if (!configRes.ok) throw new Error(config.error ?? `HTTP ${configRes.status}`);
        const chosen = (config.chosen ?? []) as { id: string; name: string }[];

        // The active habit list lives in Notion. If it cannot be read, the chosen habits can still be
        // unticked and the rule changed.
        let active: { id: string; name: string }[] = [];
        let listFailed = false;
        try {
          const listRes = await fetch("/api/habits/list", { cache: "no-store" });
          const list = await listRes.json();
          if (!listRes.ok) throw new Error("list");
          active = ((list.habits ?? []) as { id: string; name: string }[]).filter((h) => h.id && h.name);
        } catch {
          listFailed = true;
        }
        if (cancelled) return;

        const activeIds = new Set(active.map((h) => h.id));
        const merged: Option[] = [
          ...active.map((h) => ({ id: h.id, name: h.name, active: true })),
          ...chosen.filter((c) => !activeIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, active: listFailed })),
        ];
        const ids = chosen.map((c) => c.id);
        const nextRule: FocusUnlockRule = config.rule === "and" ? "and" : "or";
        setOptions(merged);
        setListError(listFailed);
        setRule(nextRule);
        setSelected(ids);
        setSaved({ rule: nextRule, ids });
        setLoad("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoad("error");
      }
    })();
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const dirty = rule !== saved.rule || selected.length !== saved.ids.length || selected.some((id, i) => id !== saved.ids[i]);
  const atLimit = selected.length >= MAX_FOCUS_HABITS;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const chosen = new Set(selected);
    return options
      .filter((o) => chosen.has(o.id) || !q || o.name.toLowerCase().includes(q))
      .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.name.localeCompare(b.name));
  }, [options, selected, filter]);

  function toggle(id: string) {
    setSaveMessage(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_FOCUS_HABITS ? prev : [...prev, id]));
  }

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/focus/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule, habit_page_ids: selected }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const ids = ((json.chosen ?? []) as { id: string }[]).map((c) => c.id);
      const nextRule: FocusUnlockRule = json.rule === "and" ? "and" : "or";
      setRule(nextRule);
      setSelected(ids);
      setSaved({ rule: nextRule, ids });
      setSaveMessage({ ok: true, text: "Saved. The phone picks it up the next time the Onyx app is opened." });
      void loadStatus();
    } catch (e) {
      setSaveMessage({ ok: false, text: `Not saved: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 space-y-4" data-testid="focus-unlock-settings">
      <div>
        <h2 className="text-base font-medium text-text-primary">Focus: unlock with habits</h2>
        <p className="text-text-tertiary text-xs mt-1">
          Pick the habits that unlock the blocked apps on the iPhone. A habit counts once it is answered Yes for the
          day in Onyx. With nothing picked, the phone unlocks at its unlock time, as before. The unlock time, the
          blocked apps and the LinkedIn exception stay on the phone.
        </p>
      </div>

      {load === "loading" && <p className="text-text-tertiary text-sm">Loading…</p>}

      {load === "error" && (
        <>
          <p className="text-down text-sm">Couldn&apos;t load the Focus settings.</p>
          {loadError && <p className="text-text-tertiary text-xs">{loadError}</p>}
        </>
      )}

      {load === "ready" && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-text-secondary text-xs mb-1">Rule</legend>
            {FOCUS_RULES.map((r) => (
              <label key={r} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="focus-rule"
                  className="mt-1"
                  checked={rule === r}
                  onChange={() => {
                    setRule(r);
                    setSaveMessage(null);
                  }}
                />
                <span>
                  <span className="text-text-primary text-sm">{FOCUS_RULE_TEXT[r].label}</span>
                  <span className="block text-text-tertiary text-xs">{FOCUS_RULE_TEXT[r].detail}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-text-secondary text-xs">
                Habits ({selected.length} of {MAX_FOCUS_HABITS} max)
              </p>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter"
                aria-label="Filter habits"
                className="w-32 bg-surface border border-border-subtle rounded-[4px] px-2 py-1 text-xs text-text-primary"
              />
            </div>
            {listError && (
              <p className="text-down text-xs">
                Couldn&apos;t load the habit list from Notion. You can still untick a chosen habit or change the rule.
              </p>
            )}
            <ul className="max-h-64 overflow-y-auto border border-border-subtle rounded-[4px] divide-y divide-border-subtle">
              {visible.length === 0 && <li className="px-3 py-2 text-text-tertiary text-xs">No habits match.</li>}
              {visible.map((o) => {
                const checked = selected.includes(o.id);
                return (
                  <li key={o.id}>
                    <label className="flex items-start gap-2 px-3 py-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        disabled={!checked && atLimit}
                        onChange={() => toggle(o.id)}
                      />
                      <span className="text-sm text-text-primary">
                        {o.name}
                        {!o.active && (
                          <span className="block text-down text-xs">
                            No longer an active habit, so it cannot be answered. Untick it.
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="space-y-1.5">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="block w-full text-center bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-medium py-2.5 rounded-[4px] text-sm transition-colors"
            >
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
            {saveMessage && <p className={`text-xs ${saveMessage.ok ? "text-text-tertiary" : "text-down"}`}>{saveMessage.text}</p>}
          </div>
        </>
      )}

      <div className="border-t border-border-subtle pt-3 space-y-1.5">
        <p className="text-text-secondary text-xs">Today, as the phone sees it</p>
        {statusFailed && <p className="text-down text-xs">Couldn&apos;t load today&apos;s status.</p>}
        {!status && !statusFailed && <p className="text-text-tertiary text-xs">Loading…</p>}
        {status && (
          <>
            <p className="text-text-tertiary text-xs">Onyx day {status.behavioral_date}</p>
            {status.habits.length > 0 && (
              <ul className="space-y-0.5">
                {status.habits.map((h) => (
                  <li key={h.name} className="text-sm text-text-primary flex justify-between gap-3">
                    <span>{h.name}</span>
                    <span className={h.done ? "text-text-secondary" : "text-down"}>{h.done ? "Done" : "To do"}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-text-secondary text-xs">{describeStatus(status)}</p>
          </>
        )}
        <p className="text-text-tertiary text-xs">
          The phone only checks when the Onyx Screen Time app is opened (or its “Check Onyx Focus habits” shortcut
          runs), so open the app after finishing the habits. If the phone cannot reach Onyx it uses the unlock time
          alone. Before 6 AM Onyx still counts the previous day, so habits start counting at 6 AM.
        </p>
      </div>
    </div>
  );
}
