/**
 * 桌宠渲染与交互层
 *
 * 职责划分：
 *   - brain.js  ：决定「做什么」（待机/休息/行走、何时触发、往哪走）
 *   - 本文件    ：负责「怎么显示」与「响应输入」
 *
 * 动作是数据驱动的（读 actions.json），新增动作无需改代码。
 */

import { Brain, BEHAVIOR, S } from './brain.js';
import {
  initSettingsPanel,
  openSettings,
  closeSettings,
  settingsOpen,
} from './settings-panel.js';
import {
  initVoice,
  setLang as setVoiceLang,
  setVolume as setVoiceVolume,
  play as playVoice,
  playRandomTalk,
  playStartupClip,
  WEATHER_CLIPS,
  setAudioBase,
} from './voice.js';
import { getWeather, formatWeatherReport, searchCity, MAX_CITIES } from './weather.js';
import { initBubble, showBubble, hideBubble, showPending, isBubbleVisible } from './bubble.js';
import { pickCareLine } from './care.js';

/* ---------- 与 Rust 通信 ---------- */

async function invoke(cmd, args) {
  const api = window.__TAURI__?.core?.invoke;
  if (!api) return undefined;
  try {
    return await api(cmd, args);
  } catch (e) {
    console.warn('invoke failed:', cmd, e);
    return undefined;
  }
}

/* ---------- 状态 ---------- */

const state = {
  manifest: null,
  current: null,
  frames: [],
  index: 0,
  lastTs: 0,
  facing: 1,        // 1 正常，-1 水平镜像
  screen: null,     // 缓存的屏幕信息
  /** 屏幕信息缓存时间戳 */
  screenTs: 0,
};

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

/** 行为控制器（boot 时创建）。提前声明，供 setAction 回调使用。 */
let brain = null;

/**
 * 用户主动暂停自主活动。
 *
 * 这是唯一一个「持续性」的暂停开关，但它是**用户显式切换**的，
 * 菜单里会显示 ✓，再点一次必定解开，不存在「悄悄卡死」的情况。
 * 其他临时接管一律通过行为状态本身（时长）实现，不引入额外标志。
 */
let autonomyPaused = false;

/**
 * 用户设置的生日（{month, day} 或 null）。
 * 启动时用于判断是否播生日语音；设置面板改动后由事件同步。
 */
let birthdayCfg = null;

/* ---------- 资源载入 ---------- */

/**
 * 资源根路径。
 *
 * ## 为什么要可变
 *
 * 素材（342 帧 PNG、38 条语音）原本**内嵌在 exe 里**，导致 exe 有 73 MB
 * —— 而程序本体只有 2 MB，97% 都是素材。
 *
 * 现在改为**外置**：素材放在 exe 同目录的 `assets/`、`audio/` 下，
 * exe 里只保留代码。启动时由 Rust 侧探测素材位置，把可用的基址
 * 通过 `get_asset_base` 告诉前端。
 *
 * ## 两种取值
 *
 *   - `''`（默认）：走 WebView 的相对路径，适用于**开发时**
 *     （素材仍在 `web/` 下，`npm run dev` 式的直接调试）
 *   - `'http://petasset.localhost/'`：走 Rust 注册的 petasset 协议
 *     读取 **exe 同目录**的外部文件，适用于打包后
 *
 * 前端不关心素材到底在哪，只认这个前缀。
 *
 * 语音的基址由 voice.js 自己持有（`setAudioBase`），这里不重复声明，
 * 避免两个模块出现同名变量。
 */
let assetBase = '';

async function loadManifest() {
  const res = await fetch(`${assetBase}assets/actions.json`);
  if (!res.ok) throw new Error('无法读取 actions.json');
  return res.json();
}

/**
 * 确定素材位置（内嵌 or 外置）。
 *
 * ## 为什么要探测而不是写死
 *
 * 素材有两种存在方式，必须都支持：
 *
 *   1. **外置**（发布版）：exe 同目录下有 `assets/`、`audio/`，
 *      这是默认形态 —— exe 因此只有几 MB 而不是 73 MB。
 *   2. **内嵌**（开发版）：素材仍在 `web/` 下，直接相对路径即可。
 *      `cargo tauri dev` 与浏览器打开 `preview.html` 都靠这条。
 *
 * Rust 侧的 `get_asset_base` 会返回可用的前缀：
 *   - 找到外部素材 -> `http://petasset.localhost/`
 *   - 没找到       -> 空串（回落到相对路径）
 *
 * 探测失败**不能致命**：宁可退回相对路径，也不要因为一个命令
 * 失败就整个启动不起来。
 */
async function resolveAssetBase() {
  try {
    const base = await invoke('get_asset_base');
    if (typeof base === 'string' && base) {
      assetBase = base;
      setAudioBase(base);
    }
  } catch {
    /* 保持空串，走相对路径 */
  }
  // 没探测到外部素材时也要显式告知 voice.js 走相对路径，
  // 否则它会保留上一次的值（本进程内不会变，但语义上应显式）。
  setAudioBase(assetBase);
  window.__assetBase = assetBase;
}

const frameCache = new Map();

async function loadFrames(actionKey) {
  if (frameCache.has(actionKey)) {
    return frameCache.get(actionKey);
  }
  const act = state.manifest.actions[actionKey];
  if (!act) throw new Error('未知动作: ' + actionKey);

  const base = `${assetBase}assets/${act.dir}/`;
  const ext = act.ext || 'png';
  const imgs = [];
  for (let i = 1; i <= act.frameCount; i++) {
    const n = String(i).padStart(4, '0');
    const img = new Image();
    img.src = `${base}f${n}.${ext}`;
    try {
      await img.decode();
    } catch {
      /* 单帧失败不阻断 */
    }
    imgs.push(img);
  }
  frameCache.set(actionKey, imgs);
  return imgs;
}

/**
 * 切换动作。
 *
 * 设计要点：
 *   1. 帧数据提前预解码并缓存，切换时是同步替换，不存在空窗。
 *   2. 并发保护用「最后请求优先」：后来的请求总是会生效，
 *      绝不会出现所有请求都被丢弃、画面停在旧帧的死锁。
 *   3. 替换后立即绘制，保证画布始终有内容。
 *
 * 早期版本用 token 比较后直接 return，一旦出现「请求被覆盖」
 * 就会连 state.current 都不更新，导致后续同动作请求被短路、
 * 画面永久卡死。现在的写法保证了至少有一次切换必然完成。
 */
/**
 * 预载全部动作，避免运行中因解码造成卡顿或竞态。
 */
async function preloadAll() {
  const keys = Object.keys(state.manifest.actions);
  await Promise.all(keys.map((k) => loadFrames(k)));
}

/**
 * 切换动作（同步替换，前提是帧已载入）。
 * 若尚未载入则先载入，并存下「待生效」标记，载入完成后立即应用。
 */
