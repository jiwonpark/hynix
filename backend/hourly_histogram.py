"""Causal completed-hour MACD histogram slope entry gate, shared by Tabs 4/5."""
import math
import time


def histogram_series(values, fast=20, slow=60, signal=9):
    from .lighter_strategy import _ema_series
    fast_ema, slow_ema = _ema_series(values, fast), _ema_series(values, slow)
    macd = [float(fast_ema[i]) - float(slow_ema[i]) for i in range(slow - 1, len(values))]
    signals = _ema_series(macd, signal)
    output = [None] * len(values)
    for i, value in enumerate(signals):
        if value is not None:
            output[slow - 1 + i] = macd[i] - float(value)
    return output


def hourly_histogram_points(bars, config):
    ordered = sorted(bars, key=lambda b: b['time'])
    periods = [int(config.get('hourly_hist_' + key, default)) for key, default in [('fast',20),('slow',60),('signal',9)]]
    hist = histogram_series([float(b['value']) for b in ordered], *periods)
    points = []
    for i, bar in enumerate(ordered):
        current, previous = hist[i], hist[i-1] if i else None
        ready = current is not None and previous is not None and all(math.isfinite(v) for v in (current,previous))
        slope = current - previous if ready else None
        points.append({'source_time':int(bar['time']), 'available_time':int(bar['time'])+3600,
                       'histogram': current, 'previous_histogram': previous, 'slope':slope,
                       'long_ok':bool(ready and slope>0), 'short_ok':bool(ready and slope<0),
                       'ready':ready, 'periods':periods, 'source':'COMPLETED_1H_MACD_HISTOGRAM'})
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
            limit=min(500,max(150,params[1]+params[2]+3))
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
