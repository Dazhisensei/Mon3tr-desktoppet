/**
 * 缩放裁剪修复的**行为验证**
 *
 * 直接抽出 main.js 里真实的 fitStage / syncScaleFromWindow，
 * 连同真实的 `let userScale` 声明一起放进 vm 沙箱求值，
 * 不手写等价实现。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('E:/work/deskpet/M3/desktop-pet/web/main.js', 'utf8');

/** 按大括号配平截取一个 function 声明。 */
function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`函数 ${name} 括号不配平`);
}

const ART_W = 906, ART_H = 704;
const HEAD_Y = 121;   // 角色头顶（rest 动作最高）

// 真实常量：从源码里取，避免与实现脱节
const mMatch = src.match(/const MIN_SCALE = ([\d.]+);\s*\nconst MAX_SCALE = ([\d.]+);/);
if (!mMatch) throw new Error('找不到 MIN_SCALE / MAX_SCALE');
const MIN_SCALE = parseFloat(mMatch[1]), MAX_SCALE = parseFloat(mMatch[2]);

/** 在沙箱里加载真实函数，并暴露 userScale 读写。 */
function makeSandbox(initialScale, winW, winH) {
  const sandbox = {
    state: { manifest: { canvas: { w: ART_W, h: ART_H } } },
    canvas: { style: {} },
    window: { innerWidth: winW, innerHeight: winH },
    MIN_SCALE, MAX_SCALE,
  };
  // 真实源码里的声明（含初值），随后由我们覆盖成 initialScale
  const declMatch = src.match(/let userScale = [\d.]+;/);
  if (!declMatch) throw new Error('找不到 userScale 声明');

  const code = `
    ${declMatch[0]}
    ${grabFn('fitStage')}
    ${grabFn('syncScaleFromWindow')}
    userScale = __initial;
    globalThis.__fitStage = fitStage;
    globalThis.__sync = syncScaleFromWindow;
    globalThis.__getScale = () => userScale;
  `;
  sandbox.__initial = initialScale;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

/** 执行 fitStage 并返回画布的 CSS 尺寸。 */
function runFit(initialScale, winW, winH) {
  const sb = makeSandbox(initialScale, winW, winH);
  vm.runInContext('__fitStage()', sb);
  return {
    w: parseFloat(sb.canvas.style.width),
    h: parseFloat(sb.canvas.style.height),
    scale: sb.__getScale(),
  };
}

let fail = 0;
const chk = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('=== 场景 A：Rust 已把窗口改成 20%，userScale 仍停在 0.45（原 bug 现场）===');
{
  const winS = 0.20;
  const winW = ART_W * winS, winH = ART_H * winS;
  const r = runFit(0.45, winW, winH);
  const cw = r.w, chh = r.h;
  console.log(`    窗口 ${winW.toFixed(1)}x${winH.toFixed(1)}   画布 ${cw}x${chh}`);
  chk('画布被夹进窗口（不再溢出顶部）', cw <= winW + 1 && chh <= winH + 1);
  const headScreen = (winH - chh) + HEAD_Y * (chh / ART_H);
  chk('角色头顶仍在窗口内（不再被裁）', headScreen >= 0, `头顶 y=${headScreen.toFixed(1)}`);
}

console.log('\n=== 场景 B：正常档位（userScale 与窗口一致）-> 不应被误夹 ===');
for (const pct of [20, 25, 35, 45, 50, 75, 100]) {
  const s = pct / 100;
  const winW = ART_W * s, winH = ART_H * s;
  const r = runFit(s, winW, winH);
  chk(`${pct}% 档画布 = 素材 × ${s}`,
      Math.abs(r.w - ART_W * s) < 0.6 && Math.abs(r.h - ART_H * s) < 0.6,
      `${r.w}x${r.h}`);
}

console.log('\n=== 场景 C：自愈函数 syncScaleFromWindow 的采纳条件 ===');
{
  // C1 真正的缩放变化：宽高同比例
  const s = 0.25, winW = ART_W * s, winH = ART_H * s;
  const sb = makeSandbox(0.45, winW, winH);
  vm.runInContext('__sync()', sb);
  chk('宽高同比例 -> 采纳新缩放', Math.abs(sb.__getScale() - s) < 0.005,
      `scale=${sb.__getScale()}`);

  // C2 气泡扩窗：只加宽、高度不变
  const sb2 = makeSandbox(0.35, ART_W * 0.35 + 200, ART_H * 0.35);
  vm.runInContext('__sync()', sb2);
  chk('仅宽度变大（气泡扩窗）-> 不采纳', Math.abs(sb2.__getScale() - 0.35) < 1e-9,
      `scale=${sb2.__getScale()}`);

  // C3 设置面板尺寸 440x560：非素材比例
  const sb3 = makeSandbox(0.35, 440, 560);
  vm.runInContext('__sync()', sb3);
  chk('设置面板尺寸（非等比例）-> 不采纳', Math.abs(sb3.__getScale() - 0.35) < 1e-9,
      `scale=${sb3.__getScale()}`);

  // C4 越界值（超出 20%~100%）-> 不采纳
  const sb4 = makeSandbox(0.35, ART_W * 0.05, ART_H * 0.05);
  vm.runInContext('__sync()', sb4);
  chk('超出合法档位范围 -> 不采纳', Math.abs(sb4.__getScale() - 0.35) < 1e-9,
      `scale=${sb4.__getScale()}`);
}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