async function setAction(key, opts = {}) {
  if (!state.manifest?.actions?.[key]) {
    console.warn('未知动作:', key);
    return;
  }
  if (state.current === key && !opts.force) return;

  if (!frameCache.has(key)) {
    await loadFrames(key);
  }

  const imgs = frameCache.get(key);
  if (!imgs || !imgs.length) return;

  // 同步替换
  state.frames = imgs;
  state.index = 0;
  state.current = key;
  state.lastTs = performance.now();

  if (canvas.width !== state.manifest.canvas.w) {
    canvas.width = state.manifest.canvas.w;
    canvas.height = state.manifest.canvas.h;
  }

  draw();
}

/**
 * 用户设定的缩放（来自配置，如 0.35）。
 *
 * **不能用「当前窗口宽度 / 素材宽度」反推**：气泡扩窗会加宽窗口，
 * 反推出来的 scale 随之变大，画布被放大 —— 角色会跟着扩窗一起长大，
 * 位置也会偏。所以缩放必须以用户设定为准，是个不随扩窗变化的值。
 */
let userScale = 0.35;

/**
 * 把画布缩放到用户设定的尺寸，并保持底部对齐。
 *
 * 画布是角色的**原始尺寸**（906×704）乘以 `userScale`。
 * 窗口尺寸与它一致（缩放档位切换时由 Rust 同步调整），
 * 因此正常情况下列两者相等；显式设置是为了避免依赖 CSS 的
 * `width:100%` —— 那个会在窗口尺寸变化时把角色拉伸变形。
 *
 * ## 为什么还要按窗口尺寸夹一层（防裁头）
 *
 * `userScale` 与「窗口当前尺寸」是**两个可能不同步的来源**：
 * 用户在设置面板里拖尺寸滑条时，Rust 端因为面板占着窗口而**延迟**
 * 应用缩放，只把值写进配置；关面板时才真正把窗口改小，且
 * **不发 `settings:scale` 事件**。于是 `userScale` 还停在旧值，
 * 画布仍按旧的大尺寸绘制。
 *
 * 画布锚定在 `#stageWrap`（`bottom:0`），比窗口高的部分
 * **只会从上方溢出**并被窗口裁掉 —— 表现出来正是「只有窗口在缩小，
 * 桌宠头部被截断」。
 *
 * 因此这里以**窗口实际尺寸**为准做一次夹取：取
 * `min(userScale, 窗口宽/素材宽, 窗口高/素材高)`。
 * 正常档位下这个 min 就是 `userScale`，行为完全不变；
 * 一旦两者失配（延迟应用缩放、窗口被外部改动等），
 * 画布会立刻收缩到窗口内，**保证角色永远不会被裁**。
 */
function fitStage() {
  const m = state.manifest;
  if (!m?.canvas) return;
  const baseW = m.canvas.w;
  const baseH = m.canvas.h;

  // 以 userScale 为准，但不超过窗口实际能容纳的缩放。
  // 用 1px 容差吸收 DPI 取整误差，避免正常档位被误夹。
  let scale = userScale;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  if (winW > 0 && winH > 0) {
    const fitW = (winW + 1) / baseW;
    const fitH = (winH + 1) / baseH;
    scale = Math.min(userScale, fitW, fitH);
  }

  canvas.style.width = `${baseW * scale}px`;
  canvas.style.height = `${baseH * scale}px`;
}

/** 合法缩放档位（与 Rust 的 MIN_SCALE / MAX_SCALE 一致）。 */
const MIN_SCALE = 0.20;
const MAX_SCALE = 1.00;

/**
 * 按窗口尺寸反推并修正 `userScale`（自愈）。
 *
 * 缩放的**权威来源是 Rust 配置**，正常情况下由 `settings:scale` 事件送达。
 * 但事件链路可能缺席（面板延迟应用缩放、事件丢失、时序不理想），
 * 一旦失配，画布就会按旧尺寸绘制并被窗口裁掉顶部。
 *
 * 这里只在**两个方向都吻合**时才采纳，避免误判：
 *   - 反推出的 scale 落在合法档位区间内
 *   - 宽与高**同时**吻合（气泡扩窗只改宽度，不会让两者同时对上）
 *
 * 两个条件都满足时，说明窗口确实是被「缩放档位」改的，
 * 此时更新 userScale 是安全且正确的。
 */
function syncScaleFromWindow() {
  const m = state.manifest;
  if (!m?.canvas) return;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  if (!(winW > 0 && winH > 0)) return;

  const sW = winW / m.canvas.w;
  const sH = winH / m.canvas.h;

  // 宽高必须一致（同一 scale 推出），容差 1px 应对 DPI 取整
  if (Math.abs(sW - sH) > 0.005) return;
  const s = (sW + sH) / 2;
  if (s < MIN_SCALE - 0.005 || s > MAX_SCALE + 0.005) return;

  if (Math.abs(s - userScale) > 0.005) {
    userScale = s;
  }
}

/**
 * 设置朝向（水平翻转）。
 *
 * 翻转写在 `#stage` 上，而居中/定位由外层 `#stageWrap` 负责。
 * 拆两层是必要的：若两者都用 `transform`，转身会把居中也一起镜像，
 * 角色会左右跳。`transform-origin: 50% 100%` 让翻转绕脚底中心进行。
 */
function setFacing(dir) {
  state.facing = dir >= 0 ? 1 : -1;
  canvas.style.transform = state.facing === 1 ? 'scaleX(1)' : 'scaleX(-1)';
}

/* ---------- 渲染 ---------- */

/**
 * 各动作的**绘制修正**。
 *
 * 素材虽在同一坐标系里裁切，但「坐」这一条是后补的，
 * 画的时候角色明显偏小、且底部悬空（实测：坐姿高 302px，
 * 待机高 518px；坐姿底部 y=494，待机脚底 y=662）。
 *
 * 直接播会显得「一坐下就缩小一大圈」，所以这里做两件事：
 *   - `scale`：放大人物的比例（坐姿 / 站姿 ≈ 0.77，符合现实中
 *     坐比站矮的比例）
 *   - `anchorBottom`：以**脚底**为锚点缩放，否则放大后会往上飘
 *
 * 这些是纯显示层的补偿，不影响行为逻辑与帧数据。
 */
const ACTION_DRAW = {
  sit: { scale: 1.32, anchorBottom: true },
};

/** 默认脚底位置（角色站立时的脚底 y，实测）。 */
const GROUND_Y = 662;

/**
 * 把当前帧画到指定 2D 上下文（含动作修正）。
 *
 * 抽成公共函数的原因：**主画布与穿透采样画布必须画得一模一样**。
 * 若采样画布漏了坐姿的缩放，坐着的角色可点区域就会和看到的错位
 * （点不到脚、却能点到空白处）。
 */
function paintFrame(c, img, w, h) {
  if (!img) return;
  c.clearRect(0, 0, w, h);

  const adj = ACTION_DRAW[state.current];
  if (!adj || !adj.scale || adj.scale === 1) {
    c.drawImage(img, 0, 0, w, h);
    return;
  }

  // 以脚底为锚点缩放：
  //   先把脚底对齐到 GROUND_Y，再放大，人物就"长高"而不是"飘起来"
  const s = adj.scale;
  const ground = adj.groundY ?? GROUND_Y;

  c.save();
  c.translate(0, ground);
  c.scale(s, s);
  c.translate(0, -ground);
  c.drawImage(img, 0, 0, w, h);
  c.restore();
}

