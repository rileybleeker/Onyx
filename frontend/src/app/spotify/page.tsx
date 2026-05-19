"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import StatCard from "@/components/StatCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, accentColor, axisLabel } from "@/lib/chart-theme";
import {
  getSpotifyKpis,
  getSpotifyDailyVolume,
  getSpotifyAudioFeatureDrift,
  getSpotifyGenreRotation,
  getSpotifyDiscoveryRate,
  getSpotifyTopArtists,
  getSpotifyTopTracks,
  getSpotifyHourOfDay,
  getSpotifySonicProfile,
  getSpotifyLedger,
  getSpotifyTopGenres,
  rangeLabel,
  type SpotifyDailySignatureRow,
  type SpotifyLedgerRow,
  type SpotifyRange,
} from "@/lib/queries";

const LEDGER_PER_PAGE = 50;

const GENRE_PALETTE = [
  "#1DB954", // spotify green
  "#F59E0B", // amber (valence)
  "#06B6D4", // cyan (energy)
  "#8B5CF6", // purple (danceability)
  "#EC4899", // pink
  "#10B981", // emerald
  "#F97316", // orange
  "#3B82F6", // blue
];

function applyRollingMean<T extends object>(
  rows: T[],
  keys: (keyof T & string)[],
  window: number = 7,
): T[] {
  if (rows.length < 2) return rows;
  const w = Math.min(window, rows.length);
  return rows.map((row, i) => {
    const start = Math.max(0, i - w + 1);
    const slice = rows.slice(start, i + 1);
    const smoothed = { ...row } as Record<string, unknown>;
    for (const k of keys) {
      let sum = 0;
      let n = 0;
      for (const r of slice) {
        const v = (r as Record<string, unknown>)[k];
        if (typeof v === "number" && !Number.isNaN(v)) {
          sum += v;
          n += 1;
        }
      }
      smoothed[k] = n > 0 ? sum / n : null;
    }
    return smoothed as T;
  });
}

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

const spotifyGreen = "#1DB954";

type Kpis = Awaited<ReturnType<typeof getSpotifyKpis>>;
type TopArtists = Awaited<ReturnType<typeof getSpotifyTopArtists>>;
type TopTracks = Awaited<ReturnType<typeof getSpotifyTopTracks>>;
type HourBuckets = Awaited<ReturnType<typeof getSpotifyHourOfDay>>;
type SonicProfile = Awaited<ReturnType<typeof getSpotifySonicProfile>>;
type TopGenres = Awaited<ReturnType<typeof getSpotifyTopGenres>>;
type FeatureDrift = Awaited<ReturnType<typeof getSpotifyAudioFeatureDrift>>;
type GenreRotation = Awaited<ReturnType<typeof getSpotifyGenreRotation>>;
type DiscoveryRate = Awaited<ReturnType<typeof getSpotifyDiscoveryRate>>;

function defaultPlaylistName(): string {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `Onyx — Top tracks ${fmt.format(new Date())}`;
}

