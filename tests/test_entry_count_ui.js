const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
for(const [file,name,prefix] of [['crypto-tab.js','cryptoEngine','crypto'],['lighter-crypto-tab.js','lighterCryptoEngine','lighterCrypto']]) {
  const source=fs.readFileSync(file,'utf8');
  assert.match(source,/Array.from\(\{length:100\}/);
  assert.match(source,/<option value="unlimited">Unlimited<\/option>/);
  const nodes=new Map();const context={window:{},URLSearchParams,console,
    document:{readyState:'loading',addEventListener(){},getElementById:id=>nodes.get(id)||null}};
  vm.createContext(context);vm.runInContext(source,context);
  const engine=context.window[name];
  const control={value:'5',dataset:{}};nodes.set(`${prefix}_inputLiveMaxTranches`,control);
  for(const value of ['1','6','10','20','100','unlimited']) {
    control.value=value;
    const limit=engine.liveStrategyPayload().max_tranches;
    assert.equal(limit,value==='unlimited'?null:Number(value));
    assert.equal(engine.entryCountLabel(limit),value==='unlimited'?'Unlimited':value);
  }
  nodes.delete(`${prefix}_inputLiveMaxTranches`);
  engine.botState={max_tranches:null};
  assert.equal(engine.liveStrategyPayload().max_tranches,null,'saved Unlimited must survive before controls mount');
  assert.equal(engine.entryCountLabel(),'Unlimited');
}
console.log('Both crypto terminals offer 1–100 and Unlimited with correct configuration payloads');