/**
 * 绘制当前帧。
 *
 * 注意：这里**不做交叉淡化**。
 *
 * 曾经尝试把切换前后的两帧按不透明度叠加来柔化过渡，但对逐帧动画
 * 是有害的——两帧的角色姿态/位置不同，叠加会产生「双影」，
 * 观感上就是画面里同时出现两个角色轮廓。频繁切换时更明显。
 *
 * 保持单帧绘制，过渡的柔和交给「不延迟切换 + 帧率稳定」来保证。
 */
function draw() {
  paintFrame(ctx, state.frames[state.index], canvas.width, canvas.height);
}

let lastFrameTime = 0;
/** 最近一次循环推进的时间，供看门狗判断是否被挂起 */
let lastLoopAt = 0;

/**
 * 一次循环推进（不含调度）。
 *
 * 与 frame() 分离的原因：这样无论 rAF 是否被挂起，
 * 都能由看门狗用同一套逻辑驱动，行为完全一致。
 */
function tickLoop(now) {
  if (!lastFrameTime) lastFrameTime = now;
  const dt = Math.min(now - lastFrameTime, 100); // 防止卡顿后瞬移
  lastFrameTime = now;
  lastLoopAt = now;

  // 帧动画推进
  const act = state.manifest?.actions?.[state.current];
  let needDraw = false;
  if (act && state.frames.length) {
    const interval = 1000 / (act.fps || 30);
    if (now - state.lastTs >= interval) {
      state.lastTs = now;
      state.index++;
      if (state.index >= state.frames.length) {
        state.index = act.loop ? 0 : state.frames.length - 1;
      }
      needDraw = true;
    }
  }
  if (needDraw) draw();

  // 维护「窗口正在自行移动」标志。
  // 跟随也算：跟随期间绝不能拿后端返回的位置覆盖本地推算值
  // （move_window 是异步的，取回的可能是上一帧的位置 → 原地踏步）。
  walkingNow = brain?.state === 'walk' || brain?.state === 'follow';

  // 行为推进。用户主动暂停时跳过，其余情况一律推进
  // （包括手动选动作后——否则选「行走」窗口不会移动，表现为原地踏步）
  //
  // 跟随是用户显式开启的操作，**不受「暂停自主活动」影响**：
  // 那个开关针对的是「桌宠自己乱走」，而不是用户的跟随指令。
  if (!autonomyPaused || brain?.state === 'follow') {
    brain?.tick(now, dt);
  }
  walkingNow = brain?.state === 'walk' || brain?.state === 'follow';

  // 诊断快照：便于在 DevTools 里查看内部状态（window.__diagOn = true 开启）
  if (window.__diagOn) {
    window.__diag = {
      t: Math.round(now),
      action: state.current,
      index: state.index,
      frameCount: state.frames.length,
      brainState: brain?.state,
      dir: brain?.dir,
      sitting: brain?.sitting,
      following: brain?.following,
      cursorX: lastCursor ? Math.round(lastCursor.rel_x * 100) : null,
      winX: state.screen ? state.screen.win_x : null,
      until: brain ? Math.round(brain.until) : null,
      autonomyPaused,
    };
  }
}

/**
 * 主循环。
 *
 * 关键：`requestAnimationFrame(frame)` 必须**无条件**被调度。
 * 早期版本把它放在函数末尾，一旦前面抛异常，循环就永久停止——
 * 表现为动画冻结、只显示第一帧。现在用 try/catch 包住主体，
 * 任何异常都不会中断下一次调度。
 */
function frame(now) {
  try {
    tickLoop(now);
  } catch (e) {
    console.error('主循环异常（已捕获，循环继续）:', e);
  }
  requestAnimationFrame(frame);
}

/**
 * 看门狗。
 *
 * WebView2 可能在窗口不被聚焦/被判定遮挡时挂起 requestAnimationFrame，
 * 导致整个动画冻结。这里用 setInterval 检测：若超过 STALL_MS
 * 没有推进，就由定时器接管驱动，保证桌宠始终在动。
 */
const STALL_MS = 400;
setInterval(() => {
  const now = performance.now();
  if (now - lastLoopAt < STALL_MS) return;
  // rAF 已停摆，用定时器继续驱动
  try {
    tickLoop(now);
  } catch (e) {
    console.error('看门狗推进异常:', e);
  }
}, 100);

/**
 * 平滑切换动作。
 *
 * 设计取舍（重要）：
 * 早期版本会在「当前循环播完」时才切换，以求姿态对齐。但这要求
 * 显示层与行为层保持状态同步，实测会出现两者失配、动画卡死的问题。
 *
 * 现在改为：**立即切换**，由交叉淡化（180ms）来掩盖姿态差异。
 * 好处是显示层永远紧跟行为层，不会出现状态不一致；
 * 观感上淡化已经足以让过渡显得柔和。
 */
function requestActionSmooth(key) {
  setAction(key);
}

/**
 * 点击穿透。
 *
 * 问题：窗口按「点击」特效的最大范围设定（906×704），
 * 平时待机时角色只占中间一块，四周大片透明区域会挡住桌面图标。
 *
 * 做法：轮询光标位置，采样该点像素的 alpha：
 *   - 落在透明处 -> 开启穿透，点击落到桌面
 *   - 落在角色上 -> 关闭穿透，角色可点
 *
 * 为什么必须由原生侧提供光标位置：一旦开启穿透，webview 就收不到
 * mousemove，前端无法自行得知光标何时回到角色上。
 */
let passthroughWanted = true;   // 用户是否希望启用点击穿透
let passthroughNow = false;     // 当前实际状态（避免重复调用）
/** 临时挂起穿透（菜单/设置面板打开期间），不改用户意图 */
let passthroughSuspended = false;

/**
 * 点击穿透的运行统计，供排查用。
 *
 * ## 为什么要暴露出来
 *
 * 该功能此前**完全静默**：`set_click_through` 失败只走 `console.warn`，
 * 而桌宠窗口没有 DevTools，用户报「穿透无效」时无从判断
 * 是「判定没跑」还是「命令调用失败」。
 *
 * 现在把关键计数放到 `window.__passthrough`，并在**连续失败**时
 * 通过 toast 告知用户 —— 与第 15 条（ACL 导致 6 个设置项静默失效）
 * 是同一类教训：涉及 IPC 的失败**不能让 catch 静默**。
 */
const passStats = {
  polls: 0,          // 轮询次数
  cursorFails: 0,    // get_cursor_rel 返回空的次数
  setOk: 0,          // set_click_through 成功次数
  setFail: 0,        // set_click_through 失败次数
  lastRel: null,     // 最近一次光标归一化位置
  lastInside: null,  // 最近一次 inside 判定
  lastOpaque: null,  // 最近一次「是否落在角色上」
  lastShouldPass: null,
  lastError: '',     // 最近一次错误信息
};
window.__passthrough = passStats;

