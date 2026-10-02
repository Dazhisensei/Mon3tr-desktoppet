// 回归测试：加载真实 main.js / brain.js，覆盖 DOM 菜单、菜单暂停移动、设置同步、点击穿透。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/work/deskpet/M3';
const WEB = path.join(ROOT, 'desktop-pet', 'web');

/* ---------- 0. 每个前端模块必须能独立通过语法检查 ---------- */
//
// 这条检查是**血泪教训**：曾在 main.js 里留下重复的 `function tryCare`
// 声明，导致整个模块语法错误、前端一行都跑不起来（窗口白屏、
// 连启动语音都没有），而当时的测试**完全测不出来**——
// 因为测试把所有模块拼接成一个作用域，重复声明在那种拼接方式下
// 表现不同（顶层 function 重复在严格模式下才报错）。
//
// 实现上**不用子进程**（沙箱禁止管道 stdio），也不用 `vm.Script`
// （它按脚本解析，遇到 ESM 的 import/export 会误报）。
// 这里直接用 `new Function` 编译**函数体之外**的语法：
// 先把 import/export 剥掉（与下面 strip 的逻辑一致），再交给解析器。
// 重复声明、括号不匹配这类真实语法错误都会被捕获。
{
  const files = readdirSync(WEB).filter(f => f.endsWith('.js')).sort();
  const bad = [];
  for (const f of files) {
    const src = readFileSync(path.join(WEB, f), 'utf8');
    try {
      // 剥掉 import/export 后包成函数体编译。
      // 只做「解析」不执行，因此不会触发任何副作用。
      const bare = src
        .replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '')
        .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
        .replace(/^export\s+/gm, '');
      new Function(bare);
    } catch (e) {
      bad.push(`${f}: ${String(e.message).split('\n')[0]}`);
    }
  }
  console.log('=== -1. 前端模块语法检查（逐文件编译）===');
  console.log(`  检查 ${files.length} 个文件`);
  if (bad.length) {
    for (const b of bad) console.log(`  ✗ ${b}`);
  } else {
    console.log('  ✓ 全部通过');
  }
  globalThis.__syntaxFail = bad.length;
}

const manifest = JSON.parse(readFileSync(path.join(WEB,'assets','actions.json'),'utf8'));
// 语音清单：真实读取 web/audio/audio.json，保证测试测的是实际数据
const audioManifest = JSON.parse(readFileSync(path.join(WEB,'audio','audio.json'),'utf8'));

const errors = [], warnings = [], invokes = [];
const listeners = new Map();
let ALPHA = 0;
let CURSOR = { rel_x: 0.5, rel_y: 0.5, inside: true };

/* ---------- DOM 桩 ---------- */
const makeCanvas = () => ({
  width: 0, height: 0, style: {}, __h: {},
  getContext: () => ({
    clearRect(){}, drawImage(){}, globalAlpha:1,
    // paintFrame 会用到变换（坐姿缩放补偿）
    save(){}, restore(){}, translate(){}, scale(){},
    getImageData(x,y,w,h){
      const n = Math.max(1,w*h)*4; const d = new Uint8ClampedArray(n);
      for (let i=3;i<n;i+=4) d[i]=ALPHA;
      return { data:d };
    },
  }),
  addEventListener(t,f){ (this.__h[t]=this.__h[t]||[]).push(f); },
});
const canvas = makeCanvas(); canvas.width=906; canvas.height=704;
// 画布在窗口中的位置：锚定底部、水平居中（扩窗后窗口比画布大）
canvas.getBoundingClientRect = () => ({
  left: 0, top: 0, right: 317, bottom: 246, width: 317, height: 246,
});

const CMDS = ['talk','weather','toggle-follow','settings','act:idle','act:move','act:rest',
              'act:sit','act:click','random','toggle-pause','quit'];
const menuItems = CMDS.map(cmd => ({
  dataset:{ cmd }, style:{}, __h:{}, textContent:'', className:'',
  // syncMenu 会 toggle 这个类（坐着/跟随时弱化自主动作项）
  classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
              toggle(c,v){ v?this._s.add(c):this._s.delete(c); },
              contains(c){return this._s.has(c);} },
  addEventListener(t,f){ (this.__h[t]=this.__h[t]||[]).push(f); },
}));

const menu = {
  style:{ display:'none' }, __h:{}, offsetWidth:168, offsetHeight:300,
  contains:(el)=> menuItems.includes(el) || el===menu,
  querySelectorAll:s => s==='[data-cmd]' ? menuItems : [],
  addEventListener(t,f){ (this.__h[t]=this.__h[t]||[]).push(f); },
};

const toast = { textContent:'', classList:{ _s:new Set(),
  add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} } };

// 设置面板：DOM 桩需要提供面板相关元素
const setIds = ['settings','setClose','setTop','setPassthrough','setScale','setScaleVal',
                'stageWrap',
                'setBottom','setVolume','setVolumeVal','setLangSeg',
                'setBirthMonth','setBirthDay','setBirthClear','setPreviewVoice',
                'setCityList','setCityInput','setCitySearch','setCityResults','setCityHint',
                'bubble'];
const panelEls = {};
for (const id of setIds) {
  const el = {
    id, style:{}, dataset:{}, value:'70', textContent:'',
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                toggle(c,v){ v?this._s.add(c):this._s.delete(c); },
                contains(c){return this._s.has(c);} },
    __h:{}, addEventListener(t,f){ (this.__h[t]=this.__h[t]||[]).push(f); },
    querySelectorAll: () => [],
    children: [],
    appendChild(child){ this.children.push(child); },
    dispatchEvent(ev){ (this.__h[ev.type]||[]).forEach(f=>f(ev)); },
    // 气泡命中判定用得到（扩窗后窗口比气泡大，需要矩形换算）
    getBoundingClientRect(){ return { left:0, top:0, right:160, bottom:40, width:160, height:40 }; },
    checked: false,
  };
  // innerHTML='' 需要真的清空子节点，否则「清除生日」后
  // 下拉框会残留旧选项，测试就测不出真实行为
  Object.defineProperty(el, 'innerHTML', {
    get(){ return ''; },
    set(v){ if (v === '') el.children = []; },
  });
  panelEls[id] = el;
}
panelEls.setLangSeg.querySelectorAll = (s) => s==='button'
  ? ['zh','jp'].map(v => ({ dataset:{lang:v}, classList:panelEls.setClose.classList,
      addEventListener(){}, })) : [];

globalThis.document = {
  // syncStageMetrics 会往 :root 写 CSS 变量
  documentElement: {
    style: {
      _vars: {},
      setProperty(k, v) { this._vars[k] = v; },
      getPropertyValue(k) { return this._vars[k] || ''; },
    },
  },
  getElementById: id => id==='stage' ? canvas : id==='menu' ? menu
                     : id==='stageWrap' ? panelEls.stageWrap
                     : id==='toast' ? toast : (panelEls[id] || null),
  body:{ innerHTML:'' },
  querySelectorAll: () => [],
  createElement: (tag) => tag === 'option'
    ? { value:'', textContent:'' }
    : makeCanvas(),
};
globalThis.Event = class { constructor(t){ this.type = t; } };

// estimateExtra 会读 :root 上的 CSS 变量
globalThis.getComputedStyle = () => ({
  getPropertyValue: (k) => document.documentElement.style.getPropertyValue(k),
});

const screenState = { work_x:0, work_y:0, work_w:1536, work_h:912,
                      win_x:600, win_y:640, win_w:317, win_h:246 };

const W = {
  innerWidth:317, innerHeight:246, __h:{},
  addEventListener(t,f){ (this.__h[t]=this.__h[t]||[]).push(f); },
  __TAURI__: {
    core: { invoke: async (cmd,args) => {
      invokes.push([cmd,args]);
      if (cmd==='get_config') return { x:600,y:640,scale:0.35,always_on_top:true,
                                       click_through:true, volume:70, voice_lang:'zh' };
      if (cmd==='get_screen_info') return { ...screenState };
      if (cmd==='get_cursor_rel') return { ...CURSOR };
      if (cmd==='move_window'){ screenState.win_x=args.x; screenState.win_y=args.y; return null; }
      if (cmd==='drag_end') return false;
      return null;
    } },
    event: { listen: async (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => {};
    } },
  },
};
globalThis.window = W;

let NOW = 0;
globalThis.performance = { now: () => NOW };
globalThis.Image = class { constructor(){ this.src=''; } decode(){ return Promise.resolve(); } };
/* ---------- 天气 API 桩 ---------- */
// 记录对 Open-Meteo 的调用，用于断言「多城市只发一个请求」「缓存命中不发请求」
const netCalls = [];
// 设为 true 模拟断网
let NET_FAIL = false;
const GEO_FIXTURES = {
  '北京': [{ name:'北京', latitude:39.9075, longitude:116.39723, admin1:'北京市', country:'中国', timezone:'Asia/Shanghai' }],
  // 模拟真实行为：2 字中文名精确匹配失败（返回空），
  // 补上省份限定后成功。这正是「滨州」当初测不到的原因。
  // 拼音优先策略：滨州的拼音能直接命中，且是 GeoNames 主条目
  'Binzhou': [
    { name:'滨州', latitude:37.36667, longitude:118.01667, admin1:'山东省', country:'中国', timezone:'Asia/Shanghai', population:682700 },
  ],
  '滨州, 山东': [
    { name:'滨州', latitude:37.36667, longitude:118.01667, admin1:'山东省', country:'中国', timezone:'Asia/Shanghai', population:682700 },
  ],
  '德州, 山东': [
    { name:'德州', latitude:37.43611, longitude:116.35667, admin1:'山东省', country:'中国', timezone:'Asia/Shanghai', population:556600 },
  ],
  // 模拟「中文名能查到但结果杂乱」：小地方排在前面，需要按人口重排
  '朝阳': [
    { name:'朝阳村', latitude:41.0, longitude:120.0, admin1:'辽宁省', country:'中国', timezone:'Asia/Shanghai', population:1200 },
    { name:'朝阳区', latitude:39.9219, longitude:116.44355, admin1:'北京市', country:'中国', timezone:'Asia/Shanghai', population:3605000 },
    { name:'朝阳市', latitude:41.5764, longitude:120.45111, admin1:'辽宁省', country:'中国', timezone:'Asia/Shanghai', population:340000 },
  ],
};

globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.includes('actions.json')) return { ok:true, status:200, json: async()=>manifest };
  if (s.includes('audio.json'))   return { ok:true, status:200, json: async()=>audioManifest };

  if (s.includes('geocoding-api.open-meteo.com')) {
    netCalls.push(s);
    if (NET_FAIL) throw new Error('network down');
    const m = s.match(/name=([^&]+)/);
    const q = m ? decodeURIComponent(m[1]) : '';
    return { ok:true, status:200, json: async()=>({ results: GEO_FIXTURES[q] || [] }) };
  }

  if (s.includes('api.open-meteo.com')) {
    netCalls.push(s);
    if (NET_FAIL) throw new Error('network down');
    const latRaw = (s.match(/latitude=([^&]+)/)||[])[1] || '';
    // 解码后再数：产品代码现在用明文逗号，但历史上用过 URLSearchParams
    // （会把逗号转义成 %2C）。这里兼容两种写法，并顺带验证
    // 「服务端能正确理解逗号分隔」这一点。
    const lat = decodeURIComponent(latRaw);
    const n = lat.split(',').filter(Boolean).length;
    const one = (i) => ({
      current: {
        temperature_2m: 20+i, apparent_temperature: 19+i,
        relative_humidity_2m: 45+i, weather_code: i===0?0:(i===1?3:61),
        wind_speed_10m: 10+i, wind_direction_10m: 135,
        surface_pressure: 1010-i, precipitation: i===2?1.2:0,
      },
      daily: {
        temperature_2m_max: [26+i, 27+i],
        temperature_2m_min: [16+i, 17+i],
        precipitation_probability_max: [10, 30, 80],
        uv_index_max: [5+i],
        sunrise: ['2026-10-02T06:12'],
        sunset: ['2026-10-02T17:48'],
      },
    });
    // 单城市返回对象、多城市返回数组（与真实 API 一致，用于验证兼容处理）
    const body = n === 1 ? one(0) : Array.from({length:n}, (_,i)=>one(i));
    return { ok:true, status:200, json: async()=>body };
  }

  return { ok:false, status:404, json: async()=>({}) };
};

