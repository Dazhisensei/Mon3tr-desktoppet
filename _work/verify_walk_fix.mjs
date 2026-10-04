/**
 * 行走修复的完整验证：不只测速度，还要测边界行为。
 *
 * 重要：累积小数位移后，「撞墙/掉头」的判定时机可能变化，
 * 必须确认没有引入新问题（例如卡在边缘抖动、或永远走不到边界）。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('E:/work/deskpet/M3/desktop-pet/web/brain.js', 'utf8');
const script = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
  .replace(/^export\s+/gm, '');

function makeBrain(screen, hooks = {}) {
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    setTimeout, clearTimeout, Promise, RegExp, Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(script + '\nglobalThis.__Brain = Brain;', sandbox);
  const B = sandbox.__Brain;
  const moves = [];
  const turns = [];
  const b = new B({
    onAction: () => {},
    onMove: (x, y) => { moves.push(x); screen.win_x = x; screen.win_y = y; },
    onTurn: (d) => { turns.push(d); hooks.onTurn?.(d); },
    getScreen: () => screen,
    getCursor: () => hooks.cursor ?? null,
  });
  return { b, moves, turns, screen };
}

let fail = 0;
const chk = (n, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

const SCREEN = () => ({
  work_x: 0, work_y: 0, work_w: 1920, work_h: 1080,
  win_x: 900, win_y: 500, win_w: 300, win_h: 234,
});

console.log('=== A. 各刷新率的速度一致性（走 5 秒）===');
for (const fps of [60, 75, 90, 120, 144, 165, 240]) {
  const screen = SCREEN();
  // 起点放中间，避免撞墙影响测量
  screen.win_x = 800;
  const { b, screen: s } = makeBrain(screen);
  b.state = 'walk'; b.dir = 1; b.longWalk = false;
  b.until = 1e9;
  const start = s.win_x;
  const dt = 1000 / fps;
  let now = 1000;
  const seconds = 5;
  for (let i = 0; i < Math.round(fps * seconds); i++) {
    now += dt;
    b.tick(now, dt);
  }
  const moved = s.win_x - start;
  const expect = 60 * seconds;
  const err = Math.abs(moved - expect) / expect;
  const ok = err < 0.02;
  if (!ok) fail++;
  console.log(`  ${String(fps).padStart(3)}Hz  移动 ${String(moved).padStart(4)}px  `
    + `期望 ${expect}px  误差 ${(err * 100).toFixed(1)}%  ${ok ? '✓' : '✗'}`);
}

console.log('\n=== B. 撞墙与掉头（不留死角）===');
{
  // 起点靠右，向右走必然撞墙
  const screen = SCREEN();
  screen.win_x = 1920 - 300 - 30;    // 距右边界 30px
  const { b, screen: s, turns } = makeBrain(screen);
  b.state = 'walk'; b.dir = 1; b.longWalk = false;
  b.until = 1e9;
  let now = 1000;
  for (let i = 0; i < 300; i++) { now += 16.67; b.tick(now, 16.67); }

  chk('撞到右边界后停下（不越界）',
      s.win_x <= 1920 - 300 + 1, `win_x=${s.win_x} 上限 ${1920-300}`);
  chk('撞墙后触发了掉头', turns.length > 0, `掉头 ${turns.length} 次`);
  chk('掉头后方向朝左', b.dir === -1, `dir=${b.dir}`);
}

console.log('\n=== C. 撞墙后能继续走动（不死锁）===');
{
  const screen = SCREEN();
  screen.win_x = 1920 - 300 - 5;
  const { b, screen: s } = makeBrain(screen);
  b.state = 'walk'; b.dir = 1; b.longWalk = false;
  b.until = 1e9;
  let now = 1000;
  // 先撞墙
  for (let i = 0; i < 120; i++) { now += 16.67; b.tick(now, 16.67); }
  const afterHit = s.win_x;
  // 再走一段，应该往左移动
  for (let i = 0; i < 120; i++) { now += 16.67; b.tick(now, 16.67); }
  chk('撞墙后继续行走（窗口确实移动了）',
      s.win_x < afterHit, `${afterHit} -> ${s.win_x}`);
}

console.log('\n=== D. 高速下不会「跳过」边界 ===');
{
  // 极端情况：一帧位移很大时，不能越过边界
  const screen = SCREEN();
  screen.win_x = 1920 - 300 - 2;
  const { b, screen: s } = makeBrain(screen);
  b.state = 'walk'; b.dir = 1; b.longWalk = false;
  b.until = 1e9;
  // 模拟卡顿后的大 dt（tickLoop 会 cap 到 100ms）
  b.tick(1100, 100);
  chk('大 dt 下仍不越界', s.win_x <= 1920 - 300 + 1, `win_x=${s.win_x}`);
}

console.log('\n=== E. 跟随鼠标也修好了 ===');
{
  for (const fps of [60, 144]) {
    const screen = SCREEN();
    screen.win_x = 300;
    // 光标在窗口右侧很远处 -> 持续向右追
    const { b, screen: s } = makeBrain(screen, { cursor: { inside: false, rel_x: 1.6, rel_y: 0.5 } });
    b.state = 'follow'; b.following = true; b.dir = 1;
    const start = s.win_x;
    let now = 1000;
    const dt = 1000 / fps;
    for (let i = 0; i < fps * 3; i++) { now += dt; b.tick(now, dt); }
    const moved = s.win_x - start;
    chk(`${fps}Hz 跟随能移动`, moved > 100,
        `${moved}px ${moved <= 0 ? '<- 踏步！' : ''}`);
  }
}

console.log('\n=== F. 小数余数不会累积漂移 ===');
{
  // 走很久后，总位移应精确等于 速度×时间（容差 2%）
  const screen = SCREEN();
  screen.win_x = 100;
  const { b, screen: s } = makeBrain(screen);
  b.state = 'walk'; b.dir = 1; b.longWalk = false;
  b.until = 1e9;
  let now = 1000;
  const dt = 1000 / 144;
  const N = 144 * 20;   // 20 秒
  const start = s.win_x;
  for (let i = 0; i < N; i++) { now += dt; b.tick(now, dt); }
  const moved = s.win_x - start;
  const expect = 60 * 20;
  chk('20 秒后无累积漂移（误差 < 1%）',
      Math.abs(moved - expect) / expect < 0.01,
      `移动 ${moved}px 期望 ${expect}px`);
}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