/** 采样用的离屏画布：与主画布同步，专门用于读取 alpha */
const probeCanvas = document.createElement('canvas');
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

/** alpha 低于该值即视为「透明」，可以穿透。留一点余量避开软边。 */
const ALPHA_THRESHOLD = 12;

/** 上次同步的帧标识，避免重复绘制同一帧（60ms 轮询下省下大量无谓开销） */
let probeKey = '';

function syncProbeCanvas(force = false) {
  const key = `${state.current}#${state.index}`;
  if (!force && key === probeKey) return;
  probeKey = key;

  if (probeCanvas.width !== canvas.width || probeCanvas.height !== canvas.height) {
    probeCanvas.width = canvas.width;
    probeCanvas.height = canvas.height;
  }
  // 用与主画布**完全相同**的绘制逻辑，否则坐姿等带缩放的动作
  // 会出现「看到的」与「可点的」不一致
  paintFrame(probeCtx, state.frames[state.index], probeCanvas.width, probeCanvas.height);
}

/**
 * 最近一次取到的光标位置（归一化，相对窗口）。
 *
 * 点击穿透的轮询本来就在调 `get_cursor_rel`，这里顺手缓存结果，
 * 供「跟随鼠标」使用 —— 否则一次移动要发两次同样的 IPC 调用。
 */
let lastCursor = null;

/**
 * 光标是否落在气泡上。
 *
 * 气泡是 DOM 元素，不参与画布的 alpha 采样。扩窗后气泡占据窗口
 * 上部的空白区（那里在采样画布里全是透明的），若不单独判断，
 * 会被判为「透明」而穿透，导致气泡点不动、文字也显得残缺。
 *
 * @param {number} relX 相对窗口的归一化横坐标
 * @param {number} relY 相对窗口的归一化纵坐标
 */
function isOverBubble(relX, relY) {
  const el = document.getElementById('bubble');
  if (!el || !isBubbleVisible()) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const px = relX * (window.innerWidth || 1);
  const py = relY * (window.innerHeight || 1);
  return px >= r.left && px < r.right && py >= r.top && py < r.bottom;
}

/**
 * 光标处是否落在角色（不透明像素）上。
 *
 * 采样一个小区域取最大值，避免恰好落在两像素缝隙而误判。
 *
 * **坐标换算要点**：`relX/relY` 是相对**整个窗口**的归一化坐标，
 * 但采样画布只有角色那一块（画布锚定在窗口底部，气泡扩窗后
 * 窗口会比画布大）。因此必须先把窗口坐标换算成画布坐标，
 * 否则扩窗后会出现「点到空白却判定为角色」的错位。
 */
function isOpaqueAt(relX, relY) {
  const w = probeCanvas.width;
  const h = probeCanvas.height;
  if (!w || !h) return true;   // 没准备好时保守处理：不穿透

  // 画布在窗口中的实际位置与尺寸（窗口坐标，单位为 CSS 像素）
  const rect = canvas.getBoundingClientRect();
  const winW = window.innerWidth || 1;
  const winH = window.innerHeight || 1;

  // 窗口归一化坐标 -> CSS 像素
  const px = relX * winW;
  const py = relY * winH;

  // 落在画布之外 -> 不是角色
  if (px < rect.left || px >= rect.right || py < rect.top || py >= rect.bottom) {
    return false;
  }

  // 换算到画布内部坐标，再映射到采样画布像素
  const x = Math.floor(((px - rect.left) / Math.max(1, rect.width)) * w);
  const y = Math.floor(((py - rect.top) / Math.max(1, rect.height)) * h);
  if (x < 0 || y < 0 || x >= w || y >= h) return false;

  const pad = 2;
  const sx = Math.max(0, x - pad);
  const sy = Math.max(0, y - pad);
  const sw = Math.min(w - sx, pad * 2 + 1);
  const sh = Math.min(h - sy, pad * 2 + 1);

  try {
    const data = probeCtx.getImageData(sx, sy, sw, sh).data;
    let maxA = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > maxA) maxA = data[i];
    }
    return maxA > ALPHA_THRESHOLD;
  } catch {
    return true;   // 读取失败时保守处理
  }
}

/**
 * 画布与窗口是否失配（用于穿透判定的自愈）。
 *
 * ## 为什么需要
 *
 * 穿透判定的正确性**强依赖**「画布实际尺寸 == 窗口尺寸」：
 * `get_cursor_rel` 给的是相对**窗口**的归一化坐标，而 `isOpaqueAt`
 * 用 `getBoundingClientRect()`（画布）来换算。两者一旦不等，
 * 同一个光标位置就会映射到画布的错误像素上，
 * 表现为「透明处判定为角色（挡住桌面）」或「角色处判定为透明（点不到）」。
 *
 * 失配的常见来源：设置面板开关、缩放档位切换后
 * `settings:scale` 事件与 `resize` 的时序差（README 第 16 条记录过同类问题）。
 *
 * 这里做一次兜底：发现画布尺寸与窗口明显不符就让 `fitStage()` 重新对齐。
 * 容差 2px 是为了吸收 DPI 取整误差，避免正常情况被反复纠正。
 */
function ensureStageMatchesWindow() {
  const rect = canvas.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  if (!winW || !winH || !rect.width || !rect.height) return;

  const off = Math.abs(rect.width - winW) > 2 || Math.abs(rect.height - winH) > 2;
  if (off) {
    // 只在「画布明显不等于窗口」时纠正。
    // 注意：气泡/面板打开期间窗口可能比画布大，属正常，此时不纠正。
    const menuOrPanel = menuOpen || settingsOpen() || isBubbleVisible();
    if (!menuOrPanel) {
      passStats.stageFixed = (passStats.stageFixed || 0) + 1;
      fitStage();
    }
  }
}

let cursorPolling = false;