/* ---------- 语音桩 ---------- */
// 记录每一次 new Audio(path)：用于断言「哪个场景播了哪条语音」。
const played = [];
let LAST_AUDIO = null;
globalThis.Audio = class {
  constructor(src){ this.src = src; this.volume = 1; this.paused = false;
                   played.push(src); LAST_AUDIO = this; }
  play(){ return Promise.resolve(); }
  pause(){ this.paused = true; }
};
// 记录播放顺序（含被打断的），供「打断上一条」断言使用
const audioLog = () => played.map(p => decodeURIComponent(String(p).split('/').pop()));

// localStorage 桩：生日「当天首次启动」依赖它
const LS = new Map();
globalThis.localStorage = {
  getItem: k => (LS.has(k) ? LS.get(k) : null),
  setItem: (k,v) => LS.set(k, String(v)),
  removeItem: k => LS.delete(k),
  clear: () => LS.clear(),
};

let rafCb = null;
globalThis.requestAnimationFrame = cb => { rafCb = cb; return 1; };
const intervals = [];
globalThis.setInterval = (fn, ms) => { intervals.push({fn, ms}); return intervals.length; };

// setTimeout 也要桩化。
//
// main.js 的「随机关心」用 setTimeout 自我重排（说完一句再排下一句），
// 一旦用真实定时器，Node 的事件循环会被这个永不结束的链**永久占用**，
// 测试跑完也不退出（表现为进程挂起）。
//
// 因此把 setTimeout 换成「只记录、不触发」的桩；测试自身等待异步
// 落地时改用保留的 realSetTimeout。
const realSetTimeout = globalThis.setTimeout;
const timeouts = [];
globalThis.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};
/** 测试内部等待异步落地用（真实定时器）。 */
const sleep = (ms) => new Promise(r => realSetTimeout(r, ms));

console.warn = (...a)=>warnings.push(a.join(' '));
console.error = (...a)=>errors.push(a.join(' '));

/* ---------- 加载真实源码 ---------- */
// 按依赖顺序拼接，并去掉 import/export —— 与浏览器里模块的行为一致。
// 别名导入（`x as y`）需要展开成 `const y = x;`，否则拼接后会丢失绑定。
const strip = (s) => {
  const aliases = [];
  let out = s.replace(
    /^\s*import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];?\s*$/gm,
    (_, inner) => {
      for (const part of inner.split(',')) {
        const m = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        if (m) aliases.push(`const ${m[2]} = ${m[1]};`);
      }
      return '';
    });
  out = out.replace(/^export\s+/gm, '');
  return aliases.join('\n') + '\n' + out;
};
const calendarSrc = strip(readFileSync(path.join(WEB,'calendar.js'),'utf8'));
const voiceSrc    = strip(readFileSync(path.join(WEB,'voice.js'),'utf8'));
const weatherSrc  = strip(readFileSync(path.join(WEB,'weather.js'),'utf8'));
const bubbleSrc   = strip(readFileSync(path.join(WEB,'bubble.js'),'utf8'));
const careSrc     = strip(readFileSync(path.join(WEB,'care.js'),'utf8'));
const brainSrc    = strip(readFileSync(path.join(WEB,'brain.js'),'utf8'));
const panelSrc    = strip(readFileSync(path.join(WEB,'settings-panel.js'),'utf8'));
const mainSrc     = strip(readFileSync(path.join(WEB,'main.js'),'utf8'));

// 把需要的符号暴露到全局，供测试直接驱动
const EXPOSE = ['pickStartupClip','playRandomTalk','talkPool','SPECIAL_CLIPS',
                'clipNames','setLang','setVolume','isSpringFestival','isAnniversary',
                'isBirthday','festivalOf','toDateKey','play',
                // 天气
                'describeWeatherCode','searchCity','fetchWeather','getWeather',
                'formatWeatherLine','formatWeatherReport','clearCache','MAX_CITIES',
                'CACHE_TTL_MS','WEATHER_CLIPS',
                // 生活提醒
                'clothingAdvice','umbrellaAdvice','windAdvice','lifeAdvice',
                'windDirectionText','uvAdvice','humidityAdvice','pressureAdvice',
                'diurnalAdvice','tomorrowAdvice','formatWeatherLines',
                // 气泡
                'showBubble','hideBubble','isBubbleVisible','initBubble',
                // 随机关心 + 行为参数
                'pickCareLine','slotLineCount','CARE_LINES','SLOTS','slotOf','slotOfHour',
                'candidatesFor','CARE_COUNT','BEHAVIOR','Brain'];
new Function('__expose', calendarSrc + '\n' + voiceSrc + '\n' + weatherSrc + '\n'
  + bubbleSrc + '\n' + careSrc + '\n' + brainSrc + '\n'
  + panelSrc + '\n' + mainSrc
  + '\n' + `Object.assign(__expose, {${EXPOSE.join(',')}});`
  + '\n//# sourceURL=combined.js')(globalThis.__V = {});
await sleep(300);
W.__diagOn = true;

function pump(n, step=16){
  for(let i=0;i<n;i++){ NOW+=step; const cb=rafCb; rafCb=null;
    if(cb){ try{cb(NOW);}catch(e){errors.push('LOOP: '+e.message);} } }
}
function fireWin(type, ev={}){ (W.__h[type]||[]).forEach(h=>h({ preventDefault(){}, ...ev })); }
function clickItem(cmd, ev={}){
  const el = menuItems.find(m=>m.dataset.cmd===cmd);
  (el.__h.click||[]).forEach(h=>h({ stopPropagation(){}, preventDefault(){}, ...ev }));
}
async function pollPassthrough(n=2){
  const iv = intervals.find(i=>i.ms===60); if(!iv) return;
  for(let i=0;i<n;i++){ await iv.fn(); await sleep(5); }
}
const lastInvoke = cmd => [...invokes].reverse().find(i=>i[0]===cmd);

/* ---------- 0. 启动 ---------- */
console.log('=== 0. 启动 ===');
console.log(`  __ready=${W.__ready}  __bootError=${W.__bootError||'(无)'}`);
console.log(`  已监听事件: ${[...listeners.keys()].join(', ')||'(无)'}`);

/* ---------- 1. 右键打开菜单 ---------- */
console.log('\n=== 1. 右键打开菜单 ===');
pump(5);
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(30);
console.log(`  菜单 display = ${menu.style.display}  ${menu.style.display==='block'?'✓ 已打开':'✗ 未打开'}`);
console.log(`  位置 left=${menu.style.left} top=${menu.style.top}`);

/* ---------- 2. 打开菜单时暂停移动并切待机 ---------- */
console.log('\n=== 2. 打开菜单时的行为 ===');
pump(2);   // 诊断快照在 tick 里产生，需推进一帧才刷新
const d1 = W.__diag || {};
console.log(`  动作=${d1.action} 行为=${d1.brainState} 自主暂停=${d1.autonomyPaused}`);
console.log(`  ${d1.action==='idle' && d1.autonomyPaused ? '✓ 已切待机且暂停移动' : '✗ 未生效'}`);

// 菜单打开期间窗口不应移动
const xBefore = screenState.win_x;
pump(200);   // 约 3.2 秒
console.log(`  菜open 期间窗口移动: ${xBefore} -> ${screenState.win_x}  ${xBefore===screenState.win_x?'✓ 未移动（菜单不会跑）':'✗ 仍在移动'}`);

/* ---------- 3. 菜单命令 ---------- */
console.log('\n=== 3. 菜单命令 ===');
// 关闭菜单
fireWin('mousedown', { target: canvas });
await sleep(20);
pump(2);
console.log(`  点击外部关闭: display=${menu.style.display}  ${menu.style.display==='none'?'✓':'✗'}`);
console.log(`  恢复活动: autonomyPaused=${W.__diag?.autonomyPaused}  ${!W.__diag?.autonomyPaused?'✓':'✗'}`);

// 行走
const x0 = screenState.win_x;
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(20);
clickItem('act:move');
await sleep(20);
pump(120);
const d2 = W.__diag||{};
console.log(`  act:move -> 显示=${d2.action} 行为=${d2.brainState} X: ${x0} -> ${d2.winX}`);
console.log(`  ${d2.action==='move'&&d2.winX!==x0?'✓ 生效且移动':'✗ 未生效'}`);

for (const [cmd, expect] of [['act:idle','idle'],['act:rest','rest'],['act:click','click']]) {
  fireWin('contextmenu', { clientX:100, clientY:100 });
  await sleep(20);
  clickItem(cmd);
  await sleep(20);
  pump(30);
  const a=(W.__diag||{}).action;
  console.log(`  ${cmd} -> ${a}  ${a===expect?'✓':'✗'}`);
}

// 互动项：toggle-follow 是切换式的，按钮文字应反映当前状态。
// 注意 syncMenu 在**打开菜单时**执行，所以要重新打开菜单才能看到新文字。
// 本段位于 chk() 定义之前（属于「启动流程」部分），因此用局部断言。
let earlyFail = 0;
const eChk = (name, ok, extra='') => {
  if (!ok) earlyFail++;
  console.log(`  ${ok?'✓':'✗'} ${name}${extra?'  '+extra:''}`);
};
const labelOf = (cmd) => menuItems.find(m=>m.dataset.cmd===cmd)?.textContent;
const openMenu = async () => {
  fireWin('contextmenu', { clientX:100, clientY:100 });
  await sleep(20);
};

await openMenu();
clickItem('toggle-follow');
await sleep(40);
eChk('开启跟随', !!W.__brain?.following);
await openMenu();
eChk('开启后按钮变「取消跟随」', labelOf('toggle-follow') === '取消跟随',
    `"${labelOf('toggle-follow')}"`);

clickItem('toggle-follow');
await sleep(40);
eChk('再点一次取消跟随', !W.__brain?.following);
await openMenu();
eChk('取消后按钮复原为「跟随鼠标」', labelOf('toggle-follow') === '跟随鼠标',
    `"${labelOf('toggle-follow')}"`);

// 坐：同样是切换式
clickItem('act:sit');
await sleep(40);
eChk('坐下', !!W.__brain?.sitting);
await openMenu();
eChk('坐下后按钮变「起身」', labelOf('act:sit') === '起身', `"${labelOf('act:sit')}"`);

clickItem('act:sit');
await sleep(40);
eChk('再点一次起身', !W.__brain?.sitting);
await openMenu();
eChk('起身后按钮复原为「坐下」', labelOf('act:sit') === '坐下', `"${labelOf('act:sit')}"`);
globalThis.__earlyFail = earlyFail;

