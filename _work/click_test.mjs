// 忠实模拟浏览器环境，直接加载 main.js 并触发菜单「行走」点击，
// 定位「死按钮」的确切原因。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WEB = "E:/work/deskpet/M3/desktop-pet/web";
const manifest = JSON.parse(readFileSync(path.join(WEB, 'assets', 'actions.json'), 'utf8'));

const errors = [];
const warnings = [];

/* ---------- DOM 桩 ---------- */
function makeCtx() {
  return { clearRect(){}, drawImage(){}, globalAlpha:1,
           getImageData(){ return { data:new Uint8ClampedArray(4) }; } };
}

const elHandlers = new Map();
function on(el, type, fn) {
  if (!el.__h) el.__h = {};
  (el.__h[type] = el.__h[type] || []).push(fn);
}
function fire(el, type, ev = {}) {
  const hs = el.__h?.[type] || [];
  for (const h of hs) h({ stopPropagation(){}, preventDefault(){}, ...ev });
}

const canvasEl = {
  width:906, height:704, style:{},
  getContext:()=>makeCtx(),
  addEventListener:(t,f)=>on(canvasEl,t,f),
};

// 菜单项：与 index.html 一致
const CMDS = ['idle','move','rest','click','play','pause','top','scale:0.25','center','quit'];
const menuItems = CMDS.map(cmd => {
  const el = { dataset:{ cmd }, style:{}, addEventListener:(t,f)=>on(el,t,f) };
  return el;
});

const menuEl = {
  style:{ display:'none' }, __h:{},
  offsetWidth:168, offsetHeight:260,
  contains:()=>true,
  querySelectorAll:(sel)=> sel === '[data-cmd]' ? menuItems : [],
  addEventListener:(t,f)=>on(menuEl,t,f),
};

globalThis.document = {
  getElementById:(id)=> id==='stage' ? canvasEl : id==='menu' ? menuEl : null,
  body:{ innerHTML:'' },
  querySelectorAll:()=>[],
  createElement:()=>({ getContext:()=>makeCtx(), width:0, height:0 }),
};

const winH = {};
globalThis.window = {
  innerWidth:317, innerHeight:246,
  addEventListener:(t,f)=>{ (winH[t]=winH[t]||[]).push(f); },
  __TAURI__: { core: { invoke: async (cmd) => {
    // 模拟 Rust 侧返回值
    if (cmd === 'get_config') return { x:100, y:100, scale:0.35, always_on_top:true };
    if (cmd === 'get_screen_info') return {
      work_x:0, work_y:0, work_w:1536, work_h:912,
      win_x:600, win_y:640, win_w:317, win_h:246 };
    if (cmd === 'drag_end') return false;
    return null;
  } } },
};

let NOW = 0;
globalThis.performance = { now: () => NOW };

globalThis.Image = class {
  constructor(){ this.src=''; this.naturalWidth=906; this.naturalHeight=704; }
  decode(){ return Promise.resolve(); }
};

globalThis.fetch = async (url) => {
  if (String(url).includes('actions.json'))
    return { ok:true, status:200, json: async()=>manifest };
  return { ok:false, status:404, json:async()=>({}) };
};

let rafCb = null;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.setInterval = () => 0;   // 看门狗不参与本次测试

const origWarn = console.warn, origErr = console.error;
console.warn = (...a)=>{ warnings.push(a.join(' ')); };
console.error = (...a)=>{ errors.push(a.join(' ')); };

/* ---------- 加载 main.js ---------- */
const brainSrc = readFileSync(path.join(WEB,'brain.js'),'utf8')
  .replace(/export const/g,'const').replace(/export class/g,'class');
const mainSrc = readFileSync(path.join(WEB,'main.js'),'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/brain\.js['"];?/,'');

try {
  new Function(brainSrc + '\n' + mainSrc + '\n//# sourceURL=combined.js')();
} catch (e) {
  console.log('加载期异常:', e.message);
}

// 等待 boot 的异步流程完成
await new Promise(r => setTimeout(r, 300));

/* ---------- 检查初始状态 ---------- */
const w = globalThis.window;
console.log('=== boot 后状态 ===');
console.log('  __ready =', w.__ready);
console.log('  __bootError =', w.__bootError || '(无)');
console.log('  __manifest 已载入 =', !!w.__manifest);

// 打开诊断输出（main.js 会写 window.__diag）
w.__diagOn = true;

// 驱动若干帧，让状态机起步
NOW = 0;
for (let i = 0; i < 5; i++) { NOW += 16; if (rafCb) { const cb = rafCb; rafCb = null; try { cb(NOW); } catch(e){ errors.push('loop: '+e.message); } } }

/* ---------- 触发菜单「行走」点击 ---------- */
const moveItem = menuItems.find(m => m.dataset.cmd === 'move');
console.log('\n=== 模拟点击「行走」 ===');
console.log('  找到菜单项 =', !!moveItem);

const before = { current: null };
try {
  // 读取当前显示动作（通过诊断或 window）
  before.current = w.__diag ? w.__diag.action : null;
} catch {}

fire(moveItem, 'click');

await new Promise(r => setTimeout(r, 200));

// 再推进几帧
for (let i = 0; i < 60; i++) { NOW += 16; if (rafCb) { const cb = rafCb; rafCb = null; try { cb(NOW); } catch(e){ errors.push('loop: '+e.message); } } }

const diag = w.__diag;
console.log('  点击后诊断:', JSON.stringify(diag));
console.log('  brain.state =', w.__brain?.state);
console.log('  brain.until =', w.__brain?.until);

/* ---------- 结果 ---------- */
console.log('\n=== console 输出 ===');
console.log('  warnings:', warnings.length ? warnings : '(无)');
console.log('  errors  :', errors.length ? errors : '(无)');

// 关键判定：点击后是否切到了 move
const ok = diag && diag.action === 'move';
console.log(`\n判定: 点击「行走」后显示动作 = ${diag ? diag.action : '未知'}  ${ok ? '✓ 生效' : '✗ 未生效（死按钮）'}`);