async function pollPassthrough() {
  // 无论是否需要穿透判定，**先取一次光标位置**。
  //
  // 原因：「跟随鼠标」依赖 lastCursor，而它在下面多条分支里都会提前
  // return（跟随中、拖拽中、菜单打开…）。若把取光标放在 return 之后，
  // 这些情形下 lastCursor 会一直停在上一次的值，跟随就动不起来。
  passStats.polls++;
  const info = await invoke('get_cursor_rel');
  if (info) lastCursor = info;
  else passStats.cursorFails++;
  if (info) {
    passStats.lastRel = [Number(info.rel_x.toFixed(3)), Number(info.rel_y.toFixed(3))];
    passStats.lastInside = !!info.inside;
  }

  if (!passthroughWanted || passthroughSuspended) {
    if (passthroughNow) {
      passthroughNow = false;
      applyClickThrough(false);
    }
    return;
  }

  // 拖拽中或菜单/设置面板打开时必须保持可交互
  // 气泡同理：它是 DOM 元素，不参与画布 alpha 采样，
  // 若不排除会被当成透明区域而穿透，导致既点不到、文字也显得残缺。
  //
  // 跟随鼠标期间**也不穿透**：窗口正朝光标移动，若此刻穿透，
  // 光标会落到桌面上，跟随的输入源就断了。
  if (dragging || menuOpen || settingsOpen() || isBubbleVisible() || brain?.following) {
    if (passthroughNow) {
      passthroughNow = false;
      applyClickThrough(false);
    }
    return;
  }

  if (!info) return;

  // 光标不在窗口内：让窗口穿透，避免挡住别处
  let shouldPass;
  if (!info.inside) {
    shouldPass = true;
    passStats.lastOpaque = null;
  } else if (isOverBubble(info.rel_x, info.rel_y)) {
    // 光标落在气泡上：必须保持可交互（气泡可点击收起）
    shouldPass = false;
    passStats.lastOpaque = true;
  } else {
    syncProbeCanvas();
    // 采样前先确认画布与窗口对齐 —— 失配会让 alpha 采样落在错误像素上，
    // 表现为「透明处挡住桌面」或「角色点不到」。
    ensureStageMatchesWindow();
    // 记录判定用的原始几何，便于定位「画布与窗口失配」这类问题
    const rect = canvas.getBoundingClientRect();
    passStats.probe = {
      win: [window.innerWidth, window.innerHeight],
      rect: [Math.round(rect.left), Math.round(rect.top),
             Math.round(rect.width), Math.round(rect.height)],
      canvas: [probeCanvas.width, probeCanvas.height],
    };
    const opaque = isOpaqueAt(info.rel_x, info.rel_y);
    passStats.lastOpaque = opaque;
    shouldPass = !opaque;
  }
  passStats.lastShouldPass = shouldPass;

  if (shouldPass !== passthroughNow) {
    passthroughNow = shouldPass;
    applyClickThrough(shouldPass);
  }
}

/**
 * 真正下发穿透开关，并记录成败。
 *
 * 抽成函数的原因：调用点有三处（用户关闭穿透、面板打开、状态变化），
 * 早期三处各自 `invoke(...)` 且**都不检查结果**，失败时完全静默。
 * 现在统一在这里 await 并统计，连续失败会提示用户。
 */
let passFailNotified = false;

async function applyClickThrough(enabled) {
  const r = await invoke('set_click_through', { enabled });
  // invoke 失败时返回 undefined；成功时该命令返回 null（Rust 侧 Ok(())）
  if (r === undefined && window.__TAURI__) {
    passStats.setFail++;
    if (!passFailNotified && passStats.setFail >= 3) {
      passFailNotified = true;
      // 不能用 toast 遮挡太久；给一次明确提示即可
      toast('点击穿透功能不可用（详见 console 日志）', 4000);
    }
    return;
  }
  passStats.setOk++;
}

/** 启动穿透轮询（约 60ms 一次，足够跟手且开销很低）。 */
function startPassthroughPolling() {
  if (cursorPolling) return;
  cursorPolling = true;
  setInterval(() => {
    pollPassthrough().catch(() => {});
  }, 60);
}

/* ---------- 屏幕信息（带缓存） ---------- */

/**
 * 是否正在行走。
 * 用一个显式标志而不是判断 brain.state —— refreshScreen 是异步的，
 * await 返回时状态可能已经变化，导致判断失效、位置被旧值覆盖。
 */
let walkingNow = false;

/**
 * 刷新屏幕与窗口几何信息。
 *
 * 行走期间绝不覆盖窗口位置：move_window 是异步的，后端返回的
 * 可能是上一次的位置，覆盖后会让每帧都从旧坐标出发（原地踏步）。
 * 行走的位置完全由前端本地推算。
 */
async function refreshScreen(force = false) {
  const now = performance.now();
  if (!force && state.screen && now - state.screenTs < 500) {
    return state.screen;
  }
  const wasWalking = walkingNow;
  const sc = await invoke('get_screen_info');
  if (sc) {
    if (state.screen && (wasWalking || walkingNow) && !force) {
      // 只更新屏幕边界与窗口尺寸，保留本地推算的位置
      state.screen.work_x = sc.work_x;
      state.screen.work_y = sc.work_y;
      state.screen.work_w = sc.work_w;
      state.screen.work_h = sc.work_h;
      state.screen.win_w = sc.win_w;
      state.screen.win_h = sc.win_h;
    } else {
      state.screen = sc;
    }
    state.screenTs = now;
  }
  return state.screen;
}

/**
 * 点击特效播完后的停顿（毫秒），之后才切回待机。
 *
 * 点击动画的首尾姿态一致（都是自然站姿），所以末尾会停在站姿上。
 * 这个停顿太短会显得「刚放完特效就急着切走」，观感突兀；
 * 适当延长能让它稳稳站一下再回到待机。想调节奏改这里即可。
 */
const CLICK_HOLD_MS = 600;

/** 点击动作的总时长（动画时长 + 末尾停顿）。 */
function clickDurationMs() {
  const sc = state.manifest?.actions?.click;
  if (!sc) return 0;
  const anim = sc.durationMs || sc.frameCount * (1000 / (sc.fps || 30));
  return anim + CLICK_HOLD_MS;
}

/* ---------- 交互：拖拽 / 单击 ---------- */

let dragging = false;

canvas.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  dragging = true;
  brain?.holdUser();
  markUserActivity();
  await invoke('drag_start', { x: e.screenX, y: e.screenY });
});

window.addEventListener('mousemove', async (e) => {
  if (!dragging) return;
  await invoke('drag_move', { x: e.screenX, y: e.screenY });
});

window.addEventListener('mouseup', async () => {
  if (!dragging) return;
  dragging = false;
  brain?.holdUser();
  await refreshScreen(true);
  const wasClick = await invoke('drag_end');
  if (wasClick) playClick();
});

/**
 * 单击：播放一次性特效。
 *
 * 播完的去向由 brain 决定：
 *   - 普通情况 -> 回到待机
 *   - **坐着时 -> 回到坐**（坐是持续状态，点击不该把它打断）
 * 这个判断在 `brain.enterIdle()` 里，靠 `sitting` 标志实现。
 */
async function playClick() {
  const sc = window.__manifest?.actions?.click;
  if (!sc) return;

  // 用户交互：推迟休息（不影响关心的冷却）
  markUserActivity();

  // 清除可能存在的暂停，确保播完能自动恢复
  autonomyPaused = false;

  // 「戳一下」语音：与动画时长不做任何对齐——
  // 语音比动画长或短都保留原样，不裁剪也不等待。
  playVoice('戳一下');

  // 先设置状态，再切画面：避免切帧耗时导致计时起点偏晚
  brain.playOneshot(performance.now(), clickDurationMs(), 'click');
  await setAction('click', { force: true });
}

/* ---------- 提示条 ---------- */

const toastEl = document.getElementById('toast');
let toastTimer = 0;

/** 短暂显示一条提示。 */
function toast(msg, ms = 1800) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- 右键菜单（DOM） ---------- */

