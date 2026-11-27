const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "../price-forecast-tab.js");
delete require.cache[require.resolve(modulePath)];
const forecast = require(modulePath);

function syntheticBars(count = 900) {
  const start = 1_700_000_000;
  const bars = [];
  for (let index = 0; index < count; index += 1) {
    const center = 100 + index * 0.012 + Math.sin(index / 19) * 2.1 + Math.sin(index / 6) * 0.7;
    const open = center - Math.sin(index / 4) * 0.13;
    const close = center + Math.cos(index / 5) * 0.14;
    bars.push({
      time: start + index * 300,
      close_time: start + (index + 1) * 300,
      open,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      close,
      volume: 100 + (index % 31),
    });
  }
  return bars;
}

const bars = syntheticBars();
const settings = forecast.normalizeSettings({
  ...forecast.DEFAULT_SETTINGS,
  min_train_samples: 120,
  train_window: 300,
  neutral_bps: 5,
});
const result = forecast.buildCausalForecast(bars, settings);

assert.equal(result.error, null);
assert.ok(result.latest, "latest completed candle must receive a forecast");
assert.ok(result.forecast_signals.length > 100, "final-quarter holdout must produce walk-forward forecasts");
assert.equal(result.validation.predictions, result.forecast_signals.length);
assert.ok(result.validation.rank_ic >= -1 && result.validation.rank_ic <= 1);
assert.ok(result.validation.brier >= 0 && result.validation.brier <= 1);
const probabilityTotal = Object.values(result.latest.probabilities).reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(probabilityTotal - 1) < 1e-12, "Up/Neutral/Down probabilities must sum to one");
assert.ok(result.latest.train_samples <= settings.train_window, "training window must be enforced");
assert.ok(result.indicators.maFast.slice(0, settings.ma_fast - 1).every((value) => value === null),
  "MA warm-up values must remain null rather than being coerced to zero and distorting the chart scale");

const sourceIndex = 600;
const originalAtSource = forecast.forecastAtIndex(bars, settings, sourceIndex);
const changedFuture = bars.map((bar, index) => index > sourceIndex
  ? { ...bar, open: bar.open * 4, high: bar.high * 4, low: bar.low * 4, close: bar.close * 4 }
  : { ...bar });
const changedAtSource = forecast.forecastAtIndex(changedFuture, settings, sourceIndex);
assert.deepEqual(changedAtSource, originalAtSource,
  "changing candles after the source time must not alter a historical forecast");

const noInputs = forecast.buildCausalForecast(bars, {
  ...settings,
  use_momentum: false,
  use_macd: false,
  use_rsi: false,
  use_ma: false,
  use_volatility: false,
});
assert.match(noInputs.error, /Enable at least one model input group/);

const momentumOnly = forecast.buildCausalForecast(bars, {
  ...settings,
  use_macd: false,
  use_rsi: false,
  use_ma: false,
  use_volatility: false,
});
assert.equal(momentumOnly.error, null);
assert.deepEqual(momentumOnly.latest.feature_names, ["return_1_bps", "return_6_bps", "momentum_accel_bps"],
  "feature switches must change the real fitted design matrix");

const now = 1_700_001_000;
const rawRows = [
  [1_700_000_000_000, "100", "101", "99", "100.5", "10", 1_700_000_299_000],
  [1_700_000_300_000, "100.5", "102", "100", "101", "12", 1_700_001_200_000],
];
const parsed = forecast.parseKlines(rawRows, "5m", now);
assert.equal(parsed.length, 1, "forming or future-close candles must be excluded");
assert.equal(parsed[0].close, 100.5);

const source = fs.readFileSync(modulePath, "utf8");
assert.match(source, /RESEARCH ONLY · NO ORDERS/,
  "forecast tab must not imply that model output is live execution");
assert.match(source, /completed candles only · forming candle excluded/,
  "forecast timing must disclose its completed-candle source");
assert.match(source, /forecast_signals: forecastSignals/,
  "historical forecast outputs must be a distinct position-independent stream");
assert.match(source, /value !== null && value !== undefined && value !== ""/,
  "numeric guards must reject null indicator warm-up values");
assert.match(source, /@media \(max-width:900px\)[\s\S]*?\.pfGrid \{ display:block; \}/,
  "the forecast chart must collapse to a true single-column mobile layout");
const featureMarkup = forecast.featureRowsMarkup(settings);
for (const group of ["momentum", "macd", "rsi", "ma", "volatility"]) {
  assert.match(featureMarkup, new RegExp(`id="pfUse_${group}"`),
    `${group} must have a real input switch`);
}

const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
assert.match(index, /id="navTabPriceForecast"/);
assert.match(index, /id="tabContentPriceForecast"/);
assert.match(index, /price-forecast-tab\.js/);
assert.match(index, /activateEngineWhenReady\(\(\) => window\.priceForecastTab, isPriceForecast, "tabContentPriceForecast"\)/,
  "tab activation must use the shared lazy activation path");
assert.match(index, /window\.priceForecastTab\.onTabDeactivated\(\)/,
  "navigation away must stop forecast polling");

console.log("Causal price forecast tab tests passed");
