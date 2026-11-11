"""Causal completed-5m MACD histogram-regime entry gate, shared by Tabs 4/5.

The ``hourly_hist_*`` names are retained as persisted API keys for backwards
compatibility; the condition itself is intentionally evaluated on 5m candles.
"""
import math
import time


def macd_hourly_series(values, fast=20, slow=60, signal=9):
    from .lighter_strategy import _ema_series
    fast_ema, slow_ema = _ema_series(values, fast), _ema_series(values, slow)
    macd = [float(fast_ema[i]) - float(slow_ema[i]) for i in range(slow - 1, len(values))]
    signals = _ema_series(macd, signal)
    histograms, aligned_signals = [None] * len(values), [None] * len(values)
    for i, value in enumerate(signals):
        if value is not None:
            histograms[slow - 1 + i] = macd[i] - float(value)
            aligned_signals[slow - 1 + i] = float(value)
    return histograms, aligned_signals


def histogram_series(values, fast=20, slow=60, signal=9):
    return macd_hourly_series(values, fast, slow, signal)[0]


def five_minute_signal_points(bars, config):
    """Return causal completed-5m MACD signal-line slope points."""
    ordered = sorted(bars, key=lambda b: b['time'])
    periods = [int(config.get(key, default)) for key, default in
               [('macd_fast_period', 12), ('macd_slow_period', 26), ('macd_signal_period', 9)]]
    values = [float(b['value']) for b in ordered]
    warmup = max(150, periods[1] + periods[2] + 2)
    points = []
    for i, bar in enumerate(ordered):
        window = values[max(0, i - warmup + 1):i + 1]
        _, signals = macd_hourly_series(window, *periods)
        current, previous = signals[-2:][::-1] if len(window) >= warmup else (None, None)
        ready = (all(v is not None and math.isfinite(v) for v in (current, previous))
                 and i >= 1 and int(bar['time']) - int(ordered[i - 1]['time']) == 300)
        slope = current - previous if ready else None
        points.append({
            'source_time': int(bar['time']), 'available_time': int(bar['time']) + 300,
            'signal': current, 'previous_signal': previous, 'signal_slope': slope,
            'long_ok': bool(ready and slope > 0), 'short_ok': bool(ready and slope < 0),
            'ready': ready, 'periods': periods, 'source': 'COMPLETED_5M_MACD_SIGNAL_SLOPE',
        })
    return points


def apply_five_minute_signal_filter(entry, side, details, config, point=None):
    enabled = bool(config.get('use_macd_signal_slope_5m', False))
    ready = bool(point and point.get('ready'))
    allowed = bool(ready and point.get('long_ok' if side > 0 else 'short_ok'))
    details['five_minute_macd_signal'] = point
    checks = details.setdefault('condition_pass', {})
    toggles = details.setdefault('condition_enabled', {})
    checks['entry_signal_slope_5m'] = allowed if ready else None
    toggles['entry_signal_slope_5m'] = enabled
    return bool(entry and (not enabled or allowed))


def hourly_histogram_points(bars, config):
    """Return completed-5m histogram regimes using legacy persisted key names."""
    ordered = sorted(bars, key=lambda b: b['time'])
    periods = [int(config.get('hourly_hist_' + key, default)) for key, default in [('fast',20),('slow',60),('signal',9)]]
    values = [float(b['value']) for b in ordered]
    # Fixed causal warmup makes live/replay independent of fetched history length.
    warmup = max(150, periods[1] + periods[2] + 3)
    points = []
    for i, bar in enumerate(ordered):
        window = values[max(0,i-warmup+1):i+1]
        hist, signals = macd_hourly_series(window, *periods)
        current, previous = signals[-2:][::-1] if len(window) >= warmup else (None, None)
        current_histogram, previous_histogram = hist[-2:][::-1] if len(window) >= warmup else (None, None)
        ready = (all(v is not None and math.isfinite(v)
                     for v in (current, previous, current_histogram, previous_histogram))
                 and i >= 1 and int(bar["time"]) - int(ordered[i-1]["time"]) == 300)
        delta = current - previous if ready else None
        points.append({'source_time':int(bar['time']), 'available_time':int(bar['time'])+300,
                       'signal':current, 'previous_signal':previous, 'signal_delta':delta,
                       'histogram':current_histogram if ready else None,
                       'previous_histogram':previous_histogram if ready else None,
                       'slope':current_histogram-previous_histogram if ready else None,
                       'histogram_cross':('CROSS_UP' if ready and previous_histogram <= 0 < current_histogram
                                          else 'CROSS_DOWN' if ready and previous_histogram >= 0 > current_histogram
                                          else 'NONE'),
                       'long_ok':bool(ready and current_histogram>0),
                       'short_ok':bool(ready and current_histogram<0),
                       'ready':ready, 'periods':periods, 'timeframe':'5m',
                       'source':'COMPLETED_5M_MACD_HISTOGRAM_REGIME'})
    return points