/**
 * 菜单用网页内的 DOM 实现。
 *
 * 曾尝试改为 Tauri 原生菜单（好处是不随窗口移动），但两条路都不通：
 *   1. `menu.popup()` 会阻塞主线程（`TrackPopupMenu` 同步调用 +
 *      外层宏 `rx.recv()` 等待），导致桌宠停止移动、设置窗口打不开，
 *      菜单关闭后积压指令一次性执行（「瞬移」）；且它用
 *      `TPM_RETURNCMD`，不发 `WM_COMMAND`，`on_menu_event` 收不到事件。
 *   2. 自建 Win32 弹出菜单实测完全不出现（很可能 `SetForegroundWindow`
 *      在后台线程无效，而菜单宿主必须是前台窗口）。
 *
 * DOM 菜单「会跟着桌宠移动」的缺点，改用下面两条策略规避：
 *   - **打开菜单时暂停自主行为**（桌宠不再走动，菜单自然不会跑）
 *   - **同时切到待机**，让姿态稳定，观感更清楚
 */

const menu = document.getElementById('menu');
let menuOpen = false;

/** 打开菜单前是否处于暂停状态，关闭时恢复 */
let pausedBeforeMenu = false;

function showMenu(x, y) {
  if (menuOpen) return;
  markUserActivity();

  // 暂停自主行为：菜单期间桌宠不再移动，避免菜单「跟着跑」。
  //
  // 但**不要强制切待机**——那会让坐着的桌宠一开菜单就站起来，
  // 关掉菜单才坐回去（用户实测反馈的问题）。
  // 坐与跟随都是用户显式开启的持续状态，菜单不该打断它们。
  pausedBeforeMenu = autonomyPaused;
  autonomyPaused = true;

  const persistent = brain?.sitting || brain?.following;
  if (!persistent) {
    // 常规情况：切待机让姿态稳定、菜单期间的观感更清楚
    brain.state = 'idle';
    setAction('idle', { force: true });
  }

  menu.style.display = 'block';
  menuOpen = true;

  // 先显示再量尺寸，避免首次打开时 offsetWidth 为 0 导致定位错
  const mw = menu.offsetWidth || 168;
  const mh = menu.offsetHeight || 240;
  menu.style.left = Math.max(0, Math.min(x, window.innerWidth - mw)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, window.innerHeight - mh)) + 'px';

  syncMenu();
}

function hideMenu() {
  menu.style.display = 'none';
  menuOpen = false;

  // 恢复打开菜单前的状态（若用户原本就暂停着，则保持暂停）
  if (!pausedBeforeMenu) {
    autonomyPaused = false;
    // 坐/跟随时不要动状态：保持在原状态即可，
    // 只有常规情况下才重新进入待机
    if (!brain.sitting && !brain.following) {
      brain.enterIdle(performance.now());
    }
  }
}

/**
 * 同步菜单里的状态。
 *
 * 除了勾选态，还要**改按钮文字**：
 *   跟随中 -> 「取消跟随」
 *   坐姿中 -> 「起身」
 * 否则用户看不出当前处于哪个状态，也不知道再点一次会发生什么。
 */
function syncMenu() {
  if (!menu) return;
  menu.querySelectorAll('[data-cmd]').forEach((el) => {
    const c = el.dataset.cmd;
    if (c === 'toggle-pause') el.dataset.on = String(autonomyPaused);

    if (c === 'toggle-follow') {
      el.textContent = brain?.following ? '取消跟随' : '跟随鼠标';
      el.dataset.on = String(!!brain?.following);
    }
    if (c === 'act:sit') {
      el.textContent = brain?.sitting ? '起身' : '坐下';
      el.dataset.on = String(!!brain?.sitting);
    }
  });
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY);
});

// 点击菜单以外的地方关闭
window.addEventListener('mousedown', (e) => {
  if (menuOpen && !menu.contains(e.target)) hideMenu();
});

/* ---------- 天气 ---------- */

/** 已配置的城市（启动时读入，设置变更后同步）。 */
let weatherCities = [];

/**
 * 查询并显示天气。
 *
 * 流程：读城市 → 查天气（1 小时缓存）→ 气泡逐行显示 → 播放对应语音。
 *
 * 语音分两条：成功用「天气」，失败用「天气失败」。
 * 无论成败都给出反馈——静默无响应最难排查。
 */
async function queryWeather() {
  if (!weatherCities.length) {
    // 没配城市时直接提示去设置，不发请求
    showBubble(['还没有设置所在地区', '右键 → 设置 → 所在地区'], { kind: 'error' });
    playVoice(WEATHER_CLIPS.fail);
    return;
  }

  showPending('正在查询天气…');

  const res = await getWeather(weatherCities);

  if (!res.ok) {
    // 失败文案按需求固定，并播「天气失败」语音
    showBubble(['博士…出了些问题，我查不到天气'], { kind: 'error' });
    playVoice(WEATHER_CLIPS.fail);
    console.warn('天气查询失败:', res.error);
    return;
  }

  // 小窗口的处理：
  //
  // 曾经在窄窗口下切 `compact`（每城市只留 1 行、丢掉体感湿度）。
  // 但气泡现在**会自动换行**、也放宽了高度上限，信息可以完整放下，
  // 再丢数据就只是"看起来少了东西"。
  //
  // 因此改为：**数据始终完整**，只在小窗时把生活提醒压到 2 条，
  // 避免气泡过高需要滚动。
  const narrow = window.innerWidth < 340;
  const lines = formatWeatherReport(res.items, {
    adviceMax: narrow ? 2 : 3,
  });
  showBubble(lines, { kind: 'weather' });
  playVoice(WEATHER_CLIPS.ok);
}

/* ---------- 随机关心 ---------- */

/**
 * 待机时每隔一段时间弹一句关心的话。
 *
 * 设计要点：
 *   - **只在待机/休息/坐时弹**：行走或跟随中插话会很突兀
 *   - **菜单/设置面板打开时不弹**：避免盖住用户正在操作的界面
 *   - **气泡已经显示时不弹**：不覆盖正在看的天气等信息
 *   - 间隔随机（不是固定周期），避免看起来像定时任务
 *
 * **冷却与用户操作无关**：到点就尝试，不因点击/拖拽而重置。
 * 若到点时恰好不满足条件（如气泡被占用），则**跳过这一次**，
 * 计时照常继续 —— 不会因为被跳过而把间隔拉长。
 */
const CARE_MIN_MS = 2 * 60 * 1000;   // 2 分钟
const CARE_MAX_MS = 3 * 60 * 1000;   // 3 分钟

let careTimer = 0;
let careNextAt = 0;
/** 最近说过的几句，避免短时间内重复 */
const careRecent = [];

/** 安排下一次关心。间隔随机，且**不受用户操作影响**。 */
function scheduleCare() {
  clearTimeout(careTimer);
  const wait = CARE_MIN_MS + Math.random() * (CARE_MAX_MS - CARE_MIN_MS);
  careNextAt = Date.now() + wait;
  careTimer = setTimeout(() => {
    tryCare();
    scheduleCare();   // 无论这次说没说成，都照常排下一次
  }, wait);
}

/**
 * 到点时判断该不该说。不满足条件就跳过，不影响后续计时。
 *
 * 允许的状态包括**跟随**：气泡是窗口内的 DOM 元素，窗口移动时
 * 它跟着一起移动，两者不会错开，所以跟随中说一句并无问题。
 * 只有「行走」除外——那是桌宠自己在溜达，此时插话意义不大。
 */
