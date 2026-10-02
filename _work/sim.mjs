// 行为状态机离线仿真（含长途行走）
import { readFileSync, writeFileSync } from 'node:fs';

// 直接从 brain.js 抽取真实的 BEHAVIOR 常量，避免仿真与实现不一致
const src = readFileSync(new URL('../desktop-pet/web/brain.js', import.meta.url), 'utf8');
const m = src.match(/export const BEHAVIOR = \{([\s\S]*?)\n\};/);
if (!m) throw new Error('无法从 brain.js 解析 BEHAVIOR');
const BEHAVIOR = eval('({' + m[1] + '})');
console.log('已从 brain.js 载入参数:', JSON.stringify(BEHAVIOR));

const S = { IDLE: 'idle', REST: 'rest', WALK: 'walk', ONESHOT: 'oneshot' };
const rand = (a, b) => a + Math.random() * (b - a);

const screen = {
  work_x: 0, work_y: 0, work_w: 1920, work_h: 1040,
  win_x: 800, win_y: 780, win_w: 317, win_h: 246,
};

const log = [];

class Brain {
  constructor() { this.state = S.IDLE; this.until = 0; this.dir = 1; this.longWalk = false; }
  enterIdle(now) { this.state = S.IDLE; this.until = now + rand(BEHAVIOR.idleMin, BEHAVIOR.idleMax); log.push(['idle', now, screen.win_x]); }
  enterRest(now) { this.state = S.REST; this.until = now + rand(BEHAVIOR.restMin, BEHAVIOR.restMax); log.push(['rest', now, screen.win_x]); }
  enterWalk(now) {
    this.state = S.WALK;
    this.longWalk = Math.random() < BEHAVIOR.pLongWalk;
    this.until = this.longWalk ? now + BEHAVIOR.longWalkMax : now + rand(BEHAVIOR.walkMin, BEHAVIOR.walkMax);
    this.dir = this.pickDirection();
    log.push(['walk', now, screen.win_x, `dir=${this.dir}${this.longWalk ? ' 长途' : ''}`]);
  }
  pickDirection() {
    const left = screen.work_x, right = screen.work_x + screen.work_w - screen.win_w;
    const span = Math.max(1, right - left);
    const t = (screen.win_x - left) / span;
    if (t < BEHAVIOR.edgeZone) return 1;
    if (t > 1 - BEHAVIOR.edgeZone) return -1;
    return Math.random() < 0.5 ? -1 : 1;
  }
  decideNext(now) {
    const r = Math.random();
    if (r < BEHAVIOR.pIdleAgain) { this.enterIdle(now); return; }
    const r2 = (r - BEHAVIOR.pIdleAgain) / (1 - BEHAVIOR.pIdleAgain);
    r2 < BEHAVIOR.pRest ? this.enterRest(now) : this.enterWalk(now);
  }
  tick(now, dt) {
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
      log.push(['hitEdge', now, nx, `dir=${this.dir}${this.longWalk ? ' 长途结束' : ''}`]);
      if (this.longWalk) { this.longWalk = false; this.until = Math.min(this.until, now + BEHAVIOR.afterEdgeWalk); }
      else { this.until = Math.max(this.until, now + BEHAVIOR.turnPause); }
    }
    screen.win_x = nx;
  }
}

const b = new Brain();
b.enterIdle(0);
let t = 0; const DT = 16; const END = 30 * 60 * 1000;
let minX = 1e9, maxX = -1e9;
while (t < END) {
  t += DT; b.tick(t, DT);
  if (screen.win_x < minX) minX = screen.win_x;
  if (screen.win_x > maxX) maxX = screen.win_x;
}

const counts = {}, dur = {};
let prev = null, prevT = 0;
for (const e of log) {
  counts[e[0]] = (counts[e[0]] || 0) + 1;
  if (prev) dur[prev] = (dur[prev] || 0) + (e[1] - prevT);
  prev = e[0]; prevT = e[1];
}
if (prev) dur[prev] = (dur[prev] || 0) + (END - prevT);
const total = (dur.idle || 0) + (dur.rest || 0) + (dur.walk || 0);

console.log('\n=== 30 分钟仿真（1920x1080）===');
console.log(`  待机 ${(dur.idle / total * 100).toFixed(1)}%  休息 ${(dur.rest / total * 100).toFixed(1)}%  行走 ${(dur.walk / total * 100).toFixed(1)}%`);
console.log(`  触发：待机${counts.idle || 0} 休息${counts.rest || 0} 行走${counts.walk || 0} 碰边${counts.hitEdge || 0}`);
const maxRight = screen.work_w - screen.win_w;
console.log(`  X 范围：${minX} ~ ${maxX}  （合法区间 0 ~ ${maxRight}）`);
console.log(`  越界：${(minX < 0 || maxX > maxRight) ? '✗ 有越界' : '✓ 无越界'}`);

console.log('\n=== 长途行走样本 ===');
log.filter(e => e[0] === 'walk' && e[3] && e[3].includes('长途')).slice(0, 5).forEach(e => {
  console.log(`  t=${(e[1] / 1000).toFixed(0)}s  x=${e[2]}  ${e[3]}`);
});

console.log('\n=== 边缘方向校验 ===');
screen.win_x = 5;   console.log(`  x=5    -> dir=${b.pickDirection()} (期望 1)`);
screen.win_x = 1580; console.log(`  x=1580 -> dir=${b.pickDirection()} (期望 -1)`);