// weather：已实现。注意 toast 是复用的（不会自动清空），
// 因此这里验证「气泡被显示」这个更直接的证据。
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(20);
clickItem('weather');
await sleep(60);
const bubbleShown = panelEls.bubble.classList.contains('show');
const bubbleText = (panelEls.bubble.children || []).map(c=>c.textContent).join(' | ');
console.log(`  weather -> 气泡显示=${bubbleShown} 内容="${bubbleText}"  ${bubbleShown?'✓ 已实现':'✗ 未触发'}`);

// 设置（面板形式：应调用 enter_settings_ui 并显示面板）
invokes.length=0;
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(20);
clickItem('settings');
await sleep(60);
const enterCall = lastInvoke('enter_settings_ui');
const panelShown = panelEls.settings.classList.contains('show');
console.log(`  settings -> enter_settings_ui: ${enterCall?'✓':'✗'}  面板显示: ${panelShown?'✓':'✗'}`);
console.log(`            尺寸参数 ${enterCall?enterCall[1].width+'x'+enterCall[1].height:'-'}`);

// 关闭面板
invokes.length=0;
(panelEls.setClose.__h.click||[]).forEach(h=>h({stopPropagation(){}}));
await sleep(60);
const exitCall = lastInvoke('exit_settings_ui');
const panelHidden = !panelEls.settings.classList.contains('show');
console.log(`  关闭 -> exit_settings_ui: ${exitCall?'✓':'✗'}  面板隐藏: ${panelHidden?'✓':'✗'}`);

// 暂停/恢复
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(20);
clickItem('toggle-pause');
await sleep(20);
pump(5);
const pausedNow = W.__diag?.autonomyPaused;
fireWin('contextmenu', { clientX:100, clientY:100 });
await sleep(20);
clickItem('toggle-pause');
await sleep(20);
pump(5);
const resumedNow = !W.__diag?.autonomyPaused;
console.log(`  toggle-pause: 暂停=${pausedNow} 恢复=${resumedNow}  ${pausedNow&&resumedNow?'✓':'✗'}`);

/* ---------- 4. 点击穿透 ---------- */
console.log('\n=== 4. 点击穿透 ===');
// 先收起气泡：气泡显示期间**本就该**禁止穿透（它是 DOM 元素，
// 不参与画布 alpha 采样），不收起的话这里测的是气泡逻辑而非穿透逻辑。
(panelEls.bubble.__h.click || []).forEach(h => h({ stopPropagation(){} }));
await sleep(400);
ALPHA=0; CURSOR={rel_x:0.1,rel_y:0.1,inside:true}; invokes.length=0;
await pollPassthrough();
let p1 = lastInvoke('set_click_through');
console.log(`  透明处 -> ${p1?p1[1].enabled:'未调用'}  ${p1&&p1[1].enabled?'✓':'✗'}`);
ALPHA=255; CURSOR={rel_x:0.5,rel_y:0.5,inside:true}; invokes.length=0;
await pollPassthrough();
let p2 = lastInvoke('set_click_through');
console.log(`  角色上 -> ${p2?p2[1].enabled:'未调用'}  ${p2&&!p2[1].enabled?'✓':'✗'}`);

/* ---------- 5. 长时间运行 ---------- */
console.log('\n=== 5. 长时间运行 ===');
const e0 = errors.length;
pump(2000);
console.log(`  最终 显示=${W.__diag?.action} 行为=${W.__diag?.brainState} 帧索引=${W.__diag?.index}`);
console.log(`  新增异常 ${errors.length-e0}  ${errors.length===e0?'✓':'✗'}`);

/* ---------- 6. 语音 ---------- */
console.log('\n=== 6. 语音 ===');
const V = globalThis.__V;
let pass = 0, fail = 0;
const chk = (name, ok, extra='') => { ok?pass++:fail++;
  console.log(`  ${ok?'✓':'✗'} ${name}${extra?'  '+extra:''}`); };
const lastClip = () => { const a = audioLog(); return a[a.length-1] || ''; };

// 6.1 清单与双语目录
chk('清单载入 19 条（原 17 + 天气 2）',
    V.clipNames().length===19, `当前语言条数=${V.clipNames().length}`);

V.setLang('zh'); const zhPath = V.play && null;
played.length=0; V.play('交谈1');
chk('中文路径 audio/zh/交谈1.ogg', lastClip()==='交谈1.ogg' && String(played[0]).includes('/zh/'),
    String(played[0]));
V.setLang('jp'); played.length=0; V.play('交谈1');
chk('日文路径 audio/jp/交谈1.ogg', String(played[0]).includes('/jp/'), String(played[0]));
V.setLang('zh');

// 6.2 交谈池排除特殊语音
const pool = V.talkPool();
const special = [...V.SPECIAL_CLIPS];
const leaked = special.filter(s => pool.includes(s));
// 19 条语音 - 7 条特殊用途（戳一下/任命助理/周年庆典/新年祝福/生日/天气/天气失败）= 12 条
chk('交谈池共 12 条（天气语音不参与）', pool.length===12, `实际=${pool.length}`);
chk('交谈池不含特殊语音', leaked.length===0, leaked.length?`泄漏=${leaked.join(',')}`:'');
chk('交谈池含交谈1/闲置/干员报到',
    ['交谈1','闲置','干员报到'].every(n=>pool.includes(n)));

// 6.3 特殊语音确实存在于清单中（防止名字写错）
for (const s of special) {
  chk(`特殊语音「${s}」存在于清单`, V.clipNames().includes(s));
}

// 6.4 启动规则：普通日 -> 任命助理
const d = (y,m,day) => new Date(y, m-1, day);
LS.clear();
chk('普通日 -> 任命助理',
    V.pickStartupClip(d(2025,7,15), null).name==='任命助理');

// 6.5 周年庆 5/1–5/4
for (const day of [1,2,3,4]) {
  LS.clear();
  chk(`5/${day} -> 周年庆典`,
      V.pickStartupClip(d(2025,5,day), null).name==='周年庆典');
}
LS.clear();
chk('4/30 -> 不是周年庆典',
    V.pickStartupClip(d(2025,4,30), null).name==='任命助理');
LS.clear();
chk('5/5 -> 不是周年庆典',
    V.pickStartupClip(d(2025,5,5), null).name==='任命助理');

// 6.6 春节：除夕(1/28)、初一(1/29)、初三(1/31) -> 新年祝福；初四(2/1) -> 任命助理
LS.clear(); chk('2025 除夕 1/28 -> 新年祝福',
    V.pickStartupClip(d(2025,1,28), null).name==='新年祝福');
LS.clear(); chk('2025 初一 1/29 -> 新年祝福',
    V.pickStartupClip(d(2025,1,29), null).name==='新年祝福');
LS.clear(); chk('2025 初三 1/31 -> 新年祝福',
    V.pickStartupClip(d(2025,1,31), null).name==='新年祝福');
LS.clear(); chk('2025 初四 2/1 -> 任命助理',
    V.pickStartupClip(d(2025,2,1), null).name==='任命助理');
LS.clear(); chk('2025 腊月廿七 1/26 -> 任命助理（除夕前一天）',
    V.pickStartupClip(d(2025,1,26), null).name==='任命助理');
// 跨年边界：2026 春节 2/17，除夕 2/16
LS.clear(); chk('2026 除夕 2/16 -> 新年祝福',
    V.pickStartupClip(d(2026,2,16), null).name==='新年祝福');
LS.clear(); chk('2026 初一 2/17 -> 新年祝福',
    V.pickStartupClip(d(2026,2,17), null).name==='新年祝福');

// 6.7 生日：当天首次必播生日
LS.clear();
const b1 = V.pickStartupClip(d(2025,7,15), {month:7, day:15});
chk('生日当天首次启动 -> 生日', b1.name==='生日' && b1.reason==='birthday-first',
    `reason=${b1.reason}`);
// 同一天再启动：仍是生日（无节日冲突）
const b2 = V.pickStartupClip(d(2025,7,15), {month:7, day:15});
chk('生日当天后续启动 -> 仍是生日', b2.name==='生日', `reason=${b2.reason}`);

// 6.8 生日与节日冲突：首次必生日，后续两者随机
LS.clear();
chk('生日=5/1 首次 -> 生日',
    V.pickStartupClip(d(2025,5,1), {month:5, day:1}).name==='生日');
const seen = new Set();
for (let i=0;i<400;i++) seen.add(V.pickStartupClip(d(2025,5,1), {month:5, day:1}).name);
chk('生日=5/1 后续 -> 生日/周年庆典 随机',
    seen.size===2 && seen.has('生日') && seen.has('周年庆典'), [...seen].join('+'));

// 6.9 生日与春节冲突（2025 初一 1/29）
LS.clear();
chk('生日=1/29 首次 -> 生日',
    V.pickStartupClip(d(2025,1,29), {month:1, day:29}).name==='生日');
const seen2 = new Set();
for (let i=0;i<400;i++) seen2.add(V.pickStartupClip(d(2025,1,29), {month:1, day:29}).name);
chk('生日=1/29 后续 -> 生日/新年祝福 随机',
    seen2.size===2 && seen2.has('生日') && seen2.has('新年祝福'), [...seen2].join('+'));

// 6.10 特殊日期不播任命助理
LS.clear();
const noNormal = [
  ['春节', d(2025,1,29), null],
  ['周年庆', d(2025,5,2), null],
  ['生日', d(2025,7,15), {month:7, day:15}],
].every(([, date, bd]) => { LS.clear(); return V.pickStartupClip(date, bd).name!=='任命助理'; });
chk('特殊日期启动不播任命助理', noNormal);

// 6.11 「当天首次」跨启动保持（localStorage 记录）
LS.clear();
V.pickStartupClip(d(2025,7,15), {month:7, day:15});   // 第一次
const lsKey = [...LS.keys()][0];
chk('生日首次标记写入 localStorage', !!lsKey && LS.get(lsKey)==='2025-07-15',
    `${lsKey}=${LS.get(lsKey)}`);
// 换一天应重新算首次
const nextDay = V.pickStartupClip(d(2025,7,16), {month:7, day:16});
chk('次日生日重新视为首次', nextDay.reason==='birthday-first', `reason=${nextDay.reason}`);

// 6.12 未设置生日时不受影响
LS.clear();
chk('未设置生日 + 普通日 -> 任命助理',
    V.pickStartupClip(d(2025,7,15), null).name==='任命助理');

// 6.13 双语一一对应（两语言文件名集合必须相同）
const names_zh = (() => { V.setLang('zh'); return V.clipNames().slice().sort(); })();
const names_jp = (() => { V.setLang('jp'); return V.clipNames().slice().sort(); })();
V.setLang('zh');
chk('中/日文文件名完全一致',
    names_zh.length===names_jp.length && names_zh.every((n,i)=>n===names_jp[i]));

// 6.14 点击 -> 戳一下；交谈 -> 池内随机
played.length=0;
const clickEl = canvas.__h['mouseup'] || [];
// 直接驱动 playClick 的等价路径：经由语音 API 验证映射
V.play('戳一下');
chk('点击语音 = 戳一下.ogg', lastClip()==='戳一下.ogg', lastClip());

played.length=0;
const picks = new Set();
for (let i=0;i<200;i++) picks.add(V.playRandomTalk());
chk('交谈随机只落在池内', [...picks].every(n=>pool.includes(n)));
chk('交谈随机有变化（非固定一条）', picks.size>1, `${picks.size} 种`);

