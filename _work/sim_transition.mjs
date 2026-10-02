// 验证动作切换与过渡逻辑：确保 pendingAction 不会卡住，
// 且点击后不再出现静止空档。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../desktop-pet/web/brain.js', import.meta.url), 'utf8');
const m = src.match(/export const BEHAVIOR = \{([\s\S]*?)\n\};/);
const BEHAVIOR = eval('({' + m[1] + '})');

const S = { IDLE: 'idle', REST: 'rest', WALK: 'walk', ONESHOT: 'oneshot' };
const rand = (a, b) => a + Math.random() * (b - a);

// 模拟一套完整的行为 + 显示层
const actions = {
  idle:  { frames: 81, fps: 30, loop: true },
  move:  { frames: 41, fps: 30, loop: true },
  rest:  { frames: 51, fps: 30, loop: true },
  click: { frames: 67, fps: 30, loop: false },
};
const durOf = k => actions[k].frames / actions[k].fps * 1000;

const screen = { work_x: 0, work_y: 0, work_w: 1920, work_h: 1040,
                 win_x: 800, win_y: 780, win_w: 317, win_h: 246 };

// 显示层状态
const disp = { current: 'idle', index: 0, lastTs: 0, pending: null, blendUntil: 0 };
const switchLog = [];
let stuckCount = 0;

function setActionNow(key, now) {
  disp.current = key;
  disp.index = 0;
  disp.lastTs = now;
  disp.blendUntil = now + 180;   // 融合窗口
  switchLog.push([now, key]);
}

const MAX_DEFER = 900;
let pendingSince = 0;

function requestSmooth(key, now) {
  if (disp.current === key) { disp.pending = null; return; }
  const act = actions[disp.current];
  if (!act || !act.loop) { setActionNow(key, now); return; }
  if (!disp.pending) pendingSince = now;
  disp.pending = key;
}

function flushPending(now) {
  if (!disp.pending) return;
  const waited = now - pendingSince;
  if (disp.index === 0 || waited >= MAX_DEFER) {
    const k = disp.pending;
    disp.pending = null;
    pendingSince = 0;
    setActionNow(k, now);
  }
}

function advanceDisplay(now) {
  const act = actions[disp.current];
  const interval = 1000 / act.fps;
  if (now - disp.lastTs >= interval) {
    disp.lastTs = now;
    disp.index++;
    if (disp.index >= act.frames) disp.index = act.loop ? 0 : act.frames - 1;
  }
  flushPending(now);
}

