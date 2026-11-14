// Run: node --test tests/weather.test.cjs
// Weather panel logic (lib/weather.ts) and the route's access rules. SYNTHETIC numbers only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const W = loadTs("lib/weather.ts");

function row(date, high, { hours = 24, night = 8, rain = 0, nightTemp = high - 10 } = {}) {
  return {
    calendar_date: date, temperature_max: high, temperature_min: high - 12, temperature_mean: high - 5,
    apparent_temp_max: high + 1, humidity_mean: 60, dew_point_mean: 5, pressure_mean: 980.5,
    precipitation_sum: rain, wind_speed_max: 16.09344, cloud_cover_mean: 40, daylight_hours: 10.5,
    sunshine_hours: 6, uv_index_max: 4.2, night_temp_mean: nightTemp, night_hours: night, n_hours: hours,
    latitude: 10.5, longitude: 20.5,
  };
}

test("metric rows are converted to US display units", () => {
  assert.equal(W.cToF(0), 32);
  assert.equal(W.cToF(-40), -40);
  assert.equal(W.cToF(null), null);
  assert.equal(W.mmToIn(25.4), 1);
  assert.equal(W.kmhToMph(16.09344), 10);
  const [d] = W.shapeWeatherRows([row("2030-01-01", 20, { rain: 12.7 })]);
  assert.deepEqual([d.highF, d.lowF, d.meanF, d.feelsHighF, d.nightF, d.dewPointF], [68, 46.4, 59, 69.8, 50, 41]);
  assert.deepEqual([d.rainIn, d.windMph, d.humidity, d.pressure, d.sunshineH, d.daylightH, d.uvMax], [0.5, 10, 60, 980.5, 6, 10.5, 4.2]);
  assert.ok(!("lat" in d) && !("latitude" in d), "the location is not part of a day");
});

test("numeric strings from PostgREST are parsed and nulls stay null", () => {
  const raw = { ...row("2030-01-01", 20), temperature_max: "21.5", uv_index_max: null, precipitation_sum: "" };
  const [d] = W.shapeWeatherRows([raw]);
  assert.equal(d.highF, 70.7);
  assert.equal(d.uvMax, null);
  assert.equal(d.rainIn, null, "a missing value is not zero rain");
});

test("a day with fewer than 20 hours is partial; an incomplete night has no night value", () => {
  assert.equal(W.isPartialDay(19), true);
  assert.equal(W.isPartialDay(20), false);
  const days = W.shapeWeatherRows([row("2030-01-02", 20, { hours: 9, night: 8 }), row("2030-01-01", 20, { night: 6 })]);
  assert.deepEqual(days.map((d) => [d.date, d.partial, d.nightF]), [["2030-01-01", false, null], ["2030-01-02", true, 50]]);
});

test("rows with a bad date or hour count are dropped", () => {
  const rows = [{ calendar_date: "nope", n_hours: 24 }, null, { calendar_date: "2030-01-01" }, row("2030-01-01", 1)];
  assert.equal(W.shapeWeatherRows(rows).length, 1);
});

test("30-day summary ignores partial days, sums rain, handles empty", () => {
  assert.equal(W.summary30([]), null);
  assert.equal(W.summary30(W.shapeWeatherRows([row("2030-01-03", 30, { hours: 5 })])), null);
  const days = W.shapeWeatherRows([
    row("2030-01-01", 10, { rain: 25.4 }), row("2030-01-02", 20, { rain: 25.4 }), row("2030-01-03", 40, { hours: 5, rain: 254 }),
  ]);
  const s = W.summary30(days);
  assert.equal(s.days, 2);
  assert.equal(s.highF, 59); // mean of 50 and 68
  assert.equal(s.rainIn, 2);
  assert.equal(s.humidity, 60);
  assert.equal(s.sunshineH, 6);
});

test("30-day summary only spans the 30 days ending at the newest complete day", () => {
  const days = W.shapeWeatherRows([row("2030-01-01", 40), row("2030-03-01", 10), row("2030-03-02", 20)]);
  assert.equal(W.summary30(days).days, 2);
  assert.equal(W.summary30(days).highF, 59);
  assert.equal(W.newestCompleteDate(days), "2030-03-02");
  assert.equal(W.newestCompleteDate([]), null);
});

test("chart points leave a partial day out of the daytime series but keep its finished night", () => {
  const pts = W.chartPoints(W.shapeWeatherRows([row("2030-01-01", 20), row("2030-01-02", 20, { hours: 10 })]));
  assert.deepEqual([pts[0].highF, pts[0].nightF, pts[0].rainIn], [68, 50, 0]);
  assert.deepEqual([pts[1].highF, pts[1].sunshineH, pts[1].rainIn, pts[1].humidity], [null, null, null, null]);
  assert.equal(pts[1].nightF, 50);
  assert.equal(pts[1].daylightH, 10.5, "day length is astronomy, known for a partial day too");
});

test("every metric's series points at a real chart-point field", () => {
  const [pt] = W.chartPoints(W.shapeWeatherRows([row("2030-01-01", 20)]));
  assert.deepEqual(W.WEATHER_METRIC_KEYS, ["temperature", "humidity", "sun", "rain", "pressure"]);
  for (const k of W.WEATHER_METRIC_KEYS) {
    const series = W.WEATHER_METRICS[k].series;
    assert.ok(series.length >= 1 && !series[0].secondary && !series[0].rightAxis, k);
    for (const s of series) assert.ok(s.key in pt, k + ": " + s.key);
  }
});

test("the selected columns exist in the schema file", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "weather_schema.sql"), "utf8");
  for (const col of W.WEATHER_COLUMNS.split(",")) assert.ok(new RegExp("\\n\\s+" + col + "\\s").test(sql), col);
});

test("route is force-dynamic, no-store, and outside the CI carve-out", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/weather/route.ts"), "utf8");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /no-store/);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes("/api/weather"));
});

test("server reader starts with the server-only import", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/weather-server.ts"), "utf8");
  assert.ok(src.startsWith('import "server-only";'));
});

test("the panel sits next to the air-quality panel and never animates", () => {
  const client = fs.readFileSync(path.join(SRC, "app/analytics/hrv/HrvAnalysisClient.tsx"), "utf8");
  const air = client.indexOf("<AirQualityPanel />");
  const weather = client.indexOf("<WeatherPanel />");
  assert.ok(air > 0 && weather > air && weather - air < 400, "WeatherPanel directly follows AirQualityPanel");
  const panel = fs.readFileSync(path.join(SRC, "components/WeatherPanel.tsx"), "utf8");
  assert.match(panel, /isAnimationActive=\{false\}/);
  assert.ok(!/isAnimationActive=\{true\}/.test(panel));
});

test("the status page knows the weather card", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
  assert.match(route, /weather: "Every 3h :32"/);
  assert.match(route, /latestBySrcType\["weather\|daily"\]/);
  assert.match(route, /\.eq\("source", "weather"\)\.eq\("data_type", "daily"\)/);
  const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");
  assert.match(page, /weather: "OPEN-METEO"/);
  assert.match(page, /"air_quality",\r?\n\s+"weather",/);
});