def apply_hourly_filter(entry, side, details, config, hourly=None):
    enabled = bool(config.get('use_hourly_hist', False))
    ready = bool(hourly and hourly.get('ready'))
    allowed = bool(ready and hourly.get('long_ok' if side > 0 else 'short_ok'))
    details['five_minute_histogram'] = hourly
    checks=details.setdefault('condition_pass', {})
    toggles=details.setdefault('condition_enabled', {})
    for direction in ('long','short'):
        key='entry_5m_hist_'+direction
        checks[key]=bool(hourly.get(direction+'_ok')) if ready else None
        toggles[key]=enabled
    return bool(entry and (not enabled or allowed))


class HourlyHistogramMixin:
    async def refresh_five_minute_macd_signal(self):
        if (self.state.get('strategy_mode') != 'macd_hist_turn'
                or not self.state.get('use_macd_signal_slope_5m', True)):
            return None
        now = time.time()
        periods = tuple(int(self.state.get(key, default)) for key, default in
                        [('macd_fast_period', 12), ('macd_slow_period', 26), ('macd_signal_period', 9)])
        key = (self.state['selected_symbol'], periods, int(now // 300))
        cache = getattr(self, '_five_minute_signal_cache', None)
        if cache and cache[0] == key and now - cache[1] < 15:
            self.state['five_minute_macd_signal'] = cache[2]
            return cache[2]
        try:
            limit = min(500, max(150, periods[1] + periods[2] + 2) + 2)
            if self.profit_venue == 'binance':
                raw = await self.client.request('GET', '/fapi/v1/klines',
                                                {'symbol': key[0], 'interval': '5m', 'limit': limit})
                bars = [{'time': int(row[0]) // 1000, 'value': float(row[4])}
                        for row in raw if int(row[6]) < int(now * 1000)]
            else:
                market_id, _, _ = await self._market(key[0])
                raw = await self.client.candles(market_id, '5m', limit, fresh=True)
                bars = [{'time': int(row['t']) // 1000, 'value': float(row['c'])}
                        for row in raw if int(row['t']) / 1000 + 300 <= now - 1]
            points = five_minute_signal_points(bars, self.state)
            result = points[-1] if points else {'ready': False}
            expected = int(now // 300) * 300 - 300
            if result.get('source_time') != expected:
                result = {**result, 'ready': False, 'long_ok': False, 'short_ok': False,
                          'error': 'Latest completed 5m candle unavailable'}
        except Exception as exc:
            result = {'ready': False, 'long_ok': False, 'short_ok': False, 'error': str(exc)}
        self.state['five_minute_macd_signal'] = result
        self._five_minute_signal_cache = (key, now, result)
        return result

    async def refresh_hourly_histogram(self):
        if not self.state.get('use_hourly_hist',True):
            return None
        now=time.time()
        params=tuple(self.state.get('hourly_hist_'+k,d) for k,d in [('fast',20),('slow',60),('signal',9)])
        key=(self.state['selected_symbol'],params,int(now//300))
        cache=getattr(self,'_hourly_hist_cache',None)
        if cache and cache[0]==key and now-cache[1]<15:
            self.state['hourly_histogram']=cache[2]
            return cache[2]
        try:
            limit=min(500,max(150,params[1]+params[2]+3)+2)
            if self.profit_venue=='binance':
                raw=await self.client.request('GET','/fapi/v1/klines',{'symbol':key[0],'interval':'5m','limit':limit})
                bars=[{'time':int(r[0])//1000,'value':float(r[4])} for r in raw if int(r[6])<int(now*1000)]
            else:
                market_id,_,_=await self._market(key[0])
                raw=await self.client.candles(market_id,'5m',limit,fresh=True)
                bars=[{'time':int(r['t'])//1000,'value':float(r['c'])} for r in raw if int(r['t'])/1000+300<=now-1]
            points=hourly_histogram_points(bars,self.state)
            result=points[-1] if points else {'ready':False}
            if result.get('source_time')!=int(now//300)*300-300:
                result={**result,'ready':False,'long_ok':False,'short_ok':False,'error':'Latest completed 5m candle unavailable'}
        except Exception as exc:
            result={'ready':False,'long_ok':False,'short_ok':False,'error':str(exc)}
        self.state['hourly_histogram']=result
        self._hourly_hist_cache=(key,now,result)
        return result

    async def five_minute_signal_entry_allowed(self, side):
        point = await self.refresh_five_minute_macd_signal()
        if (self.state.get('strategy_mode') != 'macd_hist_turn'
                or not self.state.get('use_macd_signal_slope_5m', True)):
            return True
        return bool(point and point.get('ready') and point.get('long_ok' if side > 0 else 'short_ok'))

    async def hourly_entry_allowed(self, side):
        hourly=await self.refresh_hourly_histogram()
        if not self.state.get('use_hourly_hist',True):
            return True
        return bool(hourly and hourly.get('ready') and hourly.get('long_ok' if side>0 else 'short_ok'))