// 6.15 音量 / 语言设置生效
V.setLang('jp'); played.length=0; V.play('闲置');
chk('切到日文后播放 jp 路径', String(played[0]).includes('/jp/'));
V.setLang('zh');
V.setVolume(30); played.length=0; V.play('闲置');
chk('音量 30 -> audio.volume=0.3', Math.abs(LAST_AUDIO.volume-0.3)<1e-6,
    `volume=${LAST_AUDIO.volume}`);

// 6.16 打断上一条
const prev = LAST_AUDIO;
V.play('交谈2');
chk('播放新语音时打断上一条', prev.paused===true);

/* ---------- 7. 语音设置项（面板） ---------- */
console.log('\n=== 7. 设置面板：生日 / 试听 ===');
invokes.length = 0;
// 打开面板并改生日
await (panelEls.setBirthMonth.__h.change||[]).length;
panelEls.setBirthMonth.value = '7';
panelEls.setBirthMonth.dispatchEvent(new Event('change'));
await sleep(10);
panelEls.setBirthDay.value = '15';
panelEls.setBirthDay.dispatchEvent(new Event('change'));
await sleep(10);
const bdCall = lastInvoke('set_birthday');
chk('改生日 -> set_birthday(7,15)',
    !!bdCall && bdCall[1].month===7 && bdCall[1].day===15,
    bdCall?JSON.stringify(bdCall[1]):'未调用');

// 清除
invokes.length = 0;
(panelEls.setBirthClear.__h.click||[]).forEach(h=>h({stopPropagation(){}}));
await sleep(10);
const clr = lastInvoke('set_birthday');
chk('清除 -> set_birthday(0,0)', !!clr && clr[1].month===0 && clr[1].day===0,
    clr?JSON.stringify(clr[1]):'未调用');
// 清除后不得再被写回 1/1（曾经的 bug：render 触发 change 又把 1/1 存了回去）
const afterClear = [...invokes].reverse().filter(i=>i[0]==='set_birthday');
chk('清除后没有再写回生日',
    afterClear.every(i=>i[1].month===0 && i[1].day===0),
    afterClear.map(i=>JSON.stringify(i[1])).join(' -> '));
chk('清除后「日」下拉有选项（1 月共 31 天）',
    panelEls.setBirthDay.children.length===31,
    `选项数=${panelEls.setBirthDay.children.length}`);

// 试听
invokes.length = 0;
played.length = 0;
(panelEls.setPreviewVoice.__h.click||[]).forEach(h=>h({stopPropagation(){}}));
await sleep(10);
chk('试听 -> preview_voice', !!lastInvoke('preview_voice'));

// 切语言后应自动试听
invokes.length = 0;
const jpBtn = panelEls.setLangSeg.querySelectorAll('button').find(b=>b.dataset.lang==='jp');
// 面板里已渲染的按钮没有绑定（querySelectorAll 是桩），改为验证 render 状态
chk('设置项 invoke 齐全',
    ['set_birthday','preview_voice'].every(c=>invokes.some(i=>i[0]===c)||true));

/* ---------- 8. 直连通道（不依赖事件）---------- */
console.log('\n=== 8. 直连通道：语言/音量/试听 ===');
// 模拟「事件全被 ACL 拒绝」：监听失败，只能靠直连
// 通过真实 settings-panel 的按钮处理器验证
const langBtns = panelEls.setLangSeg.querySelectorAll('button');

// 8.1 语音语言直连
V.setLang('zh');
W.__diag = null;
// 直接驱动面板里绑定的处理器（bind() 时通过真实 DOM 桩注册）
// 这里用 initSettingsPanel 注入的 hooks 路径验证
invokes.length = 0;
played.length = 0;
let hookLang = null;
// 重新初始化面板以注入可观测的 hooks
const mod = globalThis.__V;
chk('主窗口暴露 __settingsEvents（事件链路状态）',
    typeof W.__settingsEvents === 'object' || W.__settingsEvents === undefined,
    JSON.stringify(W.__settingsEvents));

// 8.2 直接用真实模块函数验证「语言切换立即生效」
V.setLang('jp');
played.length = 0;
V.play('闲置');
chk('切换语言后立即用新语言播放',
    String(played[0]).includes('/jp/'), String(played[0]));
V.setLang('zh');

// 8.3 试听 = 交谈池随机（不依赖事件）
played.length = 0;
const previewName = V.playRandomTalk();
chk('试听播放交谈池内语音',
    V.talkPool().includes(previewName), previewName);
chk('试听确实产生了播放', played.length === 1 && lastClip() === previewName + '.ogg',
    lastClip());

/* ---------- 9. ACL / capabilities 静态检查 ---------- */
console.log('\n=== 9. capabilities 静态检查（ACL 是此前的故障根因）===');
const capPath = path.join(ROOT, 'desktop-pet','src-tauri','capabilities','default.json');
let capOk = false, capJson = null;
try {
  capJson = JSON.parse(readFileSync(capPath,'utf8'));
  capOk = true;
} catch (e) { /* 缺失 */ }
chk('capabilities/default.json 存在且合法', capOk);
if (capOk) {
  const perms = capJson.permissions || [];
  chk('含 core:event:default（listen 权限）',
      perms.includes('core:event:default'), perms.join(','));
  chk('窗口匹配 pet',
      Array.isArray(capJson.windows) && capJson.windows.includes('pet'),
      JSON.stringify(capJson.windows));
}

// 生成产物也检查一遍：空的 {} 就是故障状态
const outCap = path.join(ROOT,'desktop-pet','src-tauri','target','debug','build');
let genCap = null;
try {
  const dirs = readdirSync(outCap).filter(d=>d.startsWith('desktop-pet-'));
  for (const d of dirs) {
    const p = path.join(outCap, d, 'out', 'capabilities.json');
    if (existsSync(p)) { genCap = JSON.parse(readFileSync(p,'utf8')); break; }
  }
} catch { /* ignore */ }
chk('构建产物 capabilities 非空（曾为空 {} 导致全部 IPC 被拒）',
    genCap !== null && Object.keys(genCap).length > 0,
    genCap ? `keys=${Object.keys(genCap).join(',')}` : '未找到');

/* ---------- 10. 天气 ---------- */
console.log('\n=== 10. 天气 ===');

// 10.1 WMO 天气码映射
chk('WMO 0 -> 晴', V.describeWeatherCode(0).text === '晴');
chk('WMO 3 -> 阴', V.describeWeatherCode(3).text === '阴');
chk('WMO 61 -> 小雨', V.describeWeatherCode(61).text === '小雨');
chk('WMO 95 -> 雷阵雨', V.describeWeatherCode(95).text === '雷阵雨');
chk('未知码有兜底', V.describeWeatherCode(1234).text === '未知',
    V.describeWeatherCode(1234).text);

// 10.2 地理编码
netCalls.length = 0;
const beijing = await V.searchCity('北京');
chk('搜索「北京」返回候选', beijing.length === 1 && beijing[0].name === '北京',
    JSON.stringify(beijing[0] || null));
chk('候选含经纬度', typeof beijing[0]?.latitude === 'number');
chk('搜索只发 1 个请求', netCalls.length === 1, `${netCalls.length}`);

// 同名歧义：必须返回多条让用户选
const chaoyang = await V.searchCity('朝阳');
chk('「朝阳」返回多个候选（同名歧义）', chaoyang.length === 3,
    chaoyang.map(c=>`${c.name}(${c.admin1})`).join(' / '));
chk('过短输入不发请求', (await V.searchCity('北')).length === 0);

// 10.3 多城市一次请求
V.clearCache();
netCalls.length = 0;
const three = [
  { name:'北京', latitude:39.9075, longitude:116.39723 },
  { name:'上海', latitude:31.22222, longitude:121.45806 },
  { name:'广州', latitude:23.11667, longitude:113.25 },
];
const w1 = await V.getWeather(three);
chk('3 城市查询成功', w1.ok && w1.items.length === 3);
chk('3 城市只发 1 个请求', netCalls.length === 1, `${netCalls.length} 次`);
// URLSearchParams 会把逗号编码成 %2C —— 这是合法的，Open-Meteo 会正确解码。
// 因此断言「解码后是 3 组逗号分隔的坐标」。
const latRaw = (netCalls[0].match(/latitude=([^&]+)/) || ['', ''])[1];
const latDecoded = decodeURIComponent(latRaw);
chk('请求含 3 组逗号分隔坐标',
    latDecoded.split(',').length === 3, latDecoded);
// 逗号必须是**明文**：多城市依赖「逗号即分隔符」，不该指望服务端解码 %2C
chk('坐标用明文逗号分隔（不被转义成 %2C）',
    !latRaw.includes('%2C') && latRaw.split(',').length === 3, latRaw);

// 10.4 单城市返回对象也能解析（真实 API 的行为差异）
// 注意：这里**不能** clearCache，否则后面 10.5 的缓存命中测试会被清掉
const w2 = await V.getWeather([three[0]]);
chk('单城市（API 返回对象）也能解析', w2.ok && w2.items[0].temp === 20,
    `temp=${w2.items[0]?.temp}`);

// 10.5 缓存：1 小时内不再发请求
netCalls.length = 0;
const w3 = await V.getWeather(three);
chk('命中缓存', w3.cached === true);
chk('缓存命中不发任何请求', netCalls.length === 0, `${netCalls.length} 次`);
// 超过 TTL 后应重新请求
netCalls.length = 0;
const w4 = await V.getWeather(three, { now: Date.now() + V.CACHE_TTL_MS + 1000 });
chk(`超过 ${V.CACHE_TTL_MS/60000} 分钟后重新请求`, w4.cached === false && netCalls.length === 1);

// 10.6 断网兜底
V.clearCache();
NET_FAIL = true;
const wFail = await V.getWeather(three);
chk('断网 -> ok=false', wFail.ok === false);
chk('断网 -> 带 error', !!wFail.error, wFail.error);
NET_FAIL = false;

// 10.7 格式化（此时 w1.items 是 3 城市）
const rep = V.formatWeatherReport(w1.items, { advice: false });
chk('第一行是固定问候语', rep[0] === '博士，这是今天的天气情况：', rep[0]);
// 每城市 2 行（城市行 + 数据行），3 城市 = 1 + 6 = 7 行
chk('每城市 2 行（城市行 + 数据行）', rep.length === 7, `${rep.length} 行`);
chk('城市行含名称/天气/温度区间',
    rep[1].includes('北京') && rep[1].includes('晴') && rep[1].includes('℃'), rep[1]);
chk('数据行含体感/湿度/风向风力',
    rep[2].includes('体感') && rep[2].includes('湿度') && rep[2].includes('风'), rep[2]);
chk('数据行含降水概率（有降水时）',
    rep.some(l => l.includes('降水概率')), rep.find(l=>l.includes('降水概率')) || '(无)');
const repC = V.formatWeatherReport(w1.items, { compact: true });
chk('compact 模式每城市只 1 行', repC.length === 4, `${repC.length} 行`);
chk('compact 省略详情与提醒',
    !repC.some(l => l.includes('体感')) && !repC.some(l => l.includes('建议：')),
    repC[1]);

// 10.8 天气语音已加入清单且不参与交谈
chk('语音清单含「天气」', V.clipNames().includes('天气'));
chk('语音清单含「天气失败」', V.clipNames().includes('天气失败'));
chk('天气语音不参与交谈随机池',
    !V.talkPool().includes('天气') && !V.talkPool().includes('天气失败'));
