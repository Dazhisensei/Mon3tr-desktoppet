/**
 * 验证新增的四项功能（重点是避让状态机与走动开关）。
 *
 * 用**真实的 brain.js**，不手写等价实现。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('E:/work/deskpet/M3/desktop-pet/web/brain.js', 'utf8');
const script = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
  .replace(/^export\s+/gm, '');

function makeBrain(screen) {
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Infinity, NaN,
    setTimeout, clearTimeout, Promise, RegExp, Error,
    performance: { now: () => 1000 },
  };
  vm.createContext(sandbox);
  vm.runInContext(script + '\nglobalThis.__Brain = Brain;', sandbox);
  const B = sandbox.__Brain;
  const moves = [];
  const b = new B({
    onAction: () => {},
    onMove: (x, y) => { moves.push([x, y]); screen.win_x = x; screen.win_y = y; },
    onTurn: () => {},
    getScreen: () => screen,
    getCursor: () => null,
  });
  return { b, moves, screen };
}

const SCREEN = () => ({
  work_x: 0, work_y: 0, work_w: 1920, work_h: 1080,
  win_x: 800, win_y: 500, win_w: 300, win_h: 234,
});

let fail = 0;
const chk = (n, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('=== A. 走动开关（walkEnabled）===');
{
  const { b, screen } = makeBrain(SCREEN());
  chk('默认允许走动', b.walkEnabled === true);

  // 关掉后反复决策，不应进入 WALK
  b.setWalkEnabled(false, 1000);
  let walked = 0;
  for (let i = 0; i < 200; i++) {
    b.state = 'idle';
    b.until = 0;
    b.lastUserAt = 0;          // 让休息也可能触发
    b.tick(1000 + i * 100, 100);
    if (b.state === 'walk') walked++;
  }
  chk('关闭走动后 200 次决策都不进入行走', walked === 0, `walk ${walked} 次`);

  // 开启后应该会出现行走
  b.setWalkEnabled(true, 1000);
  let walked2 = 0;
  for (let i = 0; i < 200; i++) {
    b.state = 'idle';
    b.until = 0;
    b.lastUserAt = 1000 + i * 100;   // 刚交互过 -> 不会休息 -> 只会行走/待机
    b.tick(1000 + i * 100, 100);
    if (b.state === 'walk') walked2++;
  }
  chk('开启走动后会出现行走', walked2 > 0, `walk ${walked2} 次`);
}

console.log('\n=== B. 关闭走动时若正在行走 -> 立刻回待机 ===');
{
  const { b } = makeBrain(SCREEN());
  b.state = 'walk';
  b.setWalkEnabled(false, 2000);
  chk('立即切回待机', b.state === 'idle', `state=${b.state}`);
}

console.log('\n=== C. 智能避让（enterDodge / exitDodge）===');
{
  const { b, screen, moves } = makeBrain(SCREEN());
  b.setSmartDodge(true);
  b.enterDodge(3000);

  chk('进入避让后处于坐姿', b.state === 'sit', `state=${b.state}`);
  chk('避让标记已置位', b.dodging === true);

  // 位置应移到右下角
  const margin = 24;
  const expectX = 1920 - 300 - margin;
  const expectY = 1080 - 234 - margin;
  chk('移动到右下角', Math.abs(screen.win_x - expectX) < 2 && Math.abs(screen.win_y - expectY) < 2,
      `(${screen.win_x},${screen.win_y}) 期望 (${expectX},${expectY})`);

  // 重复调用不应重复移动（幂等）
  const before = moves.length;
  b.enterDodge(3100);
  chk('重复 enterDodge 幂等（不重复移动）', moves.length === before,
      `moves ${before} -> ${moves.length}`);

  // 退出
  b.exitDodge(4000);
  chk('退出避让后不再是坐姿', b.state !== 'sit', `state=${b.state}`);
  chk('避让标记已清除', b.dodging === false);
}

console.log('\n=== D. 用户手动摆放过位置 -> 避让不挪动它 ===');
{
  const { b, screen } = makeBrain(SCREEN());
  b.setSmartDodge(true);
  b.userPlaced = true;
  const x0 = screen.win_x, y0 = screen.win_y;
  b.enterDodge(3000);
  chk('位置保持不变（只坐下不挪动）',
      screen.win_x === x0 && screen.win_y === y0,
      `(${screen.win_x},${screen.win_y})`);
  chk('但仍会坐下', b.state === 'sit', `state=${b.state}`);
}

console.log('\n=== E. 关闭智能避让时正在避让 -> 自动站起来 ===');
{
  const { b } = makeBrain(SCREEN());
  b.setSmartDodge(true);
  b.enterDodge(3000);
  chk('先确认处于坐下', b.state === 'sit');
  b.setSmartDodge(false);
  chk('关闭后自动站起', b.state !== 'sit' && b.dodging === false,
      `state=${b.state} dodging=${b.dodging}`);
}

console.log('\n=== F. 未开启智能避让时 enterDodge 不生效 ===');
{
  const { b, moves } = makeBrain(SCREEN());
  b.setSmartDodge(false);
  b.enterDodge(3000);
  chk('不进入避让', b.dodging === false && b.state !== 'sit' && moves.length === 0,
      `state=${b.state}`);
}

console.log('\n=== G. 回归：走动修复仍然有效 ===');
{
  for (const fps of [60, 144]) {
    const screen = SCREEN();
    screen.win_x = 800;
    const { b, screen: s } = makeBrain(screen);
    b.state = 'walk'; b.dir = 1; b.longWalk = false; b.until = 1e9;
    let now = 1000;
    const dt = 1000 / fps;
    const start = s.win_x;
    for (let i = 0; i < fps * 3; i++) { now += dt; b.tick(now, dt); }
    const moved = s.win_x - start;
    chk(`${fps}Hz 行走正常`, Math.abs(moved - 180) < 5, `${moved}px`);
  }
}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