export default function SpotifyPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [volume, setVolume] = useState<SpotifyDailySignatureRow[]>([]);
  const [drift, setDrift] = useState<FeatureDrift>([]);
  const [genreRotation, setGenreRotation] = useState<GenreRotation>({ rows: [], topGenres: [] });
  const [discovery, setDiscovery] = useState<DiscoveryRate>([]);
  const [topArtists, setTopArtists] = useState<TopArtists>([]);
  const [topTracks, setTopTracks] = useState<TopTracks>([]);
  const [hours, setHours] = useState<HourBuckets>([]);
  const [sonic, setSonic] = useState<SonicProfile>(null);
  const [genres, setGenres] = useState<TopGenres>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<SpotifyRange>("30d");

  // Ledger pagination is separate from the main page fetch so paging through
  // doesn't re-load the charts.
  const [ledgerPage, setLedgerPage] = useState(0);
  const [ledger, setLedger] = useState<SpotifyLedgerRow[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(true);

  // Create-playlist modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [playlistName, setPlaylistName] = useState(defaultPlaylistName());
  const [playlistDesc, setPlaylistDesc] = useState("Created from Onyx — most-played tracks from the last 30 days.");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{ spotify_url: string; name: string; track_count: number } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function submitCreatePlaylist() {
    setCreating(true);
    setCreateError(null);
    try {
      const trackIds = topTracks.map((t) => t.track_id).filter(Boolean);
      const resp = await fetch("/api/spotify/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: playlistName,
          description: playlistDesc,
          track_ids: trackIds,
          public: false,
          created_via: "button",
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`);
      setCreateResult(json);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setCreateResult(null);
    setCreateError(null);
    // Reset name to a fresh default for next time
    setPlaylistName(defaultPlaylistName());
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getSpotifyKpis(range),
      getSpotifyDailyVolume(range),
      getSpotifyAudioFeatureDrift(range),
      getSpotifyGenreRotation(range, 8),
      getSpotifyDiscoveryRate(range),
      getSpotifyTopArtists(range, 10),
      getSpotifyTopTracks(range, 10),
      getSpotifyHourOfDay(range),
      getSpotifySonicProfile(range),
      getSpotifyTopGenres(range, 10),
    ])
      .then(([k, v, d, gr, disc, ta, tt, h, sp, g]) => {
        setKpis(k);
        setVolume(v);
        setDrift(d);
        setGenreRotation(gr);
        setDiscovery(disc);
        setTopArtists(ta);
        setTopTracks(tt);
        setHours(h);
        setSonic(sp);
        setGenres(g);
      })
      .catch((err) => console.error("Spotify page load:", err))
      .finally(() => setLoading(false));
    // Reset ledger to page 0 whenever the range changes
    setLedgerPage(0);
  }, [range]);

  useEffect(() => {
    setLedgerLoading(true);
    getSpotifyLedger(range, ledgerPage, LEDGER_PER_PAGE)
      .then(({ rows, totalCount }) => {
        setLedger(rows);
        setLedgerTotal(totalCount);
      })
      .catch((err) => console.error("Spotify ledger:", err))
      .finally(() => setLedgerLoading(false));
  }, [range, ledgerPage]);

  const hasData = (kpis?.totalPlays ?? 0) > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-medium text-text-primary tracking-tight">Spotify</h1>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            Listening behavior — {rangeLabel(range)}
          </p>
        </div>
        <RangeFilter value={range} onChange={setRange} accent={spotifyGreen} />
      </header>

      <p className="text-[11px] text-text-tertiary leading-relaxed border-l-2 border-[#1DB954]/30 pl-3">
        <span className="text-text-secondary">Coverage note:</span> Only plays that Spotify&apos;s
        backend knows about appear here. Offline playback from Spotify-licensed partner devices
        (Garmin watches, some car head units, older standalone wearables) isn&apos;t reported to
        the API and won&apos;t show up — even after the device reconnects. If you listen heavily
        on Garmin during workouts, this dashboard under-counts that listening.
      </p>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeModal}
        >
          <div
            className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            {!createResult && (
              <>
                <h2 className="text-[15px] font-medium text-text-primary mb-1">Create Spotify playlist</h2>
                <p className="text-[11px] text-text-tertiary mb-4">
                  {topTracks.length} tracks · private · added to your Spotify account
                </p>
                <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">Name</label>
                <input
                  type="text"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  className="w-full mb-3 px-3 py-2 text-[13px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none transition-colors"
                  disabled={creating}
                />
                <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">Description</label>
                <textarea
                  value={playlistDesc}
                  onChange={(e) => setPlaylistDesc(e.target.value)}
                  rows={3}
                  className="w-full mb-3 px-3 py-2 text-[13px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none transition-colors resize-none"
                  disabled={creating}
                />
                {createError && (
                  <p className="text-[11px] text-red-400 font-mono mb-3 break-all">{createError}</p>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={closeModal}
                    disabled={creating}
                    className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitCreatePlaylist}
                    disabled={creating || !playlistName.trim()}
                    className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
                  >
                    {creating ? "Creating…" : "Create"}
                  </button>
                </div>
              </>
            )}
            {createResult && (
              <>
                <h2 className="text-[15px] font-medium text-text-primary mb-1">Playlist created</h2>
                <p className="text-[12px] text-text-secondary mb-1 break-words">{createResult.name}</p>
                <p className="text-[11px] text-text-tertiary font-mono mb-4">
                  {createResult.track_count} tracks · private
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={closeModal}
                    className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary transition-colors"
                  >
                    Close
                  </button>
                  <a
                    href={createResult.spotify_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 border border-[#1DB954]/40 rounded-[4px] transition-colors"
                  >
                    Open in Spotify
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
            <StatCard label="Plays" value={kpis!.totalPlays} sublabel={rangeLabel(range)} />
            <StatCard
              label="Listening"
              value={kpis!.totalHours.toFixed(1)}
              unit="hrs"
              sublabel={rangeLabel(range)}
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
            subtitle={`plays per day, ${rangeLabel(range)}`}
            source="SPOTIFY"
          >
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={volume} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={axisTick} width={50} label={axisLabel("plays", "y")} />
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

          {/* Taste evolution — three trend charts */}
          <section className="space-y-4">
            <div className="border-l-2 border-[#1DB954]/40 pl-3">
              <h2 className="text-[14px] font-medium text-text-primary">Taste evolution</h2>
              <p className="text-[11px] text-text-tertiary mt-0.5">
                How your listening has changed across {rangeLabel(range)}. Each chart is smoothed
                with a 7-day rolling mean (where the range is long enough) so daily noise doesn&apos;t
                drown out the trend.
              </p>
            </div>

            {/* Sound evolution — audio feature drift */}
            <ChartCard
              title="Sound evolution"
              subtitle={`7 audio features over time — ${rangeLabel(range)}`}
              source="RECCOBEATS"
              info="Daily mean of each feature, smoothed with a 7-day right-aligned rolling mean. All features are normalized 0–1. Days with no featurized plays are dropped before smoothing so gaps don't pull the line. Rising acousticness + falling energy is the classic 'going introspective' signature; rising danceability + speechiness leans into hip-hop / dance territory."
            >
              {drift.length === 0 ? (
                <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                  No featurized plays in this range.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart
                    data={applyRollingMean(drift, [
                      "avg_valence",
                      "avg_energy",
                      "avg_danceability",
                      "avg_acousticness",
                      "avg_instrumentalness",
                      "avg_liveness",
                      "avg_speechiness",
                    ])}
                    margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={axisTick} domain={[0, 1]} />
                    <Tooltip {...chartTooltip} formatter={(v) => (typeof v === "number" ? v.toFixed(3) : String(v))} />
                    <Legend wrapperStyle={legendStyle} />
                    <Line type="monotone" dataKey="avg_valence" stroke="#F59E0B" strokeWidth={1.3} dot={false} name="valence" />
                    <Line type="monotone" dataKey="avg_energy" stroke={accentColor} strokeWidth={1.3} dot={false} name="energy" />
                    <Line type="monotone" dataKey="avg_danceability" stroke="#8B5CF6" strokeWidth={1.3} dot={false} name="danceability" />
                    <Line type="monotone" dataKey="avg_acousticness" stroke="#10B981" strokeWidth={1.3} dot={false} name="acousticness" />
                    <Line type="monotone" dataKey="avg_instrumentalness" stroke="#EC4899" strokeWidth={1.3} dot={false} name="instrumentalness" />
                    <Line type="monotone" dataKey="avg_liveness" stroke="#F97316" strokeWidth={1.3} dot={false} name="liveness" />
                    <Line type="monotone" dataKey="avg_speechiness" stroke="#A1A1AA" strokeWidth={1.3} dot={false} name="speechiness" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Genre rotation — stacked area */}
            <ChartCard
              title="Genre rotation"
              subtitle={`daily play composition, top ${genreRotation.topGenres.length} genres + other — ${rangeLabel(range)}`}
              source="MUSICBRAINZ"
              info="Stacked area shows how many plays each day came from each top genre. Each artist's full tag set contributes — heavy-rotation artists weight their genres more. Tracks whose artist had no MusicBrainz match fall into 'other'."
            >
              {genreRotation.rows.length === 0 ? (
                <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                  No plays in this range.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={genreRotation.rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={axisTick} width={50} label={axisLabel("plays", "y")} />
                    <Tooltip {...chartTooltip} />
                    <Legend wrapperStyle={legendStyle} />
                    {genreRotation.topGenres.map((g, i) => (
                      <Area
                        key={g}
                        type="monotone"
                        dataKey={g}
                        stackId="1"
                        stroke={GENRE_PALETTE[i % GENRE_PALETTE.length]}
                        fill={GENRE_PALETTE[i % GENRE_PALETTE.length]}
                        fillOpacity={0.6}
                        name={g}
                      />
                    ))}
                    <Area
                      type="monotone"
                      dataKey="other"
                      stackId="1"
                      stroke="#52525B"
                      fill="#52525B"
                      fillOpacity={0.4}
                      name="other"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Discovery rate */}
            <ChartCard
              title="Discovery rate"
              subtitle={`% of plays that were brand-new tracks — ${rangeLabel(range)}`}
              source="SPOTIFY"
              info="For each day, the % of plays that were tracks you'd never played before (across all-time history, not just this range). The 7-day rolling mean smooths the daily spikes. Sustained high = exploration mode; sustained low = comfort-zone listening."
            >
              {discovery.length === 0 ? (
                <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                  No plays in this range.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart
                    data={applyRollingMean(discovery, ["pct_new"])}
                    margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="calendar_date" tick={axisTick} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={axisTick} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                    <Tooltip {...chartTooltip} formatter={(v) => (typeof v === "number" ? `${v.toFixed(1)}%` : String(v))} />
                    <Line type="monotone" dataKey="pct_new" stroke={spotifyGreen} strokeWidth={1.6} dot={false} name="% new tracks" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </section>

          {/* Current sonic profile */}
          <ChartCard
            title="Current sonic profile"
            subtitle={`play-weighted mean of 7 audio features — ${rangeLabel(range)}`}
            source="RECCOBEATS"
            info="All values normalized 0–1. Valence = positivity. Energy = intensity. Danceability = rhythmic regularity. Acousticness = acoustic vs. electronic. Instrumentalness = lack of vocals. Liveness = live-recording probability. Speechiness = spoken-word content. Weighted by play count so heavy rotation moves the shape."
          >
            {sonic ? (
              <ResponsiveContainer width="100%" height={320}>
                <RadarChart
                  data={sonic.profile}
                  margin={{ top: 12, right: 24, left: 24, bottom: 12 }}
                >
                  <PolarGrid stroke="#ffffff" strokeOpacity={0.08} />
                  <PolarAngleAxis
                    dataKey="feature"
                    tick={{ ...axisTick, fontSize: 11 }}
                    tickFormatter={(v: string) => v.charAt(0).toUpperCase() + v.slice(1)}
                  />
                  <PolarRadiusAxis
                    angle={90}
                    domain={[0, 1]}
                    tick={{ ...axisTick, fontSize: 9 }}
                    tickCount={5}
                    stroke="#ffffff"
                    strokeOpacity={0.1}
                  />
                  <Radar
                    name="profile"
                    dataKey="value"
                    stroke={spotifyGreen}
                    fill={spotifyGreen}
                    fillOpacity={0.25}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                  <Tooltip
                    {...chartTooltip}
                    formatter={(value) => (typeof value === "number" ? value.toFixed(3) : String(value))}
                  />
                </RadarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                No featurized plays in the last 30 days.
              </p>
            )}
            {sonic && (
              <p className="text-[10px] text-text-tertiary font-mono mt-2 text-center">
                {sonic.featurizedPlays} / {sonic.totalPlays} plays featurized · {rangeLabel(range)}
              </p>
            )}
          </ChartCard>

          {/* Top genres + top artists + top tracks side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <ChartCard
              title="Top genres"
              subtitle={`${rangeLabel(range)}, by play count`}
              source="MUSICBRAINZ"
              info="Each play counts once toward every genre tag MusicBrainz has for that artist, so heavy-rotation artists weight their genres more. Genres come from MusicBrainz (Spotify Dev Mode strips genres post-Feb 2026)."
            >
              <ol className="space-y-1.5">
                {genres.map((g, i) => (
                  <li key={`${g.genre}-${i}`} className="flex items-baseline justify-between text-[12px] font-mono">
                    <span className="text-text-secondary truncate pr-3">
                      <span className="text-text-tertiary mr-2">{String(i + 1).padStart(2, "0")}</span>
                      {g.genre}
                    </span>
                    <span className="text-text-primary tabular-nums">
                      {g.plays} <span className="text-text-tertiary text-[10px]">plays</span>
                    </span>
                  </li>
                ))}
                {genres.length === 0 && (
                  <li className="text-[11px] text-text-tertiary">No genres yet.</li>
                )}
              </ol>
            </ChartCard>

            <ChartCard title="Top artists" subtitle={`${rangeLabel(range)}, by play count`} source="SPOTIFY">
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

            <ChartCard title="Top tracks" subtitle={`${rangeLabel(range)}, by play count`} source="SPOTIFY">
              <button
                onClick={() => setModalOpen(true)}
                disabled={topTracks.length === 0}
                className="mb-3 w-full px-3 py-2 text-[11px] font-mono font-medium tracking-wide text-text-primary bg-[#1DB954]/15 hover:bg-[#1DB954]/25 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/30 rounded-[4px] transition-colors"
              >
                Create private Spotify playlist from these {topTracks.length} tracks
              </button>
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
            subtitle={`ET, ${rangeLabel(range)}`}
            source="SPOTIFY"
            info="Bars are play counts grouped by hour-of-day (America/New_York). Reveals chronotype patterns — heavy late-night listening shows up here."
          >
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hours} margin={{ top: 8, right: 8, left: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="hour" tick={axisTick} height={45} label={axisLabel("hour of day (ET)", "x")} />
                <YAxis tick={axisTick} width={50} label={axisLabel("plays", "y")} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="plays" fill={spotifyGreen} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Play ledger */}
          <ChartCard
            title="Play ledger"
            subtitle={`every play, newest first · ${rangeLabel(range)}${ledgerTotal > 0 ? ` · ${ledgerTotal.toLocaleString()} plays` : ""}`}
            source="SPOTIFY"
            info="Every track that registered in Spotify's recently-played feed for the selected range. Spotify's 30-second minimum applies — anything skipped sooner doesn't appear."
          >
            {ledgerLoading && ledger.length === 0 && (
              <p className="text-[11px] text-text-tertiary font-mono py-8 text-center">Loading…</p>
            )}
            {!ledgerLoading && ledger.length === 0 && (
              <p className="text-[11px] text-text-tertiary font-mono py-8 text-center">
                No plays in this range.
              </p>
            )}
            {ledger.length > 0 && (
              <>
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-[12px] font-mono">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border-subtle">
                        <th className="text-left py-2 px-1 font-normal w-[140px]">When (ET)</th>
                        <th className="text-left py-2 px-1 font-normal">Track</th>
                        <th className="text-left py-2 px-1 font-normal">Artist</th>
                        <th className="text-right py-2 px-1 font-normal w-[60px]">Dur</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((r) => (
                        <tr
                          key={`${r.played_at}-${r.track_id}`}
                          className="border-b border-border-subtle/50 hover:bg-white/[0.02]"
                        >
                          <td className="py-1.5 px-1 text-text-tertiary tabular-nums whitespace-nowrap">
                            {formatPlayedAt(r.played_at)}
                          </td>
                          <td className="py-1.5 px-1 text-text-primary truncate max-w-[260px]" title={r.track_name ?? ""}>
                            {r.track_name ?? "—"}
                          </td>
                          <td className="py-1.5 px-1 text-text-secondary truncate max-w-[200px]" title={r.artist_name ?? ""}>
                            {r.artist_name ?? "—"}
                          </td>
                          <td className="py-1.5 px-1 text-right text-text-tertiary tabular-nums">
                            {formatDuration(r.duration_ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between mt-3 text-[11px] font-mono">
                  <span className="text-text-tertiary">
                    Page {ledgerPage + 1} of {Math.max(1, Math.ceil(ledgerTotal / LEDGER_PER_PAGE))}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setLedgerPage((p) => Math.max(0, p - 1))}
                      disabled={ledgerPage === 0 || ledgerLoading}
                      className="px-2.5 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed border border-border-subtle rounded-[4px] transition-colors"
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => setLedgerPage((p) => p + 1)}
                      disabled={(ledgerPage + 1) * LEDGER_PER_PAGE >= ledgerTotal || ledgerLoading}
                      className="px-2.5 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed border border-border-subtle rounded-[4px] transition-colors"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              </>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}

const playedAtFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatPlayedAt(iso: string): string {
  return playedAtFmt.format(new Date(iso));
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