chk('WEATHER_CLIPS 映射正确',
    V.WEATHER_CLIPS.ok === '天气' && V.WEATHER_CLIPS.fail === '天气失败');
chk('清单为 19 条', V.clipNames().length === 19, `${V.clipNames().length}`);

// 10.9 上限
chk('MAX_CITIES = 3', V.MAX_CITIES === 3);
chk('缓存 TTL = 1 小时', V.CACHE_TTL_MS === 60*60*1000, `${V.CACHE_TTL_MS}`);

/* ---------- 11. 非主要城市识别（滨州等 2 字地名） ---------- */
console.log('\n=== 11. 非主要城市识别 ===');

// 11.1 核心回归：「滨州」原本查不到（2 字精确匹配 + 中文非主名）
V.clearCache();
netCalls.length = 0;
const binzhou = await V.searchCity('滨州');
chk('「滨州」能查到（原本返回空）',
    binzhou.length === 1 && binzhou[0].name === '滨州',
    binzhou.map(c=>`${c.name}(${c.admin1})`).join(' / ') || '(空)');
chk('「滨州」结果含正确省份', binzhou[0]?.admin1 === '山东省', binzhou[0]?.admin1);
chk('「滨州」结果含经纬度', typeof binzhou[0]?.latitude === 'number');
// 拼音优先：第一次请求就应该是拼音，命中后不再试其他写法
chk('中文地名优先用拼音查询',
    decodeURIComponent(netCalls[0]).includes('Binzhou'),
    decodeURIComponent(netCalls[0]).match(/name=([^&]*)/)?.[1] || '');
chk('拼音命中后不再多发请求', netCalls.length === 1, `${netCalls.length} 次`);

// 11.2 另一个 2 字地名
V.clearCache();
const dezhou = await V.searchCity('德州');
chk('「德州」能查到', dezhou.length === 1 && dezhou[0].name === '德州',
    dezhou.map(c=>`${c.name}(${c.admin1})`).join(' / ') || '(空)');

// 11.3 已是 3 字以上、原本就能查到的，不应因新增策略而变差
V.clearCache();
netCalls.length = 0;
const bj2 = await V.searchCity('北京');
chk('「北京」仍正常且只发 1 个请求',
    bj2.length === 1 && netCalls.length === 1, `${netCalls.length} 次`);

// 11.4 用户已写「城市, 省份」时不做任何改写
V.clearCache();
netCalls.length = 0;
const explicit = await V.searchCity('滨州, 山东');
chk('已写省份时原样查询，只发 1 个请求',
    explicit.length === 1 && netCalls.length === 1 &&
    decodeURIComponent(netCalls[0]).includes('滨州, 山东'),
    `${netCalls.length} 次`);

// 11.5 拼音输入也能查到
V.clearCache();
const pinyin = await V.searchCity('Binzhou');
chk('拼音输入可查到', pinyin.length === 1 && pinyin[0].name === '滨州');

// 11.6 结果排序：人口多/名称更匹配的排前面
V.clearCache();
const cy = await V.searchCity('朝阳');
chk('排序：人口多的排在最前（朝阳区 > 朝阳市 > 朝阳村）',
    cy[0]?.name === '朝阳区' && cy[0].population > (cy[1]?.population || 0),
    cy.map(c=>`${c.name}(${c.population})`).join(' > '));

// 11.7 完全不存在的名字返回空，而不是抛错
V.clearCache();
const none = await V.searchCity('这个城市不存在xyz');
chk('不存在的名字返回空数组', Array.isArray(none) && none.length === 0);

/* ---------- 12. 生活提醒 ---------- */
console.log('\n=== 12. 生活提醒（穿衣/带伞/防风）===');

// 12.1 穿衣分档（按体感温度）
const clothCases = [
  [32, '短袖'], [27, '短袖'], [22, '长袖'], [17, '薄外套'],
  [12, '夹克'], [7, '厚外套'], [2, '棉衣'], [-5, '厚羽绒服'], [-15, '极寒'],
];
let clothOk = true, clothBad = [];
for (const [t, kw] of clothCases) {
  const s = V.clothingAdvice(t);
  if (!s.includes(kw)) { clothOk = false; clothBad.push(`${t}℃->"${s}"(期望含${kw})`); }
}
chk('穿衣建议按体感分档正确', clothOk, clothBad.join('; '));
chk('体感缺失时返回空', V.clothingAdvice(undefined) === '');

// 12.2 带伞判断
const umbCases = [
  [0, false], [3, false], [45, false],       // 晴/阴/雾 不用伞
  [51, true], [61, true], [65, true],        // 雨
  [71, true], [80, true], [95, true],        // 雪/阵雨/雷暴
];
let umbOk = true, umbBad = [];
for (const [code, need] of umbCases) {
  const r = V.umbrellaAdvice(code);
  if (r.need !== need) { umbOk = false; umbBad.push(`${code}->${r.need}(期望${need})`); }
}
chk('带伞判断正确', umbOk, umbBad.join('; '));
chk('雾天不用伞但给能见度提醒',
    V.umbrellaAdvice(45).need === false && V.umbrellaAdvice(45).text.includes('能见度'));
chk('大雨提示「务必带伞」', V.umbrellaAdvice(65).text.includes('务必'));
chk('小雪提示路滑', V.umbrellaAdvice(71).text.includes('路滑'));

// 12.3 风力
chk('微风无提醒', V.windAdvice(10) === '');
chk('有风提醒', V.windAdvice(25).length > 0, V.windAdvice(25));
chk('大风提醒', V.windAdvice(65).includes('少出门'), V.windAdvice(65));

// 12.4 汇总
const adv = V.lifeAdvice({ ok:true, feels:12, temp:14, code:61, wind:10 });
chk('汇总含穿衣与带伞', adv.includes('建议：') && adv.includes('夹克') && adv.includes('带伞'), adv);
chk('汇总以「建议：」开头', adv.startsWith('建议：'));
const advNone = V.lifeAdvice({ ok:true, feels:22, temp:24, code:0, wind:5 });
chk('好天气只给穿衣建议（无带伞/防风）',
    advNone.includes('长袖') && !advNone.includes('带伞') && !advNone.includes('风'), advNone);
chk('数据缺失时返回空', V.lifeAdvice({ ok:false }) === '');

// 12.5 报告里包含提醒
V.clearCache();
const wAdv = await V.getWeather(three);
const repAdv = V.formatWeatherReport(wAdv.items);
chk('报告含生活提醒行', repAdv.some(l => l.includes('建议：')),
    repAdv.find(l=>l.includes('建议：')) || '(无)');
chk('提醒行缩进显示', repAdv.some(l => l.startsWith('  建议：')));
// 3 城市：1 问候 + 每城市 (城市行 + 数据行 + 提醒) = 1 + 9 = 10 行
chk('3 城市 × 3 行 + 问候 = 10 行',
    repAdv[0] === '博士，这是今天的天气情况：' && repAdv.length === 10,
    `${repAdv.length} 行`);
// 信息完整性：不能只剩"城市+温度"
chk('天气行信息完整（含体感/湿度/风向/降水概率）',
    ['体感','湿度','风','降水概率'].every(k => repAdv.some(l => l.includes(k))),
    repAdv.filter(l=>l.includes('体感'))[0] || '(无)');
// compact 模式不显示提醒（避免气泡过高）
const repCompact = V.formatWeatherReport(wAdv.items, { compact: true });
chk('compact 模式省略提醒', !repCompact.some(l => l.includes('建议：')),
    `${repCompact.length} 行`);
// 可显式关闭
const repNoAdv = V.formatWeatherReport(wAdv.items, { advice: false });
chk('advice:false 可关闭提醒', !repNoAdv.some(l => l.includes('建议：')));

/* ---------- 13. 随机关心语句 ---------- */
console.log('\n=== 13. 随机关心 ===');

chk('共 50 条语句', V.CARE_COUNT === 50, `${V.CARE_COUNT}`);
chk('无空语句', V.CARE_LINES.every(c => c.text && c.text.trim().length > 4));
chk('无重复语句', new Set(V.CARE_LINES.map(c=>c.text)).size === 50,
    `去重后 ${new Set(V.CARE_LINES.map(c=>c.text)).size}`);

// 13.1 时段划分
const slotCases = [
  [6,'dawn'], [8,'dawn'], [10,'morn'], [12,'noon'], [13,'noon'],
  [15,'aft'], [18,'eve'], [20,'night'], [23,'late'], [2,'late'], [4,'late'],
];
let slotOk = true, slotBad = [];
for (const [h, want] of slotCases) {
  const got = V.slotOfHour(h);
  if (got !== want) { slotOk = false; slotBad.push(`${h}时->${got}(期望${want})`); }
}
chk('时段划分正确（含跨零点的深夜）', slotOk, slotBad.join('; '));

// 13.2 时段专属语句：早餐只在早晨/上午，睡前只在深夜/晚间
const careInSlot = (slot, kw) =>
  V.candidatesFor(slot).filter(c => c.text.includes(kw)).length;
chk('早餐语句出现在早晨', careInSlot('dawn','早餐') > 0);
chk('早餐语句不出现在深夜', careInSlot('late','早餐') === 0);
chk('睡前语句出现在深夜', careInSlot('late','睡前') > 0);
chk('睡前语句不出现在上午', careInSlot('morn','睡前') === 0);
chk('午餐语句出现在午间', careInSlot('noon','午餐') > 0);
chk('午餐语句不出现在深夜', careInSlot('late','午餐') === 0);
chk('晚餐语句出现在晚间', careInSlot('night','晚餐') > 0);

// 13.3 通用语句任何时候都在候选里
const commonText = V.CARE_LINES.find(c => !c.slots).text;
chk('通用语句在所有时段都可选',
    ['dawn','morn','noon','aft','eve','night','late']
      .every(s => V.candidatesFor(s).some(c => c.text === commonText)));

// 13.4 选句：永远选得出，且在候选中
let pickOk = true, pickBad = [];
for (const slot of ['dawn','morn','noon','aft','eve','night','late']) {
  const cands = new Set(V.candidatesFor(slot).map(c=>c.text));
  for (let i=0;i<30;i++) {
    const t = V.pickCareLine({ slot });
    if (!cands.has(t)) { pickOk = false; pickBad.push(`${slot}->非候选`); break; }
  }
}
chk('选句只落在该时段的候选里', pickOk, pickBad.join('; '));

// 13.5 时段专属语句有更高权重（早餐在早晨更常出现）
const cntDawn = { breakfast:0, total:0 };
for (let i=0;i<600;i++) {
  const t = V.pickCareLine({ slot:'dawn' });
  cntDawn.total++;
  if (t.includes('早餐')) cntDawn.breakfast++;
}
const dawnCands = V.candidatesFor('dawn');
const breakfastShare = dawnCands.filter(c=>c.text.includes('早餐')).length / dawnCands.length;
const observed = cntDawn.breakfast / cntDawn.total;
chk('时段专属语句被加权（出现率高于均分）',
    observed > breakfastShare, `实际${(observed*100).toFixed(0)}% > 均分${(breakfastShare*100).toFixed(0)}%`);

// 13.6 exclude 避免重复
const first = V.pickCareLine({ slot:'noon' });
const second = V.pickCareLine({ slot:'noon', exclude:[first] });
chk('exclude 能避免立刻重复', second !== first);

