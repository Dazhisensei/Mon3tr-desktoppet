/**
 * 用**真实的 brain.js** 验证「原地踏步」与帧率的关系。
 *
 * 不手写等价实现，直接加载源码，注入可控的 getScreen/onMove。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('E:/work/deskpet/M3/desktop-pet/web/brain.js', 'utf8');
const script = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
  .replace(/^export\s+/gm, '');

/** 造一个 Brain，模拟给定帧率走 N 帧，返回窗口实际移动距离。 */
function simulate(fps, frames, opts = {}) {
  // 屏幕 1920 宽，窗口 300 宽，起点居中
  const screen = {
    work_x: 0, work_y: 0, work_w: 1920, work_h: 1080,
    win_x: 800, win_y: 500, win_w: 300, win_h: 234,
  };
  const moves = [];

  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    setTimeout, clearTimeout, Promise, RegExp, Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(script + '\nglobalThis.__Brain = Brain;', sandbox);

  const B = sandbox.__Brain;
  const b = new B({
    onAction: () => {},
    onMove: (x, y) => { moves.push(x); screen.win_x = x; screen.win_y = y; },
    onTurn: () => {},
    getScreen: () => screen,
    getCursor: () => null,
  });

  let now = 1000;
  const dt = 1000 / fps;
  // 强制进入行走，并给一个足够长的时长
  vm.runInContext('void 0', sandbox);
  b.state = 'walk';
  b.dir = 1;
  b.longWalk = false;
  b.until = now + 100000;      // 不会中途结束
  b.onAction('move');

  const startX = screen.win_x;
  for (let i = 0; i < frames; i++) {
    now += dt;
    b.tick(now, dt);
  }
  return { moved: screen.win_x - startX, moves: moves.length, startX, endX: screen.win_x };
}

let fail = 0;
const chk = (n, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('=== 各刷新率下，行走 3 秒（180 帧 @60fps 等价时长）===');
const CASES = [
  [60,  180],
  [75,  225],
  [90,  270],
  [120, 360],
  [144, 432],
  [165, 495],
];
for (const [fps, frames] of CASES) {
  const seconds = frames / fps;
  const r = simulate(fps, frames);
  const expect = 60 * seconds;   // walkSpeed = 60 px/s
  const ok = Math.abs(r.moved - expect) < expect * 0.15;
  console.log(`  ${String(fps).padStart(3)} Hz  ${seconds.toFixed(1)}s  `
    + `实际移动 ${String(r.moved).padStart(4)} px  期望约 ${expect.toFixed(0)} px  `
    + `${ok ? 'OK' : '✗ 严重偏少'}`);
}

console.log('\n=== 判定 ===');
{
  const r60 = simulate(60, 180);
  const r120 = simulate(120, 360);
  const r144 = simulate(144, 432);

  chk('60Hz 能正常行走', r60.moved > 100, `${r60.moved} px`);
  chk('120Hz 能正常行走', r120.moved > 100,
      `${r120.moved} px ${r120.moved <= 0 ? '<- 原地踏步！' : ''}`);
  chk('144Hz 能正常行走', r144.moved > 100,
      `${r144.moved} px ${r144.moved <= 0 ? '<- 原地踏步！' : ''}`);
}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败（复现了问题）'}`);
process.exit(fail === 0 ? 0 : 1);
