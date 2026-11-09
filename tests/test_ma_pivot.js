const assert=require('node:assert/strict');
const fs=require('node:fs');
const common=require('../terminal-common.js');
for(const fixture of require('./fixtures/ma_pivot_cases.json')) {
 const points=fixture.values.map((value,time)=>({time,value}));
 const result=common.maPivotAnalysis(points,points.length-1,points.length,fixture.minimum);
 for(const [expected,key] of [['ready','ready'],['up','up_count'],['down','down_count'],['long','long_pass'],['short','short_pass'],['last','last_arrow']]) assert.equal(result[key],fixture[expected],fixture.name+' '+key);
 const causal=common.maPivotAnalysis([...points,{time:points.length,value:100000}],points.length-1,points.length,fixture.minimum);
 assert.deepEqual(causal,result,'future candles cannot change a past guide condition');
}
assert.equal(common.maPivotAnalysis([{time:1,value:1}],1,3).ready,false);
let primitive;
const chart={timeScale:()=>({timeToCoordinate:t=>t*10})};
const series={attachPrimitive:p=>{primitive=p;},priceToCoordinate:v=>1000-v};
const guides=common.createMaExtremumHoverSeries(chart,{7:'#000'},2,series);
const data=[101,100,103,103.2,106.8,107,110].map((value,time)=>({time,value}));
const settings={use_ma_pivot_direction:true,ma_pivot_period:7,ma_pivot_lookback:7,ma_pivot_min_arrows:2};
common.renderMaExtremumHover(guides,{7:data},6,{},settings);
const ctx={save(){},restore(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){}};
const draw=()=>primitive.paneViews()[0].renderer().draw({useMediaCoordinateSpace:cb=>cb({context:ctx})});
draw();
assert.deepEqual(guides[7].intersections().map(c=>c.direction),['up','down','up'],'visible arrows match the engine condition geometry');
const before=guides[7].intersections();
chart.timeScale=()=>({timeToCoordinate:t=>t*20});draw();
guides[7].intersections().forEach((c,i)=>assert.equal(c.x,before[i].x*2));
common.renderMaExtremumHover(guides,{7:data},6,{}, {...settings,ma_pivot_lookback:8});draw();
assert.deepEqual(guides[7].data(),[],'no misleading selected guide before configured warmup');
console.log('MA pivot canonical geometry, causal history and native arrows passed');
// Forming candles cannot change the optional condition's selected guide.
common.renderMaExtremumHover(guides,{7:[...data,{time:7,value:1000}]},7,{}, {...settings,completedBefore:6});
assert.deepEqual(guides[7].data(),[data[1],data[6]]);
// Replay drafts survive rerender/reload while Match Live deliberately replaces them.
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
for(const prefix of ['crypto_','lighterCrypto_']) {
 const store=new Map();
 const {window,document}=parseHTML('<html><body><main></main></body></html>');
 const context={window,document,console,localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('terminal-common.js','utf8'),context);
 const ui=window.TerminalCommon,host=document.querySelector('main');
 host.innerHTML=ui.renderMaProximityControls(prefix,{});ui.bindMaPivotControls(prefix);
 const count=document.getElementById(prefix+'maPivotLookback');count.value='30';count.dispatchEvent(new window.Event('input'));
 host.innerHTML=ui.renderMaProximityControls(prefix,{ma_pivot_lookback:120});
 assert.equal(document.getElementById(prefix+'maPivotLookback').value,'30','local draft survives rerender');
 ui.syncMaPivotControls(prefix,{strategy_mode:'ma_proximity',strategy_params:{ma_pivot_lookback:90}});
 assert.equal(document.getElementById(prefix+'maPivotLookback').value,'30','polling preserves draft');
 Object.defineProperty(document.getElementById(prefix+'maPivotPeriod'),'value',{value:'24',writable:true,configurable:true});
 ui.syncMaPivotControls(prefix,{strategy_mode:'ma_proximity',strategy_params:{ma_pivot_lookback:90}},true);
 assert.equal(document.getElementById(prefix+'maPivotLookback').value,'90','match live replaces draft');
 assert.equal(store.has(prefix+'maPivotDraft'),false);
 const config={...ui.maPivotSettings(prefix),use_ma_pivot_direction:true};
 ui.renderMaPivotStatus(prefix,'Live',{ma_pivot:{rule:"last_arrow_v1",ready:true,period:7,lookback:120,min_arrows:1,long_pass:true,short_pass:true}},config,100000,true);
 assert.equal(document.getElementById(prefix+'maPivotLongLive').textContent,'LIVE · UNAVAILABLE','old parameter counts cannot pass a new setting');
 assert.match(document.getElementById(prefix+'maPivotLiveSource').textContent,/parameters changed/i);
 ui.renderMaPivotStatus(prefix,'Live',{ma_pivot:{ready:true,period:24,lookback:90,long_pass:true,short_pass:true}},config,100000,true);
 assert.equal(document.getElementById(prefix+'maPivotLongLive').textContent,'LIVE · UNAVAILABLE','pre-migration any-arrow verdict cannot be reused');
}
console.log('MA pivot replay draft persistence and Match Live passed');