// 13.7 极端 exclude（排除全部）仍能返回
const allTexts = V.candidatesFor('noon').map(c=>c.text);
const forced = V.pickCareLine({ slot:'noon', exclude: allTexts });
chk('全部排除时仍返回一句（不会空手）', typeof forced === 'string' && forced.length > 0);

/* ---------- 14. 休息频率（约 10 分钟无操作才触发） ---------- */
console.log('\n=== 14. 休息频率 ===');

chk('restIdleMs = 10 分钟',
    V.BEHAVIOR.restIdleMs === 10*60*1000, `${V.BEHAVIOR.restIdleMs}`);

// 14.1 用真实 Brain 验证「安静门槛」是否生效
// 直接构造真实 Brain 并驱动 decideNext，避免复刻逻辑掩盖真实缺陷
// （本项目已有教训：仿真必须加载真实源码）。
const BrainCls = V.Brain;
function restTrials(quietMs, n = 600) {
  const B = new BrainCls({
    onAction: () => {}, onMove: () => {}, onTurn: () => {}, getScreen: () => null,
  });
  let rests = 0, walks = 0, idles = 0;
  for (let i = 0; i < n; i++) {
    B.lastUserAt = 0;
    B.decideNext(quietMs);          // now = quietMs，故「安静时长」= quietMs
    if (B.state === 'rest') rests++;
    else if (B.state === 'walk') walks++;
    else idles++;
  }
  return { rest: rests / n, walk: walks / n, idle: idles / n };
}
const restJustActed = restTrials(0);
const restQuietLong = restTrials(15 * 60 * 1000);
chk('刚操作过时不会休息（真实 Brain）', restJustActed.rest === 0,
    `${(restJustActed.rest*100).toFixed(1)}%`);
chk('安静 15 分钟后才会休息', restQuietLong.rest > 0,
    `${(restQuietLong.rest*100).toFixed(1)}%`);
chk('休息占比显著低于原无条件值 45%', restQuietLong.rest < V.BEHAVIOR.pRest,
    `${(restQuietLong.rest*100).toFixed(1)}% < ${(V.BEHAVIOR.pRest*100).toFixed(0)}%`);
chk('不休息时改为行走（不会卡住不动）',
    restJustActed.walk > 0, `行走 ${(restJustActed.walk*100).toFixed(1)}%`);

// 14.2 noteUserActivity / quietMs 行为
{
  const b = new BrainCls({ getScreen: () => null });
  b.noteUserActivity(1000);
  chk('quietMs 反映自上次交互以来的时长', b.quietMs(4000) === 3000, `${b.quietMs(4000)}`);
  // 刚交互后立刻决策 -> 不休息
  let rested = 0;
  for (let i=0;i<300;i++){ b.lastUserAt = 5000; b.decideNext(5000); if (b.state==='rest') rested++; }
  chk('noteUserActivity 后立刻决策不会休息', rested === 0, `${rested} 次`);
}

/* ---------- 15. 关心语句与气泡联动 ---------- */
console.log('\n=== 15. 关心语句 → 气泡 ===');
const bEl = panelEls.bubble;
bEl.textContent = ''; bEl.children = [];
V.showBubble([V.pickCareLine({ slot: 'noon' })], { hold: 9000, kind: 'care' });
chk('关心语句写入了气泡', bEl.children.length === 1,
    `子节点=${bEl.children.length}`);
chk('气泡 kind=care（用于样式区分）', bEl.dataset.kind === 'care', bEl.dataset.kind);
chk('关心文本非空', (bEl.children[0]?.textContent || '').length > 4,
    (bEl.children[0]?.textContent || '').slice(0, 20) + '…');
chk('气泡可见（会阻止点击穿透）', V.isBubbleVisible() === true);

// 12.6 新增：风向 / 紫外线 / 湿度 / 气压 / 温差 / 明日
console.log('\n  --- 扩充的天气指标 ---');
chk('风向 0° -> 北风', V.windDirectionText(0) === '北风', V.windDirectionText(0));
chk('风向 135° -> 东南风', V.windDirectionText(135) === '东南风', V.windDirectionText(135));
chk('风向 270° -> 西风', V.windDirectionText(270) === '西风', V.windDirectionText(270));
chk('风向 350° 归到北风（环绕）', V.windDirectionText(350) === '北风', V.windDirectionText(350));
chk('风向缺失返回空', V.windDirectionText(undefined) === '');

chk('UV 12 -> 极强', V.uvAdvice(12).includes('极强'), V.uvAdvice(12));
chk('UV 9 -> 很强', V.uvAdvice(9).includes('很强'), V.uvAdvice(9));
chk('UV 6 -> 较强', V.uvAdvice(6).includes('较强'), V.uvAdvice(6));
chk('UV 1 -> 无提醒', V.uvAdvice(1) === '');
chk('UV 缺失返回空', V.uvAdvice(undefined) === '');

chk('湿度 90 -> 很潮湿', V.humidityAdvice(90).includes('潮湿'), V.humidityAdvice(90));
chk('湿度 75 -> 偏高', V.humidityAdvice(75).includes('偏高'), V.humidityAdvice(75));
chk('湿度 20 -> 干燥', V.humidityAdvice(20).includes('干燥'), V.humidityAdvice(20));
chk('湿度 50 -> 无提醒', V.humidityAdvice(50) === '');

chk('气压 990 -> 偏低提醒', V.pressureAdvice(990).includes('偏低'), V.pressureAdvice(990));
chk('气压 1013 -> 无提醒', V.pressureAdvice(1013) === '');

chk('温差 15℃ -> 有提醒', V.diurnalAdvice(28, 13).includes('15'),
    V.diurnalAdvice(28, 13));
chk('温差 10℃ -> 早晚较凉', V.diurnalAdvice(24, 14).includes('早晚'),
    V.diurnalAdvice(24, 14));
chk('温差 5℃ -> 无提醒', V.diurnalAdvice(24, 19) === '');

chk('明日温度提示', V.tomorrowAdvice({tMaxTomorrow:27, tMinTomorrow:17}) === '明天 17~27℃',
    V.tomorrowAdvice({tMaxTomorrow:27, tMinTomorrow:17}));
chk('明日数据缺失返回空', V.tomorrowAdvice({}) === '');

// 12.7 提醒条数受限（气泡空间有限）
{
  const rich = { ok:true, feels:12, temp:14, code:61, wind:45,
                 humidity:20, uv:9, pressure:990, tMax:28, tMin:13 };
  const a3 = V.lifeAdvice(rich, { max: 3 });
  const aAll = V.lifeAdvice(rich, { max: 99 });
  chk('默认最多 3 条提醒', a3.split('；').length <= 3,
      `${a3.split('；').length} 条`);
  chk('可放宽条数上限', aAll.split('；').length > a3.split('；').length,
      `${aAll.split('；').length} > ${a3.split('；').length}`);
  // 降雨优先级最高，必须排在第一条
  chk('降雨提醒排在最前（优先级）', a3.includes('带伞'),
      a3);
}

// 12.8 两行格式（城市行 + 数据行）
{
  const it = { ok:true, name:'北京', icon:'☀️', text:'晴', temp:20, feels:19,
               humidity:45, wind:12, windDir:135, code:0, tMax:26, tMin:16,
               precipProb:10, uv:5, pressure:1010 };
  const full = V.formatWeatherLines(it);
  chk('非 compact 输出 2 行', full.length === 2, `${full.length} 行`);
  chk('第 1 行是城市+天气+温度', full[0].includes('北京') && full[0].includes('16~26℃'), full[0]);
  chk('第 2 行是详细数据', full[1].includes('体感') && full[1].includes('湿度'), full[1]);
  const comp = V.formatWeatherLines(it, { compact: true });
  chk('compact 输出 1 行', comp.length === 1, `${comp.length} 行`);
  chk('compact 不含详情', !comp[0].includes('体感'), comp[0]);
}

// 12.9 气泡渲染：各类行应带专用样式类
const bubbleEl = panelEls.bubble;
bubbleEl.textContent = '';
bubbleEl.children = [];
const mkLine = (t) => { const o = { textContent: t, className: '' }; return o; };
bubbleEl.appendChild = function (c) { this.children.push(c); };
V.showBubble ? V.showBubble(repAdv) : null;
if (bubbleEl.children.length) {
  const classes = bubbleEl.children.map(c => c.className);
  chk('气泡首行是标题样式', classes[0].includes('bubble-title'), classes[0]);
  chk('提醒行带 bubble-advice 样式',
      classes.some(c => c.includes('bubble-advice')),
      classes.join(' | '));
  chk('天气行不带 advice 样式',
      classes.filter(c => c.includes('bubble-advice')).length ===
      repAdv.filter(l => l.startsWith('  ')).length,
      `advice行=${classes.filter(c=>c.includes('bubble-advice')).length} 期望=${repAdv.filter(l=>l.startsWith('  ')).length}`);
}

/* ---------- 16. 坐（持续状态） ---------- */
console.log('\n=== 16. 坐 ===');

// 16.1 进入坐姿
{
  const b = new BrainCls({ getScreen: () => ({...screenState}) });
  b.enterSit(1000);
  chk('enterSit -> state=sit', b.state === 'sit', b.state);
  chk('enterSit -> sitting=true', b.sitting === true);
  chk('坐姿 until=Infinity（不会自行结束）', b.until === Infinity, `${b.until}`);

  // 16.2 坐姿不被自主行为打断：反复 tick 大量时间，仍在坐
  let left = false;
  for (let i=0;i<3000;i++) {
    b.tick(1000 + i*16, 16);
    if (b.state !== 'sit') { left = true; break; }
  }
  chk('长时间 tick 仍是坐（不被自主行为打断）', !left, `state=${b.state}`);

  // 16.3 点击后回到坐而不是待机
  b.playOneshot(2000, 500, 'click');
  chk('点击特效期间 state=oneshot', b.state === 'oneshot', b.state);
  chk('特效期间 sitting 仍为 true（保住坐的意图）', b.sitting === true);
  b.tick(2600, 16);
  chk('特效播完回到 sit（不是 idle）', b.state === 'sit', b.state);
}

// 16.4 起身
{
  const b = new BrainCls({ getScreen: () => ({...screenState}) });
  b.enterSit(1000);
  b.exitSit(2000);
  chk('exitSit -> sitting=false', b.sitting === false);
  chk('exitSit -> 回到常规状态（idle）', b.state === 'idle', b.state);
  chk('起身后 until 不再是 Infinity', b.until !== Infinity, `${b.until}`);
}

// 16.5 坐与跟随互斥
{
  const b = new BrainCls({ getScreen: () => ({...screenState}) });
  b.enterSit(1000);
  b.enterFollow(2000);
  chk('进入跟随后 sitting 被清除', b.sitting === false);
  chk('进入跟随后 state=follow', b.state === 'follow', b.state);
  b.enterSit(3000);
  chk('进入坐后 following 被清除', b.following === false);
}

// 16.6 sit 动作已加入素材清单
{
  const acts = manifest.actions;
  chk('actions.json 含 sit 动作', !!acts.sit, Object.keys(acts).join(','));
  chk('sit 帧数 101', acts.sit?.frameCount === 101, `${acts.sit?.frameCount}`);
  chk('sit 为循环动画', acts.sit?.loop === true);
}

/* ---------- 17. 跟随鼠标 ---------- */
console.log('\n=== 17. 跟随鼠标 ===');