function tryCare() {
  const st = brain?.state;
  const okState = st === 'idle' || st === 'rest' || st === 'sit' || st === 'follow';
  if (!okState) return;
  // 用户正在操作的界面不要盖住
  if (menuOpen || settingsOpen()) return;
  // 气泡已被占用（如正在显示天气）就不要抢
  if (isBubbleVisible()) return;
  // 用户显式暂停自主活动时不打扰
  if (autonomyPaused) return;

  const text = pickCareLine({ exclude: careRecent });
  careRecent.push(text);
  if (careRecent.length > 10) careRecent.shift();

  showBubble([text], { hold: 9000, kind: 'care' });
}

/** 记录一次用户交互。 */
function markUserActivity() {
  brain?.noteUserActivity(performance.now());
}

/* ---------- 菜单命令处理 ---------- */

async function runMenuCommand(cmd) {
  switch (cmd) {
    case 'quit':
      await invoke('save_position');
      await invoke('quit_app');
      return;

    case 'talk': {
      // 交谈：从「非特殊用途」的语音里随机播一条。
      // 特殊用途的（戳一下/任命助理/周年庆典/新年祝福/生日）不参与随机池。
      const name = playRandomTalk();
      if (name) toast(`交谈：${name}`, 1200);
      break;
    }

    case 'settings':
      // 设置是主窗口内的面板（不是独立窗口），
      // 打开时窗口会被临时放大
      await openSettings();
      break;

    case 'weather':
      await queryWeather();
      break;

    case 'follow': {
      toast('跟随：功能开发中');
      break;
    }

    case 'random':
      autonomyPaused = false;
      brain.enterIdle(performance.now());
      brain.until = performance.now();
      break;

    case 'toggle-pause':
      autonomyPaused = !autonomyPaused;
      if (autonomyPaused) {
        brain.state = 'idle';
        await setAction('idle', { force: true });
      } else {
        brain.enterIdle(performance.now());
      }
      break;

    case 'toggle-follow':
      // 跟随是持续性状态：再点一次关闭
      if (brain.following) {
        brain.exitFollow(performance.now());
        toast('已取消跟随', 1200);
      } else {
        brain.enterFollow(performance.now());
        toast('跟随鼠标中，再点一次取消', 1800);
      }
      break;

    case 'act:sit':
      // 坐也是切换式：再点一次起身
      if (brain.sitting) {
        brain.exitSit(performance.now());
        toast('已起身', 1200);
      } else {
        brain.enterSit(performance.now());
        toast('坐下中，再点一次起身', 1600);
      }
      break;

    case 'act:idle':
    case 'act:move':
    case 'act:rest':
    case 'act:click': {
      // 手动选动作：直接进入对应行为状态，而不冻结状态机
      // （冻结 tick 会导致选「行走」时窗口不移动，即原地踏步）
      autonomyPaused = false;
      const now = performance.now();
      const hold = 8000;
      const key = cmd.slice(4); // 去掉 "act:"

      // 手动选普通动作会**解除**坐与跟随——用户意图明确要换动作了
      brain.sitting = false;
      brain.following = false;

      if (key === 'move') {
        brain.enterWalk(now);
        brain.until = now + hold;
      } else if (key === 'rest') {
        brain.enterRest(now);
        brain.until = now + hold;
      } else if (key === 'idle') {
        brain.enterIdle(now);
        brain.until = now + hold;
      } else if (key === 'click') {
        brain.playOneshot(now, clickDurationMs(), 'click');
        await setAction('click', { force: true });
      }
      break;
    }

    default:
      console.warn('未知菜单项:', cmd);
  }
}

function bindMenu() {
  if (!menu) return;
  menu.querySelectorAll('[data-cmd]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 先关闭菜单（会恢复正常活动），再执行命令，
      // 否则命令里设置的 autonomyPaused 会被 hideMenu 覆盖
      hideMenu();
      await runMenuCommand(el.dataset.cmd);
    });
  });
}

/**
 * 监听设置窗口引发的改动。
 *
 * 两个窗口各有一份界面状态，必须靠事件同步，
 * 否则设置里改了尺寸/穿透，主窗口仍按旧值判断。
 */
async function listenSettingChanges() {
  const api = window.__TAURI__?.event?.listen;
  if (!api) return;

  /**
   * 监听失败必须**可见**。
   *
   * 曾经这里只写 console.error —— 而桌宠没有 DevTools，
   * 于是「事件全都没注册上」这种故障完全静默：设置里改语言、
   * 点试听、调音量全都毫无反应，却看不出任何报错。
   *
   * 真实原因是没有 capabilities 文件，Tauri 2 的 ACL 拒绝了
   * `core:event:listen`（见 src-tauri/capabilities/default.json）。
   */
  const failed = [];
  const safe = async (name, fn) => {
    try {
      await api(name, fn);
    } catch (e) {
      failed.push(name);
      console.error('listen failed:', name, e);
    }
  };

  // 点击穿透开关（设置窗口改动后同步）
  await safe('settings:passthrough', async (e) => {
    passthroughWanted = e.payload !== false;
    if (!passthroughWanted && passthroughNow) {
      passthroughNow = false;
      // 用统一的封装，失败会被统计并提示（早期直接 invoke 会静默）
      await applyClickThrough(false);
    }
  });

  // 缩放：窗口尺寸变了，必须重新取几何信息（行走边界依赖 win_w）
  await safe('settings:scale', async (e) => {
    // 记录用户设定的缩放：fitStage 以它为准，而不是从窗口宽度反推
    if (typeof e?.payload === 'number') userScale = e.payload;
    fitStage();
    await refreshScreen(true);
  });

  // 音量：立即作用于新播放的语音，并调整正在播放的那条
  await safe('settings:volume', (e) => setVoiceVolume(e.payload));

  // 语音语言：切换后下一条语音即为新语言
  await safe('settings:voice-lang', (e) => {
    setVoiceLang(e.payload);
    toast(`语音语言：${e.payload === 'jp' ? '日本語' : '中文'}`, 1200);
  });

  // 试听：设置面板里点「试听」时，播一条当前语言的交谈语音
  await safe('settings:preview-voice', () => {
    playRandomTalk();
  });

  // 生日：面板里改了就同步到本地，下次启动即按新值判断
  await safe('settings:birthday', (e) => {
    birthdayCfg = e.payload || null;
  });

  // 所在地区：面板里增删后同步，天气查询立即用新列表
  await safe('settings:cities', (e) => {
    weatherCities = Array.isArray(e.payload) ? e.payload : [];
  });

  // 把结果暴露出来，便于在控制台/自检里确认事件链路是否接通
  window.__settingsEvents = {
    ok: failed.length === 0,
    failed,
  };
  if (failed.length) {
    // 事件是「设置面板 → 主窗口」的唯一同步通道，断了就说明
    // 设置里的改动不会生效。用 toast 明确告知，而不是静默失败。
    toast(`设置同步不可用（${failed.length} 项事件未注册）`, 4000);
  }
}

