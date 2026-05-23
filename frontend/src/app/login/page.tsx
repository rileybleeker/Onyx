"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

type Mode = "password" | "magic";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createSupabaseBrowser();

    if (mode === "password") {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }
      router.replace("/status");
      router.refresh();
      return;
    }

    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (authError) {
      setError(authError.message);
    } else {
      setSent(true);
    }
    setLoading(false);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setSent(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-text-primary">Onyx</h1>
          <p className="text-text-tertiary mt-1">Personal Data Scientist</p>
        </div>

        {sent ? (
          <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 text-center">
            <p className="text-text-primary font-medium">Check your email</p>
            <p className="text-text-secondary text-sm mt-2">
              We sent a magic link to <span className="text-text-primary">{email}</span>
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-surface-card border border-border-subtle rounded-[6px] p-6 space-y-4"
          >
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-text-secondary mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="w-full bg-surface-raised border border-border-subtle rounded-[4px] px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            {mode === "password" && (
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-text-secondary mb-1.5">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full bg-surface-raised border border-border-subtle rounded-[4px] px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-medium py-2.5 rounded-[4px] text-sm transition-colors"
            >
              {loading
                ? mode === "password"
                  ? "Signing in..."
                  : "Sending..."
                : mode === "password"
                  ? "Sign in"
                  : "Send magic link"}
            </button>

            <button
              type="button"
              onClick={() => switchMode(mode === "password" ? "magic" : "password")}
              className="w-full text-text-tertiary hover:text-text-secondary text-xs transition-colors"
            >
              {mode === "password"
                ? "Email me a magic link instead"
                : "Sign in with password instead"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