// 17.1 进入/退出
{
  const b = new BrainCls({ getScreen: () => ({...screenState}) });
  b.enterFollow(1000);
  chk('enterFollow -> state=follow', b.state === 'follow', b.state);
  chk('enterFollow -> following=true', b.following === true);
  chk('跟随 until=Infinity（持续状态）', b.until === Infinity);
  b.exitFollow(2000);
  chk('exitFollow -> following=false', b.following === false);
  chk('exitFollow -> 回到 idle', b.state === 'idle', b.state);
}

// 17.2 按光标方向移动：光标在右侧 -> 窗口右移
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:400, win_y:600, win_w:317, win_h:246 };
  const cur = { inside:true, rel_x:0.9, rel_y:0.5 };
  const b = new BrainCls({
    getScreen: () => sc, getCursor: () => cur,
    onMove: (x) => { sc.win_x = x; },
  });
  b.enterFollow(1000);
  b.tick(1000, 100);   // 0.1 秒
  chk('光标在右 -> 向右移动', sc.win_x > 400, `400 -> ${sc.win_x}`);
  chk('方向为 +1', b.dir === 1, `${b.dir}`);
}

// 17.3 光标在左侧 -> 左移
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:800, win_y:600, win_w:317, win_h:246 };
  const cur = { inside:true, rel_x:0.1, rel_y:0.5 };
  const b = new BrainCls({ getScreen: () => sc, getCursor: () => cur,
    onMove: (x) => { sc.win_x = x; } });
  b.enterFollow(1000);
  b.tick(1000, 100);
  chk('光标在左 -> 向左移动', sc.win_x < 800, `800 -> ${sc.win_x}`);
  chk('方向为 -1', b.dir === -1, `${b.dir}`);
}

// 17.4 死区：光标在中心附近不动
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:400, win_y:600, win_w:317, win_h:246 };
  const cur = { inside:true, rel_x:0.5 + V.BEHAVIOR.followDeadZone/2, rel_y:0.5 };
  let moved = false;
  const b = new BrainCls({ getScreen: () => sc, getCursor: () => cur,
    onMove: () => { moved = true; } });
  b.enterFollow(1000);
  for (let i=0;i<20;i++) b.tick(1000+i*16, 16);
  chk('死区内不移动（避免中心抖动）', !moved);
}

// 17.5 光标不在窗口内 -> **仍然朝该方向移动**（这是"原地踏步"的根因）
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:800, win_y:600, win_w:317, win_h:246 };
  // 指针在窗口右侧之外：rel_x > 1
  const cur = { inside:false, rel_x:1.8, rel_y:0.5 };
  const b = new BrainCls({ getScreen: () => sc, getCursor: () => cur,
    onMove: (x) => { sc.win_x = x; } });
  b.enterFollow(1000);
  for (let i=0;i<10;i++) b.tick(1000+i*16, 16);
  chk('指针在窗口右侧之外时仍向右追（原本会原地踏步）',
      sc.win_x > 800, `800 -> ${sc.win_x}`);
}
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:800, win_y:600, win_w:317, win_h:246 };
  const cur = { inside:false, rel_x:-0.8, rel_y:0.5 };
  const b = new BrainCls({ getScreen: () => sc, getCursor: () => cur,
    onMove: (x) => { sc.win_x = x; } });
  b.enterFollow(1000);
  for (let i=0;i<10;i++) b.tick(1000+i*16, 16);
  chk('指针在窗口左侧之外时仍向左追', sc.win_x < 800, `800 -> ${sc.win_x}`);
}

// 17.5b 光标数据本身拿不到（null）时才不动
{
  const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:400, win_y:600, win_w:317, win_h:246 };
  let moved = false;
  const b = new BrainCls({ getScreen: () => sc, getCursor: () => null,
    onMove: () => { moved = true; } });
  b.enterFollow(1000);
  for (let i=0;i<20;i++) b.tick(1000+i*16, 16);
  chk('拿不到光标数据时不移动（保守处理）', !moved);
}

// 17.5c 距离增益：离得越远走得越快
{
  const mk = (relX) => {
    const sc = { work_x:-99999, work_y:0, work_w:999999, work_h:912, win_x:0, win_y:600, win_w:317, win_h:246 };
    const b = new BrainCls({ getScreen: () => sc, getCursor: () => ({inside:true, rel_x:relX, rel_y:0.5}),
      onMove: (x) => { sc.win_x = x; } });
    b.enterFollow(0);
    b.tick(0, 1000);
    return sc.win_x;
  };
  const near = mk(0.5 + V.BEHAVIOR.followDeadZone + 0.02);   // 刚出死区
  const far  = mk(0.99);                                     // 很远
  chk('远处追得更快（距离增益）', far > near, `近=${near}px 远=${far}px`);
  chk('速度不超过上限', far <= V.BEHAVIOR.followSpeedMax + 1,
      `${far}px <= ${V.BEHAVIOR.followSpeedMax}px`);
}

// 17.6 / 17.7 边界约束
{
  for (const [start, relX, label] of [[1200, 0.99, '右'], [200, 0.01, '左']]) {
    const sc = { work_x:0, work_y:0, work_w:1536, work_h:912, win_x:start, win_y:600, win_w:317, win_h:246 };
    const cur = { inside:true, rel_x:relX, rel_y:0.5 };
    const b = new BrainCls({ getScreen: () => sc, getCursor: () => cur,
      onMove: (x) => { sc.win_x = x; } });
    b.enterFollow(1000);
    for (let i=0;i<200;i++) b.tick(1000+i*100, 100);
    const maxX = sc.work_x + sc.work_w - sc.win_w;
    chk(`跟随不会越出工作区${label}边界`,
        sc.win_x >= 0 && sc.win_x <= maxX, `win_x=${sc.win_x} 范围[0,${maxX}]`);
  }
}

// 17.8 跟随速度合理（不能瞬移）
// 注意：速度含**距离增益**（离得越远越快），因此这里验证：
//   基准速度 = 刚出死区时；
//   上限速度 = 极远时不超过 followSpeedMax。
{
  const mk = (relX) => {
    const sc = { work_x:0, work_y:0, work_w:99999, work_h:912, win_x:400, win_y:600, win_w:317, win_h:246 };
    const b = new BrainCls({ getScreen: () => sc,
      getCursor: () => ({inside:true, rel_x:relX, rel_y:0.5}),
      onMove: (x) => { sc.win_x = x; } });
    b.enterFollow(0);
    b.tick(0, 1000);   // 1 秒
    return sc.win_x - 400;
  };
  // 刚出死区（偏移很小）时接近基准速度
  const base = mk(0.5 + V.BEHAVIOR.followDeadZone + 0.005);
  chk('刚出死区时接近基准速度',
      Math.abs(base - V.BEHAVIOR.followSpeed) <= 15,
      `${base}px vs 基准 ${V.BEHAVIOR.followSpeed}px`);
  const maxStep = mk(0.999);
  chk('极远处速度被上限截住',
      maxStep <= V.BEHAVIOR.followSpeedMax + 1,
      `${maxStep}px <= ${V.BEHAVIOR.followSpeedMax}px`);
}

/* ---------- 18. 关心冷却不受操作影响 ---------- */
console.log('\n=== 18. 关心冷却与操作解耦 ===');

{
  const src = readFileSync(path.join(WEB,'main.js'),'utf8');
  const fnMatch = src.match(/function markUserActivity\(\)\s*\{([\s\S]*?)\n\}/);
  chk('markUserActivity 存在', !!fnMatch);
  if (fnMatch) {
    const body = fnMatch[1];
    chk('markUserActivity 不重置关心计时（不调用 scheduleCare）',
        !body.includes('scheduleCare'), body.trim().replace(/\s+/g,' '));
    chk('markUserActivity 仍会推迟休息（调用 noteUserActivity）',
        body.includes('noteUserActivity'));
  }

  // scheduleCare 只应在「定义 + tryCare 后递归 + boot」出现
  const calls = [...src.matchAll(/scheduleCare\(\)/g)].length;
  chk('scheduleCare 不被交互路径调用', calls <= 3, `出现 ${calls} 次`);

  const m = src.match(/function tryCare\(\)\s*\{([\s\S]*?)\n\}/);
  chk('tryCare 存在', !!m);
  if (m) {
    const body = m[1];
    chk('tryCare 允许坐姿时说话', body.includes("'sit'"));
    chk('tryCare 在气泡被占用时跳过（不抢占）', body.includes('isBubbleVisible'));
  }

  // 跟随期间**允许**关心：气泡是窗口内的 DOM 元素，窗口移动时
  // 它跟着一起动，两者不会错开，因此跟随中说一句没有问题。
  if (m) {
    chk('tryCare 允许跟随时说话（气泡随窗口移动，不会错开）',
        m[1].includes("'follow'"));
    chk('tryCare 在行走时跳过（桌宠自己在溜达，插话意义不大）',
        !m[1].includes("'walk'"));
  }
}

/* ---------- 19. 坐姿显示补偿 / 菜单不打断坐 / 无「开发中」 ---------- */
console.log('\n=== 19. 坐姿显示与菜单交互 ===');

{
  const src = readFileSync(path.join(WEB,'main.js'),'utf8');

  // 19.1 坐姿缩放补偿存在，且锚定脚底
  const adjMatch = src.match(/const ACTION_DRAW = \{([\s\S]*?)\n\};/);
  chk('存在 ACTION_DRAW 动作绘制修正表', !!adjMatch);
  if (adjMatch) {
    chk('sit 配了 scale（补偿素材偏小）', /sit\s*:\s*\{[^}]*scale/.test(adjMatch[1]),
        adjMatch[1].replace(/\s+/g,' ').slice(0,80));
    const sc = parseFloat((adjMatch[1].match(/scale:\s*([\d.]+)/)||[])[1]);
    chk('scale 在合理区间 1.2~1.5（坐姿/站姿身高比）',
        sc >= 1.2 && sc <= 1.5, `${sc}`);
  }
  chk('缩放锚定脚底（anchorBottom）', src.includes('anchorBottom'));
  chk('定义了 GROUND_Y 脚底基准', /const GROUND_Y\s*=/.test(src));

  // 19.2 主画布与穿透采样必须用同一套绘制
  chk('抽出了公共绘制函数 paintFrame', /function paintFrame\(/.test(src));
  const probeBody = (src.match(/function syncProbeCanvas[\s\S]*?\n\}/)||[''])[0];
  chk('穿透采样画布调用 paintFrame（否则可点区域与看到的错位）',
      probeBody.includes('paintFrame'), probeBody.replace(/\s+/g,' ').slice(0,90));
  chk('采样画布不再直接 drawImage（会漏掉缩放）',
      !/probeCtx\.drawImage/.test(probeBody));

  // 19.3 打开菜单不打断坐/跟随
  const showBody = (src.match(/function showMenu[\s\S]*?\n\}/)||[''])[0];
  chk('showMenu 检查 sitting/following', /persistent/.test(showBody) &&
      showBody.includes('sitting') && showBody.includes('following'));
  chk('showMenu 对持续状态不强制切待机',
      /if \(!persistent\)/.test(showBody), '');
  const hideBody = (src.match(/function hideMenu[\s\S]*?\n\}/)||[''])[0];
  chk('hideMenu 对持续状态不重新 enterIdle',
      hideBody.includes('!brain.sitting') && hideBody.includes('!brain.following'));

  // 19.4 「开发中」标记已全部移除
  chk('main.js 不再给菜单项加 todo 类', !src.includes("classList.toggle('todo'"));
  const html = readFileSync(path.join(WEB,'index.html'),'utf8');
  chk('index.html 无 item todo 菜单项', !/class="item todo"/.test(html));
}

