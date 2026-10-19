const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const common = require('../terminal-common.js');
function section(id, parent=null) {
  const classes=new Set(['collapsible-section','is-collapsed']);
  const arrow={disabled:true,setAttribute(name,value){this[name]=value;}};
  return {id,parentElement:parent,arrow,querySelector(){return arrow;},
    classList:{contains:name=>classes.has(name),remove:name=>classes.delete(name)}};
}
const parent=section('terminal'), child=section('chart',parent);
common.revealChartSection(child);
for (const node of [parent,child]) {
  assert(!node.classList.contains('is-collapsed'), 'saved chart and ancestor collapse must be removed');
  assert.equal(node.arrow.disabled,false);
  assert.equal(node.arrow['aria-expanded'],'true');
}
for (const [file,name,tab] of [['lighter-tab.js','lighterEngine','Lighter'],
  ['crypto-tab.js','cryptoEngine','Crypto'], ['lighter-crypto-tab.js','lighterCryptoEngine','LighterCrypto']]) {
  const arrow={disabled:true,classList:{contains: name=>name==='section-collapse-btn'}};
  const order={disabled:false,classList:{contains:()=>false}};
  const root={dataset:{terminalInstance:tab[0].toLowerCase()+tab.slice(1)},
    querySelectorAll(selector){return selector==='button,input,select'?[arrow,order]:[];}};
  const context={window:{TerminalCommon:common},console,URLSearchParams,
    document:{readyState:'loading',addEventListener(){},getElementById(id){return id===`tabContent${tab}`?root:null;}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const engine=context.window[name];
  engine.labelTerminal=()=>{};engine.applyMode=()=>{};
  engine.renderVirtualState=()=>{};engine.syncBotStatus=()=>{};
  engine.init();
  assert.equal(arrow.disabled,false,`${file}: viewing controls work in read-only mode`);
  assert.equal(order.disabled,true,`${file}: order controls remain locked`);
}
console.log('Saved chart/ancestor visibility and safe expand controls passed');
