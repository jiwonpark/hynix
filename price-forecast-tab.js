(function (root, factory) {
  const instance = factory();
  if (typeof module === "object" && module.exports) module.exports = instance;
  if (root) root.priceForecastTab = instance;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "skhynix_price_forecast_settings_v1";
  const INTERVAL_SECONDS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 };
  const FEATURE_GROUPS = ["momentum", "macd", "rsi", "ma", "volatility"];

  const DEFAULT_SETTINGS = Object.freeze({
    symbol: "BTCUSDT",
    interval: "5m",
    horizon_bars: 1,
    neutral_bps: 8,
    confidence_pct: 45,
    ridge_lambda: 1,
    train_window: 500,
    min_train_samples: 180,
    cost_bps: 10,
    momentum_lookback: 6,
    macd_fast: 12,
    macd_slow: 26,
    macd_signal: 9,
    rsi_period: 14,
    ma_fast: 20,
    ma_slow: 50,
    ma_slope_lookback: 3,
    atr_period: 14,
    use_momentum: true,
    use_macd: true,
    use_rsi: true,
    use_ma: true,
    use_volatility: true,
  });

  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value)));
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
  const stdev = (values) => {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + ((Number(value) - avg) ** 2), 0) / (values.length - 1));
  };

  function formatNumber(value, digits = 2, fallback = "—") {
    return finite(value) ? Number(value).toFixed(digits) : fallback;
  }

  function formatKst(epochSeconds) {
    if (!finite(epochSeconds)) return "—";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(Number(epochSeconds) * 1000)).replace(",", "") + " KST";
  }

  function simpleMovingAverage(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index]);
      sum += value;
      if (index >= period) sum -= Number(values[index - period]);
      if (index >= period - 1) out[index] = sum / period;
    }
    return out;
  }

  function exponentialMovingAverage(values, period) {
    const out = new Array(values.length).fill(null);
    if (!values.length) return out;
    const alpha = 2 / (period + 1);
    let current = Number(values[0]);
    out[0] = current;
    for (let index = 1; index < values.length; index += 1) {
      current = alpha * Number(values[index]) + (1 - alpha) * current;
      out[index] = current;
    }
    return out;
  }

  function wilderRsi(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gains = 0;
    let losses = 0;
    for (let index = 1; index <= period; index += 1) {
      const delta = Number(values[index]) - Number(values[index - 1]);
      gains += Math.max(0, delta);
      losses += Math.max(0, -delta);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    for (let index = period + 1; index < values.length; index += 1) {
      const delta = Number(values[index]) - Number(values[index - 1]);
      avgGain = ((avgGain * (period - 1)) + Math.max(0, delta)) / period;
      avgLoss = ((avgLoss * (period - 1)) + Math.max(0, -delta)) / period;
      out[index] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  function wilderAtr(bars, period) {
    const trueRanges = bars.map((bar, index) => {
      if (index === 0) return Number(bar.high) - Number(bar.low);
      const previousClose = Number(bars[index - 1].close);
      return Math.max(
        Number(bar.high) - Number(bar.low),
        Math.abs(Number(bar.high) - previousClose),
        Math.abs(Number(bar.low) - previousClose),
      );
    });
    const out = new Array(bars.length).fill(null);
    if (bars.length < period) return out;
    let current = mean(trueRanges.slice(0, period));
    out[period - 1] = current;
    for (let index = period; index < bars.length; index += 1) {
      current = ((current * (period - 1)) + trueRanges[index]) / period;
      out[index] = current;
    }
    return out;
  }

  function rollingReturnVolatility(values, period = 12) {
    const returns = values.map((value, index) => index > 0 ? Math.log(Number(value) / Number(values[index - 1])) * 10000 : null);
    const out = new Array(values.length).fill(null);
    for (let index = period; index < values.length; index += 1) {
      out[index] = stdev(returns.slice(index - period + 1, index + 1).filter(finite));
    }
    return out;
  }

  function calculateIndicators(bars, settings) {
    const closes = bars.map((bar) => Number(bar.close));
    const maFast = simpleMovingAverage(closes, settings.ma_fast);
    const maSlow = simpleMovingAverage(closes, settings.ma_slow);
    const rsi = wilderRsi(closes, settings.rsi_period);
    const atr = wilderAtr(bars, settings.atr_period);
    const fastEma = exponentialMovingAverage(closes, settings.macd_fast);
    const slowEma = exponentialMovingAverage(closes, settings.macd_slow);
    const macd = closes.map((_, index) => Number(fastEma[index]) - Number(slowEma[index]));
    const macdSignal = exponentialMovingAverage(macd, settings.macd_signal);
    const macdHistogram = macd.map((value, index) => Number(value) - Number(macdSignal[index]));
    const returnVolatility = rollingReturnVolatility(closes, 12);
    return { closes, maFast, maSlow, rsi, atr, macd, macdSignal, macdHistogram, returnVolatility };
  }

  function featureRowAt(bars, indicators, settings, index) {
    const { closes, maFast, maSlow, rsi, atr, macdHistogram, returnVolatility } = indicators;
    const lookback = settings.momentum_lookback;
    const slopeLookback = settings.ma_slope_lookback;
    const requirements = [2];
    if (settings.use_momentum) requirements.push(lookback);
    if (settings.use_macd) requirements.push(settings.macd_slow + settings.macd_signal, settings.atr_period);
    if (settings.use_rsi) requirements.push(settings.rsi_period + 1);
    if (settings.use_ma) requirements.push(settings.ma_slow + slopeLookback, settings.atr_period);
    if (settings.use_volatility) requirements.push(settings.atr_period, 13);
    const minimumIndex = Math.max(...requirements);
    if (index < minimumIndex || !bars[index]) return null;
    const close = Number(closes[index]);
    const atrValue = Number(atr[index]);
    const needsAtr = settings.use_macd || settings.use_ma || settings.use_volatility;
    if (!(close > 0) || (needsAtr && !(atrValue > 0))) return null;
    const atrDenominator = atrValue > 0 ? atrValue : 1;

    const values = [];
    const names = [];
    const add = (name, value) => {
      if (!finite(value)) return false;
      names.push(name);
      values.push(Number(value));
      return true;
    };
    const oneBarBps = Math.log(close / Number(closes[index - 1])) * 10000;
    const lookbackBps = Math.log(close / Number(closes[index - lookback])) * 10000;
    const histogramAtr = Number(macdHistogram[index]) / atrDenominator;
    const histogramDiffAtr = (Number(macdHistogram[index]) - Number(macdHistogram[index - 1])) / atrDenominator;
    const rsiValue = Number(rsi[index]);
    const rsiDelta = rsiValue - Number(rsi[index - 1]);
    const maDistanceAtr = (close - Number(maFast[index])) / atrDenominator;
    const maSpreadAtr = (Number(maFast[index]) - Number(maSlow[index])) / atrDenominator;
    const maSlopeAtr = (Number(maFast[index]) - Number(maFast[index - slopeLookback])) / atrDenominator;
    const risingMa = Number(maFast[index]) > Number(maFast[index - slopeLookback]);
    const fallingMa = Number(maFast[index]) < Number(maFast[index - slopeLookback]);
    const crossedUnder = Number(closes[index - 1]) >= Number(maFast[index - 1]) && close < Number(maFast[index]);
    const crossedOver = Number(closes[index - 1]) <= Number(maFast[index - 1]) && close > Number(maFast[index]);
    const rideHangState = crossedUnder && risingMa ? 1 : (crossedOver && fallingMa ? -1 : 0);
    const atrPct = (atrValue / close) * 100;
    const volatilityBps = Number(returnVolatility[index]);

    if (settings.use_momentum) {
      add("return_1_bps", oneBarBps);
      add(`return_${lookback}_bps`, lookbackBps);
      add("momentum_accel_bps", oneBarBps - Math.log(Number(closes[index - 1]) / Number(closes[index - 2])) * 10000);
    }
    if (settings.use_macd) {
      add("macd_hist_atr", histogramAtr);
      add("macd_hist_diff_atr", histogramDiffAtr);
    }
    if (settings.use_rsi) {
      add("rsi_centered", (rsiValue - 50) / 10);
      add("rsi_delta", rsiDelta / 10);
    }
    if (settings.use_ma) {
      add("price_ma_atr", maDistanceAtr);
      add("ma_spread_atr", maSpreadAtr);
      add("ma_slope_atr", maSlopeAtr);
      add("ma_ride_hang", rideHangState);
    }
    if (settings.use_volatility) {
      add("atr_pct", atrPct);
      add("return_volatility_bps", volatilityBps);
      add("candle_body_atr", (Number(bars[index].close) - Number(bars[index].open)) / atrDenominator);
    }
    if (!values.length || values.some((value) => !finite(value))) return null;
    return {
      index,
      time: Number(bars[index].time),
      values,
      names,
      metrics: {
        one_bar_bps: oneBarBps,
        lookback_bps: lookbackBps,
        macd_hist_atr: histogramAtr,
        macd_hist_diff_atr: histogramDiffAtr,
        rsi: rsiValue,
        rsi_delta: rsiDelta,
        ma_distance_atr: maDistanceAtr,
        ma_spread_atr: maSpreadAtr,
        ma_slope_atr: maSlopeAtr,
        ma_ride_hang: rideHangState,
        atr_pct: atrPct,
        volatility_bps: volatilityBps,
      },
    };
  }

  function buildFeatureRows(bars, settings) {
    const indicators = calculateIndicators(bars, settings);
    const rows = new Array(bars.length).fill(null);
    for (let index = 0; index < bars.length; index += 1) {
      rows[index] = featureRowAt(bars, indicators, settings, index);
    }
    return { indicators, rows };
  }

  function solveLinearSystem(matrix, vector) {
    const size = vector.length;
    const augmented = matrix.map((row, index) => row.slice().concat(Number(vector[index])));
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < size; row += 1) {
        if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if (Math.abs(augmented[pivot][column]) < 1e-12) return new Array(size).fill(0);
      if (pivot !== column) [augmented[pivot], augmented[column]] = [augmented[column], augmented[pivot]];
      const divisor = augmented[column][column];
      for (let cell = column; cell <= size; cell += 1) augmented[column][cell] /= divisor;
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue;
        const factor = augmented[row][column];
        for (let cell = column; cell <= size; cell += 1) augmented[row][cell] -= factor * augmented[column][cell];
      }
    }
    return augmented.map((row) => row[size]);
  }

  function fitRidge(samples, lambda) {
    if (!samples.length || !samples[0]?.x?.length) return null;
    const width = samples[0].x.length;
    const means = new Array(width).fill(0).map((_, column) => mean(samples.map((sample) => sample.x[column])));
    const scales = new Array(width).fill(0).map((_, column) => Math.max(1e-9, stdev(samples.map((sample) => sample.x[column]))));
    const yMean = mean(samples.map((sample) => sample.y));
    const xtx = Array.from({ length: width }, () => new Array(width).fill(0));
    const xty = new Array(width).fill(0);
    samples.forEach((sample) => {
      const standardized = sample.x.map((value, column) => (Number(value) - means[column]) / scales[column]);
      const centeredY = Number(sample.y) - yMean;
      for (let row = 0; row < width; row += 1) {
        xty[row] += standardized[row] * centeredY;
        for (let column = 0; column < width; column += 1) xtx[row][column] += standardized[row] * standardized[column];
      }
    });
    for (let column = 0; column < width; column += 1) xtx[column][column] += Math.max(0, Number(lambda));
    const weights = solveLinearSystem(xtx, xty);
    const model = { means, scales, yMean, weights, residuals: [], sample_count: samples.length };
    model.residuals = samples.map((sample) => Number(sample.y) - predictRidge(model, sample.x));
    return model;
  }

  function predictRidge(model, values) {
    if (!model || !Array.isArray(values) || values.length !== model.weights.length) return null;
    return model.yMean + values.reduce((sum, value, index) => (
      sum + model.weights[index] * ((Number(value) - model.means[index]) / model.scales[index])
    ), 0);
  }

  function probabilityFromResiduals(expectedBps, residuals, neutralBps) {
    const counts = { up: 1, neutral: 1, down: 1 };
    residuals.forEach((residual) => {
      const possible = Number(expectedBps) + Number(residual);
      if (possible > neutralBps) counts.up += 1;
      else if (possible < -neutralBps) counts.down += 1;
      else counts.neutral += 1;
    });
    const total = counts.up + counts.neutral + counts.down;
    return {
      up: counts.up / total,
      neutral: counts.neutral / total,
      down: counts.down / total,
    };
  }

  function classify(probabilities) {
    return ["up", "neutral", "down"].reduce((best, key) => (
      probabilities[key] > probabilities[best] ? key : best
    ), "up");
  }

  function realizedClass(returnBps, neutralBps) {
    if (returnBps > neutralBps) return "up";
    if (returnBps < -neutralBps) return "down";
    return "neutral";
  }

  function makeSamples(bars, featureRows, settings) {
    const samples = [];
    const horizon = settings.horizon_bars;
    featureRows.forEach((row, index) => {
      const targetIndex = index + horizon;
      if (!row || targetIndex >= bars.length) return;
      const sourceClose = Number(bars[index].close);
      const targetClose = Number(bars[targetIndex].close);
      if (!(sourceClose > 0) || !(targetClose > 0)) return;
      samples.push({
        index,
        targetIndex,
        x: row.values,
        y: Math.log(targetClose / sourceClose) * 10000,
      });
    });
    return samples;
  }

  function ranks(values) {
    const ordered = values.map((value, index) => ({ value: Number(value), index })).sort((a, b) => a.value - b.value);
    const result = new Array(values.length);
    let cursor = 0;
    while (cursor < ordered.length) {
      let end = cursor;
      while (end + 1 < ordered.length && ordered[end + 1].value === ordered[cursor].value) end += 1;
      const rank = (cursor + end + 2) / 2;
      for (let offset = cursor; offset <= end; offset += 1) result[ordered[offset].index] = rank;
      cursor = end + 1;
    }
    return result;
  }

  function correlation(left, right) {
    if (left.length < 3 || left.length !== right.length) return null;
    const leftMean = mean(left);
    const rightMean = mean(right);
    let numerator = 0;
    let leftSq = 0;
    let rightSq = 0;
    for (let index = 0; index < left.length; index += 1) {
      const x = Number(left[index]) - leftMean;
      const y = Number(right[index]) - rightMean;
      numerator += x * y;
      leftSq += x * x;
      rightSq += y * y;
    }
    return leftSq > 0 && rightSq > 0 ? numerator / Math.sqrt(leftSq * rightSq) : null;
  }

  function forecastAtIndex(bars, rawSettings, sourceIndex) {
    const settings = normalizeSettings(rawSettings);
    const { rows } = buildFeatureRows(bars, settings);
    const row = rows[sourceIndex];
    if (!row) return null;
    const samples = makeSamples(bars, rows, settings)
      .filter((sample) => sample.targetIndex <= sourceIndex)
      .slice(-settings.train_window);
    if (samples.length < settings.min_train_samples) return null;
    const model = fitRidge(samples, settings.ridge_lambda);
    const expectedBps = predictRidge(model, row.values);
    const probabilities = probabilityFromResiduals(expectedBps, model.residuals, settings.neutral_bps);
    const direction = classify(probabilities);
    const confidence = probabilities[direction];
    return {
      source_index: sourceIndex,
      source_time: Number(bars[sourceIndex].time),
      expected_bps: expectedBps,
      probabilities,
      direction,
      confidence,
      qualified: confidence * 100 >= settings.confidence_pct,
      train_samples: samples.length,
      residual_sigma_bps: stdev(model.residuals),
      feature_names: row.names,
      feature_metrics: row.metrics,
    };
  }

  function normalizeSettings(raw = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const settings = {
      ...merged,
      symbol: String(merged.symbol || DEFAULT_SETTINGS.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20),
      interval: INTERVAL_SECONDS[merged.interval] ? merged.interval : DEFAULT_SETTINGS.interval,
      horizon_bars: Math.round(clamp(merged.horizon_bars, 1, 12)),
      neutral_bps: clamp(merged.neutral_bps, 0, 500),
      confidence_pct: clamp(merged.confidence_pct, 0, 100),
      ridge_lambda: clamp(merged.ridge_lambda, 0.0001, 10000),
      train_window: Math.round(clamp(merged.train_window, 100, 1200)),
      min_train_samples: Math.round(clamp(merged.min_train_samples, 60, 1000)),
      cost_bps: clamp(merged.cost_bps, 0, 500),
      momentum_lookback: Math.round(clamp(merged.momentum_lookback, 2, 50)),
      macd_fast: Math.round(clamp(merged.macd_fast, 2, 100)),
      macd_slow: Math.round(clamp(merged.macd_slow, 3, 200)),
      macd_signal: Math.round(clamp(merged.macd_signal, 2, 100)),
      rsi_period: Math.round(clamp(merged.rsi_period, 2, 100)),
      ma_fast: Math.round(clamp(merged.ma_fast, 2, 200)),
      ma_slow: Math.round(clamp(merged.ma_slow, 3, 400)),
      ma_slope_lookback: Math.round(clamp(merged.ma_slope_lookback, 1, 50)),
      atr_period: Math.round(clamp(merged.atr_period, 2, 100)),
    };
    FEATURE_GROUPS.forEach((group) => { settings[`use_${group}`] = merged[`use_${group}`] !== false; });
    if (settings.macd_fast >= settings.macd_slow) settings.macd_fast = Math.max(2, settings.macd_slow - 1);
    if (settings.ma_fast >= settings.ma_slow) settings.ma_fast = Math.max(2, settings.ma_slow - 1);
    settings.min_train_samples = Math.min(settings.min_train_samples, settings.train_window);
    return settings;
  }

  function buildCausalForecast(bars, rawSettings = {}) {
    const settings = normalizeSettings(rawSettings);
    const enabledGroups = FEATURE_GROUPS.filter((group) => settings[`use_${group}`]);
    const empty = (error) => ({ settings, error, latest: null, forecast_signals: [], validation: null, indicators: null });
    if (!enabledGroups.length) return empty("Enable at least one model input group.");
    if (!Array.isArray(bars) || bars.length < settings.min_train_samples + settings.horizon_bars + 60) {
      return empty(`Need at least ${settings.min_train_samples + settings.horizon_bars + 60} completed candles.`);
    }

    const { indicators, rows } = buildFeatureRows(bars, settings);
    const samples = makeSamples(bars, rows, settings);
    const validSourceIndices = rows.map((row, index) => row ? index : null).filter((index) => index !== null);
    const latestIndex = validSourceIndices[validSourceIndices.length - 1];
    const latest = forecastAtIndex(bars, settings, latestIndex);
    if (!latest) return empty("Not enough matured causal samples for the selected training window.");

    const earliestValidationIndex = Math.max(
      rows.findIndex(Boolean),
      Math.floor(bars.length * 0.75),
      settings.min_train_samples + settings.horizon_bars,
    );
    const forecastSignals = [];
    const expectedValues = [];
    const realizedValues = [];
    let correct = 0;
    let qualified = 0;
    let brierSum = 0;
    let netBps = 0;
    let directionalQualified = 0;

    for (let sourceIndex = earliestValidationIndex; sourceIndex < bars.length - settings.horizon_bars; sourceIndex += 1) {
      if (!rows[sourceIndex]) continue;
      const eligible = samples
        .filter((sample) => sample.targetIndex <= sourceIndex)
        .slice(-settings.train_window);
      if (eligible.length < settings.min_train_samples) continue;
      const model = fitRidge(eligible, settings.ridge_lambda);
      const expectedBps = predictRidge(model, rows[sourceIndex].values);
      const probabilities = probabilityFromResiduals(expectedBps, model.residuals, settings.neutral_bps);
      const direction = classify(probabilities);
      const confidence = probabilities[direction];
      const targetIndex = sourceIndex + settings.horizon_bars;
      const actualBps = Math.log(Number(bars[targetIndex].close) / Number(bars[sourceIndex].close)) * 10000;
      const actualDirection = realizedClass(actualBps, settings.neutral_bps);
      const isQualified = confidence * 100 >= settings.confidence_pct;
      const oneHot = { up: actualDirection === "up" ? 1 : 0, neutral: actualDirection === "neutral" ? 1 : 0, down: actualDirection === "down" ? 1 : 0 };
      brierSum += ((probabilities.up - oneHot.up) ** 2 + (probabilities.neutral - oneHot.neutral) ** 2 + (probabilities.down - oneHot.down) ** 2) / 3;
      expectedValues.push(expectedBps);
      realizedValues.push(actualBps);
      if (isQualified) {
        qualified += 1;
        if (direction === actualDirection) correct += 1;
        if (direction === "up") { netBps += actualBps - settings.cost_bps; directionalQualified += 1; }
        if (direction === "down") { netBps += -actualBps - settings.cost_bps; directionalQualified += 1; }
      }
      forecastSignals.push({
        source_index: sourceIndex,
        source_time: Number(bars[sourceIndex].time),
        target_index: targetIndex,
        target_time: Number(bars[targetIndex].time),
        expected_bps: expectedBps,
        actual_bps: actualBps,
        probabilities,
        direction,
        actual_direction: actualDirection,
        confidence,
        qualified: isQualified,
        train_samples: eligible.length,
      });
    }

    const rankIc = correlation(ranks(expectedValues), ranks(realizedValues));
    const validation = {
      predictions: forecastSignals.length,
      qualified,
      directional_qualified: directionalQualified,
      hit_rate_pct: qualified ? (correct / qualified) * 100 : null,
      brier: forecastSignals.length ? brierSum / forecastSignals.length : null,
      rank_ic: rankIc,
      average_net_bps: directionalQualified ? netBps / directionalQualified : null,
      holdout_fraction: 0.25,
    };
    return { settings, error: null, latest, forecast_signals: forecastSignals, validation, indicators };
  }

  function parseKlines(rows, interval, nowSeconds = Date.now() / 1000) {
    const intervalSeconds = INTERVAL_SECONDS[interval] || 300;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      close_time: finite(row[6]) ? Math.floor(Number(row[6]) / 1000) : Math.floor(Number(row[0]) / 1000) + intervalSeconds,
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5] || 0),
    })).filter((bar) => (
      finite(bar.time) && finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close)
      && bar.close_time <= nowSeconds
    )).sort((left, right) => left.time - right.time);
  }

  class PriceForecastTab {
    constructor() {
      this.mounted = false;
      this.loaded = false;
      this.active = false;
      this.settings = this.loadSettings();
      this.bars = [];
      this.result = null;
      this.chart = null;
      this.candleSeries = null;
      this.maFastSeries = null;
      this.maSlowSeries = null;
      this.requestSequence = 0;
      this.loading = false;
      this.lastLoadedAt = 0;
      this.pollTimer = null;
      this.resizeObserver = null;
    }

    loadSettings() {
      if (typeof localStorage === "undefined") return normalizeSettings();
      try { return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
      catch (_) { return normalizeSettings(); }
    }

    saveSettings() {
      if (typeof localStorage === "undefined") return;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch (_) {}
    }

    mount(containerId = "tabContentPriceForecast") {
      if (this.mounted || typeof document === "undefined") return;
      const container = document.getElementById(containerId);
      if (!container) return;
      this.renderSkeleton(container);
      this.bindControls();
      this.initChart();
      this.mounted = true;
      this.refresh({ fit: true });
    }

    renderSkeleton(container) {
      const s = this.settings;
      container.innerHTML = `
        <style>
          #tabContentPriceForecast { --pf-gap:var(--terminal-space-min, 6px); }
          #tabContentPriceForecast button { width:auto;height:auto;flex:0 0 auto; }
          #tabContentPriceForecast .pfPanel { background:#fff;border:1px solid #dbe2e7;border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(15,23,42,.05); }
          #tabContentPriceForecast .pfControls { display:flex;align-items:end;gap:var(--pf-gap);flex-wrap:wrap; }
          #tabContentPriceForecast .pfField { display:flex;flex-direction:column;gap:3px;min-width:76px; }
          #tabContentPriceForecast .pfField label { color:#64748b;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em; }
          #tabContentPriceForecast :is(select,input[type=number],input[type=text]) { height:30px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#0f172a;padding:0 7px;font-size:11px;font-weight:700; }
          #tabContentPriceForecast .pfGrid { display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,.8fr);gap:var(--pf-gap);margin-top:var(--pf-gap); }
          #tabContentPriceForecast .pfGrid > * { min-width:0;max-width:100%; }
          #tabContentPriceForecast #pfChartPanel { min-width:0;overflow:hidden; }
          #tabContentPriceForecast #pfChartHost { min-width:0;max-width:100%;overflow:hidden; }
          #tabContentPriceForecast .pfProbGrid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--pf-gap); }
          #tabContentPriceForecast .pfProb { border-radius:8px;padding:11px;border:1px solid #e2e8f0;background:#f8fafc; }
          #tabContentPriceForecast .pfProb strong { display:block;font-size:24px;font-variant-numeric:tabular-nums;margin-top:3px; }
          #tabContentPriceForecast .pfKpis { display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--pf-gap);margin-top:var(--pf-gap); }
          #tabContentPriceForecast .pfKpi { padding:9px;border:1px solid #e2e8f0;border-radius:7px;background:#f8fafc;min-width:0; }
          #tabContentPriceForecast .pfKpi span { color:#64748b;font-size:9px;font-weight:800;text-transform:uppercase;display:block; }
          #tabContentPriceForecast .pfKpi strong { color:#0f172a;font-size:16px;font-variant-numeric:tabular-nums;display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis; }
          #tabContentPriceForecast .pfFeature { display:grid;grid-template-columns:auto minmax(90px,1fr) auto;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid #eef2f7;font-size:11px; }
          #tabContentPriceForecast .pfFeature:last-child { border-bottom:0; }
          #tabContentPriceForecast .pfFeatureValue { color:#475569;text-align:right;font-variant-numeric:tabular-nums; }
          #tabContentPriceForecast .pfState { padding:2px 6px;border-radius:999px;font-size:9px;font-weight:900;background:#dcfce7;color:#047857; }
          #tabContentPriceForecast .pfState.off { background:#f1f5f9;color:#64748b; }
          #tabContentPriceForecast .pfTable { width:100%;border-collapse:collapse;font-size:10.5px;font-variant-numeric:tabular-nums; }
          #tabContentPriceForecast .pfTable :is(th,td) { padding:7px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap; }
          #tabContentPriceForecast .pfTable :is(th,td):first-child { text-align:left; }
          #tabContentPriceForecast .pfToggle { accent-color:#0284c7;width:15px;height:15px; }
          #tabContentPriceForecast .pfStatus { min-height:20px;color:#475569;font-size:10.5px;margin-top:7px;line-height:1.45; }
          #tabContentPriceForecast .pfError { color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:7px;border-radius:6px; }
          @media (max-width:900px) {
            #tabContentPriceForecast .pfGrid { display:block; }
            #tabContentPriceForecast .pfGrid > * + * { margin-top:var(--pf-gap); }
            #tabContentPriceForecast .pfKpis { grid-template-columns:repeat(2,minmax(0,1fr)); }
          }
          @media (max-width:560px) {
            #tabContentPriceForecast .pfProbGrid { grid-template-columns:1fr; }
            #tabContentPriceForecast .pfKpis { grid-template-columns:1fr; }
          }
        </style>
        <section class="pfPanel" aria-label="Causal price forecast controls">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
            <div>
              <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;"><strong style="font-size:16px;color:#0f172a;">Causal Price Forecast</strong><span style="background:#e0f2fe;color:#0369a1;border-radius:999px;padding:3px 7px;font-size:9px;font-weight:900;">RESEARCH ONLY · NO ORDERS</span></div>
              <small style="color:#64748b;">Ridge forecast trained only on matured outcomes · completed Binance futures candles · walk-forward validation</small>
            </div>
            <button id="pfRefresh" type="button" style="border:1px solid #0284c7;background:#0284c7;color:#fff;border-radius:5px;padding:7px 11px;font-size:11px;font-weight:800;">↻ Refresh</button>
          </div>
          <div class="pfControls">
            <div class="pfField"><label for="pfSymbol">Symbol</label><input id="pfSymbol" type="text" value="${s.symbol}" maxlength="20" style="width:100px;text-transform:uppercase;"></div>
            <div class="pfField"><label for="pfInterval">Candle</label><select id="pfInterval">${Object.keys(INTERVAL_SECONDS).map((value) => `<option value="${value}"${s.interval === value ? " selected" : ""}>${value}</option>`).join("")}</select></div>
            <div class="pfField"><label for="pfHorizon">Horizon bars</label><input id="pfHorizon" type="number" min="1" max="12" step="1" value="${s.horizon_bars}"></div>
            <div class="pfField"><label for="pfNeutralBps">Neutral ±bp</label><input id="pfNeutralBps" type="number" min="0" max="500" step="1" value="${s.neutral_bps}"></div>
            <div class="pfField"><label for="pfConfidence">Min confidence %</label><input id="pfConfidence" type="number" min="0" max="100" step="1" value="${s.confidence_pct}"></div>
            <div class="pfField"><label for="pfCostBps">Round-trip cost bp</label><input id="pfCostBps" type="number" min="0" max="500" step="1" value="${s.cost_bps}"></div>
            <div class="pfField"><label for="pfLambda">Ridge λ</label><input id="pfLambda" type="number" min="0.0001" max="10000" step="0.1" value="${s.ridge_lambda}"></div>
            <div class="pfField"><label for="pfTrainWindow">Train window</label><input id="pfTrainWindow" type="number" min="100" max="1200" step="10" value="${s.train_window}"></div>
            <div class="pfField"><label for="pfMinSamples">Min samples</label><input id="pfMinSamples" type="number" min="60" max="1000" step="10" value="${s.min_train_samples}"></div>
          </div>
        </section>

        <div class="pfGrid">
          <section class="pfPanel collapsible-section" id="pfChartPanel">
            <div class="collapsible-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px;">
              <div><strong id="pfChartTitle">${s.symbol} · ${s.interval}</strong><small id="pfChartSubtitle" style="display:block;color:#64748b;margin-top:2px;">Loading completed candles…</small></div>
              <button class="section-collapse-btn" type="button" aria-expanded="true" aria-label="Toggle section" title="Collapse / Expand section"><svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
            </div>
            <div id="pfChartHost" style="height:460px;width:100%;position:relative;border:1px solid #e2e8f0;border-radius:7px;background:#fff;"></div>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:10px;font-weight:700;color:#64748b;"><span style="color:#0284c7;">— Fast MA</span><span style="color:#7c3aed;">— Slow MA</span><span style="color:#16a34a;">▲ Qualified Up forecast</span><span style="color:#dc2626;">▼ Qualified Down forecast</span><span style="color:#64748b;">● Qualified Neutral forecast</span></div>
            <div id="pfChartStatus" class="pfStatus">Waiting for completed candles.</div>
          </section>

          <div style="display:flex;flex-direction:column;gap:var(--pf-gap);">
            <section class="pfPanel" aria-label="Latest forecast">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:7px;margin-bottom:8px;"><strong>Next-horizon distribution</strong><span id="pfForecastBadge" class="pfState off">WAITING</span></div>
              <div class="pfProbGrid">
                <div class="pfProb" style="background:#f0fdf4;border-color:#bbf7d0;color:#047857;"><span>UP</span><strong id="pfProbUp">—</strong></div>
                <div class="pfProb" style="color:#475569;"><span>NEUTRAL</span><strong id="pfProbNeutral">—</strong></div>
                <div class="pfProb" style="background:#fef2f2;border-color:#fecaca;color:#b91c1c;"><span>DOWN</span><strong id="pfProbDown">—</strong></div>
              </div>
              <div class="pfKpis" style="grid-template-columns:repeat(2,minmax(0,1fr));">
                <div class="pfKpi"><span>Expected move</span><strong id="pfExpected">—</strong></div>
                <div class="pfKpi"><span>Residual σ</span><strong id="pfSigma">—</strong></div>
              </div>
              <div id="pfForecastSource" class="pfStatus">Source: awaiting a completed candle.</div>
            </section>

            <section class="pfPanel" aria-label="Forecast inputs">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:7px;margin-bottom:2px;"><strong>Model inputs</strong><small style="color:#64748b;">Each switch refits the model</small></div>
              ${this.featureRowsMarkup(s)}
              <div id="pfInputSource" class="pfStatus">Values unavailable until candles load.</div>
            </section>
          </div>
        </div>

        <section class="pfPanel" style="margin-top:var(--pf-gap);" aria-label="Walk-forward validation">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;"><div><strong>Purged walk-forward validation</strong><small style="display:block;color:#64748b;margin-top:2px;">Final 25% holdout · each prediction trains only on outcomes known at its source candle · no shuffled split</small></div><span id="pfValidationStatus" class="pfState off">WAITING</span></div>
          <div class="pfKpis">
            <div class="pfKpi"><span>Qualified / total</span><strong id="pfPredictionCount">—</strong></div>
            <div class="pfKpi"><span>Class hit rate</span><strong id="pfHitRate">—</strong></div>
            <div class="pfKpi"><span>Rank IC</span><strong id="pfRankIc">—</strong></div>
            <div class="pfKpi"><span>Multiclass Brier</span><strong id="pfBrier">—</strong></div>
            <div class="pfKpi"><span>Avg directional net</span><strong id="pfNetBps">—</strong></div>
          </div>
          <div style="overflow:auto;max-height:280px;margin-top:var(--pf-gap);">
            <table class="pfTable"><thead><tr><th>Source candle (KST)</th><th>Forecast</th><th>Confidence</th><th>Expected</th><th>Realized</th><th>Outcome</th></tr></thead><tbody id="pfForecastRows"><tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:18px;">No causal forecasts yet.</td></tr></tbody></table>
          </div>
          <p style="font-size:10px;color:#64748b;line-height:1.45;margin:8px 0 0;">Forecast markers are model outputs, not fills or trade recommendations. The displayed current forecast has no realized outcome yet. News, liquidation cascades, latency, and order-book impact are not modeled.</p>
        </section>
      `;
    }

    featureRowsMarkup(settings) {
      const rows = [
        ["momentum", "Momentum", `lookback <input id="pfMomentumLookback" type="number" min="2" max="50" step="1" value="${settings.momentum_lookback}" style="width:56px;height:24px;">`],
        ["macd", "MACD H", `<input id="pfMacdFast" type="number" min="2" max="100" value="${settings.macd_fast}" style="width:45px;height:24px;"> / <input id="pfMacdSlow" type="number" min="3" max="200" value="${settings.macd_slow}" style="width:45px;height:24px;"> / <input id="pfMacdSignal" type="number" min="2" max="100" value="${settings.macd_signal}" style="width:45px;height:24px;">`],
        ["rsi", "Wilder RSI", `period <input id="pfRsiPeriod" type="number" min="2" max="100" value="${settings.rsi_period}" style="width:56px;height:24px;">`],
        ["ma", "MA trend + Ride/Hang", `<input id="pfMaFast" type="number" min="2" max="200" value="${settings.ma_fast}" style="width:48px;height:24px;"> / <input id="pfMaSlow" type="number" min="3" max="400" value="${settings.ma_slow}" style="width:48px;height:24px;"> · slope <input id="pfMaSlope" type="number" min="1" max="50" value="${settings.ma_slope_lookback}" style="width:48px;height:24px;">`],
        ["volatility", "ATR + volatility", `ATR <input id="pfAtrPeriod" type="number" min="2" max="100" value="${settings.atr_period}" style="width:56px;height:24px;">`],
      ];
      return rows.map(([key, label, controls]) => `
        <div class="pfFeature" data-feature="${key}">
          <input class="pfToggle" id="pfUse_${key}" type="checkbox"${settings[`use_${key}`] ? " checked" : ""} aria-label="Use ${label}">
          <div><strong>${label}</strong><div style="color:#64748b;margin-top:3px;">${controls}</div></div>
          <div><span id="pfState_${key}" class="pfState${settings[`use_${key}`] ? "" : " off"}">${settings[`use_${key}`] ? "ACTIVE" : "OFF"}</span><div id="pfValue_${key}" class="pfFeatureValue" style="margin-top:4px;">—</div></div>
        </div>
      `).join("");
    }

    initChart() {
      const host = document.getElementById("pfChartHost");
      if (!host || !globalThis.LightweightCharts) return;
      this.chart = globalThis.LightweightCharts.createChart(host, {
        width: Math.max(320, host.clientWidth), height: Math.max(320, host.clientHeight),
        layout: { background: { color: "#ffffff" }, textColor: "#475569", fontSize: 11 },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        rightPriceScale: { borderColor: "#e2e8f0", scaleMargins: { top: 0.08, bottom: 0.12 } },
        timeScale: { borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 7 },
        crosshair: { mode: globalThis.LightweightCharts.CrosshairMode?.Normal ?? 0 },
      });
      this.candleSeries = this.chart.addCandlestickSeries({
        upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
        wickUpColor: "#16a34a", wickDownColor: "#dc2626", priceLineVisible: true,
      });
      this.maFastSeries = this.chart.addLineSeries({ color: "#0284c7", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      this.maSlowSeries = this.chart.addLineSeries({ color: "#7c3aed", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(host);
      }
    }

    bindControls() {
      const rerunIds = [
        "pfHorizon", "pfNeutralBps", "pfConfidence", "pfCostBps", "pfLambda", "pfTrainWindow", "pfMinSamples",
        "pfMomentumLookback", "pfMacdFast", "pfMacdSlow", "pfMacdSignal", "pfRsiPeriod", "pfMaFast", "pfMaSlow", "pfMaSlope", "pfAtrPeriod",
      ];
      rerunIds.forEach((id) => document.getElementById(id)?.addEventListener("change", () => this.rerunFromControls()));
      FEATURE_GROUPS.forEach((group) => document.getElementById(`pfUse_${group}`)?.addEventListener("change", () => this.rerunFromControls()));
      document.getElementById("pfRefresh")?.addEventListener("click", () => this.refresh({ fit: false, force: true }));
      document.getElementById("pfSymbol")?.addEventListener("change", () => this.refreshFromMarketControls());
      document.getElementById("pfInterval")?.addEventListener("change", () => this.refreshFromMarketControls());
    }

    readControls() {
      const value = (id, fallback) => document.getElementById(id)?.value ?? fallback;
      const checked = (id, fallback) => document.getElementById(id)?.checked ?? fallback;
      return normalizeSettings({
        ...this.settings,
        symbol: value("pfSymbol", this.settings.symbol), interval: value("pfInterval", this.settings.interval),
        horizon_bars: value("pfHorizon", this.settings.horizon_bars), neutral_bps: value("pfNeutralBps", this.settings.neutral_bps),
        confidence_pct: value("pfConfidence", this.settings.confidence_pct), cost_bps: value("pfCostBps", this.settings.cost_bps),
        ridge_lambda: value("pfLambda", this.settings.ridge_lambda), train_window: value("pfTrainWindow", this.settings.train_window),
        min_train_samples: value("pfMinSamples", this.settings.min_train_samples), momentum_lookback: value("pfMomentumLookback", this.settings.momentum_lookback),
        macd_fast: value("pfMacdFast", this.settings.macd_fast), macd_slow: value("pfMacdSlow", this.settings.macd_slow),
        macd_signal: value("pfMacdSignal", this.settings.macd_signal), rsi_period: value("pfRsiPeriod", this.settings.rsi_period),
        ma_fast: value("pfMaFast", this.settings.ma_fast), ma_slow: value("pfMaSlow", this.settings.ma_slow),
        ma_slope_lookback: value("pfMaSlope", this.settings.ma_slope_lookback), atr_period: value("pfAtrPeriod", this.settings.atr_period),
        ...Object.fromEntries(FEATURE_GROUPS.map((group) => [`use_${group}`, checked(`pfUse_${group}`, this.settings[`use_${group}`])])),
      });
    }

    rerunFromControls() {
      this.settings = this.readControls();
      this.saveSettings();
      this.syncFeatureStates();
      if (!this.bars.length) return;
      this.setStatus("Refitting causal ridge model…");
      setTimeout(() => {
        this.result = buildCausalForecast(this.bars, this.settings);
        this.renderResult({ fit: false });
      }, 0);
    }

    refreshFromMarketControls() {
      this.settings = this.readControls();
      this.saveSettings();
      this.refresh({ fit: true, force: true });
    }

    syncFeatureStates() {
      FEATURE_GROUPS.forEach((group) => {
        const badge = document.getElementById(`pfState_${group}`);
        if (!badge) return;
        const enabled = this.settings[`use_${group}`];
        badge.textContent = enabled ? "ACTIVE" : "OFF";
        badge.classList.toggle("off", !enabled);
      });
    }

    setStatus(message, error = false) {
      const status = document.getElementById("pfChartStatus");
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("pfError", error);
    }

    async fetchRows(symbol, interval) {
      const location = typeof window !== "undefined" ? window.location : null;
      const path = location?.pathname?.startsWith("/skhynix") ? "/skhynix/api/klines" : "/api/klines";
      const origin = location?.origin && location.origin !== "null" ? location.origin : "";
      const proxyUrl = origin ? `${origin}${path}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=1500` : "";
      const directUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=1500`;
      const candidates = [directUrl, proxyUrl].filter(Boolean);
      let lastError = null;
      for (const url of candidates) {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timeout = setTimeout(() => controller?.abort(), url === proxyUrl ? 15000 : 3500);
        try {
          const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const rows = await response.json();
          if (!Array.isArray(rows) || !rows.length) throw new Error("No candles returned");
          return rows;
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw lastError || new Error("Unable to fetch Binance candles");
    }

    async refresh(options = {}) {
      if (!this.mounted) return;
      this.settings = this.readControls();
      this.saveSettings();
      const sequence = ++this.requestSequence;
      this.loading = true;
      const startedAt = performance.now ? performance.now() : Date.now();
      this.setStatus(`Loading completed ${this.settings.interval} ${this.settings.symbol} candles…`);
      document.getElementById("pfRefresh")?.setAttribute("disabled", "disabled");
      try {
        const rows = await this.fetchRows(this.settings.symbol, this.settings.interval);
        if (sequence !== this.requestSequence) return;
        const bars = parseKlines(rows, this.settings.interval);
        const previousLatestClose = this.bars.length ? Number(this.bars[this.bars.length - 1].close_time) : null;
        const nextLatestClose = bars.length ? Number(bars[bars.length - 1].close_time) : null;
        if (!options.force && this.result && !this.result.error && previousLatestClose === nextLatestClose) {
          this.lastLoadedAt = Date.now();
          const elapsed = ((performance.now ? performance.now() : Date.now()) - startedAt) / 1000;
          this.setStatus(`${this.bars.length.toLocaleString()} completed candles · checked in ${elapsed.toFixed(2)}s · no newer completed candle · source ${formatKst(previousLatestClose)}`);
          return;
        }
        const result = buildCausalForecast(bars, this.settings);
        if (!bars.length) throw new Error("No completed candles are available.");
        this.bars = bars;
        this.result = result;
        this.lastLoadedAt = Date.now();
        this.loaded = !result.error;
        this.renderResult({ fit: options.fit !== false });
        window.updateMainTabLoading?.("priceforecast");
        const elapsed = ((performance.now ? performance.now() : Date.now()) - startedAt) / 1000;
        if (!result.error) this.setStatus(`${bars.length.toLocaleString()} completed candles · chart + forecast usable in ${elapsed.toFixed(2)}s · latest source ${formatKst(bars[bars.length - 1].close_time)}`);
      } catch (error) {
        if (sequence !== this.requestSequence) return;
        this.loaded = Boolean(this.result && !this.result.error);
        this.setStatus(`Forecast unavailable: ${error.message}. Use Refresh to retry; prior valid output remains unchanged.`, true);
      } finally {
        if (sequence === this.requestSequence) {
          this.loading = false;
          document.getElementById("pfRefresh")?.removeAttribute("disabled");
        }
      }
    }

    renderResult(options = {}) {
      const result = this.result;
      const title = document.getElementById("pfChartTitle");
      const subtitle = document.getElementById("pfChartSubtitle");
      if (title) title.textContent = `${this.settings.symbol} · ${this.settings.interval}`;
      if (subtitle) subtitle.textContent = `${this.settings.horizon_bars} bar horizon · completed candles only · forming candle excluded`;
      this.syncFeatureStates();
      if (!result || result.error) {
        this.setStatus(result?.error || "Forecast unavailable.", true);
        this.renderUnavailable(result?.error || "Unavailable");
        return;
      }
      this.renderChart(options.fit !== false);
      this.renderLatest();
      this.renderValidation();
      this.renderFeatureValues();
    }

    renderUnavailable(message) {
      ["pfProbUp", "pfProbNeutral", "pfProbDown", "pfExpected", "pfSigma", "pfPredictionCount", "pfHitRate", "pfRankIc", "pfBrier", "pfNetBps"].forEach((id) => {
        const node = document.getElementById(id); if (node) node.textContent = "—";
      });
      const badge = document.getElementById("pfForecastBadge");
      if (badge) { badge.textContent = "UNAVAILABLE"; badge.className = "pfState off"; }
      const validation = document.getElementById("pfValidationStatus");
      if (validation) { validation.textContent = "UNAVAILABLE"; validation.className = "pfState off"; }
      const source = document.getElementById("pfForecastSource");
      if (source) source.textContent = message;
    }

    renderChart(fit) {
      if (!this.candleSeries || !this.result?.indicators) return;
      const { maFast, maSlow } = this.result.indicators;
      this.candleSeries.setData(this.bars.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      this.maFastSeries.setData(this.bars.map((bar, index) => finite(maFast[index]) ? { time: bar.time, value: Number(maFast[index]) } : null).filter(Boolean));
      this.maSlowSeries.setData(this.bars.map((bar, index) => finite(maSlow[index]) ? { time: bar.time, value: Number(maSlow[index]) } : null).filter(Boolean));
      const markers = this.result.forecast_signals.filter((signal) => signal.qualified).slice(-160).map((signal) => ({
        time: signal.source_time,
        position: signal.direction === "up" ? "belowBar" : signal.direction === "down" ? "aboveBar" : "inBar",
        color: signal.direction === "up" ? "#16a34a" : signal.direction === "down" ? "#dc2626" : "#64748b",
        shape: signal.direction === "up" ? "arrowUp" : signal.direction === "down" ? "arrowDown" : "circle",
        text: "",
      }));
      const latest = this.result.latest;
      markers.push({
        time: latest.source_time,
        position: latest.direction === "up" ? "belowBar" : latest.direction === "down" ? "aboveBar" : "inBar",
        color: "#00a7c4",
        shape: latest.direction === "up" ? "arrowUp" : latest.direction === "down" ? "arrowDown" : "circle",
        text: `NEXT ${(latest.confidence * 100).toFixed(0)}%`,
      });
      markers.sort((left, right) => Number(left.time) - Number(right.time));
      this.candleSeries.setMarkers(markers);
      if (fit) this.chart?.timeScale()?.fitContent();
    }

    renderLatest() {
      const latest = this.result.latest;
      const probability = (key) => `${(latest.probabilities[key] * 100).toFixed(1)}%`;
      document.getElementById("pfProbUp").textContent = probability("up");
      document.getElementById("pfProbNeutral").textContent = probability("neutral");
      document.getElementById("pfProbDown").textContent = probability("down");
      document.getElementById("pfExpected").textContent = `${latest.expected_bps >= 0 ? "+" : ""}${latest.expected_bps.toFixed(1)} bp`;
      document.getElementById("pfSigma").textContent = `${latest.residual_sigma_bps.toFixed(1)} bp`;
      const badge = document.getElementById("pfForecastBadge");
      if (badge) {
        badge.textContent = `${latest.direction.toUpperCase()} · ${latest.qualified ? "QUALIFIED" : "LOW CONFIDENCE"}`;
        badge.className = `pfState${latest.qualified ? "" : " off"}`;
      }
      const intervalSeconds = INTERVAL_SECONDS[this.settings.interval];
      const sourceClose = latest.source_time + intervalSeconds;
      const targetClose = sourceClose + intervalSeconds * this.settings.horizon_bars;
      const source = document.getElementById("pfForecastSource");
      if (source) source.textContent = `PAPER MODEL · Source candle closed ${formatKst(sourceClose)} · target close ${formatKst(targetClose)} · ${latest.train_samples} matured training samples · neutral band ±${this.settings.neutral_bps} bp`;
    }

    renderFeatureValues() {
      const metrics = this.result.latest.feature_metrics;
      const values = {
        momentum: `1-bar ${metrics.one_bar_bps >= 0 ? "+" : ""}${formatNumber(metrics.one_bar_bps, 1)} bp · lookback ${metrics.lookback_bps >= 0 ? "+" : ""}${formatNumber(metrics.lookback_bps, 1)} bp`,
        macd: `H ${formatNumber(metrics.macd_hist_atr, 3)} ATR · Δ ${formatNumber(metrics.macd_hist_diff_atr, 3)}`,
        rsi: `${formatNumber(metrics.rsi, 1)} · Δ ${metrics.rsi_delta >= 0 ? "+" : ""}${formatNumber(metrics.rsi_delta, 1)}`,
        ma: `price ${metrics.ma_distance_atr >= 0 ? "+" : ""}${formatNumber(metrics.ma_distance_atr, 2)} ATR · slope ${metrics.ma_slope_atr >= 0 ? "+" : ""}${formatNumber(metrics.ma_slope_atr, 2)} · ${metrics.ma_ride_hang > 0 ? "RIDE" : metrics.ma_ride_hang < 0 ? "HANG" : "NO CROSS"}`,
        volatility: `ATR ${formatNumber(metrics.atr_pct, 3)}% · σ ${formatNumber(metrics.volatility_bps, 1)} bp`,
      };
      FEATURE_GROUPS.forEach((group) => {
        const node = document.getElementById(`pfValue_${group}`);
        if (node) node.textContent = this.settings[`use_${group}`] ? values[group] : "Excluded from fit";
      });
      const inputSource = document.getElementById("pfInputSource");
      const bar = this.bars[this.result.latest.source_index];
      if (inputSource && bar) inputSource.textContent = `Source: Binance futures completed ${this.settings.interval} candle · ${formatKst(bar.close_time)} · ${this.result.latest.feature_names.length} active numeric inputs`;
    }

    renderValidation() {
      const validation = this.result.validation;
      document.getElementById("pfPredictionCount").textContent = `${validation.qualified} / ${validation.predictions}`;
      document.getElementById("pfHitRate").textContent = finite(validation.hit_rate_pct) ? `${validation.hit_rate_pct.toFixed(1)}%` : "N/A";
      document.getElementById("pfRankIc").textContent = finite(validation.rank_ic) ? validation.rank_ic.toFixed(3) : "N/A";
      document.getElementById("pfBrier").textContent = finite(validation.brier) ? validation.brier.toFixed(3) : "N/A";
      document.getElementById("pfNetBps").textContent = finite(validation.average_net_bps) ? `${validation.average_net_bps >= 0 ? "+" : ""}${validation.average_net_bps.toFixed(1)} bp` : "N/A";
      const status = document.getElementById("pfValidationStatus");
      if (status) { status.textContent = `${validation.predictions} OOS FORECASTS`; status.className = "pfState"; }
      const body = document.getElementById("pfForecastRows");
      if (!body) return;
      const recent = this.result.forecast_signals.slice(-30).reverse();
      body.innerHTML = recent.map((signal) => {
        const color = signal.direction === "up" ? "#16a34a" : signal.direction === "down" ? "#dc2626" : "#64748b";
        const correct = signal.direction === signal.actual_direction;
        return `<tr><td>${formatKst(signal.source_time + INTERVAL_SECONDS[this.settings.interval])}</td><td style="color:${color};font-weight:800;">${signal.direction.toUpperCase()}${signal.qualified ? "" : " · LOW"}</td><td>${(signal.confidence * 100).toFixed(1)}%</td><td>${signal.expected_bps >= 0 ? "+" : ""}${signal.expected_bps.toFixed(1)} bp</td><td>${signal.actual_bps >= 0 ? "+" : ""}${signal.actual_bps.toFixed(1)} bp</td><td style="color:${correct ? "#047857" : "#b91c1c"};font-weight:800;">${correct ? "MATCH" : "MISS"}</td></tr>`;
      }).join("") || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:18px;">No validation forecasts.</td></tr>';
    }

    resize() {
      const host = document.getElementById("pfChartHost");
      if (!host || !this.chart) return;
      this.chart.applyOptions({ width: Math.max(320, host.clientWidth), height: Math.max(320, host.clientHeight) });
    }

    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        if (!this.active) return;
        const intervalMs = INTERVAL_SECONDS[this.settings.interval] * 1000;
        if (Date.now() - this.lastLoadedAt >= Math.min(intervalMs, 60000)) this.refresh({ fit: false });
      }, 30000);
    }

    stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    onTabActivated() {
      this.active = true;
      this.mount();
      this.resize();
      if (this.mounted && !this.loading && (!this.loaded || Date.now() - this.lastLoadedAt > Math.min(INTERVAL_SECONDS[this.settings.interval] * 1000, 60000))) {
        this.refresh({ fit: !this.loaded });
      }
      this.startPolling();
    }

    onTabDeactivated() {
      this.active = false;
      this.stopPolling();
    }
  }

  const instance = new PriceForecastTab();
  instance.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  instance.INTERVAL_SECONDS = INTERVAL_SECONDS;
  instance.normalizeSettings = normalizeSettings;
  instance.parseKlines = parseKlines;
  instance.buildFeatureRows = buildFeatureRows;
  instance.fitRidge = fitRidge;
  instance.forecastAtIndex = forecastAtIndex;
  instance.buildCausalForecast = buildCausalForecast;
  return instance;
});
