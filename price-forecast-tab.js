(function (root, factory) {
  const instance = factory();
  if (typeof module === "object" && module.exports) module.exports = instance;
  if (root) root.priceForecastTab = instance;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "skhynix_price_forecast_settings_v4";
  const INTERVAL_SECONDS = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const FEATURE_GROUPS = ["momentum", "macd", "rsi", "ma", "volatility"];

  const DEFAULT_SETTINGS = Object.freeze({
    venue: "binance_futures",
    symbol: "ETHUSDT",
    interval: "4h",
    horizon_bars: 1,
    min_hold_bars: 3,
    neutral_bps: 8,
    confidence_pct: 52,
    use_confidence_gate: true,
    use_expected_edge_gate: false,
    min_expected_bps: 8,
    ridge_lambda: 400,
    train_window: 1000,
    min_train_samples: 180,
    cost_bps: 10,
    use_daily_trend_filter: true,
    daily_ma_period: 100,
    hold_same_direction: true,
    entry_direction_mode: "long_only",
    use_stop_loss: false,
    stop_loss_pct: 3.0,
    notional_usd: 200,
    leverage: 1.0,
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
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((left, right) => Number(left) - Number(right));
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? Number(sorted[mid]) : (Number(sorted[mid - 1]) + Number(sorted[mid])) / 2;
  };
  const stdev = (values) => {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + ((Number(value) - avg) ** 2), 0) / (values.length - 1));
  };

  function formatNumber(value, digits = 2, fallback = "—") {
    return finite(value) ? Number(value).toFixed(digits) : fallback;
  }

  function formatPrice(value, symbol = "ETHUSDT") {
    if (!finite(value)) return "—";
    const num = Number(value);
    const sym = String(symbol || "").toUpperCase();
    const digits = sym.startsWith("DOGE") ? 5 : sym.startsWith("XRP") ? 4 : num >= 1000 ? 2 : 2;
    return `$${num.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  const KST_TIME_ZONE = "Asia/Seoul";
  const KST_FULL_SEC_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const KST_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const KST_MD_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE, month: "2-digit", day: "2-digit",
  });
  const KST_HMS_FMT = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const KST_HM_FMT = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

  function formatKst(epochSeconds) {
    if (!finite(epochSeconds)) return "—";
    return KST_FULL_SEC_FMT.format(new Date(Number(epochSeconds) * 1000)).replace(",", "") + " KST";
  }

  function formatKstTick(epochSeconds, tickMarkType) {
    if (!finite(epochSeconds)) return "";
    const numTime = Number(epochSeconds);
    const date = new Date(numTime * 1000);
    if (Number.isNaN(date.getTime())) return "";
    if (tickMarkType === 4) return KST_HMS_FMT.format(date);
    const kstSecOfDay = ((Math.floor(numTime) + 32400) % 86400 + 86400) % 86400;
    if (kstSecOfDay === 0) return tickMarkType === 0 ? KST_DATE_FMT.format(date) : KST_MD_FMT.format(date);
    if (tickMarkType === 0 || tickMarkType === 1 || tickMarkType === 2) return `${KST_MD_FMT.format(date)} ${KST_HM_FMT.format(date)}`;
    return KST_HM_FMT.format(date);
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
    const barRange = Number(bars[index].high) - Number(bars[index].low);
    const candleClv = barRange > 0 ? ((2 * close - Number(bars[index].high) - Number(bars[index].low)) / barRange) : 0;

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
      add("candle_clv", candleClv);
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
        candle_clv: candleClv,
      },
    };
  }

  function localVolatilityScaleBps(bars, indicators, settings, index) {
    const close = Number(bars[index]?.close || 0);
    if (!(close > 0)) return 10;
    const atr = indicators?.atr?.[index];
    const atrBps = finite(atr) && atr > 0 ? (Number(atr) / close) * 10000 : 20;
    const rv = indicators?.returnVolatility?.[index];
    const perBar = Math.max(2, finite(rv) && rv > 0 ? (0.55 * Number(rv) + 0.45 * atrBps * 0.72) : atrBps * 0.75);
    return perBar * Math.sqrt(Math.max(1, Number(settings?.horizon_bars || 1)));
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

  function fitRidge(samples, lambda, options = {}) {
    if (!samples.length || !samples[0]?.x?.length) return null;
    const n = samples.length;
    const width = samples[0].x.length;
    const means = new Array(width).fill(0);
    const scales = new Array(width).fill(0);
    for (let i = 0; i < n; i += 1) {
      const xi = samples[i].x;
      for (let column = 0; column < width; column += 1) means[column] += Number(xi[column]);
    }
    for (let column = 0; column < width; column += 1) means[column] /= n;
    for (let i = 0; i < n; i += 1) {
      const xi = samples[i].x;
      for (let column = 0; column < width; column += 1) {
        const diff = Number(xi[column]) - means[column];
        scales[column] += diff * diff;
      }
    }
    for (let column = 0; column < width; column += 1) {
      scales[column] = Math.max(1e-9, Math.sqrt(scales[column] / Math.max(1, n - 1)));
    }
    const lamInput = Math.max(0, Number(lambda));
    const volScaled = finite(samples[0]?.scale) && Number(samples[0].scale) > 0;
    if (volScaled) return fitRidgeVolScaled(samples, lamInput, means, scales, options);

    const xtx = Array.from({ length: width }, () => new Array(width).fill(0));
    const xty = new Array(width).fill(0);
    const yMean = mean(samples.map((sample) => sample.y));
    for (let i = 0; i < n; i += 1) {
      const xi = samples[i].x;
      const centeredY = Number(samples[i].y) - yMean;
      for (let row = 0; row < width; row += 1) {
        const zRow = (Number(xi[row]) - means[row]) / scales[row];
        xty[row] += zRow * centeredY;
        for (let column = row; column < width; column += 1) {
          const zCol = (Number(xi[column]) - means[column]) / scales[column];
          const prod = zRow * zCol;
          xtx[row][column] += prod;
          if (column !== row) xtx[column][row] += prod;
        }
      }
    }
    for (let column = 0; column < width; column += 1) xtx[column][column] += lamInput;
    const weights = solveLinearSystem(xtx, xty);
    const model = { means, scales, yMean, weights, amplitude: 1, tanhPredict: false, residuals: [], normResiduals: null, sample_count: n };
    model.residuals = samples.map((sample) => Number(sample.y) - predictRidge(model, sample.x));
    return model;
  }

  function fitRidgeVolScaled(samples, lamInput, means, scales, options = {}) {
    const n = samples.length;
    const width = means.length;
    const targetK = 0.8;
    const zFlat = new Float64Array(n * width);
    const yNorm = new Float64Array(n);
    const xtx = Array.from({ length: width }, () => new Array(width).fill(0));
    const xty = new Array(width).fill(0);
    const lamEff = lamInput * (n / 500);
    const offDiagKeep = 1 - clamp(lamInput / (lamInput + 45), 0, 0.90);

    for (let i = 0; i < n; i += 1) {
      const xi = samples[i].x;
      const base = i * width;
      for (let column = 0; column < width; column += 1) {
        zFlat[base + column] = Math.tanh(((Number(xi[column]) - means[column]) / scales[column]) / 2) * 2;
      }
      const yn = Number(samples[i].y) / Math.max(2, Number(samples[i].scale));
      yNorm[i] = yn;
      const yTanh = Math.tanh(yn / targetK);
      for (let row = 0; row < width; row += 1) {
        const zr = zFlat[base + row];
        xty[row] += zr * yTanh;
        xtx[row][row] += zr * zr;
        for (let column = row + 1; column < width; column += 1) xtx[row][column] += zr * zFlat[base + column];
      }
    }
    for (let row = 0; row < width; row += 1) {
      xtx[row][row] += lamEff;
      for (let column = row + 1; column < width; column += 1) {
        const val = xtx[row][column] * offDiagKeep;
        xtx[row][column] = val;
        xtx[column][row] = val;
      }
    }
    const weights = solveLinearSystem(xtx, xty);

    let num = 0;
    let den = 0;
    const trainScores = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const base = i * width;
      let score = 0;
      for (let column = 0; column < width; column += 1) score += zFlat[base + column] * weights[column];
      trainScores[i] = score;
      const clippedY = clamp(yNorm[i], -2.5, 2.5);
      num += score * clippedY;
      den += score * score;
    }
    const ampRaw = den > 1e-9 ? num / den : targetK;
    const amplitude = clamp(ampRaw > 0 ? ampRaw : targetK, 0.25, 2.5);
    const normResiduals = new Float64Array(n);
    for (let i = 0; i < n; i += 1) normResiduals[i] = yNorm[i] - trainScores[i] * amplitude;
    const sortedNorm = Float64Array.from(normResiduals).sort();
    const mid = n >> 1;
    const normCenter = n % 2 ? sortedNorm[mid] : (sortedNorm[mid - 1] + sortedNorm[mid]) / 2;
    let normMean = 0;
    for (let i = 0; i < n; i += 1) normMean += normResiduals[i];
    normMean /= n;
    let normVar = 0;
    for (let i = 0; i < n; i += 1) {
      const diff = normResiduals[i] - normMean;
      normVar += diff * diff;
    }
    const normSigma = n > 1 ? Math.sqrt(normVar / (n - 1)) : 0;

    const residuals = options.skipLegacyResiduals
      ? null
      : Array.from(normResiduals, (value, i) => value * Number(samples[i].scale));

    return {
      means, scales, yMean: 0, weights, amplitude, tanhPredict: true,
      residuals, normResiduals, normCenter, normSigma, sample_count: n,
    };
  }

  function predictRidge(model, values, targetScale = null) {
    if (!model || !Array.isArray(values) || values.length !== model.weights.length) return null;
    let sum = model.yMean;
    for (let index = 0; index < values.length; index += 1) {
      const z = (Number(values[index]) - model.means[index]) / model.scales[index];
      const normalized = model.tanhPredict ? Math.tanh(z / 2) * 2 : z;
      sum += model.weights[index] * normalized;
    }
    const predicted = sum * (model.amplitude ?? 1);
    return (model.normResiduals && finite(targetScale) && Number(targetScale) > 0)
      ? predicted * Number(targetScale)
      : predicted;
  }

  function probabilityFromResiduals(expectedBps, residuals, neutralBps, knownCenter = null, scaleFactor = 1) {
    const counts = { up: 1, neutral: 1, down: 1 };
    const s = Number(scaleFactor) || 1;
    const center = knownCenter !== null && finite(knownCenter) ? Number(knownCenter) : median(residuals) * s;
    const expected = Number(expectedBps);
    const band = Number(neutralBps);
    for (let index = 0; index < residuals.length; index += 1) {
      const centered = Number(residuals[index]) * s - center;
      const plus = expected + centered;
      const minus = expected - centered;
      if (plus > band) counts.up += 0.5;
      else if (plus < -band) counts.down += 0.5;
      else counts.neutral += 0.5;
      if (minus > band) counts.up += 0.5;
      else if (minus < -band) counts.down += 0.5;
      else counts.neutral += 0.5;
    }
    const total = counts.up + counts.neutral + counts.down;
    return { up: counts.up / total, neutral: counts.neutral / total, down: counts.down / total };
  }

  function classify(probabilities) {
    return ["neutral", "up", "down"].reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best), "neutral");
  }

  function makeSamples(bars, featureRows, settings, indicators = null) {
    const resolvedIndicators = indicators || calculateIndicators(bars, settings);
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
        scale: localVolatilityScaleBps(bars, resolvedIndicators, settings, index),
      });
    });
    return samples;
  }

  function forecastStepFromEligible(bars, indicators, row, eligible, settings, sourceIndex) {
    if (!row || !eligible || eligible.length < settings.min_train_samples) return null;
    const model = fitRidge(eligible, settings.ridge_lambda, { skipLegacyResiduals: true });
    const sourceScale = localVolatilityScaleBps(bars, indicators, settings, sourceIndex);
    const expectedBps = predictRidge(model, row.values, sourceScale);
    const useScaled = Boolean(model.normResiduals && finite(sourceScale) && sourceScale > 0);
    const probabilities = useScaled
      ? probabilityFromResiduals(expectedBps, model.normResiduals, settings.neutral_bps, model.normCenter * sourceScale, sourceScale)
      : probabilityFromResiduals(expectedBps, model.residuals, settings.neutral_bps);
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
      train_samples: eligible.length,
      residual_sigma_bps: useScaled ? model.normSigma * sourceScale : stdev(model.residuals),
      feature_names: row.names,
      feature_metrics: row.metrics,
    };
  }

  function forecastAtIndex(bars, rawSettings, sourceIndex) {
    const settings = normalizeSettings(rawSettings);
    const { indicators, rows } = buildFeatureRows(bars, settings);
    const row = rows[sourceIndex];
    if (!row) return null;
    const eligible = makeSamples(bars, rows, settings, indicators)
      .filter((sample) => sample.targetIndex <= sourceIndex)
      .slice(-settings.train_window);
    return forecastStepFromEligible(bars, indicators, row, eligible, settings, sourceIndex);
  }

  function normalizeSettings(raw = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const venue = String(merged.venue || DEFAULT_SETTINGS.venue).toLowerCase() === "lighter" ? "lighter" : "binance_futures";
    const interval = ["5m", "15m", "1h", "4h"].includes(merged.interval) ? merged.interval : DEFAULT_SETTINGS.interval;
    const cleanSym = String(merged.symbol || DEFAULT_SETTINGS.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || DEFAULT_SETTINGS.symbol;
    const settings = {
      ...merged,
      venue,
      symbol: cleanSym,
      interval,
      horizon_bars: Math.round(clamp(merged.horizon_bars, 1, 12)),
      min_hold_bars: Math.round(clamp(merged.min_hold_bars ?? 1, 1, 24)),
      neutral_bps: clamp(merged.neutral_bps, 0, 500),
      confidence_pct: clamp(merged.confidence_pct, 0, 100),
      use_confidence_gate: merged.use_confidence_gate !== false,
      use_expected_edge_gate: Boolean(merged.use_expected_edge_gate),
      min_expected_bps: clamp(merged.min_expected_bps ?? 8, 0, 500),
      ridge_lambda: clamp(merged.ridge_lambda, 0.0001, 10000),
      train_window: Math.round(clamp(merged.train_window, 100, 1200)),
      min_train_samples: Math.round(clamp(merged.min_train_samples, 60, 1000)),
      cost_bps: clamp(merged.cost_bps, 0, 500),
      use_daily_trend_filter: merged.use_daily_trend_filter !== false,
      daily_ma_period: Math.round(clamp(merged.daily_ma_period ?? 20, 2, 200)),
      hold_same_direction: merged.hold_same_direction !== false,
      entry_direction_mode: ["two_way", "long_only", "short_only"].includes(merged.entry_direction_mode) ? merged.entry_direction_mode : "two_way",
      use_stop_loss: Boolean(merged.use_stop_loss),
      stop_loss_pct: clamp(merged.stop_loss_pct ?? 3.0, 0.1, 50),
      notional_usd: clamp(merged.notional_usd ?? 200, 10, 5000),
      leverage: clamp(merged.leverage ?? 1.0, 1, 10),
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
    const empty = (error) => ({ settings, error, latest: null, forecast_signals: [], indicators: null });
    if (!enabledGroups.length) return empty("Enable at least one model input group.");
    if (!Array.isArray(bars) || bars.length < settings.min_train_samples + settings.horizon_bars + 60) {
      return empty(`Need at least ${settings.min_train_samples + settings.horizon_bars + 60} completed candles.`);
    }
    const { indicators, rows } = buildFeatureRows(bars, settings);
    const samples = makeSamples(bars, rows, settings, indicators);
    const validSourceIndices = rows.map((row, index) => row ? index : null).filter((index) => index !== null);
    const latestIndex = validSourceIndices[validSourceIndices.length - 1];
    const latestEligible = latestIndex === undefined
      ? []
      : samples.filter((sample) => sample.targetIndex <= latestIndex).slice(-settings.train_window);
    const latest = latestIndex === undefined
      ? null
      : forecastStepFromEligible(bars, indicators, rows[latestIndex], latestEligible, settings, latestIndex);
    if (!latest) return empty("Not enough matured causal samples for the selected training window.");

    const realizedClass = (retBps, band) => (retBps > band ? "up" : retBps < -band ? "down" : "neutral");
    const rankVals = (vals) => {
      const ordered = vals.map((v, idx) => ({ v: Number(v), idx })).sort((a, b) => a.v - b.v);
      const out = new Array(vals.length);
      for (let i = 0; i < ordered.length;) {
        let j = i;
        while (j + 1 < ordered.length && ordered[j + 1].v === ordered[i].v) j += 1;
        const r = (i + j + 2) / 2;
        for (let k = i; k <= j; k += 1) out[ordered[k].idx] = r;
        i = j + 1;
      }
      return out;
    };
    const corr = (xs, ys) => {
      if (xs.length < 3) return null;
      const mx = mean(xs), my = mean(ys);
      let num = 0, dx2 = 0, dy2 = 0;
      for (let i = 0; i < xs.length; i += 1) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
      }
      return dx2 > 0 && dy2 > 0 ? num / Math.sqrt(dx2 * dy2) : null;
    };

    const earliestIndex = Math.max(
      rows.findIndex(Boolean),
      Math.floor(bars.length * 0.75),
      settings.min_train_samples + settings.horizon_bars,
    );
    const forecastSignals = [];
    const expectedValues = [];
    const realizedValues = [];
    let correct = 0, qualified = 0, brierSum = 0;
    let sampleCursor = 0;
    for (let sourceIndex = earliestIndex; sourceIndex < bars.length - settings.horizon_bars; sourceIndex += 1) {
      if (!rows[sourceIndex]) continue;
      while (sampleCursor < samples.length && samples[sampleCursor].targetIndex <= sourceIndex) sampleCursor += 1;
      const eligible = samples.slice(Math.max(0, sampleCursor - settings.train_window), sampleCursor);
      const step = forecastStepFromEligible(bars, indicators, rows[sourceIndex], eligible, settings, sourceIndex);
      if (!step) continue;
      const targetIndex = sourceIndex + settings.horizon_bars;
      const actualBps = Math.log(Number(bars[targetIndex].close) / Number(bars[sourceIndex].close)) * 10000;
      const actualDir = realizedClass(actualBps, settings.neutral_bps);
      const p = step.probabilities;
      brierSum += ((p.up - (actualDir === "up" ? 1 : 0)) ** 2 + (p.neutral - (actualDir === "neutral" ? 1 : 0)) ** 2 + (p.down - (actualDir === "down" ? 1 : 0)) ** 2) / 3;
      expectedValues.push(step.expected_bps);
      realizedValues.push(actualBps);
      if (step.qualified) {
        qualified += 1;
        if (step.direction === actualDir) correct += 1;
      }
      forecastSignals.push({
        source_index: sourceIndex,
        source_time: Number(bars[sourceIndex].time),
        target_index: targetIndex,
        target_time: Number(bars[targetIndex].time),
        expected_bps: step.expected_bps,
        actual_bps: actualBps,
        probabilities: step.probabilities,
        direction: step.direction,
        actual_direction: actualDir,
        confidence: step.confidence,
        qualified: step.qualified,
        train_samples: eligible.length,
      });
    }
    const validation = {
      predictions: forecastSignals.length,
      qualified,
      hit_rate_pct: qualified ? (correct / qualified) * 100 : null,
      brier: forecastSignals.length ? brierSum / forecastSignals.length : null,
      rank_ic: corr(rankVals(expectedValues), rankVals(realizedValues)),
    };
    return { settings, error: null, latest, forecast_signals: forecastSignals, validation, indicators };
  }

  function parseKlines(rows, interval, nowSeconds = Date.now() / 1000) {
    const intervalSeconds = INTERVAL_SECONDS[interval] || 14400;
    if (!Array.isArray(rows)) return [];
    const deduped = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const bar = {
        time: Math.floor(Number(row[0]) / 1000),
        close_time: finite(row[6]) ? Math.floor(Number(row[6]) / 1000) : Math.floor(Number(row[0]) / 1000) + intervalSeconds,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] || 0),
      };
      if (finite(bar.time) && finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close) && bar.close_time <= nowSeconds) {
        deduped.set(bar.time, bar);
      }
    }
    return Array.from(deduped.values()).sort((left, right) => left.time - right.time);
  }

  function entryDirectionAllowed(mode, side) {
    const parsed = String(mode || "two_way").trim().toLowerCase();
    return parsed === "two_way" || (parsed === "long_only" && side > 0) || (parsed === "short_only" && side < 0);
  }

  function alignDailyTrend(bars, dailyBars, maPeriod = 20) {
    if (!Array.isArray(dailyBars) || !dailyBars.length || !Array.isArray(bars) || !bars.length) {
      return new Array((bars || []).length).fill(null);
    }
    const orderedDaily = [...dailyBars].sort((a, b) => Number(a.time) - Number(b.time));
    const dCloses = orderedDaily.map((b) => Number(b.close));
    const dMa = simpleMovingAverage(dCloses, Math.max(2, Math.round(maPeriod || 20)));
    const aligned = new Array(bars.length).fill(null);
    let cursor = 0;
    for (let idx = 0; idx < bars.length; idx += 1) {
      const barCloseTime = Math.floor(Number(bars[idx].close_time ?? bars[idx].time));
      while (cursor + 1 < orderedDaily.length && Math.floor(Number(orderedDaily[cursor + 1].close_time ?? orderedDaily[cursor + 1].time)) <= barCloseTime) {
        cursor += 1;
      }
      const dBar = orderedDaily[cursor];
      const dCloseTime = Math.floor(Number(dBar.close_time ?? dBar.time));
      const maVal = dMa[cursor];
      const dClose = Number(dBar.close);
      if (dCloseTime <= barCloseTime && finite(maVal) && dClose > 0) {
        const trend = dClose > maVal ? 1 : (dClose < maVal ? -1 : 0);
        aligned[idx] = {
          daily_time: Math.floor(Number(dBar.time)),
          daily_close_time: dCloseTime,
          daily_close: dClose,
          daily_ma: Number(maVal),
          daily_trend: trend,
        };
      }
    }
    return aligned;
  }

  function buildDailyMaSeries(bars, dailyBars, maPeriod = 20) {
    const aligned = alignDailyTrend(bars, dailyBars, maPeriod);
    const series = [];
    for (let i = 0; i < bars.length; i += 1) {
      const ctx = aligned[i];
      if (ctx && finite(ctx.daily_ma)) {
        series.push({ time: Number(bars[i].time), value: Number(ctx.daily_ma) });
      }
    }
    return series;
  }

  function runCausalReplayWithDaily(barsInput, dailyBarsInput, rawSettings = {}, replayOpts = {}) {
    const settings = normalizeSettings(rawSettings);
    const enabledGroups = FEATURE_GROUPS.filter((g) => settings[`use_${g}`]);
    if (!enabledGroups.length) {
      return { success: false, error: "Enable at least one model input group.", settings, entry_signals: [], entry_trend: [], trades: [], markers: [] };
    }
    const bars = (barsInput || []).filter((b) => b && b.completed !== false);
    const dailyBars = (dailyBarsInput || []).filter((b) => b && b.completed !== false);
    const minNeeded = settings.min_train_samples + settings.horizon_bars + 60;
    if (bars.length < minNeeded) {
      return { success: false, error: `Need at least ${minNeeded} completed ${settings.interval} candles.`, settings, entry_signals: [], entry_trend: [], trades: [], markers: [] };
    }

    const notionalUsd = Number(replayOpts.notional_usd ?? settings.notional_usd ?? 200);
    const leverage = Number(replayOpts.leverage ?? settings.leverage ?? 1);
    const maxEvalBars = Math.max(100, Math.round(Number(replayOpts.max_eval_bars ?? replayOpts.limit ?? 360)));
    const initialEquityUsd = Number(replayOpts.initial_equity_usd ?? notionalUsd);

    const { indicators, rows } = buildFeatureRows(bars, settings);
    const samples = makeSamples(bars, rows, settings, indicators);
    const alignedDaily = alignDailyTrend(bars, dailyBars, settings.daily_ma_period);

    const firstValidIdx = rows.findIndex((r) => r !== null);
    const firstValid = firstValidIdx < 0 ? 0 : firstValidIdx;
    let lastValid = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i] !== null) {
        lastValid = i;
        break;
      }
    }
    const earliest = Math.max(firstValid, settings.min_train_samples + settings.horizon_bars, bars.length - maxEvalBars);

    const entrySignals = [];
    const entryTrend = [];
    let sampleCursor = 0;
    const trainWindow = settings.train_window;
    const dailyOn = Boolean(settings.use_daily_trend_filter);
    const dirMode = settings.entry_direction_mode;
    let latestEval = null;

    const evalStep = (srcIdx) => {
      const row = rows[srcIdx];
      if (!row) return null;
      while (sampleCursor < samples.length && samples[sampleCursor].targetIndex <= srcIdx) {
        sampleCursor += 1;
      }
      const start = Math.max(0, sampleCursor - trainWindow);
      const eligible = samples.slice(start, sampleCursor);
      const step = forecastStepFromEligible(bars, indicators, row, eligible, settings, srcIdx);
      if (!step) return null;
      const dCtx = alignedDaily[srcIdx];
      const dTrend = dCtx ? Math.round(dCtx.daily_trend) : 0;
      const rawSide = step.direction === "up" ? 1 : (step.direction === "down" ? -1 : 0);
      const dailyAllowsLong = dailyOn ? (dCtx !== null && dTrend > 0) : true;
      const dailyAllowsShort = dailyOn ? (dCtx !== null && dTrend < 0) : true;
      const sideAllowedByDaily = (rawSide === 1 && dailyAllowsLong) || (rawSide === -1 && dailyAllowsShort);
      const trendSign = dailyOn ? (dCtx ? dTrend : 0) : 0;
      const confidencePass = !settings.use_confidence_gate || Number(step.confidence) * 100 >= settings.confidence_pct;
      const edgePass = !settings.use_expected_edge_gate || Math.abs(Number(step.expected_bps)) >= settings.min_expected_bps;
      const entryAllowed = rawSide !== 0 && confidencePass && edgePass && sideAllowedByDaily && entryDirectionAllowed(dirMode, rawSide);
      return { step, dCtx, dTrend, rawSide, dailyAllowsLong, dailyAllowsShort, sideAllowedByDaily, trendSign, confidencePass, edgePass, entryAllowed };
    };

    for (let srcIdx = earliest; srcIdx < bars.length; srcIdx += 1) {
      const res = evalStep(srcIdx);
      if (!res) continue;
      const { step, dCtx, dTrend, rawSide, dailyAllowsLong, dailyAllowsShort, sideAllowedByDaily, trendSign, confidencePass, edgePass, entryAllowed } = res;
      const bar = bars[srcIdx];
      const barTime = Math.floor(Number(bar.time));
      const barCloseTime = Math.floor(Number(bar.close_time ?? bar.time));
      const barClose = Number(bar.close);
      entryTrend.push({
        time: barTime,
        close_time: barCloseTime,
        sign: trendSign,
        daily_close: dCtx ? dCtx.daily_close : null,
        daily_ma: dCtx ? dCtx.daily_ma : null,
        daily_time: dCtx ? dCtx.daily_close_time : null,
      });
      entrySignals.push({
        index: srcIdx,
        time: barTime,
        close_time: barCloseTime,
        close: barClose,
        raw_direction: step.direction,
        raw_side: rawSide,
        side: entryAllowed ? rawSide : 0,
        qualified: Boolean(confidencePass),
        confidence_pass: Boolean(confidencePass),
        edge_pass: Boolean(edgePass),
        confidence_pct: Number(step.confidence) * 100.0,
        expected_bps: Number(step.expected_bps),
        daily_trend: trendSign,
        daily_ma: dCtx ? dCtx.daily_ma : null,
        daily_close: dCtx ? dCtx.daily_close : null,
        daily_ok: Boolean(sideAllowedByDaily),
        entry_allowed: Boolean(entryAllowed),
        train_samples: Number(step.train_samples),
      });
      if (srcIdx === lastValid) {
        latestEval = { res, idx: srcIdx };
      }
    }

    const buildLatestEval = (idx, res) => {
      if (!res) return null;
      const { step, dCtx, dTrend, rawSide, dailyAllowsLong, dailyAllowsShort, sideAllowedByDaily, confidencePass, edgePass, entryAllowed } = res;
      const bar = bars[idx];
      const confPct = Number(step.confidence) * 100.0;
      return {
        strategy: "causal_ridge_daily",
        symbol: settings.symbol,
        venue: settings.venue,
        interval: settings.interval,
        time: Math.floor(Number(bar.time)),
        close_time: Math.floor(Number(bar.close_time ?? bar.time)),
        close: Number(bar.close),
        ma_fast: indicators.maFast[idx],
        ma_slow: indicators.maSlow[idx],
        direction: step.direction,
        candidate_side: entryAllowed ? rawSide : 0,
        raw_side: rawSide,
        expected_bps: Number(step.expected_bps),
        confidence_pct: confPct,
        use_confidence_gate: Boolean(settings.use_confidence_gate),
        min_confidence_pct: Number(settings.confidence_pct),
        confidence_pass: Boolean(confidencePass),
        use_expected_edge_gate: Boolean(settings.use_expected_edge_gate),
        min_expected_bps: Number(settings.min_expected_bps),
        edge_pass: Boolean(edgePass),
        probabilities: step.probabilities,
        residual_sigma_bps: Number(step.residual_sigma_bps),
        train_samples: Number(step.train_samples),
        use_daily_trend_filter: dailyOn,
        daily_ma_period: settings.daily_ma_period,
        daily_ready: dCtx !== null,
        daily_trend: dTrend,
        daily_close: dCtx ? dCtx.daily_close : null,
        daily_ma: dCtx ? dCtx.daily_ma : null,
        daily_close_time: dCtx ? dCtx.daily_close_time : null,
        daily_allows_long: dailyAllowsLong,
        daily_allows_short: dailyAllowsShort,
        side_allowed_by_daily: sideAllowedByDaily,
        hold_same_direction: Boolean(settings.hold_same_direction),
        min_hold_bars: Number(settings.min_hold_bars),
        entry_direction_mode: dirMode,
        entry_allowed: entryAllowed,
        feature_names: step.feature_names,
        feature_metrics: step.feature_metrics,
      };
    };

    if (latestEval && latestEval.res) {
      latestEval = buildLatestEval(latestEval.idx, latestEval.res);
    } else if (lastValid >= 0) {
      latestEval = buildLatestEval(lastValid, evalStep(lastValid));
    } else {
      latestEval = null;
    }

    const sigByIdx = new Map();
    entrySignals.forEach((sig) => sigByIdx.set(sig.index, sig));
    const minHoldBars = settings.min_hold_bars;
    const holdSame = Boolean(settings.hold_same_direction);
    const feeRate = Number(settings.cost_bps) / 10000.0;
    const useSl = Boolean(settings.use_stop_loss);
    const slFrac = Number(settings.stop_loss_pct) / 100.0;

    const trades = [];
    const markers = [];
    let openPos = null;
    let pendingAction = null;
    let eq = initialEquityUsd;
    let peak = eq;
    let maxDd = 0.0;
    let worstTradePct = 0.0;
    let wins = 0;

    const recordExit = (exitPx, barTime, reason, hoverPrefix) => {
      if (!openPos) return;
      const rawRet = openPos.side * (exitPx / openPos.entry_price - 1.0);
      const netRet = rawRet - feeRate;
      const pnlPct = netRet * 100.0;
      const roePct = netRet * 100.0 * leverage;
      const pnlUsd = openPos.notional * netRet;
      const feeUsd = openPos.notional * feeRate;
      eq = Math.max(0.0, eq + pnlUsd);
      peak = Math.max(peak, eq);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - eq) / peak) * 100.0);
      worstTradePct = Math.min(worstTradePct, roePct);
      if (pnlUsd > 0) wins += 1;
      const pk = openPos.pairKey;
      const dirStr = openPos.side > 0 ? "long" : "short";
      trades.push({
        pairKey: pk, symbol: settings.symbol, side: openPos.side, direction: dirStr,
        signal_time: openPos.signal_time,
        entry_time: openPos.entry_time, exit_time: barTime,
        entry_price: openPos.entry_price, exit_price: exitPx,
        qty: openPos.qty, notional: openPos.notional, fee_usd: feeUsd,
        gross_pnl_usd: openPos.notional * rawRet, net_pnl_usd: pnlUsd,
        pnl_pct: pnlPct, roe_pct: roePct, reason, source: "virtual", hypothetical: true,
      });
      markers.push({
        time: barTime, source: "virtual", hypothetical: true, is_entry: false, is_exit: true,
        side: -openPos.side, direction: dirStr, ratio: exitPx, entry_price: openPos.entry_price,
        exit_price: exitPx, qty: openPos.qty, notional: openPos.notional, pairKey: pk,
        pnl: pnlUsd, pnl_pct: pnlPct, pnl_authoritative: true,
        hoverText: `${hoverPrefix} @ $${exitPx.toFixed(2)} · net ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} USD (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
      });
      openPos = null;
    };

    const recordEntry = (side, sig, idx, entryPx) => {
      const barTime = Math.floor(Number(bars[idx].time));
      const pk = `paper:${trades.length + 1}:${barTime}`;
      const notional = notionalUsd * leverage;
      const qty = notional / entryPx;
      const dirStr = side > 0 ? "long" : "short";
      openPos = {
        pairKey: pk, side, entry_index: idx, entry_time: barTime,
        signal_time: Number(sig.time), entry_price: entryPx, qty, notional, renewals: 0,
      };
      markers.push({
        time: barTime, source: "virtual", hypothetical: true, is_entry: true, is_exit: false,
        side, direction: dirStr, ratio: entryPx, entry_price: entryPx,
        exit_price: null, qty, notional, pairKey: pk, pnl: null, pnl_pct: null,
        hoverText: `PAPER ${side > 0 ? "LONG" : "SHORT"} NEXT-OPEN @ $${entryPx.toFixed(2)} · signal ${sig.confidence_pct.toFixed(1)}% · ${sig.expected_bps >= 0 ? "+" : ""}${sig.expected_bps.toFixed(1)}bp`,
      });
    };

    for (let idx = earliest; idx < bars.length; idx += 1) {
      const bar = bars[idx];
      const barTime = Math.floor(Number(bar.time));
      const barOpen = Number(bar.open);
      const barClose = Number(bar.close);
      const barHigh = Number(bar.high);
      const barLow = Number(bar.low);
      if (pendingAction) {
        const action = pendingAction;
        pendingAction = null;
        if (["exit", "reverse"].includes(action.kind)) {
          recordExit(barOpen, barTime, action.reason, `PAPER NEXT-OPEN EXIT (${action.reason})`);
        }
        if (["entry", "reverse"].includes(action.kind) && action.side) {
          recordEntry(Number(action.side), action.signal, idx, barOpen);
        }
      }

      if (openPos !== null && useSl) {
        let hitSl = false;
        let exitPx = barClose;
        if (openPos.side > 0 && barLow <= openPos.entry_price * (1.0 - slFrac)) {
          hitSl = true;
          exitPx = openPos.entry_price * (1.0 - slFrac);
        } else if (openPos.side < 0 && barHigh >= openPos.entry_price * (1.0 + slFrac)) {
          hitSl = true;
          exitPx = openPos.entry_price * (1.0 + slFrac);
        }
        if (hitSl) {
          recordExit(exitPx, barTime, "stop_loss", "PAPER STOP EXIT");
        }
      }

      if (openPos !== null && peak > 0) {
        const adversePx = openPos.side > 0 ? barLow : barHigh;
        const adverseRet = openPos.side * (adversePx / openPos.entry_price - 1.0) - feeRate;
        const adverseEq = Math.max(0, eq + openPos.notional * adverseRet);
        maxDd = Math.max(maxDd, ((peak - adverseEq) / peak) * 100.0);
        const closeRet = openPos.side * (barClose / openPos.entry_price - 1.0) - feeRate;
        peak = Math.max(peak, eq + openPos.notional * closeRet);
      }

      const sig = sigByIdx.get(idx) || null;
      const sigSide = sig ? Number(sig.side) : 0;
      if (idx + 1 >= bars.length) continue;
      if (openPos !== null) {
        const held = idx - openPos.entry_index + 1;
        if (held >= minHoldBars) {
          if (holdSame && sigSide === openPos.side) {
            openPos.renewals += 1;
          } else {
            const reversing = Boolean(sig && sigSide !== 0 && sigSide !== openPos.side);
            pendingAction = {
              kind: reversing ? "reverse" : "exit",
              side: reversing ? sigSide : 0,
              signal: sig,
              reason: reversing ? "opposite_signal_reversal" : "horizon_exit",
            };
          }
        }
      } else if (sigSide !== 0 && sig !== null) {
        pendingAction = { kind: "entry", side: sigSide, signal: sig, reason: "signal_entry" };
      }
    }

    const totalTrades = trades.length;
    const netPnlUsd = trades.reduce((acc, t) => acc + t.net_pnl_usd, 0);
    const totalFeesUsd = trades.reduce((acc, t) => acc + t.fee_usd, 0);
    return {
      success: true,
      error: null,
      venue: settings.venue,
      symbol: settings.symbol,
      interval: settings.interval,
      settings,
      latest_evaluation: latestEval,
      latest_condition_time: latestEval ? latestEval.close_time : null,
      entry_signals: entrySignals,
      entry_trend: entryTrend,
      daily_ma_series: entryTrend.filter((item) => finite(item.daily_ma)).map((item) => ({ time: item.time, value: item.daily_ma })),
      trades,
      open_position: openPos,
      markers,
      summary: {
        trades: totalTrades,
        wins,
        win_rate_pct: totalTrades ? (wins / totalTrades) * 100.0 : null,
        net_pnl_usd: netPnlUsd,
        return_on_initial_pct: initialEquityUsd > 0 ? ((eq - initialEquityUsd) / initialEquityUsd) * 100.0 : 0.0,
        max_drawdown_pct: maxDd,
        worst_trade_pct: totalTrades ? worstTradePct : 0.0,
        total_fees_usd: totalFeesUsd,
        fee_bps: Number(settings.cost_bps),
        fill_model: "next_bar_open",
        min_hold_bars: minHoldBars,
        hold_same_direction: holdSame,
        use_daily_trend_filter: dailyOn,
        eval_bars: entrySignals.length,
      },
    };
  }

  function getApiPrefix() {
    const p = typeof window !== "undefined" ? window.location.pathname : "";
    return p.startsWith("/skhynix") ? "/skhynix" : "";
  }

  async function apiGet(path, options = {}) {
    const resp = await fetch(`${getApiPrefix()}${path}`, { signal: options.signal });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((payload && (payload.error || payload.detail)) || `HTTP ${resp.status}`);
    if (!payload) throw new Error("Invalid API response");
    return payload;
  }

  async function apiPost(path, body) {
    const token = window.terminalLockManager?.token;
    if (!token) throw new Error("Unlock the terminal first");
    const resp = await fetch(`${getApiPrefix()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((payload && (payload.error || payload.detail)) || `HTTP ${resp.status}`);
    if (!payload) throw new Error("Invalid API response");
    return payload;
  }

  class PriceForecastTab {
    constructor() {
      this.mounted = false;
      this.loaded = false;
      this.active = false;
      this.settings = this.loadSettings();
      this.loadedMarket = null;
      this.bars = [];
      this.dailyBars = [];
      this.dailyMaSeries = [];
      this.actualMarkers = [];
      this.replayPayload = null;
      this.statusPayload = null;
      this.botState = null;
      this.errors = { status: null, chart: null, replay: null };
      this.chart = null;
      this.candleSeries = null;
      this.maFastSeries = null;
      this.maSlowSeries = null;
      this.dailyMaSeriesPlot = null;
      this.executionChartFrame = null;
      this.executionChartController = null;
      this.rawExecutionMarkers = [];
      this.showActualMarkers = true;
      this.showVirtualMarkers = true;
      this.showSignalArrows = true;
      this.groupTradesAsRange = false;
      this.historyFilter = "all";
      this.activeHoveredExecutionMarkerKey = null;
      this.activeHoveredPairKey = null;
      this.selectedExecutionMarkerKey = null;
      this.selectedPairKey = null;
      this.stopPriceScaleWatch = null;
      this._rangeChangeRaf = null;
      this.requestSequence = 0;
      this.replaySequence = 0;
      this.loading = false;
      this.pendingFit = false;
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
      globalThis.collapsibleSectionsManager?.ensureCollapseButtons?.(container);
      globalThis.collapsibleSectionsManager?.restoreStates?.();
      this.bindControls();
      this.applyExecutionLock();
      this.initChart();
      this.mounted = true;
      this.refreshAll({ fit: true });
    }

    renderSkeleton(container) {
      const s = this.settings;
      container.innerHTML = `
        <style>
          #tabContentPriceForecast { --pf-gap:var(--terminal-space-min, 6px); }
          #tabContentPriceForecast button { width:auto;height:auto;flex:0 0 auto; }
          #tabContentPriceForecast .pfPanel { background:#fff;border:1px solid #dbe2e7;border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(15,23,42,.05); }
          #tabContentPriceForecast .pfHeaderRow { display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px; }
          #tabContentPriceForecast .pfActions { display:flex;gap:6px;flex-wrap:wrap;align-items:center; }
          #tabContentPriceForecast .pfBtn { border-radius:6px;padding:6px 11px;font-size:11px;font-weight:800;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#0f172a; }
          #tabContentPriceForecast .pfBtn.primary { background:#0284c7;border-color:#0284c7;color:#fff; }
          #tabContentPriceForecast .pfBtn.arm { background:#059669;border-color:#059669;color:#fff; }
          #tabContentPriceForecast .pfBtn.pause { background:#d97706;border-color:#d97706;color:#fff; }
          #tabContentPriceForecast .pfBtn.danger { background:#dc2626;border-color:#dc2626;color:#fff; }
          #tabContentPriceForecast .pfAcctGrid { display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--pf-gap);margin-bottom:8px; }
          #tabContentPriceForecast .pfKpi { padding:9px;border:1px solid #e2e8f0;border-radius:7px;background:#f8fafc;min-width:0; }
          #tabContentPriceForecast .pfKpi span { color:#64748b;font-size:9px;font-weight:800;text-transform:uppercase;display:block; }
          #tabContentPriceForecast .pfKpi strong { color:#0f172a;font-size:15px;font-variant-numeric:tabular-nums;display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
          #tabContentPriceForecast .pfKpi small { display:block;color:#64748b;font-size:9.5px;margin-top:2px; }
          #tabContentPriceForecast .pfControls { display:flex;align-items:end;gap:var(--pf-gap);flex-wrap:wrap; }
          #tabContentPriceForecast .pfField { display:flex;flex-direction:column;gap:3px;min-width:72px; }
          #tabContentPriceForecast .pfField label { color:#64748b;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:4px; }
          #tabContentPriceForecast :is(select,input[type=number],input[type=text]) { height:30px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#0f172a;padding:0 7px;font-size:11px;font-weight:700; }
          #tabContentPriceForecast .pfGrid { display:grid;grid-template-columns:minmax(0,1.72fr) minmax(290px,.82fr);gap:var(--pf-gap);margin-top:var(--pf-gap); }
          #tabContentPriceForecast .pfGrid > * { min-width:0;max-width:100%; }
          #tabContentPriceForecast .pfCondRow { display:grid;grid-template-columns:minmax(100px,1fr) auto;gap:6px;padding:7px 0;border-bottom:1px solid #eef2f7;font-size:11px;align-items:center; }
          #tabContentPriceForecast .pfCondRow:last-child { border-bottom:0; }
          #tabContentPriceForecast .pfState { padding:2px 7px;border-radius:999px;font-size:9px;font-weight:900;background:#dcfce7;color:#047857;display:inline-block;white-space:nowrap; }
          #tabContentPriceForecast .pfState.wait { background:#fef3c7;color:#92400e; }
          #tabContentPriceForecast .pfState.off { background:#f1f5f9;color:#64748b; }
          #tabContentPriceForecast .pfState.err { background:#fee2e2;color:#b91c1c; }
          #tabContentPriceForecast .pfFeature { display:grid;grid-template-columns:auto minmax(80px,1fr) auto;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #eef2f7;font-size:10.5px; }
          #tabContentPriceForecast .pfFeature:last-child { border-bottom:0; }
          #tabContentPriceForecast .pfToggle { accent-color:#0284c7;width:14px;height:14px;cursor:pointer; }
          #tabContentPriceForecast .pfStatusBar { font-size:10.5px;color:#475569;margin-top:6px;line-height:1.4; }
          #tabContentPriceForecast .pfErrorBox { color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:7px 10px;border-radius:6px;font-size:11px;font-weight:700;margin-bottom:8px; }
          #tabContentPriceForecast .pfWarnBox { color:#92400e;background:#fffbeb;border:1px solid #fde68a;padding:7px 10px;border-radius:6px;font-size:11px;font-weight:700;margin-bottom:8px; }
          #tabContentPriceForecast .pfTableWrap { overflow:auto;max-inline-size:100%;max-block-size:380px;container-type:inline-size;border:1px solid #e2e8f0;border-radius:8px;margin-top:8px; }
          #tabContentPriceForecast .pfTable { width:100%;border-collapse:separate;border-spacing:0;font-size:11px;font-variant-numeric:tabular-nums; }
          #tabContentPriceForecast .pfTable thead th { position:sticky;inset-block-start:0;z-index:2;background:#f8fafc;color:#475569;font-size:9.5px;font-weight:800;text-transform:uppercase;padding:8px 9px;border-bottom:1px solid #cbd5e1;text-align:left;white-space:nowrap; }
          #tabContentPriceForecast .pfTable tbody td { padding:8px 9px;border-bottom:1px solid #eef2f7;vertical-align:middle;white-space:nowrap; }
          #tabContentPriceForecast .pfTable tbody tr { cursor:pointer; }
          #tabContentPriceForecast .pfTable tbody tr:hover { background:#f8fafc; }
          #tabContentPriceForecast .pfHistTabs { display:flex;gap:4px;flex-wrap:wrap; }
          #tabContentPriceForecast .pfHistTab { border:1px solid #cbd5e1;background:#fff;color:#475569;border-radius:5px;padding:4px 9px;font-size:10.5px;font-weight:700;cursor:pointer; }
          #tabContentPriceForecast .pfHistTab.active { background:#0f172a;color:#fff;border-color:#0f172a; }
          @media (max-width:980px) {
            #tabContentPriceForecast .pfGrid { display:block; }
            #tabContentPriceForecast .pfGrid > * + * { margin-top:var(--pf-gap); }
            #tabContentPriceForecast .pfAcctGrid { grid-template-columns:repeat(2,minmax(0,1fr)); }
          }
          @media (max-width:560px) {
            #tabContentPriceForecast .pfAcctGrid { grid-template-columns:1fr; }
          }
        </style>

        <section class="pfPanel" aria-label="Causal Ridge and completed daily trend trading controls">
          <div class="pfHeaderRow">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <strong style="font-size:16px;color:#0f172a;">4h Quant Trader (Causal Ridge + Daily Trend)</strong>
                <span id="pfLiveBadge" class="pfState off">SYNCING…</span>
                <span id="pfVenuePill" style="background:#e0f2fe;color:#0369a1;border-radius:999px;padding:2px 8px;font-size:9.5px;font-weight:900;">BINANCE FUTURES</span>
              </div>
              <small id="pfHeaderSub" style="color:#64748b;display:block;margin-top:2px;">Completed-close signals · next-open paper fills · authenticated live execution uses current quotes</small>
            </div>
            <div class="pfActions">
              <button id="pfBtnUnlock" class="pfBtn primary" type="button" style="display:none;">🔒 Unlock Live Controls</button>
              <button id="pfBtnValidatedPreset" class="pfBtn" type="button" title="Loads the researched ETH configuration into the paper controls; saving live still requires unlock">ETH Research Preset</button>
              <button id="pfBtnToggleLive" class="pfBtn arm terminal-action-control" type="button">▶ Start Live Bot</button>
              <button id="pfBtnSaveConfig" class="pfBtn primary terminal-action-control" type="button">💾 Save Strategy &amp; Size</button>
              <button id="pfBtnReconcile" class="pfBtn terminal-action-control" type="button">⚖ Reconcile</button>
              <button id="pfBtnFlatten" class="pfBtn danger terminal-action-control" type="button">🛑 Flatten</button>
              <button id="pfRefresh" class="pfBtn" type="button">↻ Refresh</button>
            </div>
          </div>

          <div id="pfAlertBanner" style="display:none;"></div>

          <div class="pfAcctGrid">
            <div class="pfKpi">
              <span>Account Equity</span>
              <strong id="pfAcctEquity">—</strong>
              <small id="pfAcctSource">Awaiting venue telemetry</small>
            </div>
            <div class="pfKpi">
              <span>Available Margin</span>
              <strong id="pfAcctMargin">—</strong>
              <small id="pfAcctExposure">Gross: —</small>
            </div>
            <div class="pfKpi">
              <span>Selected Position</span>
              <strong id="pfOpenPos">0 Open (Flat)</strong>
              <small id="pfOpenPosSub">No bot-owned tranche</small>
            </div>
            <div class="pfKpi">
              <span>Unrealized PnL</span>
              <strong id="pfUnrealizedPnl">—</strong>
              <small id="pfLastBotAction">Bot action: —</small>
            </div>
            <div class="pfKpi">
              <span>Verified Bot Realized PnL</span>
              <strong id="pfRealizedPnl">—</strong>
              <small id="pfRealizedCount">0 verified exits</small>
            </div>
          </div>

          <div class="pfControls">
            <div class="pfField">
              <label for="pfVenue">Venue</label>
              <select id="pfVenue">
                <option value="binance_futures"${s.venue === "binance_futures" ? " selected" : ""}>Binance Futures</option>
                <option value="lighter"${s.venue === "lighter" ? " selected" : ""}>Lighter DEX (0-Fee)</option>
              </select>
            </div>
            <div class="pfField">
              <label for="pfSymbol">Symbol</label>
              <select id="pfSymbol">
                <option value="ETHUSDT"${s.symbol === "ETHUSDT" ? " selected" : ""}>ETH (Perp)</option>
                <option value="BTCUSDT"${s.symbol === "BTCUSDT" ? " selected" : ""}>BTC (Perp)</option>
                <option value="SOLUSDT"${s.symbol === "SOLUSDT" ? " selected" : ""}>SOL (Perp)</option>
                <option value="DOGEUSDT"${s.symbol === "DOGEUSDT" ? " selected" : ""}>DOGE (Perp)</option>
                <option value="XRPUSDT"${s.symbol === "XRPUSDT" ? " selected" : ""}>XRP (Perp)</option>
              </select>
            </div>
            <div class="pfField">
              <label for="pfInterval">Candle</label>
              <select id="pfInterval">
                <option value="4h"${s.interval === "4h" ? " selected" : ""}>4h (Live Default)</option>
                <option value="1h"${s.interval === "1h" ? " selected" : ""}>1h</option>
                <option value="15m"${s.interval === "15m" ? " selected" : ""}>15m</option>
                <option value="5m"${s.interval === "5m" ? " selected" : ""}>5m</option>
              </select>
            </div>
            <div class="pfField"><label for="pfNotional">Notional ($)</label><input id="pfNotional" type="number" min="10" max="5000" step="10" value="${s.notional_usd}" style="width:76px;"></div>
            <div class="pfField"><label for="pfLeverage">Lev (x)</label><input id="pfLeverage" type="number" min="1" max="10" step="0.5" value="${s.leverage}" style="width:58px;"></div>
            <div class="pfField"><label for="pfConfidence"><input id="pfUseConfidenceGate" class="pfToggle" type="checkbox"${s.use_confidence_gate ? " checked" : ""}> Min Conf %</label><input id="pfConfidence" type="number" min="0" max="100" step="1" value="${s.confidence_pct}" style="width:68px;"></div>
            <div class="pfField">
              <label for="pfUseDailyFilter"><input id="pfUseDailyFilter" class="pfToggle" type="checkbox"${s.use_daily_trend_filter ? " checked" : ""}> 1d MA</label>
              <input id="pfDailyMaPeriod" type="number" min="2" max="200" step="1" value="${s.daily_ma_period}" style="width:64px;">
            </div>
            <div class="pfField" style="min-width:82px;">
              <span style="color:#64748b;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;">Hold Streaks</span>
              <label for="pfHoldSameDirection" style="height:30px;padding:0 8px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#0f172a;font-size:11px;font-weight:700;text-transform:none;letter-spacing:0;cursor:pointer;margin:0;"><input id="pfHoldSameDirection" class="pfToggle" type="checkbox"${s.hold_same_direction ? " checked" : ""}> Hold</label>
            </div>
            <div class="pfField">
              <label for="pfDirectionMode">Direction</label>
              <select id="pfDirectionMode" style="width:116px;">
                <option value="two_way"${s.entry_direction_mode === "two_way" ? " selected" : ""}>Two-Way (L+S)</option>
                <option value="long_only"${s.entry_direction_mode === "long_only" ? " selected" : ""}>Long Only</option>
                <option value="short_only"${s.entry_direction_mode === "short_only" ? " selected" : ""}>Short Only</option>
              </select>
            </div>
            <div class="pfField"><label for="pfNeutralBps">Class Band ±bp</label><input id="pfNeutralBps" type="number" min="0" max="500" step="1" value="${s.neutral_bps}" style="width:64px;"></div>
            <div class="pfField"><label for="pfMinExpectedBps"><input id="pfUseExpectedEdgeGate" class="pfToggle" type="checkbox"${s.use_expected_edge_gate ? " checked" : ""}> Min Edge bp</label><input id="pfMinExpectedBps" type="number" min="0" max="500" step="1" value="${s.min_expected_bps}" style="width:64px;"></div>
            <div class="pfField"><label for="pfLambda">Ridge λ</label><input id="pfLambda" type="number" min="0.0001" max="10000" step="10" value="${s.ridge_lambda}" style="width:68px;"></div>
            <div class="pfField"><label for="pfCostBps">Fee bp</label><input id="pfCostBps" type="number" min="0" max="500" step="1" value="${s.cost_bps}" style="width:56px;"></div>
            <div class="pfField">
              <label for="pfUseStopLoss"><input id="pfUseStopLoss" class="pfToggle" type="checkbox"${s.use_stop_loss ? " checked" : ""}> Stop %</label>
              <input id="pfStopLossPct" type="number" min="0.1" max="50" step="0.5" value="${s.stop_loss_pct}" style="width:58px;">
            </div>
            <div class="pfField"><label for="pfHorizon">Forecast Bars</label><input id="pfHorizon" type="number" min="1" max="12" step="1" value="${s.horizon_bars}" style="width:56px;"></div>
            <div class="pfField"><label for="pfMinHoldBars">Min Hold Bars</label><input id="pfMinHoldBars" type="number" min="1" max="24" step="1" value="${s.min_hold_bars}" style="width:56px;"></div>
          </div>
          <div style="display:flex;gap:12px;margin-top:7px;font-size:10px;color:#475569;flex-wrap:wrap;align-items:center;">
            <span><strong>Execution Safeguards (Always Active):</strong> Cross-bot collision lock · Account leverage cap ≤ 2.0x · Margin buffer ≥ 125% · Spread ≤ 15 bp · Completed candle freshness</span>
            <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="pfShowSignalsToggle" class="pfToggle" type="checkbox" checked> Show independent entry signal arrows</label>
          </div>
        </section>

        <div class="pfGrid">
          <section class="pfPanel collapsible-section" id="pfChartPanel">
            <div id="pfExecutionChartFrame"></div>
            <div id="pfChartStatus" class="pfStatusBar">Loading completed candles &amp; trades…</div>
          </section>

          <div style="display:flex;flex-direction:column;gap:var(--pf-gap);">
            <section class="pfPanel" aria-label="Live and Paper Strategy Conditions">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px;">
                <strong>Entry Conditions &amp; 1d Regime</strong>
                <span id="pfEvalStatusBadge" class="pfState off">WAITING</span>
              </div>
              <div class="pfCondRow">
                <div><strong>1. 1d MA Trend Filter</strong><div id="pfCondDailyDetail" style="color:#64748b;font-size:10px;">Awaiting completed 1d bar</div></div>
                <span id="pfCondDailyBadge" class="pfState off">WAITING</span>
              </div>
              <div class="pfCondRow">
                <div><strong>2. Min Confidence Gate</strong><div id="pfCondConfDetail" style="color:#64748b;font-size:10px;">Awaiting completed 4h bar</div></div>
                <span id="pfCondConfBadge" class="pfState off">WAITING</span>
              </div>
              <div class="pfCondRow">
                <div><strong>3. Expected Return Edge</strong><div id="pfCondEdgeDetail" style="color:#64748b;font-size:10px;">Optional |expected| minimum</div></div>
                <span id="pfCondEdgeBadge" class="pfState off">WAITING</span>
              </div>
              <div style="font-size:10px;font-weight:900;color:#475569;margin-top:8px;">EXIT CONDITIONS</div>
              <div class="pfCondRow">
                <div><strong>Minimum Hold + Signal Streak</strong><div id="pfCondHoldDetail" style="color:#64748b;font-size:10px;">Awaiting paper position</div></div>
                <span id="pfCondHoldBadge" class="pfState off">N/A</span>
              </div>
              <div class="pfCondRow">
                <div><strong>Intrabar Stop Loss</strong><div id="pfCondStopDetail" style="color:#64748b;font-size:10px;">Optional paper/live exit</div></div>
                <span id="pfCondStopBadge" class="pfState off">OFF</span>
              </div>
              <div style="font-size:10px;font-weight:900;color:#475569;margin-top:8px;">EXECUTION SAFEGUARDS</div>
              <div class="pfCondRow">
                <div><strong>Account + Order Safety</strong><div id="pfCondGuardDetail" style="color:#64748b;font-size:10px;">Collision · Margin · Spread</div></div>
                <span id="pfCondGuardBadge" class="pfState off">CHECKING</span>
              </div>
              <div id="pfEvalSource" class="pfStatusBar">Source: awaiting completed candle.</div>
            </section>

            <section class="pfPanel" aria-label="Causal Ridge Input Switches">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:2px;">
                <strong>Ridge Model Inputs</strong>
                <small style="color:#64748b;">Refits replay · Save updates bot</small>
              </div>
              ${this.featureRowsMarkup(s)}
            </section>
          </div>
        </div>

        <section class="pfPanel" style="margin-top:var(--pf-gap);" aria-label="Historical Trades">
          <div class="pfHeaderRow" style="margin-bottom:6px;">
            <div>
              <strong style="font-size:14px;color:#0f172a;">Historical Trades (Actual Fills &amp; Causal Replay)</strong>
              <small id="pfHistSubtitle" style="display:block;color:#64748b;margin-top:2px;">Click any row to highlight its paired trade rectangle on the chart · Hover chart markers for P&amp;L</small>
            </div>
            <div class="pfHistTabs" role="tablist" aria-label="Trade source filter">
              <button type="button" class="pfHistTab active" data-hist-filter="all">All Trades</button>
              <button type="button" class="pfHistTab" data-hist-filter="actual">Actual Exchange Fills</button>
              <button type="button" class="pfHistTab" data-hist-filter="virtual">Paper Replay</button>
            </div>
          </div>

          <div class="pfAcctGrid" style="margin-bottom:6px;">
            <div class="pfKpi"><span>Replay Trades</span><strong id="pfSumTrades">—</strong></div>
            <div class="pfKpi"><span>Win Rate</span><strong id="pfSumWin">—</strong></div>
            <div class="pfKpi"><span>Paper Net Return</span><strong id="pfSumReturn">—</strong></div>
            <div class="pfKpi"><span>Max Drawdown</span><strong id="pfSumMaxDD">—</strong></div>
            <div class="pfKpi"><span>Worst Single Trade</span><strong id="pfSumWorst">—</strong></div>
          </div>

          <div tabindex="0" role="region" aria-label="Historical Trades Table" class="pfTableWrap">
            <table class="pfTable">
              <thead>
                <tr>
                  <th>Time (KST)</th>
                  <th>Source / Event</th>
                  <th>Direction</th>
                  <th>Symbol / Size</th>
                  <th>Entry → Exit</th>
                  <th>Fee</th>
                  <th>Realized PnL</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="pfHistoryBody">
                <tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">Loading trade history…</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    featureRowsMarkup(settings) {
      const inpCss = "height:22px;padding:0 3px;text-align:center;";
      const rows = [
        ["momentum", "Momentum", `lb <input id="pfMomentumLookback" type="number" min="2" max="50" step="1" value="${settings.momentum_lookback}" style="width:48px;${inpCss}">`],
        ["macd", "MACD H", `<input id="pfMacdFast" type="number" min="2" max="100" value="${settings.macd_fast}" style="width:44px;${inpCss}">/<input id="pfMacdSlow" type="number" min="3" max="200" value="${settings.macd_slow}" style="width:44px;${inpCss}">/<input id="pfMacdSignal" type="number" min="2" max="100" value="${settings.macd_signal}" style="width:42px;${inpCss}">`],
        ["rsi", "RSI", `p <input id="pfRsiPeriod" type="number" min="2" max="100" value="${settings.rsi_period}" style="width:48px;${inpCss}">`],
        ["ma", "MA + Slope", `<input id="pfMaFast" type="number" min="2" max="200" value="${settings.ma_fast}" style="width:44px;${inpCss}">/<input id="pfMaSlow" type="number" min="3" max="400" value="${settings.ma_slow}" style="width:46px;${inpCss}">·<input id="pfMaSlope" type="number" min="1" max="50" value="${settings.ma_slope_lookback}" style="width:40px;${inpCss}">`],
        ["volatility", "ATR + Vol", `p <input id="pfAtrPeriod" type="number" min="2" max="100" value="${settings.atr_period}" style="width:48px;${inpCss}">`],
      ];
      return rows.map(([key, label, controls]) => `
        <div class="pfFeature" data-feature="${key}">
          <input class="pfToggle" id="pfUse_${key}" type="checkbox"${settings[`use_${key}`] ? " checked" : ""} aria-label="Use ${label}">
          <div><strong>${label}</strong><div style="color:#64748b;margin-top:2px;">${controls}</div></div>
          <div><span id="pfState_${key}" class="pfState${settings[`use_${key}`] ? "" : " off"}">${settings[`use_${key}`] ? "ACTIVE" : "OFF"}</span></div>
        </div>
      `).join("");
    }

    initChart() {
      const frameHost = document.getElementById("pfExecutionChartFrame");
      if (!frameHost || !globalThis.LightweightCharts) return;
      const FrameClass = globalThis.StrategyExecutionChartFrame;
      if (FrameClass) {
        this.executionChartFrame = FrameClass.mount({
          container: frameHost,
          id: "pfChartCard",
          title: "4H CANDLES + COMPLETED 1D TREND + PAIRED ACTUAL & PAPER TRADES",
          showAssetPane: false,
          height: 450,
          ids: {
            action: "pfBtnRerunPaper",
            actual: "pfShowActual",
            virtual: "pfShowPaper",
            status: "pfFrameStatus",
            secondaryStatus: "pfDailyFilterOverlayBadge",
            host: "pfChartHost",
            legend: "pfChartLegend",
            sync: "pfChartSync",
          },
          action: { label: "↻ Rerun Paper", onClick: () => this.refreshReplay({ force: true }) },
          actual: { visible: true, label: "Actual (net)", onToggle: () => { this.showActualMarkers = !this.showActualMarkers; this.syncChartMarkerVisibility(); } },
          virtual: { visible: true, label: "Paper", onToggle: () => { this.showVirtualMarkers = !this.showVirtualMarkers; this.syncChartMarkerVisibility(); } },
          grouping: { asRange: this.groupTradesAsRange, onChange: (asRange) => { this.groupTradesAsRange = asRange; this.renderOverlayMarkers(); } },
          status: "Loading completed candles & paired trades…",
          legendPosition: "top",
          legend: `<span style="color:#0284c7">— MA${this.settings.ma_fast}</span><span style="color:#7c3aed">— MA${this.settings.ma_slow}</span><span style="color:#d97706">┈ 1d MA${this.settings.daily_ma_period} Trend</span><span><strong style="color:#16a34a">▶</strong> Long / Cover</span><span><strong style="color:#dc2626">▶</strong> Short / Sell</span><span style="background:linear-gradient(90deg,rgba(220,38,38,.18),rgba(22,163,74,.18));padding:1px 6px;border-radius:4px;">Shading: 1d MA${this.settings.daily_ma_period} Regime</span>`,
        });
      } else {
        frameHost.innerHTML = `<div id="pfChartHost" style="height:450px;width:100%;position:relative;"></div>`;
      }

      const host = document.getElementById("pfChartHost");
      if (!host) return;
      this.chart = globalThis.LightweightCharts.createChart(host, {
        width: Math.max(320, host.clientWidth),
        height: 450,
        layout: { background: { color: "#ffffff" }, textColor: "#475569", fontSize: 11 },
        localization: { locale: "ko-KR", timeFormatter: (time) => formatKst(time) },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        rightPriceScale: { borderColor: "#e2e8f0", scaleMargins: { top: 0.08, bottom: 0.12 } },
        timeScale: { borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t, type) => formatKstTick(t, type) },
        crosshair: { mode: globalThis.LightweightCharts.CrosshairMode?.Normal ?? 0 },
      });

      const ControllerClass = globalThis.StrategyExecutionChartController;
      if (ControllerClass) {
        ControllerClass.compactCrosshairMarkers(this.chart);
        ControllerClass.configureStandardTimeScale(this.chart, { rightOffset: 5 });
      }

      this.candleSeries = this.chart.addCandlestickSeries({
        upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
        wickUpColor: "#16a34a", wickDownColor: "#dc2626", priceLineVisible: true,
      });
      this.maFastSeries = this.chart.addLineSeries({ color: "#0284c7", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
      this.maSlowSeries = this.chart.addLineSeries({ color: "#7c3aed", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
      this.dailyMaSeriesPlot = this.chart.addLineSeries({ color: "#d97706", lineWidth: 2, lineStyle: globalThis.LightweightCharts.LineStyle?.Dashed ?? 2, priceLineVisible: false, lastValueVisible: true });

      if (ControllerClass) {
        this.executionChartController = new ControllerClass({ series: this.candleSeries, lineStyle: globalThis.LightweightCharts.LineStyle });
      }

      host.style.position = "relative";
      this.ensureOverlayLayers(host);

      this.chart.subscribeClick(() => {
        this.selectedExecutionMarkerKey = null;
        this.selectedPairKey = null;
        this.updateHoverPopup(null);
        this.renderTradeTriangles();
      });
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (this._rangeChangeRaf) return;
        this._rangeChangeRaf = requestAnimationFrame(() => {
          this._rangeChangeRaf = null;
          this.renderTrendBands();
          this.renderOverlayMarkers();
        });
      });
      if (ControllerClass?.watchPriceScale) {
        this.stopPriceScaleWatch = ControllerClass.watchPriceScale({
          series: this.candleSeries,
          host,
          samplePrice: () => this.bars?.at(-1)?.close,
          onChange: () => {
            this.renderTrendBands();
            this.renderOverlayMarkers();
          },
        });
      }
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(host);
      }
    }

    ensureOverlayLayers(host) {
      if (!document.getElementById("pfTrendBandLayer")) {
        const bands = document.createElement("div");
        bands.id = "pfTrendBandLayer";
        bands.style.cssText = "position:absolute;z-index:2;inset:0 0 26px 0;overflow:hidden;pointer-events:none;";
        host.appendChild(bands);
      }
      if (!document.getElementById("pfTradeTrianglesLayer")) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "pfTradeTrianglesLayer";
        svg.setAttribute("aria-label", "Paired entry and exit profit triangles");
        svg.style.cssText = "position:absolute;inset:0 0 26px 0;width:100%;height:calc(100% - 26px);z-index:6;pointer-events:none;overflow:hidden;";
        host.appendChild(svg);
      }
      if (!document.getElementById("pfTradeMarkerTargets")) {
        const layer = document.createElement("div");
        layer.id = "pfTradeMarkerTargets";
        layer.setAttribute("aria-label", "Interactive paired trade markers");
        layer.style.cssText = "position:absolute;inset:0 0 26px 0;z-index:7;pointer-events:none;overflow:hidden;";
        host.appendChild(layer);
      }
      if (!document.getElementById("pfTradeMarkerHover")) {
        const hover = document.createElement("div");
        hover.id = "pfTradeMarkerHover";
        hover.setAttribute("role", "status");
        hover.style.cssText = "display:none;position:absolute;z-index:9;top:8px;left:12px;max-width:min(440px,calc(100% - 24px));padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1;background:rgba(255,255,255,0.97);box-shadow:0 2px 8px rgba(15,23,42,.12);font-size:11px;font-weight:800;color:#0f172a;pointer-events:none;";
        host.appendChild(hover);
      }
    }

    syncChartMarkerVisibility() {
      this.executionChartFrame?.setVisibility("actual", this.showActualMarkers);
      this.executionChartFrame?.setVisibility("virtual", this.showVirtualMarkers);
      this.renderOverlayMarkers();
    }

    bindControls() {
      const replayIds = [
        "pfConfidence", "pfUseConfidenceGate", "pfUseDailyFilter", "pfDailyMaPeriod", "pfHoldSameDirection",
        "pfDirectionMode", "pfNeutralBps", "pfUseExpectedEdgeGate", "pfMinExpectedBps", "pfLambda", "pfCostBps", "pfUseStopLoss",
        "pfStopLossPct", "pfHorizon", "pfMinHoldBars", "pfNotional", "pfLeverage",
        "pfMomentumLookback", "pfMacdFast", "pfMacdSlow", "pfMacdSignal", "pfRsiPeriod", "pfMaFast", "pfMaSlow", "pfMaSlope", "pfAtrPeriod",
      ];
      replayIds.forEach((id) => document.getElementById(id)?.addEventListener("change", () => this.onSettingsEdited()));
      FEATURE_GROUPS.forEach((group) => document.getElementById(`pfUse_${group}`)?.addEventListener("change", () => this.onSettingsEdited()));
      document.getElementById("pfVenue")?.addEventListener("change", () => this.onVenueOrSymbolChanged());
      document.getElementById("pfSymbol")?.addEventListener("change", () => this.onVenueOrSymbolChanged());
      document.getElementById("pfInterval")?.addEventListener("change", () => this.onIntervalChanged());
      document.getElementById("pfShowSignalsToggle")?.addEventListener("change", (e) => {
        this.showSignalArrows = Boolean(e.target.checked);
        this.renderNativeSignalArrows();
      });
      document.getElementById("pfRefresh")?.addEventListener("click", () => this.refreshAll({ fit: false, force: true }));
      document.getElementById("pfBtnValidatedPreset")?.addEventListener("click", () => this.applyValidatedEthPreset());
      document.getElementById("pfBtnUnlock")?.addEventListener("click", () => window.terminalLockManager?.openPasswordModal?.());
      document.getElementById("pfBtnSaveConfig")?.addEventListener("click", () => this.saveConfigToBot());
      document.getElementById("pfBtnToggleLive")?.addEventListener("click", () => this.toggleLiveBot());
      document.getElementById("pfBtnReconcile")?.addEventListener("click", () => this.reconcileBot());
      document.getElementById("pfBtnFlatten")?.addEventListener("click", () => this.flattenBot());
      document.querySelectorAll("#tabContentPriceForecast .pfHistTab").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.historyFilter = btn.getAttribute("data-hist-filter") || "all";
          document.querySelectorAll("#tabContentPriceForecast .pfHistTab").forEach((b) => b.classList.toggle("active", b === btn));
          this.renderHistoryTable();
        });
      });
    }

    readControls() {
      const val = (id, fb) => document.getElementById(id)?.value ?? fb;
      const chk = (id, fb) => document.getElementById(id)?.checked ?? fb;
      return normalizeSettings({
        ...this.settings,
        venue: val("pfVenue", this.settings.venue),
        symbol: val("pfSymbol", this.settings.symbol),
        interval: val("pfInterval", this.settings.interval),
        notional_usd: val("pfNotional", this.settings.notional_usd),
        leverage: val("pfLeverage", this.settings.leverage),
        use_confidence_gate: chk("pfUseConfidenceGate", this.settings.use_confidence_gate),
        confidence_pct: val("pfConfidence", this.settings.confidence_pct),
        use_daily_trend_filter: chk("pfUseDailyFilter", this.settings.use_daily_trend_filter),
        daily_ma_period: val("pfDailyMaPeriod", this.settings.daily_ma_period),
        hold_same_direction: chk("pfHoldSameDirection", this.settings.hold_same_direction),
        entry_direction_mode: val("pfDirectionMode", this.settings.entry_direction_mode),
        neutral_bps: val("pfNeutralBps", this.settings.neutral_bps),
        use_expected_edge_gate: chk("pfUseExpectedEdgeGate", this.settings.use_expected_edge_gate),
        min_expected_bps: val("pfMinExpectedBps", this.settings.min_expected_bps),
        ridge_lambda: val("pfLambda", this.settings.ridge_lambda),
        cost_bps: val("pfCostBps", this.settings.cost_bps),
        use_stop_loss: chk("pfUseStopLoss", this.settings.use_stop_loss),
        stop_loss_pct: val("pfStopLossPct", this.settings.stop_loss_pct),
        horizon_bars: val("pfHorizon", this.settings.horizon_bars),
        min_hold_bars: val("pfMinHoldBars", this.settings.min_hold_bars),
        momentum_lookback: val("pfMomentumLookback", this.settings.momentum_lookback),
        macd_fast: val("pfMacdFast", this.settings.macd_fast),
        macd_slow: val("pfMacdSlow", this.settings.macd_slow),
        macd_signal: val("pfMacdSignal", this.settings.macd_signal),
        rsi_period: val("pfRsiPeriod", this.settings.rsi_period),
        ma_fast: val("pfMaFast", this.settings.ma_fast),
        ma_slow: val("pfMaSlow", this.settings.ma_slow),
        ma_slope_lookback: val("pfMaSlope", this.settings.ma_slope_lookback),
        atr_period: val("pfAtrPeriod", this.settings.atr_period),
        ...Object.fromEntries(FEATURE_GROUPS.map((g) => [`use_${g}`, chk(`pfUse_${g}`, this.settings[`use_${g}`])])),
      });
    }

    applyValidatedEthPreset() {
      const preset = normalizeSettings({
        ...this.readControls(),
        venue: "binance_futures",
        symbol: "ETHUSDT",
        interval: "4h",
        horizon_bars: 1,
        min_hold_bars: 3,
        use_confidence_gate: true,
        confidence_pct: 52,
        use_expected_edge_gate: false,
        use_daily_trend_filter: true,
        daily_ma_period: 100,
        hold_same_direction: true,
        entry_direction_mode: "long_only",
        use_stop_loss: false,
        cost_bps: 10,
        leverage: 1,
      });
      const values = {
        pfVenue: preset.venue, pfSymbol: preset.symbol, pfInterval: preset.interval,
        pfHorizon: preset.horizon_bars, pfMinHoldBars: preset.min_hold_bars,
        pfConfidence: preset.confidence_pct, pfDailyMaPeriod: preset.daily_ma_period,
        pfDirectionMode: preset.entry_direction_mode, pfCostBps: preset.cost_bps,
        pfLeverage: preset.leverage,
      };
      Object.entries(values).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = String(value);
      });
      const checks = {
        pfUseConfidenceGate: true, pfUseExpectedEdgeGate: false,
        pfUseDailyFilter: true, pfHoldSameDirection: true, pfUseStopLoss: false,
      };
      Object.entries(checks).forEach(([id, checked]) => {
        const el = document.getElementById(id);
        if (el) el.checked = checked;
      });
      this.settings = preset;
      this.saveSettings();
      window.showToast?.("ETH preset loaded for paper replay. Unlock and Save Strategy to change the paused live bot.", "success");
      this.onVenueOrSymbolChanged();
    }

    syncFeatureBadges() {
      FEATURE_GROUPS.forEach((group) => {
        const badge = document.getElementById(`pfState_${group}`);
        if (!badge) return;
        const on = Boolean(this.settings[`use_${group}`]);
        badge.textContent = on ? "ACTIVE" : "OFF";
        badge.className = `pfState${on ? "" : " off"}`;
      });
    }

    onVenueOrSymbolChanged() {
      const prevVenue = this.settings.venue;
      const next = this.readControls();
      if (next.venue !== prevVenue) {
        next.cost_bps = next.venue === "lighter" ? 0 : 10;
        const costInput = document.getElementById("pfCostBps");
        if (costInput) costInput.value = String(next.cost_bps);
      }
      this.settings = next;
      this.saveSettings();
      this.loadedMarket = null;
      this.refreshAll({ fit: true, force: true });
    }

    async onIntervalChanged() {
      const next = this.readControls();
      this.settings = next;
      this.saveSettings();
      this.loadedMarket = null;
      this.setStatus(`Loading ${next.symbol} · ${next.interval} completed candles…`);
      await this.refreshChart({ fit: true });
      if (this.loadedMarket?.venue === next.venue && this.loadedMarket?.symbol === next.symbol && this.loadedMarket?.interval === next.interval && this.bars.length) {
        await this.refreshReplay({ force: true });
      }
      window.updateMainTabLoading?.("priceforecast");
    }

    onSettingsEdited() {
      this.settings = this.readControls();
      this.saveSettings();
      this.syncFeatureBadges();
      if (this.bars.length) {
        if (this.dailyBars.length) {
          this.dailyMaSeries = buildDailyMaSeries(this.bars, this.dailyBars.filter((b) => b && b.completed !== false), this.settings.daily_ma_period);
        }
        this.renderCandlesAndMAs(false);
      }
      this.refreshReplay({ force: true });
    }

    async refreshAll(options = {}) {
      if (!this.mounted) return;
      this.settings = this.readControls();
      this.saveSettings();
      this.syncFeatureBadges();
      const seq = ++this.requestSequence;
      this.loading = true;
      this.setStatus("Refreshing account telemetry & completed candles…");
      try {
        await Promise.all([
          this.refreshStatus(),
          this.refreshChart({ fit: options.fit !== false }),
        ]);
        if (seq !== this.requestSequence) return;
        const m = this.loadedMarket;
        const s = this.settings;
        if (m && m.venue === s.venue && m.symbol === s.symbol && m.interval === s.interval && this.bars.length) {
          await this.refreshReplay({ force: options.force });
        } else if (this.errors.chart) {
          this.errors.replay = this.errors.chart;
          this.executionChartFrame?.setStatus?.(`Waiting for candles: ${this.errors.chart}`);
        }
        if (seq !== this.requestSequence) return;
        this.lastLoadedAt = Date.now();
        this.loaded = Boolean(this.bars.length);
        window.updateMainTabLoading?.("priceforecast");
      } finally {
        if (seq === this.requestSequence) this.loading = false;
      }
    }

    async refreshStatus() {
      try {
        const data = await apiGet("/api/forecast-trader/status");
        this.statusPayload = data;
        this.botState = data.bot || null;
        this.errors.status = data.success ? null : (data.error || "Status unavailable");
        this.renderStatusAndAccount();
        window.updateMainTabLoading?.("priceforecast");
      } catch (err) {
        this.errors.status = err.message;
        this.renderStatusError(err.message);
        window.updateMainTabLoading?.("priceforecast");
      }
    }

    async refreshChart(options = {}) {
      const s = this.settings;
      const chartSeq = (this._chartSeq = (this._chartSeq || 0) + 1);
      const q = new URLSearchParams({
        venue: s.venue,
        symbol: s.symbol,
        interval: s.interval,
        limit: "1350",
        include_daily: "true",
        daily_ma_period: String(s.daily_ma_period),
      });
      try {
        let data = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            data = await apiGet(`/api/forecast-trader/candles?${q.toString()}`);
            if (chartSeq !== this._chartSeq) return;
            if (!data.success || !Array.isArray(data.bars) || !data.bars.length) {
              throw new Error(data.error || "No candles returned");
            }
            lastErr = null;
            break;
          } catch (err) {
            if (chartSeq !== this._chartSeq) return;
            lastErr = err;
            if (attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              if (chartSeq !== this._chartSeq) return;
            }
          }
        }
        if (lastErr) throw lastErr;
        this.errors.chart = null;
        this.bars = data.bars;
        this.dailyBars = Array.isArray(data.daily_bars) ? data.daily_bars : [];
        this.dailyMaSeries = this.dailyBars.length
          ? buildDailyMaSeries(this.bars, this.dailyBars.filter((b) => b && b.completed !== false), s.daily_ma_period)
          : (data.daily_ma_series || []);
        this.actualMarkers = (data.markers || []).map((m, i) => ({
          ...m,
          markerKey: `actual:${m.pairKey}:${m.is_entry ? "E" : "X"}:${m.time}:${i}`,
        }));
        this.loadedMarket = { venue: s.venue, symbol: s.symbol, interval: s.interval };
        this.renderCandlesAndMAs(options.fit !== false);
        this.rebuildCombinedMarkers();
        const completedCount = this.bars.filter((b) => b.completed !== false).length;
        const latestCompleted = [...this.bars].reverse().find((b) => b.completed !== false) || this.bars.at(-1);
        const lastBar = this.bars.at(-1);
        const formingNote = lastBar && lastBar.completed === false ? ` · forming bar closes ${formatKst(lastBar.close_time)}` : "";
        this.setStatus(`${s.symbol} · ${s.interval} · ${completedCount} completed bars · latest completed close ${formatKst(latestCompleted?.close_time)}${formingNote}`);
        window.updateMainTabLoading?.("priceforecast");
      } catch (err) {
        if (chartSeq !== this._chartSeq) return;
        this.errors.chart = err.message;
        this.setStatus(`Chart unavailable: ${err.message}`, true);
        window.updateMainTabLoading?.("priceforecast");
      }
    }

    async refreshReplay() {
      const s = this.settings;
      const seq = ++this.replaySequence;
      this.executionChartFrame?.setStatus?.(`Running causal ${s.interval} + 1d MA${s.daily_ma_period} replay…`);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (seq !== this.replaySequence) return;
        if (!this.bars.length || this.loadedMarket?.interval !== s.interval || this.loadedMarket?.symbol !== s.symbol) {
          throw new Error(this.errors.chart || "No completed candles available for replay");
        }
        const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        const data = runCausalReplayWithDaily(this.bars, this.dailyBars, s, {
          notional_usd: s.notional_usd,
          leverage: s.leverage,
          max_eval_bars: 360,
          initial_equity_usd: s.notional_usd,
        });
        const elapsedMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
        if (seq !== this.replaySequence) return;
        if (data.error) throw new Error(data.error);
        this.errors.replay = null;
        this.replayPayload = data;
        this.renderConditions();
        this.renderReplaySummary();
        this.renderNativeSignalArrows();
        this.renderTrendBands();
        this.rebuildCombinedMarkers();
        this.renderHistoryTable();
        const sum = data.summary || {};
        this.executionChartFrame?.setStatus?.(`PAPER REPLAY (${s.cost_bps}bp fee basis) · ${sum.trades ?? 0} trades · ${sum.eval_bars ?? 0} completed ${s.interval} bars (${elapsedMs}ms) · latest source ${formatKst(data.latest_condition_time)}`);
        this.executionChartFrame?.setSecondaryStatus?.(s.use_daily_trend_filter ? `1d MA${s.daily_ma_period} Filter ACTIVE` : "1d MA Filter OFF");
        window.updateMainTabLoading?.("priceforecast");
      } catch (err) {
        if (seq !== this.replaySequence) return;
        this.errors.replay = err.message;
        this.executionChartFrame?.setStatus?.(`Replay unavailable: ${err.message}`);
        window.updateMainTabLoading?.("priceforecast");
      }
    }

    renderStatusError(msg) {
      const badge = document.getElementById("pfLiveBadge");
      if (badge) { badge.textContent = "TELEMETRY ERROR"; badge.className = "pfState err"; }
      const banner = document.getElementById("pfAlertBanner");
      if (banner) {
        banner.style.display = "block";
        banner.className = "pfErrorBox";
        banner.textContent = `Account/Bot telemetry unavailable: ${msg}`;
      }
      document.getElementById("pfAcctEquity").textContent = "—";
      document.getElementById("pfAcctMargin").textContent = "—";
      document.getElementById("pfAcctSource").textContent = "UNAVAILABLE";
    }

    renderStatusAndAccount() {
      const data = this.statusPayload;
      const bot = data?.bot;
      const acct = data?.account;
      if (!data || !bot) return;

      const isEnabled = Boolean(bot.enabled);
      const blocked = Boolean(bot.execution_blocked || bot.recovery_required);
      const badge = document.getElementById("pfLiveBadge");
      if (badge) {
        badge.textContent = blocked ? "BLOCKED / RECONCILE" : isEnabled ? "LIVE · ARMED" : "PAUSED · PAPER ONLY";
        badge.className = `pfState ${blocked ? "err" : isEnabled ? "" : "off"}`;
      }
      const navPill = document.getElementById("navPillForecastTrader");
      if (navPill) {
        navPill.textContent = isEnabled ? "LIVE" : "4H";
        navPill.style.background = isEnabled ? "#16a34a" : "#0891b2";
      }
      const toggleBtn = document.getElementById("pfBtnToggleLive");
      if (toggleBtn) {
        toggleBtn.textContent = isEnabled ? "⏸ Pause Live Bot" : "▶ Start Live Bot";
        toggleBtn.className = `pfBtn ${isEnabled ? "pause" : "arm"} terminal-action-control`;
      }
      const venuePill = document.getElementById("pfVenuePill");
      if (venuePill) venuePill.textContent = `${acct?.venue_label || bot.venue} · ${bot.selected_symbol}`;

      const banner = document.getElementById("pfAlertBanner");
      const warnText = data.conflict_message || bot.blocked_reason || (!acct?.authenticated && acct?.error) || bot.last_error;
      if (banner) {
        if (warnText) {
          banner.style.display = "block";
          banner.className = (data.conflict_message || blocked) ? "pfErrorBox" : "pfWarnBox";
          banner.textContent = warnText;
        } else {
          banner.style.display = "none";
        }
      }

      const eqEl = document.getElementById("pfAcctEquity");
      const marEl = document.getElementById("pfAcctMargin");
      const srcEl = document.getElementById("pfAcctSource");
      const expEl = document.getElementById("pfAcctExposure");
      const cur = acct?.currency || "USDT";
      if (acct?.authenticated && finite(acct.equity)) {
        eqEl.textContent = `$${Number(acct.equity).toFixed(2)} ${cur}`;
        marEl.textContent = finite(acct.available_margin) ? `$${Number(acct.available_margin).toFixed(2)} ${cur}` : "—";
        const ageSec = acct.updated_ms ? Math.max(0, Math.round((Date.now() - Number(acct.updated_ms)) / 1000)) : null;
        srcEl.textContent = `${acct.source}${acct.stale ? " (refreshing)" : ""}${ageSec !== null ? ` · ${ageSec}s ago` : ""}`;
        const otherCnt = (acct.other_positions || []).length;
        expEl.textContent = `Account gross $${Number(acct.account_gross_notional || 0).toFixed(2)}${otherCnt ? ` · +${otherCnt} other bot pos` : ""}`;
      } else {
        eqEl.textContent = "—";
        marEl.textContent = "—";
        srcEl.textContent = acct?.error || "UNAVAILABLE";
        expEl.textContent = "Do not rely on cached zero";
      }

      const selPos = acct?.positions || [];
      const openPosEl = document.getElementById("pfOpenPos");
      const openPosSub = document.getElementById("pfOpenPosSub");
      const uPnlEl = document.getElementById("pfUnrealizedPnl");
      if (selPos.length) {
        const p = selPos[0];
        const qty = Number(p.size ?? p.position_amt ?? 0);
        const side = p.side || (qty > 0 ? "LONG" : "SHORT");
        openPosEl.textContent = `${side} ${Math.abs(qty).toFixed(4)} ${bot.selected_symbol}`;
        openPosEl.style.color = side === "LONG" ? "#16a34a" : "#dc2626";
        openPosSub.textContent = `Entry ${formatPrice(p.entry_price, bot.selected_symbol)} · $${Number(p.notional || 0).toFixed(2)}`;
        const upnl = Number(acct.unrealized_pnl || 0);
        uPnlEl.textContent = `${upnl >= 0 ? "+" : "-"}$${Math.abs(upnl).toFixed(2)}`;
        uPnlEl.style.color = upnl > 0 ? "#16a34a" : upnl < 0 ? "#dc2626" : "#0f172a";
      } else {
        openPosEl.textContent = "0 Open (Flat)";
        openPosEl.style.color = "#0f172a";
        openPosSub.textContent = `Live size target: $${Number(bot.effective_order_usd || 200).toFixed(0)} (${bot.strategy_interval})`;
        uPnlEl.textContent = "$0.00";
        uPnlEl.style.color = "#0f172a";
      }
      document.getElementById("pfLastBotAction").textContent = bot.last_action || "Awaiting next completed candle";

      const vCount = Number(bot.verified_exit_count || 0);
      const vPnl = Number(bot.verified_realized_pnl_usd || 0);
      const rEl = document.getElementById("pfRealizedPnl");
      rEl.textContent = vCount ? `${vPnl >= 0 ? "+" : "-"}$${Math.abs(vPnl).toFixed(2)}` : "$0.00";
      rEl.style.color = vPnl > 0 ? "#16a34a" : vPnl < 0 ? "#dc2626" : "#0f172a";
      document.getElementById("pfRealizedCount").textContent = `${vCount} verified exchange exits`;

      // Guard against stale or conflicting safeguard badge
      const guardBadge = document.getElementById("pfCondGuardBadge");
      const guardDetail = document.getElementById("pfCondGuardDetail");
      if (guardBadge && guardDetail) {
        if (data.conflict_message || blocked) {
          guardBadge.textContent = "BLOCKED";
          guardBadge.className = "pfState err";
          guardDetail.textContent = data.conflict_message || bot.blocked_reason || "Blocked";
        } else if (!acct?.authenticated) {
          guardBadge.textContent = "UNAVAILABLE";
          guardBadge.className = "pfState wait";
          guardDetail.textContent = acct?.error || "Telemetry unavailable";
        } else {
          guardBadge.textContent = "PASS";
          guardBadge.className = "pfState";
          guardDetail.textContent = `OK · Leverage ≤ ${bot.gross_leverage_cap}x · Free margin sufficient`;
        }
      }
      this.renderHistoryTable();
      this.renderConditions();
      this.applyExecutionLock();
    }

    renderConditions() {
      const ev = this.replayPayload?.latest_evaluation || this.botState?.last_evaluation;
      if (!ev) return;
      const overallBadge = document.getElementById("pfEvalStatusBadge");
      const dailyBadge = document.getElementById("pfCondDailyBadge");
      const dailyDetail = document.getElementById("pfCondDailyDetail");
      const confBadge = document.getElementById("pfCondConfBadge");
      const confDetail = document.getElementById("pfCondConfDetail");
      const edgeBadge = document.getElementById("pfCondEdgeBadge");
      const edgeDetail = document.getElementById("pfCondEdgeDetail");
      const holdBadge = document.getElementById("pfCondHoldBadge");
      const holdDetail = document.getElementById("pfCondHoldDetail");
      const stopBadge = document.getElementById("pfCondStopBadge");
      const stopDetail = document.getElementById("pfCondStopDetail");
      const evalSource = document.getElementById("pfEvalSource");

      const dirLabel = ev.direction ? String(ev.direction).toUpperCase() : "NEUTRAL";
      if (overallBadge) {
        overallBadge.textContent = ev.entry_allowed ? `${dirLabel} · READY` : `${dirLabel} · WAITING`;
        overallBadge.className = `pfState ${ev.entry_allowed ? "" : "wait"}`;
      }
      if (!ev.use_daily_trend_filter) {
        dailyBadge.textContent = "OFF";
        dailyBadge.className = "pfState off";
        dailyDetail.textContent = "1d MA filter disabled (allows both directions)";
      } else if (!ev.daily_ready) {
        dailyBadge.textContent = "UNAVAILABLE";
        dailyBadge.className = "pfState err";
        dailyDetail.textContent = "Completed 1d MA unavailable";
      } else {
        const allowTxt = ev.daily_trend > 0 ? "LONG ONLY" : ev.daily_trend < 0 ? "SHORT ONLY" : "NEUTRAL";
        dailyBadge.textContent = ev.side_allowed_by_daily ? `PASS (${allowTxt})` : `WAITING (${allowTxt})`;
        dailyBadge.className = `pfState ${ev.side_allowed_by_daily ? "" : "wait"}`;
        dailyDetail.textContent = `1d Close ${formatPrice(ev.daily_close, ev.symbol)} vs MA${ev.daily_ma_period} ${formatPrice(ev.daily_ma, ev.symbol)} (${formatKst(ev.daily_close_time)})`;
      }

      const confidenceGateOn = ev.use_confidence_gate !== undefined ? Boolean(ev.use_confidence_gate) : Boolean(this.settings.use_confidence_gate);
      if (!confidenceGateOn) {
        confBadge.textContent = "OFF";
        confBadge.className = "pfState off";
        confDetail.textContent = `Observed ${dirLabel} confidence ${Number(ev.confidence_pct).toFixed(1)}%`;
      } else {
        confBadge.textContent = ev.confidence_pass ? `PASS (${Number(ev.confidence_pct).toFixed(1)}%)` : `WAITING (${Number(ev.confidence_pct).toFixed(1)}%)`;
        confBadge.className = `pfState ${ev.confidence_pass ? "" : "wait"}`;
        confDetail.textContent = `${dirLabel} conf ${Number(ev.confidence_pct).toFixed(1)}% vs min ${Number(ev.min_confidence_pct).toFixed(0)}%`;
      }

      const expectedEdgeGateOn = ev.use_expected_edge_gate !== undefined ? Boolean(ev.use_expected_edge_gate) : Boolean(this.settings.use_expected_edge_gate);
      if (!expectedEdgeGateOn) {
        edgeBadge.textContent = "OFF";
        edgeBadge.className = "pfState off";
        edgeDetail.textContent = `Expected ${Number(ev.expected_bps) >= 0 ? "+" : ""}${Number(ev.expected_bps).toFixed(1)} bp · informational`;
      } else {
        edgeBadge.textContent = ev.edge_pass ? `PASS (${Number(ev.expected_bps) >= 0 ? "+" : ""}${Number(ev.expected_bps).toFixed(1)} bp)` : `WAITING (${Number(ev.expected_bps).toFixed(1)} bp)`;
        edgeBadge.className = `pfState ${ev.edge_pass ? "" : "wait"}`;
        edgeDetail.textContent = `|Expected| ${Math.abs(Number(ev.expected_bps)).toFixed(1)} bp vs min ${Number(ev.min_expected_bps).toFixed(1)} bp`;
      }

      const paperPos = this.replayPayload?.open_position;
      if (holdBadge && holdDetail) {
        if (!paperPos) {
          holdBadge.textContent = "N/A";
          holdBadge.className = "pfState off";
          holdDetail.textContent = `No paper position · minimum ${Number(ev.min_hold_bars || this.settings.min_hold_bars)} bars · streak hold ${ev.hold_same_direction ? "ON" : "OFF"}`;
        } else {
          const latestIdx = this.bars.length - 1;
          const held = Math.max(0, latestIdx - Number(paperPos.entry_index) + 1);
          const ready = held >= Number(ev.min_hold_bars || this.settings.min_hold_bars);
          holdBadge.textContent = ready ? `PASS (${held} bars)` : `WAITING (${held} bars)`;
          holdBadge.className = `pfState ${ready ? "" : "wait"}`;
          holdDetail.textContent = `Exit eligible after ${Number(ev.min_hold_bars || this.settings.min_hold_bars)} completed bars · matching signal extends: ${ev.hold_same_direction ? "ON" : "OFF"}`;
        }
      }
      if (stopBadge && stopDetail) {
        if (!this.settings.use_stop_loss) {
          stopBadge.textContent = "OFF";
          stopBadge.className = "pfState off";
          stopDetail.textContent = "Optional intrabar stop disabled";
        } else if (!paperPos) {
          stopBadge.textContent = "N/A";
          stopBadge.className = "pfState off";
          stopDetail.textContent = `No paper position · threshold ${Number(this.settings.stop_loss_pct).toFixed(1)}%`;
        } else {
          const side = Number(paperPos.side);
          const ret = side * (Number(ev.close) / Number(paperPos.entry_price) - 1) * 100;
          const hit = ret <= -Number(this.settings.stop_loss_pct);
          stopBadge.textContent = hit ? "PASS (EXIT)" : "WAITING";
          stopBadge.className = `pfState ${hit ? "" : "wait"}`;
          stopDetail.textContent = `Completed-close move ${ret.toFixed(2)}% vs -${Number(this.settings.stop_loss_pct).toFixed(1)}% · replay also checks bar high/low`;
        }
      }

      if (evalSource) {
        evalSource.textContent = `Source: ${ev.venue === "lighter" ? "Lighter" : "Binance Futures"} completed ${ev.interval} bar closed ${formatKst(ev.close_time)} · ${ev.train_samples} samples`;
      }
    }

    renderCandlesAndMAs(fit) {
      if (!this.candleSeries || !this.bars.length) return;
      this.candleSeries.setData(this.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
      const s = this.settings;
      const legend = document.getElementById("pfChartLegend");
      if (legend) {
        legend.innerHTML = `<span style="color:#0284c7">— MA${s.ma_fast}</span><span style="color:#7c3aed">— MA${s.ma_slow}</span><span style="color:#d97706">┈ 1d MA${s.daily_ma_period} Trend</span><span><strong style="color:#16a34a">▶</strong> Long / Cover</span><span><strong style="color:#dc2626">▶</strong> Short / Sell</span><span style="background:linear-gradient(90deg,rgba(220,38,38,.18),rgba(22,163,74,.18));padding:1px 6px;border-radius:4px;">Shading: 1d MA${s.daily_ma_period} Regime</span>`;
      }
      const maFast = simpleMovingAverage(this.bars.map((b) => b.close), s.ma_fast);
      const maSlow = simpleMovingAverage(this.bars.map((b) => b.close), s.ma_slow);
      this.maFastSeries?.setData(this.bars.map((b, i) => finite(maFast[i]) ? { time: b.time, value: maFast[i] } : null).filter(Boolean));
      this.maSlowSeries?.setData(this.bars.map((b, i) => finite(maSlow[i]) ? { time: b.time, value: maSlow[i] } : null).filter(Boolean));
      if (this.dailyMaSeriesPlot) {
        const dData = s.use_daily_trend_filter ? this.dailyMaSeries : [];
        this.dailyMaSeriesPlot.setData(dData);
      }
      if (fit) {
        const host = document.getElementById("pfChartHost");
        if (host && host.clientWidth > 0 && host.clientHeight > 0) {
          const range = globalThis.StrategyExecutionChartController?.initialRange?.(this.bars.length, 96);
          if (range) this.chart?.timeScale()?.setVisibleLogicalRange?.(range);
          else this.chart?.timeScale()?.fitContent?.();
          this.pendingFit = false;
        } else {
          this.pendingFit = true;
        }
      }
      this.renderTrendBands();
    }

    renderNativeSignalArrows() {
      if (!this.candleSeries) return;
      if (!this.showSignalArrows || !this.replayPayload?.entry_signals) {
        this.candleSeries.setMarkers([]);
        return;
      }
      const sigs = this.replayPayload.entry_signals.filter((s) => s.entry_allowed).slice(-160);
      this.candleSeries.setMarkers(sigs.map((sig) => ({
        time: sig.time,
        position: sig.side > 0 ? "belowBar" : "aboveBar",
        color: sig.side > 0 ? "rgba(22,163,74,0.75)" : "rgba(220,38,38,0.75)",
        shape: sig.side > 0 ? "arrowUp" : "arrowDown",
        text: "",
      })));
    }

    renderTrendBands() {
      const layer = document.getElementById("pfTrendBandLayer");
      const host = document.getElementById("pfChartHost");
      if (!layer || !host || !this.chart) return;
      layer.replaceChildren();
      const trendPts = this.replayPayload?.entry_trend;
      if (!this.settings.use_daily_trend_filter || !Array.isArray(trendPts) || !trendPts.length) return;
      const ts = this.chart.timeScale();
      const hostWidth = host.clientWidth || 0;
      const runs = [];
      let cur = null;
      for (const pt of trendPts) {
        const sign = Number(pt.sign || 0);
        if (!sign) {
          if (cur) runs.push(cur);
          cur = null;
          continue;
        }
        if (!cur || cur.sign !== sign) {
          if (cur) runs.push(cur);
          cur = { sign, start: pt.time, end: pt.time };
        } else {
          cur.end = pt.time;
        }
      }
      if (cur) runs.push(cur);
      let barW = 8;
      if (trendPts.length > 1) {
        const x2 = ts.timeToCoordinate(trendPts.at(-1).time);
        const x1 = ts.timeToCoordinate(trendPts.at(-2).time);
        if (Number.isFinite(x1) && Number.isFinite(x2)) barW = Math.max(2, Math.abs(x2 - x1));
      }
      const frag = document.createDocumentFragment();
      for (const run of runs) {
        const xStart = ts.timeToCoordinate(run.start);
        const xEnd = ts.timeToCoordinate(run.end);
        if (!Number.isFinite(xStart) || !Number.isFinite(xEnd)) continue;
        const left = Math.max(0, Math.min(hostWidth, Math.min(xStart, xEnd) - barW / 2));
        const right = Math.max(0, Math.min(hostWidth, Math.max(xStart, xEnd) + barW / 2));
        if (right <= left) continue;
        const band = document.createElement("div");
        band.style.cssText = `position:absolute;top:0;bottom:0;left:${left}px;width:${right - left}px;background:${run.sign > 0 ? "rgba(22,163,74,0.08)" : "rgba(220,38,38,0.08)"};pointer-events:none;`;
        frag.appendChild(band);
      }
      layer.appendChild(frag);
    }

    rebuildCombinedMarkers() {
      const virtual = (this.replayPayload?.markers || []).map((m, idx) => ({
        ...m,
        markerKey: `virtual:${m.pairKey}:${m.is_entry ? "E" : "X"}:${m.time}:${idx}`,
      }));
      const actual = this.actualMarkers || [];
      this.rawExecutionMarkers = [...actual, ...virtual];
      this.renderOverlayMarkers();
    }

    isMarkerVisible(marker) {
      if (marker.source === "actual" && !this.showActualMarkers) return false;
      if (marker.source === "virtual" && !this.showVirtualMarkers) return false;
      return true;
    }

    getTradePairs() {
      const visible = this.rawExecutionMarkers.filter((m) => this.isMarkerVisible(m));
      const map = new Map();
      visible.forEach((m) => {
        if (!m.pairKey) return;
        const p = map.get(m.pairKey) || { entries: [], exits: [] };
        if (m.is_entry) p.entries.push(m);
        else p.exits.push(m);
        map.set(m.pairKey, p);
      });
      const pairs = [];
      map.forEach((p, pairKey) => {
        if (p.entries.length && p.exits.length) {
          for (let i = 0; i < p.entries.length; i += 1) {
            pairs.push({ entry: p.entries[i], exit: p.exits[i] || p.exits[p.exits.length - 1], pairKey });
          }
        }
      });
      return pairs;
    }

    renderOverlayMarkers() {
      const layer = document.getElementById("pfTradeMarkerTargets");
      const host = document.getElementById("pfChartHost");
      if (!layer || !host || !this.chart || !this.candleSeries) return;
      const w = host.clientWidth || 0;
      const h = layer.clientHeight || 424;
      layer.textContent = "";
      const visible = this.rawExecutionMarkers.filter((m) => this.isMarkerVisible(m));
      const groups = new Map();
      visible.forEach((m) => {
        const arr = groups.get(m.time) || [];
        arr.push(m);
        groups.set(m.time, arr);
      });
      const frag = document.createDocumentFragment();
      groups.forEach((markers) => {
        const x = this.chart.timeScale().timeToCoordinate(markers[0].time);
        if (!Number.isFinite(x) || x < -30 || x > w + 30) {
          markers.forEach((m) => { m._targetX = null; m._targetY = null; });
          return;
        }
        const items = (this.groupTradesAsRange && markers.length > 1) ? [markers[0]] : markers;
        items.forEach((marker) => {
          const price = Number(marker.ratio ?? marker.entry_price ?? marker.exit_price);
          const y = Number.isFinite(price) ? this.candleSeries.priceToCoordinate(price) : null;
          if (!Number.isFinite(y) || y < 0 || y > h) {
            marker._targetX = x;
            marker._targetY = null;
            return;
          }
          const finalY = Math.max(6, Math.min(h - 6, y));
          markers.forEach((m) => { if (items.length === 1) { m._targetX = x; m._targetY = finalY; } });
          marker._targetX = x;
          marker._targetY = finalY;

          const isEntry = Boolean(marker.is_entry);
          const isShort = marker.direction === "short";
          const isSell = isShort === isEntry;
          const color = isSell ? "#dc2626" : "#16a34a";
          const fill = marker.hypothetical ? "none" : color;

          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("aria-label", marker.hoverText || "Trade marker");
          if (isEntry) {
            btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 8 8" style="display:block;overflow:visible;pointer-events:none;"><polygon points="0.5,0.5 7.5,4 0.5,7.5" fill="${fill}" stroke="${color}" stroke-width="${marker.hypothetical ? "1.1" : "0.75"}" stroke-linejoin="round"/></svg>`;
            btn.style.cssText = `appearance:none;position:absolute;left:${x}px;top:${finalY}px;transform:translate(-100%,-50%);width:9px;height:9px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;`;
          } else {
            btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 8 8" style="display:block;overflow:visible;pointer-events:none;"><polygon points="7.5,0.5 0.5,4 7.5,7.5" fill="${fill}" stroke="${color}" stroke-width="${marker.hypothetical ? "1.1" : "0.75"}" stroke-linejoin="round"/></svg>`;
            btn.style.cssText = `appearance:none;position:absolute;left:${x}px;top:${finalY}px;transform:translate(0,-50%);width:9px;height:9px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;`;
          }
          btn.addEventListener("mouseenter", () => {
            this.activeHoveredExecutionMarkerKey = marker.markerKey;
            this.activeHoveredPairKey = marker.pairKey;
            this.updateHoverPopup(marker);
            this.renderTradeTriangles();
          });
          btn.addEventListener("mouseleave", () => {
            this.activeHoveredExecutionMarkerKey = null;
            this.activeHoveredPairKey = null;
            const sel = this.rawExecutionMarkers.find((m) => m.markerKey === this.selectedExecutionMarkerKey) || null;
            this.updateHoverPopup(sel);
            this.renderTradeTriangles();
          });
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.selectedExecutionMarkerKey = marker.markerKey;
            this.selectedPairKey = marker.pairKey;
            this.updateHoverPopup(marker);
            this.renderTradeTriangles();
          });
          frag.appendChild(btn);
        });
      });
      layer.appendChild(frag);
      this.renderTradeTriangles();
    }

    updateHoverPopup(marker) {
      const box = document.getElementById("pfTradeMarkerHover");
      if (!box) return;
      if (!marker) {
        box.style.display = "none";
        box.textContent = "";
        return;
      }
      box.style.display = "block";
      box.textContent = `${formatKst(marker.time)} · ${marker.hoverText}`;
    }

    renderTradeTriangles() {
      const svg = document.getElementById("pfTradeTrianglesLayer");
      if (!svg || !this.chart || !this.candleSeries) return;
      svg.innerHTML = "";
      const activePair = this.activeHoveredPairKey || this.selectedPairKey;
      if (!activePair) return;
      const pairs = this.getTradePairs();
      const frag = document.createDocumentFragment();
      pairs.forEach(({ entry, exit, pairKey }) => {
        if (pairKey !== activePair) return;
        const p1 = Number(entry.ratio ?? entry.entry_price);
        const p2 = Number(exit.ratio ?? exit.exit_price);
        let x1 = entry._targetX ?? this.chart.timeScale().timeToCoordinate(entry.time);
        let x2 = exit._targetX ?? this.chart.timeScale().timeToCoordinate(exit.time);
        let y1 = this.candleSeries.priceToCoordinate(p1);
        let y2 = this.candleSeries.priceToCoordinate(p2);
        if (!Number.isFinite(x1) || !Number.isFinite(x2) || !Number.isFinite(y1) || !Number.isFinite(y2)) return;
        const ox1 = x1, oy1 = y1, ox2 = x2, oy2 = y2;
        if (x1 > x2) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; }
        const isShort = entry.direction === "short";
        const isProfit = (exit.pnl != null) ? Number(exit.pnl) > 0 : (isShort ? p1 >= p2 : p2 >= p1);
        let cornerX, cornerY;
        if (isShort) {
          cornerX = y1 <= y2 ? x2 : x1;
          cornerY = y1 <= y2 ? y1 : y2;
        } else {
          cornerX = y1 <= y2 ? x1 : x2;
          cornerY = y1 <= y2 ? y2 : y1;
        }
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", `${x1.toFixed(1)},${y1.toFixed(1)} ${cornerX.toFixed(1)},${cornerY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);
        poly.setAttribute("fill", isProfit ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)");
        poly.setAttribute("stroke", isProfit ? "rgba(22,163,74,0.7)" : "rgba(220,38,38,0.7)");
        poly.setAttribute("stroke-width", "1.2");
        frag.appendChild(poly);

        const diag = document.createElementNS("http://www.w3.org/2000/svg", "line");
        diag.setAttribute("x1", ox1.toFixed(1)); diag.setAttribute("y1", oy1.toFixed(1));
        diag.setAttribute("x2", ox2.toFixed(1)); diag.setAttribute("y2", oy2.toFixed(1));
        diag.setAttribute("stroke", isProfit ? "#16a34a" : "#dc2626");
        diag.setAttribute("stroke-width", "1.5");
        frag.appendChild(diag);
      });
      svg.appendChild(frag);
    }

    focusTradePair(pairKey) {
      if (!pairKey || !this.chart) return false;
      const pair = this.getTradePairs().find((candidate) => candidate.pairKey === pairKey);
      if (!pair) return false;
      const entryTime = Number(pair.entry?.time);
      const exitTime = Number(pair.exit?.time);
      if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime)) return false;
      const intervalSeconds = INTERVAL_SECONDS[this.settings.interval] || INTERVAL_SECONDS["4h"];
      const padding = intervalSeconds * 6;
      this.selectedPairKey = pairKey;
      this.chart.timeScale().setVisibleRange({
        from: Math.min(entryTime, exitTime) - padding,
        to: Math.max(entryTime, exitTime) + padding,
      });
      requestAnimationFrame(() => this.renderOverlayMarkers());
      return true;
    }

    renderReplaySummary() {
      const sum = this.replayPayload?.summary;
      if (!sum) return;
      document.getElementById("pfSumTrades").textContent = `${sum.trades ?? 0} (${sum.wins ?? 0} wins)`;
      document.getElementById("pfSumWin").textContent = finite(sum.win_rate_pct) ? `${Number(sum.win_rate_pct).toFixed(1)}%` : "—";
      const retEl = document.getElementById("pfSumReturn");
      const ret = Number(sum.return_on_initial_pct || 0);
      retEl.textContent = `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% (${sum.net_pnl_usd >= 0 ? "+" : "-"}$${Math.abs(Number(sum.net_pnl_usd || 0)).toFixed(2)})`;
      retEl.style.color = ret > 0 ? "#16a34a" : ret < 0 ? "#dc2626" : "#0f172a";
      document.getElementById("pfSumMaxDD").textContent = `-${Number(sum.max_drawdown_pct || 0).toFixed(1)}%`;
      document.getElementById("pfSumWorst").textContent = `${Number(sum.worst_trade_pct || 0).toFixed(1)}%`;
    }

    renderHistoryTable() {
      const body = document.getElementById("pfHistoryBody");
      if (!body) return;
      const actualEvents = (this.botState?.execution_history || []).map((ev) => ({
        kind: "actual",
        time: Number(ev.exit_time || ev.time || 0),
        isExit: ev.event === "EXIT",
        symbol: ev.symbol,
        direction: Number(ev.original_side ?? ev.side ?? 0) > 0 ? "long" : "short",
        qty: Number(ev.qty || 0),
        notional: Number(ev.notional_usd || 0),
        entryPrice: Number(ev.entry_price || (ev.event === "ENTRY" ? ev.price : 0) || 0),
        exitPrice: ev.event === "EXIT" ? Number(ev.price || 0) : null,
        feeUsd: ev.round_trip_fee_usd ?? ev.fee_usd,
        grossPnl: ev.gross_pnl_usd,
        netPnl: ev.net_pnl_usd,
        pnlPct: ev.pnl_pct,
        verified: Boolean(ev.pnl_authoritative),
        status: ev.event === "EXIT" ? "CLOSED (LIVE)" : "OPEN (LIVE)",
        pairKey: String(ev.entry_order_id || ev.order_id || ""),
      }));
      const paperTrades = (this.replayPayload?.trades || []).map((t) => ({
        kind: "virtual",
        time: Number(t.exit_time || t.entry_time || 0),
        isExit: true,
        symbol: t.symbol,
        direction: t.direction,
        qty: Number(t.qty || 0),
        notional: Number(t.notional || 0),
        entryPrice: Number(t.entry_price || 0),
        exitPrice: Number(t.exit_price || 0),
        feeUsd: Number(t.fee_usd || 0),
        grossPnl: Number(t.gross_pnl_usd || 0),
        netPnl: Number(t.net_pnl_usd || 0),
        pnlPct: Number(t.roe_pct ?? t.pnl_pct ?? 0),
        verified: true,
        status: `PAPER · ${t.reason || "horizon"}`,
        pairKey: String(t.pairKey || ""),
      }));

      let rows = [];
      if (this.historyFilter === "actual") rows = actualEvents;
      else if (this.historyFilter === "virtual") rows = paperTrades;
      else rows = [...actualEvents, ...paperTrades];
      rows.sort((a, b) => b.time - a.time);
      const sliced = rows.slice(0, 80);
      if (!sliced.length) {
        body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No historical trades for selected filter yet.</td></tr>';
        return;
      }
      body.innerHTML = sliced.map((r) => {
        const isActual = r.kind === "actual";
        const srcBadge = isActual
          ? `<span style="background:${r.isExit ? "#e0f2fe" : "#ede9fe"};color:${r.isExit ? "#0369a1" : "#6d28d9"};padding:2px 6px;border-radius:4px;font-weight:800;">${r.isExit ? "LIVE EXIT" : "LIVE ENTRY"}</span>`
          : `<span style="background:#f1f5f9;color:#475569;padding:2px 6px;border-radius:4px;font-weight:800;">PAPER</span>`;
        const dirBadge = r.direction === "short"
          ? `<span style="color:#dc2626;font-weight:800;">SHORT</span>`
          : `<span style="color:#16a34a;font-weight:800;">LONG</span>`;
        const pxStr = r.exitPrice
          ? `${formatPrice(r.entryPrice, r.symbol)} → ${formatPrice(r.exitPrice, r.symbol)}`
          : formatPrice(r.entryPrice, r.symbol);
        const feeStr = r.feeUsd == null ? "—" : `$${Number(r.feeUsd).toFixed(4)}`;
        const pnlStr = r.isExit && r.verified && finite(r.netPnl)
          ? `<span style="font-weight:800;color:${r.netPnl >= 0 ? "#16a34a" : "#dc2626"}">${r.netPnl >= 0 ? "+" : "-"}$${Math.abs(r.netPnl).toFixed(2)} (${r.pnlPct >= 0 ? "+" : ""}${Number(r.pnlPct).toFixed(2)}%)</span>`
          : (r.isExit ? '<span style="color:#b45309;">Unverified</span>' : '<span style="color:#64748b;">Open lot</span>');
        return `<tr data-pair-key="${r.pairKey}">
          <td style="font-family:monospace;">${formatKst(r.time)}</td>
          <td>${srcBadge}</td>
          <td>${dirBadge}</td>
          <td><strong>${r.symbol}</strong><br><small style="color:#64748b;">$${r.notional.toFixed(0)} (${r.qty.toFixed(4)})</small></td>
          <td style="font-family:monospace;font-weight:700;">${pxStr}</td>
          <td style="font-family:monospace;color:#64748b;">${feeStr}</td>
          <td>${pnlStr}</td>
          <td style="font-size:10px;font-weight:700;color:${isActual ? "#047857" : "#475569"};">${r.status}</td>
        </tr>`;
      }).join("");

      body.querySelectorAll("tr[data-pair-key]").forEach((tr) => {
        tr.addEventListener("click", () => {
          const pk = tr.getAttribute("data-pair-key");
          if (!pk) return;
          if (!this.focusTradePair(pk)) {
            this.selectedPairKey = pk;
            this.renderTradeTriangles();
          }
        });
      });
    }

    ensureUnlocked() {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is locked. Unlock at top or enter password first.", "warn");
        window.terminalLockManager?.openPasswordModal?.();
        return false;
      }
      return true;
    }

    buildBotConfigPayload() {
      const s = this.readControls();
      return {
        venue: s.venue,
        selected_symbol: s.symbol,
        strategy_interval: s.interval,
        horizon_bars: s.horizon_bars,
        min_hold_bars: s.min_hold_bars,
        neutral_bps: s.neutral_bps,
        use_confidence_gate: s.use_confidence_gate,
        confidence_pct: s.confidence_pct,
        use_expected_edge_gate: s.use_expected_edge_gate,
        min_expected_bps: s.min_expected_bps,
        ridge_lambda: s.ridge_lambda,
        train_window: s.train_window,
        min_train_samples: s.min_train_samples,
        cost_bps: s.cost_bps,
        use_daily_trend_filter: s.use_daily_trend_filter,
        daily_ma_period: s.daily_ma_period,
        hold_same_direction: s.hold_same_direction,
        entry_direction_mode: s.entry_direction_mode,
        use_stop_loss: s.use_stop_loss,
        stop_loss_pct: s.stop_loss_pct,
        notional_usd: s.notional_usd,
        leverage: s.leverage,
        momentum_lookback: s.momentum_lookback,
        macd_fast: s.macd_fast, macd_slow: s.macd_slow, macd_signal: s.macd_signal,
        rsi_period: s.rsi_period, ma_fast: s.ma_fast, ma_slow: s.ma_slow,
        ma_slope_lookback: s.ma_slope_lookback, atr_period: s.atr_period,
        ...Object.fromEntries(FEATURE_GROUPS.map((g) => [`use_${g}`, Boolean(s[`use_${g}`])])),
      };
    }

    async saveConfigToBot() {
      if (!this.ensureUnlocked()) return false;
      try {
        const res = await apiPost("/api/forecast-trader/config", this.buildBotConfigPayload());
        if (res?.bot) this.botState = res.bot;
        window.showToast?.("✅ Strategy & sizing saved to EC2 bot.", "success");
        await this.refreshAll({ fit: false, force: true });
        return true;
      } catch (err) {
        window.alert(err.message);
        return false;
      }
    }

    async toggleLiveBot() {
      if (!this.ensureUnlocked()) return false;
      const currentlyEnabled = Boolean(this.botState?.enabled);
      const next = !currentlyEnabled;
      try {
        if (next) {
          const cfg = this.buildBotConfigPayload();
          await apiPost("/api/forecast-trader/config", cfg);
        }
        const res = await apiPost("/api/forecast-trader/toggle", { enabled: next, confirm_live_trading: next });
        if (res?.bot) this.botState = res.bot;
        window.showToast?.(next ? "🟢 Live 4h Quant Bot ARMED" : "⏸ Live 4h Quant Bot PAUSED", "info");
        await this.refreshStatus();
        return true;
      } catch (err) {
        window.alert(err.message);
        return false;
      }
    }

    async reconcileBot() {
      if (!this.ensureUnlocked()) return false;
      try {
        await apiPost("/api/forecast-trader/reconcile", {});
        window.showToast?.("⚖ Position & pending orders reconciled.", "success");
        await this.refreshStatus();
        return true;
      } catch (err) {
        window.alert(err.message);
        return false;
      }
    }

    async flattenBot() {
      if (!this.ensureUnlocked()) return false;
      if (!window.confirm("Immediately close any open Tab 11 position at market and pause the live bot?")) return false;
      try {
        await apiPost("/api/forecast-trader/flatten", {});
        window.showToast?.("🛑 Position flattened and bot paused.", "warn");
        await this.refreshAll({ fit: false, force: true });
        return true;
      } catch (err) {
        window.alert(err.message);
        return false;
      }
    }

    applyExecutionLock() {
      const locked = Boolean(window.terminalLockManager?.isLocked);
      const root = document.getElementById("tabContentPriceForecast");
      if (root) root.classList.toggle("terminal-read-only", locked);
      const unlockBtn = document.getElementById("pfBtnUnlock");
      if (unlockBtn) unlockBtn.style.display = locked ? "inline-flex" : "none";
      document.querySelectorAll("#tabContentPriceForecast .terminal-action-control").forEach((el) => {
        el.disabled = locked;
      });
    }

    setStatus(message, error = false) {
      const node = document.getElementById("pfChartStatus");
      if (!node) return;
      node.textContent = message;
      node.className = error ? "pfStatusBar pfErrorBox" : "pfStatusBar";
    }

    resize() {
      const host = document.getElementById("pfChartHost");
      if (!host || !this.chart) return;
      this.chart.applyOptions({ width: Math.max(320, host.clientWidth), height: 450 });
      if (this.pendingFit && host.clientWidth > 0 && host.clientHeight > 0 && this.bars.length) {
        const range = globalThis.StrategyExecutionChartController?.initialRange?.(this.bars.length, 96);
        if (range) this.chart?.timeScale()?.setVisibleLogicalRange?.(range);
        else this.chart?.timeScale()?.fitContent?.();
        this.pendingFit = false;
      }
      this.renderTrendBands();
      this.renderOverlayMarkers();
    }

    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(async () => {
        if (!this.active) return;
        this.refreshStatus();
        const intervalMs = INTERVAL_SECONDS[this.settings.interval] * 1000;
        if (Date.now() - this.lastLoadedAt >= Math.min(intervalMs, 60000)) {
          await this.refreshChart({ fit: false });
          if (this.active) await this.refreshReplay();
          this.lastLoadedAt = Date.now();
        }
      }, 15000);
    }

    stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    onTabActivated() {
      this.active = true;
      this.mount();
      this.resize();
      if (this.mounted && !this.loading && (!this.loaded || Date.now() - this.lastLoadedAt > 30000)) {
        this.refreshAll({ fit: !this.loaded });
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
  instance.formatKst = formatKst;
  instance.formatKstTick = formatKstTick;
  instance.normalizeSettings = normalizeSettings;
  instance.parseKlines = parseKlines;
  instance.buildFeatureRows = buildFeatureRows;
  instance.fitRidge = fitRidge;
  instance.probabilityFromResiduals = probabilityFromResiduals;
  instance.forecastAtIndex = forecastAtIndex;
  instance.buildCausalForecast = buildCausalForecast;
  instance.alignDailyTrend = alignDailyTrend;
  instance.buildDailyMaSeries = buildDailyMaSeries;
  instance.runCausalReplayWithDaily = runCausalReplayWithDaily;
  return instance;
});
