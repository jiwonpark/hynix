"""Causal MA pivot-guide entry filter; independent of positions and chart zoom."""
import math

RULE_VERSION = "last_arrow_v2"

# ma_pivot_min_arrows is retained for old configurations; the rule uses only the last arrow.
KEYS = ('use_ma_pivot_direction', 'ma_pivot_period', 'ma_pivot_lookback', 'ma_pivot_min_arrows')
DEFAULTS = dict(use_ma_pivot_direction=False, ma_pivot_period=24,
                ma_pivot_lookback=120, ma_pivot_min_arrows=1)


def validate_setting(key, value):
    if key == 'use_ma_pivot_direction':
        if not isinstance(value, bool):
            raise ValueError('MA pivot switch must be boolean')
        return value
    number = float(value)
    if isinstance(value, bool) or not math.isfinite(number) or not number.is_integer():
        raise ValueError(f'{key} must be a whole number')
    number = int(number)
    if key == 'ma_pivot_period' and number not in (7, 24, 60):
        raise ValueError('Pivot MA must be 7, 24 or 60')
    if key == 'ma_pivot_lookback' and not 3 <= number <= 440:
        raise ValueError('Pivot lookback must be between 3 and 440 MA points')
    if key == 'ma_pivot_min_arrows' and not 1 <= number <= 440:
        raise ValueError('Minimum pivot arrows must be between 1 and 440')
    return number


def analyze_ma_points(values, min_arrows=1):
    # min_arrows is accepted only for compatibility with older saved configs.
    result = dict(ready=False, long_pass=False, short_pass=False, up_count=0,
                  down_count=0, crossings=[], slope=None, pivot_index=None,
                  last_arrow=None, rule=RULE_VERSION)
    if len(values) < 3 or not all(math.isfinite(v) for v in values):
        return dict(result, reason='MA history unavailable')
    direction, pivot = 0, None
    for i in range(1, len(values)):
        change = values[i] - values[i-1]
        sign = 1 if change > 0 else -1 if change < 0 else 0
        if sign and direction and sign != direction:
            pivot = i-1
        if sign:
            direction = sign
    if pivot is None:
        return dict(result, reason='No confirmed pivot in lookback')
    end = len(values)-1
    slope = (values[end]-values[pivot])/(end-pivot)
    scale = max(1e-12, max(abs(v) for v in values))
    # Negative normalized prices have the same orientation as canvas y.
    delta = [((values[pivot]+slope*(i-pivot))-v)/scale for i,v in enumerate(values)]
    epsilon = 1e-10
    crossings = []
    def add(x, before, after):
        if x <= pivot+epsilon or x >= end-epsilon:
            return
        if any(abs(c['index']-x) <= epsilon for c in crossings):
            return
        left = int(math.floor(x))
        crossings.append(dict(index=x, left_index=left, right_index=min(end,left+1),
                              fraction=x-left, value=values[pivot]+slope*(x-pivot),
                              direction='up' if after > before else 'down'))
    for i in range(pivot, end+1):
        d = delta[i]
        if abs(d) <= epsilon:
            if i > pivot and i < end:
                before, after = delta[i-1], delta[i+1]
                if abs(before)>epsilon and abs(after)>epsilon and (before>0)!=(after>0):
                    add(i,before,after)
        elif i>pivot:
            before = delta[i-1]
            if abs(before)>epsilon and (before>0)!=(d>0):
                add(i-1+before/(before-d),before,d)
    up = sum(c['direction']=='up' for c in crossings)
    down = len(crossings)-up
    last_arrow = crossings[-1]['direction'] if crossings else None
    return dict(result, ready=True, reason=None, slope=slope, pivot_index=pivot,
                pivot_age_bars=end-pivot, start_value=values[pivot], end_value=values[end],
                crossings=crossings, up_count=up, down_count=down, last_arrow=last_arrow,
                long_pass=slope > 0 if last_arrow is None else last_arrow == 'up',
                short_pass=slope < 0 if last_arrow is None else last_arrow == 'down')


def evaluate_ma_pivot(prices, period=24, lookback=120, min_arrows=1):
    required = period+lookback-1
    if len(prices)<required:
        result=analyze_ma_points([])
        result['reason']=f'Need {required} completed candles'
    else:
        source=prices[-required:]
        total=sum(source[:period]); values=[total/period]
        for i in range(period,len(source)):
            total+=source[i]-source[i-period]
            values.append(total/period)
        result=analyze_ma_points(values,min_arrows)
    return dict(result, period=period, lookback=lookback, min_arrows=min_arrows)
