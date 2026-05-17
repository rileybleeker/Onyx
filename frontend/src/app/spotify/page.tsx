"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import StatCard from "@/components/StatCard";
import { chartTooltip, axisTick, gridStyle, accentColor } from "@/lib/chart-theme";
import {
  getSpotifyKpis,
  getSpotifyDailyVolume,
  getSpotifyDailyAudioFeatures,
  getSpotifyTopArtists,
  getSpotifyTopTracks,
  getSpotifyHourOfDay,
  type SpotifyDailySignatureRow,
} from "@/lib/queries";

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

const spotifyGreen = "#1DB954";

type Kpis = Awaited<ReturnType<typeof getSpotifyKpis>>;
type TopArtists = Awaited<ReturnType<typeof getSpotifyTopArtists>>;
type TopTracks = Awaited<ReturnType<typeof getSpotifyTopTracks>>;
type HourBuckets = Awaited<ReturnType<typeof getSpotifyHourOfDay>>;

export default function SpotifyPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [volume, setVolume] = useState<SpotifyDailySignatureRow[]>([]);
  const [features, setFeatures] = useState<SpotifyDailySignatureRow[]>([]);
  const [topArtists, setTopArtists] = useState<TopArtists>([]);
  const [topTracks, setTopTracks] = useState<TopTracks>([]);
  const [hours, setHours] = useState<HourBuckets>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getSpotifyKpis(30),
      getSpotifyDailyVolume(90),
      getSpotifyDailyAudioFeatures(60),
      getSpotifyTopArtists(30, 10),
      getSpotifyTopTracks(30, 10),
      getSpotifyHourOfDay(30),
    ])
      .then(([k, v, f, ta, tt, h]) => {
        setKpis(k);
        setVolume(v);
        setFeatures(f);
        setTopArtists(ta);
        setTopTracks(tt);
        setHours(h);
      })
      .catch((err) => console.error("Spotify page load:", err))
      .finally(() => setLoading(false));
  }, []);

  const hasData = (kpis?.totalPlays ?? 0) > 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-medium text-text-primary tracking-tight">Spotify</h1>
        <p className="text-[12px] text-text-tertiary mt-0.5">
          Listening behavior — last 30 days (charts cover 60–90)
        </p>
      </header>

      {loading && (
        <p className="text-[12px] text-text-tertiary font-mono">Loading…</p>
      )}

      {!loading && !hasData && (
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-8 text-center">
          <p className="text-[13px] text-text-secondary">No Spotify plays in the database yet.</p>
          <p className="text-[11px] text-text-tertiary mt-2 font-mono">
            Run the OAuth bootstrap: <code>python spotify_etl.py --auth</code>
          </p>
          <p className="text-[11px] text-text-tertiary mt-1 font-mono">
            Then: <code>python ci_token_helper.py upload spotify</code>, then <code>python spotify_etl.py</code>
          </p>
        </div>
      )}

      {!loading && hasData && (
        <>
          {/* KPI Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Plays" value={kpis!.totalPlays} sublabel="last 30 days" />
            <StatCard
              label="Listening"
              value={kpis!.totalHours.toFixed(1)}
              unit="hrs"
              sublabel="last 30 days"
            />
            <StatCard
              label="Unique Tracks"
              value={kpis!.uniqueTracks}
              sublabel={`${kpis!.uniqueArtists} artists`}
            />
            <StatCard
              label="Top Track"
              value={kpis!.topTrack ? `${kpis!.topTrack.count}×` : "—"}
              sublabel={
                kpis!.topTrack
                  ? `${kpis!.topTrack.name ?? "—"} · ${kpis!.topTrack.artist ?? "—"}`
                  : undefined
              }
            />
          </div>

          {/* Listening volume over time */}
          <ChartCard
            title="Listening volume"
            subtitle="plays per day, last 90 days"
            source="SPOTIFY"
          >
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={volume} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={axisTick} />
                <Tooltip {...chartTooltip} />
                <Line
                  type="monotone"
                  dataKey="play_count"
                  stroke={spotifyGreen}
                  strokeWidth={1.5}
                  dot={false}
                  name="plays"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Audio mood signature */}
          <ChartCard
            title="Audio mood signature"
            subtitle="daily mean of valence, energy, danceability — last 60 days"
            source="RECCOBEATS"
            info="Valence = positivity. Energy = intensity. Danceability = rhythmic regularity. Days with no featurized plays are omitted, so the line isn't biased by gaps."
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={features} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={axisTick} domain={[0, 1]} />
                <Tooltip {...chartTooltip} />
                <Legend wrapperStyle={legendStyle} />
                <Line type="monotone" dataKey="avg_valence" stroke="#F59E0B" strokeWidth={1.4} dot={false} name="valence" />
                <Line type="monotone" dataKey="avg_energy" stroke={accentColor} strokeWidth={1.4} dot={false} name="energy" />
                <Line type="monotone" dataKey="avg_danceability" stroke="#8B5CF6" strokeWidth={1.4} dot={false} name="danceability" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Top artists + top tracks side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ChartCard title="Top artists" subtitle="last 30 days, by play count" source="SPOTIFY">
              <ol className="space-y-1.5">
                {topArtists.map((a, i) => (
                  <li key={`${a.name}-${i}`} className="flex items-baseline justify-between text-[12px] font-mono">
                    <span className="text-text-secondary truncate pr-3">
                      <span className="text-text-tertiary mr-2">{String(i + 1).padStart(2, "0")}</span>
                      {a.name}
                    </span>
                    <span className="text-text-primary tabular-nums">
                      {a.plays} <span className="text-text-tertiary text-[10px]">plays</span>
                    </span>
                  </li>
                ))}
                {topArtists.length === 0 && (
                  <li className="text-[11px] text-text-tertiary">No artists yet.</li>
                )}
              </ol>
            </ChartCard>

            <ChartCard title="Top tracks" subtitle="last 30 days, by play count" source="SPOTIFY">
              <ol className="space-y-1.5">
                {topTracks.map((t, i) => (
                  <li key={`${t.name}-${i}`} className="flex items-baseline justify-between text-[12px] font-mono">
                    <span className="text-text-secondary truncate pr-3">
                      <span className="text-text-tertiary mr-2">{String(i + 1).padStart(2, "0")}</span>
                      {t.name}
                      <span className="text-text-tertiary"> · {t.artist}</span>
                    </span>
                    <span className="text-text-primary tabular-nums">
                      {t.plays} <span className="text-text-tertiary text-[10px]">plays</span>
                    </span>
                  </li>
                ))}
                {topTracks.length === 0 && (
                  <li className="text-[11px] text-text-tertiary">No tracks yet.</li>
                )}
              </ol>
            </ChartCard>
          </div>

          {/* Hour of day */}
          <ChartCard
            title="Listening by hour of day"
            subtitle="ET, last 30 days"
            source="SPOTIFY"
            info="Bars are play counts grouped by hour-of-day (America/New_York). Reveals chronotype patterns — heavy late-night listening shows up here."
          >
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hours} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="hour" tick={axisTick} />
                <YAxis tick={axisTick} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="plays" fill={spotifyGreen} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}
    </div>
  );
}