/* ---------- 启动 ---------- */

(async function boot() {
  try {
    // 先把素材基址定下来，再读清单 —— 顺序不能反，
    // 否则 manifest 会去错误的位置找。
    await resolveAssetBase();

    state.manifest = await loadManifest();
    window.__manifest = state.manifest;

    // 预载全部动作帧：切换时即为同步替换，彻底消除竞态与空窗
    await preloadAll();

    const cfg = await invoke('get_config');
    if (cfg) {
      // 尊重用户保存的点击穿透开关（其余设置项由设置窗口负责）
      passthroughWanted = cfg.click_through !== false;
      // 已配置的所在地区（天气用）
      weatherCities = Array.isArray(cfg.weather_cities) ? cfg.weather_cities : [];
      // 缩放：画布尺寸以它为准（不随气泡扩窗变化）
      if (typeof cfg.scale === 'number' && cfg.scale > 0) userScale = cfg.scale;
    }

    // 语音：先载入清单并应用音量/语言，再按启动规则播一条
    await initVoice();
    if (cfg) {
      setVoiceLang(cfg.voice_lang);
      setVoiceVolume(cfg.volume);
      birthdayCfg = cfg.birthday || null;
    }

    brain = new Brain({
      // 自主行为用平滑切换：等当前循环播完再换，姿态衔接更自然
      onAction: (key, opts) => {
        if (opts && opts.force) setAction(key, opts);
        else requestActionSmooth(key);
      },
      onMove: (x, y) => {
        // 行走推进：先更新本地缓存，再异步发指令。
        // 不能等 invoke 返回，否则每帧都会基于旧位置计算。
        if (state.screen) {
          state.screen.win_x = x;
          state.screen.win_y = y;
        }
        // 检查 move_window 是否真的成功（失败会在控制台暴露）
        invoke('move_window', { x, y }).then((r) => {
          if (r === undefined && window.__TAURI__) {
            // 调用失败会被 invoke 内部捕获并 console.warn
          }
        });
        if (window.__diagOn) {
          (window.__moveLog = window.__moveLog || []).push([Math.round(performance.now()), x, y]);
          if (window.__moveLog.length > 300) window.__moveLog.shift();
        }
      },
      onTurn: (dir) => setFacing(dir),
      getScreen: () => {
        // 行走中不触发刷新，避免异步返回把位置覆盖回旧值
        if (!walkingNow) refreshScreen();
        return state.screen;
      },
      // 跟随鼠标需要光标位置；由原生侧提供（穿透开启后前端收不到 mousemove）
      getCursor: () => lastCursor,
    });

    await setAction('idle', { force: true });
    await refreshScreen(true);
    draw();

    // 让画布尺寸与窗口匹配（气泡扩窗后会再次调用）
    fitStage();
    // 窗口尺寸变化时重新适配。
    //
    // 除了重绘，还尝试**修正 userScale**：设置面板关闭时 Rust 会按新缩放
    // 改变窗口大小，若事件因故没到（或到达顺序不理想），
    // userScale 就会与窗口失配、画布被裁。
    // 这里在 resize 后按窗口尺寸反推一次：**只在能整除到某个合法档位时**
    // 才采纳，避免把气泡扩窗（宽度变大）误判成缩放变化。
    window.addEventListener('resize', () => {
      syncScaleFromWindow();
      fitStage();
    });

    // 绑定右键菜单
    bindMenu();

    // 对话气泡（天气、关心语句的显示区）
    //
    // 气泡固定在窗口顶部、高度 60%、内容超出内部滚动，
    // **不改变窗口尺寸**——这样角色永远不会被裁。
    initBubble();

    // 初始化设置面板
    initSettingsPanel({
      invoke,
      // 直连通道：设置面板与主窗口同处一个窗口，可以直接调用，
      // 不必依赖可能被 ACL 拒绝的 settings:* 事件
      onLangChange: (lang) => {
        setVoiceLang(lang);
        toast(`语音语言：${lang === 'jp' ? '日本語' : '中文'}`, 1200);
      },
      onVolumeChange: (v) => setVoiceVolume(v),
      onPreview: () => playRandomTalk(),
      // 所在地区改动：天气查询立即用新列表
      onCitiesChange: (list) => { weatherCities = Array.isArray(list) ? list : []; },
      // 面板里搜城市，复用天气模块的地理编码
      searchCity,
      maxCities: MAX_CITIES,
      onOpen: (open) => {
        // 面板打开时保持窗口可交互（不能穿透），并暂停自主行为
        if (open) {
          passthroughSuspended = true;
          pausedBeforeMenu = autonomyPaused;
          autonomyPaused = true;
          if (passthroughNow) {
            passthroughNow = false;
            applyClickThrough(false);
          }
        } else {
          passthroughSuspended = false;
          if (!pausedBeforeMenu) {
            autonomyPaused = false;
            brain?.enterIdle(performance.now());
          }
          // 面板关闭时 Rust 会按最新缩放重设窗口尺寸。
          // 事件（settings:scale）通常已经处理过，但这里再自愈一次，
          // 确保画布尺寸与窗口一致 —— 否则画布偏大会被裁掉顶部（角色头没了）。
          syncScaleFromWindow();
          fitStage();
          refreshScreen(true);
        }
      },
    });

    // 设置窗口改动后同步（缩放会改变窗口尺寸，需刷新几何信息）
    await listenSettingChanges();

    // 关键：让行为层从「待机」正式起步。
    // 若不做这一步，brain.until 仍是初始值 0，第一帧就会触发决策，
    // 导致刚启动就乱切动作。
    brain.enterIdle(performance.now());

    // 启动语音。
    // 规则见 voice.js 的 pickStartupClip：
    //   生日（当天首次启动必定播）> 春节 > 周年庆 > 任命助理，
    // 特殊日期启动时不会播「任命助理」。
    // 与动画时长不做对齐，语音照常播完。
    try {
      const picked = playStartupClip(new Date(), birthdayCfg);
      if (picked?.reason && picked.reason !== 'normal') {
        toast(`启动语音：${picked.name}`, 1500);
      }
      window.__startupVoice = picked;
    } catch (e) {
      console.warn('启动语音失败:', e);
    }

    requestAnimationFrame(frame);

    // 启动点击穿透轮询：让透明区域不挡住桌面图标
    syncProbeCanvas(true);
    startPassthroughPolling();

    // 把「安静起点」设为启动时刻——否则 lastUserAt 为 0，
    // 一启动就算「安静了很久」，会立刻触发休息。
    markUserActivity();

    // 开始「随机关心」计时（每 2~3 分钟尝试说一句，与用户操作无关）
    scheduleCare();

    window.__brain = brain;
    window.__ready = true;
  } catch (err) {
    document.body.innerHTML =
      '<pre style="color:#f66;background:rgba(20,20,20,.92);font:12px monospace;' +
      'padding:8px;margin:0;white-space:pre-wrap">启动失败: ' +
      String(err) +
      '</pre>';
    window.__bootError = String(err);
    window.__ready = true;
  }
})();
