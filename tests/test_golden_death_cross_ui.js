const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const cryptoTabCode = fs.readFileSync(path.join(root, 'crypto-tab.js'), 'utf8');
const lighterCryptoTabCode = fs.readFileSync(path.join(root, 'lighter-crypto-tab.js'), 'utf8');

[
  { name: 'cryptoEngine (Tab 4)', code: cryptoTabCode, engineKey: 'cryptoEngine', prefix: 'crypto_' },
  { name: 'lighterCryptoEngine (Tab 5)', code: lighterCryptoTabCode, engineKey: 'lighterCryptoEngine', prefix: 'lighterCrypto_' }
].forEach(({ name, code, engineKey, prefix }) => {
  const elements = new Map();
  const context = {
    window: {},
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, {
            id,
            style: {},
            dataset: {},
            classList: { add() {}, remove() {}, toggle() {} },
            checked: true,
            value: '',
            textContent: '',
            setAttribute() {},
            getAttribute() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            insertAdjacentHTML() {},
            replaceChildren() {},
            append() {},
            addEventListener() {}
          });
        }
        return elements.get(id);
      },
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          style: {},
          dataset: {},
          classList: { add() {}, remove() {} },
          appendChild() {},
          append() {},
          replaceChildren() {},
        };
      }
    },
    URLSearchParams,
    console,
    safeStorage: {
      getItem() { return null; },
      setItem() {}
    }
  };
  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(code, context);

  const engine = context.window[engineKey];
  assert.ok(engine, `${name} must expose window.${engineKey}`);

  // 1. Verify paradigm registration
  const paradigm = engine.paradigms['golden_death_cross'];
  assert.ok(paradigm, `${name} must have golden_death_cross paradigm`);
  assert.equal(paradigm.id, 'golden_death_cross');
  assert.equal(paradigm.defaultParams.fast_ma_period, 9);
  assert.equal(paradigm.defaultParams.slow_ma_period, 21);
  assert.equal(paradigm.defaultParams.min_cross_spread_bps, 0.0);

  // 2. Test replaySettings()
  engine.currentParadigm = 'golden_death_cross';
  const settings = engine.replaySettings();
  assert.equal(settings.strategy_mode, 'golden_death_cross');
  assert.equal(settings.fast_ma_period, 9);
  assert.equal(settings.slow_ma_period, 21);
  assert.equal(settings.min_cross_spread_bps, 0.0);
  assert.equal(settings.use_golden_cross, true);
  assert.equal(settings.use_death_cross, true);
  assert.equal(settings.use_cross_spread, true);
  assert.equal(settings.use_cross_exit, true);

  // 3. Test liveStrategyPayload()
  const payload = engine.liveStrategyPayload('golden_death_cross');
  assert.equal(payload.strategy_mode, 'golden_death_cross');
  assert.equal(payload.fast_ma_period, 9);
  assert.equal(payload.slow_ma_period, 21);
  assert.equal(payload.min_cross_spread_bps, 0.0);
  assert.equal(payload.use_golden_cross, true);
  assert.equal(payload.use_death_cross, true);
  assert.equal(payload.use_cross_spread, true);
  assert.equal(payload.use_cross_exit, true);

  // 4. Test renderParadigmDetail() returns markup with proper ids
  const markup = engine.renderParadigmDetail('golden_death_cross');
  assert.match(markup, new RegExp(`${prefix}inpCrossFastPeriod`));
  assert.match(markup, new RegExp(`${prefix}inpCrossSlowPeriod`));
  assert.match(markup, new RegExp(`${prefix}inpCrossMinSpreadBps`));
  assert.match(markup, new RegExp(`${prefix}valCrossFastMa`));
  assert.match(markup, new RegExp(`${prefix}valCrossSlowMa`));
  assert.match(markup, new RegExp(`${prefix}valCrossSpread`));
  assert.match(markup, new RegExp(`${prefix}valCrossRegime`));
  assert.match(markup, /<select[^>]+inpCrossFastPeriod/);
  assert.match(markup, /MA7 · chart line/);
  assert.match(markup, /MA24 · chart line/);
  assert.match(markup, /MA60 · chart line/);

  const accelMarkup = engine.renderParadigmDetail('ma_acceleration');
  assert.match(accelMarkup, /<select[^>]+inpMaAccelPeriod/);
  assert.match(accelMarkup, /MA7 · chart line/);
  assert.match(accelMarkup, /MA24 · chart line/);
  assert.match(accelMarkup, /MA60 · chart line/);

  // 5. Test alignReplayToLive()
  engine.botState = {
    strategy_mode: 'golden_death_cross',
    strategy_interval: '15m',
    fast_ma_period: 12,
    slow_ma_period: 30,
    min_cross_spread_bps: 1.5,
    use_golden_cross: true,
    use_death_cross: false,
    use_cross_spread: true,
    use_cross_exit: true
  };
  // stub refreshChart & runBacktest for unit test
  engine.refreshChart = () => {};
  engine.runBacktest = () => {};
  engine.alignReplayToLive();
  assert.equal(engine.interval, '15m');
  assert.equal(engine.currentParadigm, 'golden_death_cross');

  console.log(`✓ ${name} Golden & Death Cross UI/Replay tests passed`);
});

console.log('All Golden & Death Cross frontend test suites passed.');