class Brain {
  constructor() { this.state = S.IDLE; this.until = 0; this.dir = 1; this.plannedSpan = 0;
                  this.holdUntil = 0; this.pausedByUser = false; this.paused = false; this.longWalk = false; }
  onAction(k, o) { if (o && o.force) setActionNow(k, this._now); else requestSmooth(k, this._now); }
  notifyActionApplied(now) { if (this.state === S.ONESHOT) return;
    if (this.plannedSpan > 0) { this.until = now + this.plannedSpan; this.plannedSpan = 0; } }
  enterIdle(now) { this.state = S.IDLE; this.plannedSpan = rand(BEHAVIOR.idleMin, BEHAVIOR.idleMax);
    this.until = now + this.plannedSpan; this.onAction('idle'); }
  enterRest(now) { this.state = S.REST; this.plannedSpan = rand(BEHAVIOR.restMin, BEHAVIOR.restMax);
    this.until = now + this.plannedSpan; this.onAction('rest'); }
  enterWalk(now) { this.state = S.WALK;
    this.longWalk = Math.random() < BEHAVIOR.pLongWalk;
    this.plannedSpan = this.longWalk ? BEHAVIOR.longWalkMax : rand(BEHAVIOR.walkMin, BEHAVIOR.walkMax);
    this.until = now + this.plannedSpan; this.dir = this.pickDirection(); this.onAction('move'); }
  pickDirection() {
    const left = screen.work_x, right = screen.work_x + screen.work_w - screen.win_w;
    const t = (screen.win_x - left) / Math.max(1, right - left);
    if (t < BEHAVIOR.edgeZone) return 1;
    if (t > 1 - BEHAVIOR.edgeZone) return -1;
    return Math.random() < 0.5 ? -1 : 1;
  }
  decideNext(now) { const r = Math.random();
    if (r < BEHAVIOR.pIdleAgain) { this.enterIdle(now); return; }
    const r2 = (r - BEHAVIOR.pIdleAgain) / (1 - BEHAVIOR.pIdleAgain);
    r2 < BEHAVIOR.pRest ? this.enterRest(now) : this.enterWalk(now); }
  playOneshot(now, ms, key) { this.state = S.ONESHOT; this.until = now + ms;
    this.holdUntil = 0; this.onAction(key, { force: true }); }
  tick(now, dt) {
    this._now = now;
    if (this.paused || this.pausedByUser) return;
    if (now < this.holdUntil && this.state !== S.ONESHOT) return;
    if (this.state === S.ONESHOT) { if (now >= this.until) this.enterIdle(now); return; }
    if (this.state === S.IDLE) { if (now >= this.until) this.decideNext(now); return; }
    if (this.state === S.REST) { if (now >= this.until) this.enterIdle(now); return; }
    if (this.state === S.WALK) { this.stepWalk(now, dt); if (now >= this.until) this.enterIdle(now); }
  }
  stepWalk(now, dt) {
    const dx = (BEHAVIOR.walkSpeed * this.dir * dt) / 1000;
    let nx = screen.win_x + Math.round(dx);
    const left = screen.work_x, right = screen.work_x + screen.work_w - screen.win_w;
    let hit = false;
    if (nx <= left) { nx = left; this.dir = 1; hit = true; }
    else if (nx >= right) { nx = right; this.dir = -1; hit = true; }
    if (hit) {
      if (this.longWalk) { this.longWalk = false; this.until = Math.min(this.until, now + BEHAVIOR.afterEdgeWalk); }
      else { this.until = Math.max(this.until, now + BEHAVIOR.turnPause); }
    }
    screen.win_x = nx;
  }
}

// ---- 仿真 ----
const b = new Brain();
b._now = 0;
setActionNow('idle', 0);
b.enterIdle(0);

// 在 t=30s 插入一次点击
const CLICK_AT = 30000;
let clicked = false;

let t = 0; const DT = 16; const END = 20 * 60 * 1000;
let maxPendingMs = 0, pendingStart = 0;
let clickDone = 0, idleResumed = 0;

while (t < END) {
  t += DT;
  b._now = t;

  if (!clicked && t >= CLICK_AT) {
    clicked = true;
    b.holdUser && b.holdUser();
    b.playOneshot(t, durOf('click') + 80, 'click');
    clickDone = t + durOf('click');
  }

  b.tick(t, DT);
  advanceDisplay(t);

  // 监控 pending 是否长时间不执行（卡死检测）
  if (disp.pending) {
    if (!pendingStart) pendingStart = t;
    maxPendingMs = Math.max(maxPendingMs, t - pendingStart);
    if (t - pendingStart > 5000) stuckCount++;
  } else pendingStart = 0;

  // 记录点击结束后何时恢复待机
  if (clicked && !idleResumed && t > clickDone && b.state === S.IDLE) idleResumed = t;
}

console.log('=== 切换与过渡验证（20 分钟）===');
console.log(`动作切换次数: ${switchLog.length}`);
console.log(`pending 最长等待: ${maxPendingMs.toFixed(0)} ms  ${maxPendingMs > 3000 ? '✗ 过长' : '✓ 正常'}`);
console.log(`卡死次数(>5s): ${stuckCount}  ${stuckCount ? '✗' : '✓'}`);
console.log(`最终显示动作: ${disp.current}  pending=${disp.pending}`);

if (clicked) {
  console.log('\n=== 点击后的恢复 ===');
  console.log(`  点击播放结束: ${(clickDone/1000).toFixed(2)}s`);
  console.log(`  恢复待机时刻: ${(idleResumed/1000).toFixed(2)}s`);
  const gap = idleResumed - clickDone;
  console.log(`  空档: ${gap.toFixed(0)} ms  ${gap < 400 ? '✓ 无明显静止' : '✗ 仍有静止 ' + gap.toFixed(0) + 'ms'}`);
}

console.log('\n=== 最近 14 次切换 ===');
switchLog.slice(-14).forEach(([tt, k]) => console.log(`  t=${(tt/1000).toFixed(2)}s -> ${k}`));
