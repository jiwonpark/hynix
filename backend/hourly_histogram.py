"""Causal completed-hour MACD signal-line second-difference entry gate, shared by Tabs 4/5."""
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


def hourly_histogram_points(bars, config):
    ordered = sorted(bars, key=lambda b: b['time'])
    periods = [int(config.get('hourly_hist_' + key, default)) for key, default in [('fast',20),('slow',60),('signal',9)]]
    values = [float(b['value']) for b in ordered]
    # Fixed causal warmup makes live/replay independent of fetched history length.
    warmup = max(150, periods[1] + periods[2] + 3)
    points = []
    for i, bar in enumerate(ordered):
        window = values[max(0,i-warmup+1):i+1]
        hist, signals = macd_hourly_series(window, *periods)
        current, previous, previous2 = signals[-3:][::-1] if len(window) >= warmup else (None, None, None)
        ready = (all(v is not None and math.isfinite(v) for v in (current, previous, previous2))
                 and i >= 2 and int(bar["time"]) - int(ordered[i-1]["time"]) == 3600
                 and int(ordered[i-1]["time"]) - int(ordered[i-2]["time"]) == 3600)
        delta = current - previous if ready else None
        previous_delta = previous - previous2 if ready else None
        acceleration = delta - previous_delta if ready else None
        points.append({'source_time':int(bar['time']), 'available_time':int(bar['time'])+3600,
                       'signal':current, 'previous_signal':previous, 'previous2_signal':previous2,
                       'signal_delta':delta, 'previous_signal_delta':previous_delta,
                       'signal_acceleration':acceleration,
                       'histogram':hist[-1] if ready else None,
                       'previous_histogram':hist[-2] if ready else None,
                       'slope':hist[-1]-hist[-2] if ready else None,
                       'long_ok':bool(ready and acceleration>0), 'short_ok':bool(ready and acceleration<0),
                       'ready':ready, 'periods':periods, 'source':'COMPLETED_1H_MACD_SIGNAL_SECOND_DIFF'})
    return points


def apply_hourly_filter(entry, side, details, config, hourly=None):
    enabled = bool(config.get('use_hourly_hist', False))
    ready = bool(hourly and hourly.get('ready'))
    allowed = bool(ready and hourly.get('long_ok' if side > 0 else 'short_ok'))
    details['hourly_histogram'] = hourly
    checks=details.setdefault('condition_pass', {})
    toggles=details.setdefault('condition_enabled', {})
    for direction in ('long','short'):
        key='entry_hourly_hist_'+direction
        checks[key]=bool(hourly.get(direction+'_ok')) if ready else None
        toggles[key]=enabled
    return bool(entry and (not enabled or allowed))


class HourlyHistogramMixin:
    async def refresh_hourly_histogram(self):
        if not self.state.get('use_hourly_hist',True):
            return None
        now=time.time()
        params=tuple(self.state.get('hourly_hist_'+k,d) for k,d in [('fast',20),('slow',60),('signal',9)])
        key=(self.state['selected_symbol'],params,int(now//3600))
        cache=getattr(self,'_hourly_hist_cache',None)
        if cache and cache[0]==key and now-cache[1]<15:
            self.state['hourly_histogram']=cache[2]
            return cache[2]
        try:
            limit=min(500,max(150,params[1]+params[2]+3)+2)
            if self.profit_venue=='binance':
                raw=await self.client.request('GET','/fapi/v1/klines',{'symbol':key[0],'interval':'1h','limit':limit})
                bars=[{'time':int(r[0])//1000,'value':float(r[4])} for r in raw if int(r[6])<int(now*1000)]
            else:
                market_id,_,_=await self._market(key[0])
                raw=await self.client.candles(market_id,'1h',limit,fresh=True)
                bars=[{'time':int(r['t'])//1000,'value':float(r['c'])} for r in raw if int(r['t'])/1000+3600<=now-1]
            points=hourly_histogram_points(bars,self.state)
            result=points[-1] if points else {'ready':False}
            if result.get('source_time')!=int(now//3600)*3600-3600:
                result={**result,'ready':False,'long_ok':False,'short_ok':False,'error':'Latest completed hour unavailable'}
        except Exception as exc:
            result={'ready':False,'long_ok':False,'short_ok':False,'error':str(exc)}
        self.state['hourly_histogram']=result
        self._hourly_hist_cache=(key,now,result)
        return result

    async def hourly_entry_allowed(self, side):
        hourly=await self.refresh_hourly_histogram()
        if not self.state.get('use_hourly_hist',True):
            return True
        return bool(hourly and hourly.get('ready') and hourly.get('long_ok' if side>0 else 'short_ok'))
