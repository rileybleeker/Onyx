// Unit-tagged number types (re-audit 2026-06-07, units/gpt-5/F-005).
//
// Onyx mixes units that are easy to confuse: WHOOP durations are milliseconds
// (`*_milli`), Garmin and Eight Sleep durations are seconds (`*_seconds`),
// energy is kJ (WHOOP) or kcal (Garmin, Cronometer), weight is stored in kg and
// shown in lb. Field names and comments carried the unit until now; these types
// let the compiler carry it too.
//
// How it works: `Seconds` is a plain number at runtime. For the type checker it
// carries an optional "unit" tag (the "flavored" branding pattern):
//   - a plain `number` is accepted wherever a `Seconds` is expected, so
//     untagged call sites (most Supabase rows arrive as `any`) keep compiling;
//   - a value tagged with a DIFFERENT unit is a compile error. Passing a
//     `Milliseconds` to `formatDuration(seconds: Seconds)` fails to build,
//     which is exactly the off-by-1000 mistake the audit worried about.
//
//   const inBed: Milliseconds = row.total_in_bed_time_milli;
//   formatDurationMs(inBed);   // ok
//   formatDuration(inBed);     // type error: "ms" is not "s"
//   formatDuration(msToSeconds(inBed)); // ok
//
// Arithmetic drops the tag (`a + b` is a plain `number`), so convert with the
// helpers below rather than with inline `* 1000` / `/ 60000` math, and tag a
// variable with its unit when it is computed from raw fields.

declare const unit: unique symbol;

/** A number tagged with unit `U` for the type checker only. Zero runtime cost. */
export type Unit<U extends string> = number & { readonly [unit]?: U };

export type Milliseconds = Unit<"ms">;
export type Seconds = Unit<"s">;
export type Minutes = Unit<"min">;
export type Hours = Unit<"h">;
export type Meters = Unit<"m">;
export type Kilograms = Unit<"kg">;
export type Pounds = Unit<"lb">;
export type Kilojoules = Unit<"kJ">;
export type Kilocalories = Unit<"kcal">;

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
export const MS_PER_HOUR = MS_PER_SECOND * SECONDS_PER_HOUR;

// Precise conversions; round at display time only (format.ts).
export const msToSeconds = (ms: Milliseconds): Seconds => ms / MS_PER_SECOND;
export const secondsToMs = (s: Seconds): Milliseconds => s * MS_PER_SECOND;
export const msToMinutes = (ms: Milliseconds): Minutes => ms / MS_PER_MINUTE;
export const minutesToSeconds = (min: Minutes): Seconds => min * SECONDS_PER_MINUTE;
export const hoursToSeconds = (h: Hours): Seconds => h * SECONDS_PER_HOUR;
export const hoursToMs = (h: Hours): Milliseconds => h * MS_PER_HOUR;