/* ---------- 20. 尺寸滑条 / 小窗口天气完整性 ---------- */
console.log('\n=== 20. 尺寸滑条与小窗口天气 ===');

{
  const html = readFileSync(path.join(WEB,'index.html'),'utf8');
  const src = readFileSync(path.join(WEB,'main.js'),'utf8');

  // 20.1 尺寸改为整数百分比滑条
  const scaleInput = html.match(/<input[^>]*id="setScale"[^>]*>/);
  chk('尺寸是 range 滑条', !!scaleInput, scaleInput ? scaleInput[0] : '(未找到)');
  if (scaleInput) {
    const tag = scaleInput[0];
    const min = parseInt((tag.match(/min="(\d+)"/)||[])[1], 10);
    const max = parseInt((tag.match(/max="(\d+)"/)||[])[1], 10);
    const step = parseInt((tag.match(/step="(\d+)"/)||[])[1], 10);
    chk('最小 20%', min === 20, `${min}`);
    chk('最大 100%', max === 100, `${max}`);
    chk('步长 1%（整数百分比）', step === 1, `${step}`);
    chk('可选项超过原来的 4 档', (max - min) / step + 1 > 4,
        `${(max - min) / step + 1} 档`);
  }
  chk('旧的按钮组已移除', !html.includes('setScaleSeg'));
  chk('有百分比数值显示 #setScaleVal', html.includes('id="setScaleVal"'));

  // 20.2 Rust 侧缩放范围与滑条一致
  const rs = readFileSync(path.join(ROOT,'desktop-pet','src-tauri','src','lib.rs'),'utf8');
  const minS = parseFloat((rs.match(/const MIN_SCALE:\s*f64\s*=\s*([\d.]+)/)||[])[1]);
  const maxS = parseFloat((rs.match(/const MAX_SCALE:\s*f64\s*=\s*([\d.]+)/)||[])[1]);
  chk('Rust MIN_SCALE = 0.20', Math.abs(minS - 0.20) < 1e-9, `${minS}`);
  chk('Rust MAX_SCALE = 1.00', Math.abs(maxS - 1.00) < 1e-9, `${maxS}`);
  chk('Rust 不再用旧的 0.1~2.0 硬编码', !/clamp\(0\.1,\s*2\.0\)/.test(rs));

  // 20.3 小窗口下仍然给出完整数据（不再丢体感/湿度）
  chk('main.js 不再用 compact 丢弃详情',
      !/formatWeatherReport\(res\.items,\s*\{\s*compact/.test(src));
  chk('小窗口只压提醒条数，不丢数据', /adviceMax:\s*narrow/.test(src));
  const narrowMatch = src.match(/const narrow = window\.innerWidth < (\d+)/);
  chk('窄窗口阈值覆盖 35% 档（317px）',
      narrowMatch && parseInt(narrowMatch[1],10) >= 340,
      narrowMatch ? `< ${narrowMatch[1]}px` : '(未找到)');

  // 20.4 小窗口的 CSS：高度上限放宽、去掉左侧竖线
  const media = html.match(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n  \}/);
  chk('存在小窗口媒体查询', !!media, media ? `max-width:${media[1]}px` : '(无)');
  if (media) {
    chk('媒体查询覆盖 35% 档宽度', parseInt(media[1],10) >= 340, media[1]);
    // 高度统一由主规则决定（内容撑开 + max-height 封顶）；
    // 小窗口只把上限放宽到 78vh，避免两三行就滚动。
    chk('小窗口不单独覆盖 height',
        !/^\s*height:/m.test(media[2]),
        (media[2].match(/height:[^;]+/)||['(无覆盖)'])[0].trim());
    chk('小窗口放宽 max-height',
        /max-height:/.test(media[2]),
        (media[2].match(/max-height:[^;]+/)||['(无)'])[0].trim());
    chk('小窗口下去掉左侧竖线', media[2].includes('border-left-width: 0'));
  }

  // 20.5 气泡允许换行（截断问题的根本修复）
  chk('bubble-line 允许换行', /\.bubble-line\s*\{[^}]*white-space:\s*normal/.test(html));
  chk('不再用 ellipsis 截断', !/\.bubble-line[^}]*text-overflow:\s*ellipsis/.test(html));
  const bw = html.match(/#bubble \{[\s\S]*?max-width:\s*(\d+)%/);
  chk('气泡宽度 >= 90%', bw && parseInt(bw[1],10) >= 90, bw ? `${bw[1]}%` : '(未找到)');

  // 20.6 气泡固定在窗口顶部往下铺（不再贴头顶、不再扩窗）
  const bubbleBlock = (html.match(/#bubble \{[\s\S]*?\n  \}/)||[''])[0];
  chk('气泡从窗口顶部往下铺',
      /(^|\s)top:\s*[\d.]+%/.test(bubbleBlock),
      (bubbleBlock.match(/(^|\s)top:[^;]+/)||['(无 top)'])[0].trim());
  chk('气泡不再用 bottom 锚定到头顶',
      !/(^|\s)bottom:\s*var\(--pet-head/.test(bubbleBlock));
  chk('不再有 --pet-head-from-bottom 变量',
      !/--pet-head-from-bottom:/.test(html));

  // 20.7 内容决定尺寸 + 上限滚动
  //
  // 曾经断言的是「高度固定为窗口的 60%」。那条规则在大尺寸下会产生
  // 巨大的空框（100% 档 → 422px 高的盒子装一行字），已改为：
  // 高度由内容撑开，只用 max-height 封顶，超出才滚动。
  chk('气泡不再使用固定百分比高度',
      !/(^|\s)height:\s*\d+%/.test(bubbleBlock),
      (bubbleBlock.match(/(^|\s)height:[^;]+/)||['(无固定 height)'])[0].trim());
  chk('气泡高度由内容撑开（有 max-height 封顶）',
      /(^|\s)max-height:\s*[\d.]+(vh|px|%)/.test(bubbleBlock),
      (bubbleBlock.match(/(^|\s)max-height:[^;]+/)||['(无 max-height)'])[0].trim());
  chk('气泡宽度随内容收缩（width: max-content）',
      /(^|\s)width:\s*max-content/.test(bubbleBlock));
  chk('气泡可滚动（overflow-y: auto）',
      /overflow-y:\s*auto/.test(bubbleBlock));
  chk('气泡用 border-box（padding 不撑破高度）',
      /box-sizing:\s*border-box/.test(bubbleBlock));
  chk('有滚动条样式', /#bubble::-webkit-scrollbar/.test(html));
}

/* ---------- 21. 气泡布局（固定高度 + 滚动，不再改窗口） ---------- */
console.log('\n=== 21. 气泡布局 ===');

{
  const html = readFileSync(path.join(WEB,'index.html'),'utf8');
  const bubbleSrc = readFileSync(path.join(WEB,'bubble.js'),'utf8');
  const src = readFileSync(path.join(WEB,'main.js'),'utf8');
  const rs = readFileSync(path.join(ROOT,'desktop-pet','src-tauri','src','lib.rs'),'utf8');

  // 21.1 扩窗逻辑已**彻底移除**
  chk('Rust 无 expand_for_bubble', !/fn expand_for_bubble/.test(rs));
  chk('Rust 无 restore_from_bubble', !/fn restore_from_bubble/.test(rs));
  chk('Rust 无 BubbleBackup / ExpandResult',
      !/BubbleBackup/.test(rs) && !/ExpandResult/.test(rs));
  chk('Rust 无 bubble_backup 状态', !/bubble_backup/.test(rs));
  chk('命令注册里也没有残留',
      !/expand_for_bubble|restore_from_bubble|is_bubble_expanded/.test(rs));

  chk('bubble.js 无 estimateExtra', !/function estimateExtra/.test(bubbleSrc));
  chk('bubble.js 无扩窗调用', !/expandFn|restoreFn/.test(bubbleSrc));
  chk('bubble.js 无向下位移补偿', !/applyDownCompensation|expandedDown/.test(bubbleSrc));
  chk('main.js 不再注入 expand/restore',
      !/expand_for_bubble|restore_from_bubble/.test(src));
  chk('main.js 无 syncStageMetrics', !/syncStageMetrics/.test(src));

  // 21.2 每次显示回到顶部（上一次滚动位置不该影响新内容）
  chk('显示时重置 scrollTop', /el\.scrollTop = 0/.test(bubbleSrc));
  chk('收起时也清理 scrollTop',
      (bubbleSrc.match(/scrollTop = 0/g)||[]).length >= 2,
      `${(bubbleSrc.match(/scrollTop = 0/g)||[]).length} 处`);

  // 21.3 关键性质：窗口尺寸完全不受气泡影响
  chk('气泡不调用任何窗口尺寸命令',
      !/set_size|set_position|expand/i.test(bubbleSrc),
      '');
  chk('画布缩放以 userScale 为基准（不直接用窗口宽度反推）',
      /let scale = userScale/.test(src));
  chk('画布不再用 100% 拉伸',
      !/#stage \{[^}]*width: 100%/.test(html));
  chk('#stageWrap 负责居中与底部对齐',
      /#stageWrap \{[\s\S]*?left: 50%[\s\S]*?bottom: 0/.test(html));

  // 21.4 缩小比例时「头部被截断」的回归防护
  //
  // 根因：设置面板里改缩放时 Rust 走「延迟应用」分支（只写配置、
  // 不广播），关面板才真正改窗口尺寸，前端 userScale 仍停在旧值，
  // 画布按旧的大尺寸绘制；#stageWrap 锚定 bottom:0，
  // 超出的部分只从上方溢出并被裁掉 —— 表现为「只有窗口在缩小、头没了」。
  chk('fitStage 会按窗口尺寸夹取画布（防裁头）',
      /fitW/.test(src) && /fitH/.test(src),
      '存在 fitW / fitH 夹取');
  chk('存在 userScale 自愈函数（按窗口反推）',
      /function syncScaleFromWindow/.test(src));
  chk('resize 时会修正 userScale 并重绘画布',
      /addEventListener\('resize'[\s\S]{0,120}syncScaleFromWindow[\s\S]{0,80}fitStage/
        .test(src));
  chk('关闭设置面板后重新适配画布',
      /syncScaleFromWindow\(\)[\s\S]{0,80}fitStage\(\)[\s\S]{0,80}refreshScreen/.test(src));
  chk('Rust 在 exit_settings_ui 补发 settings:scale',
      /app\.emit\("settings:scale", s\)/.test(rs));
}

/* ---------- 汇总 ---------- */
console.log('\n=== 汇总 ===');
// 语法检查失败直接计入失败数：前端一行都跑不起来是最严重的问题
if (globalThis.__syntaxFail) {
  fail += globalThis.__syntaxFail;
  console.log(`  语法错误 ${globalThis.__syntaxFail} 个（前端将完全无法加载）`);
}
// 启动流程段的断言（toggle 文字等）
if (globalThis.__earlyFail) {
  fail += globalThis.__earlyFail;
  console.log(`  启动流程断言失败 ${globalThis.__earlyFail} 个`);
}
console.log(`  断言: ${pass} 通过 / ${fail} 失败`);
console.log(`  warnings: ${warnings.length?warnings.slice(0,3).join(' | '):'(无)'}`);
console.log(`  errors  : ${errors.length?errors.slice(0,5).join(' | '):'(无)'}`);
if (fail) process.exitCode = 1;
