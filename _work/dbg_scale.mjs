/**
 * 缩放裁剪问题的最小复现：只驱动真实的 fitStage 逻辑与 CSS。
 *
 * 思路：把 index.html 里的 #stageWrap / #stage 规则取出来，
 * 手算「窗口 N×M、画布 906*s×704*s」时画布的最终盒子，
 * 看它是否超出窗口上边界（超出 = 头部被裁）。
 */

// 从真实 index.html 读取（不手写等价实现）
import { readFileSync } from 'node:fs';
const html = readFileSync(
  'E:/work/deskpet/M3/desktop-pet/web/index.html', 'utf8'
);

const wrap = (html.match(/#stageWrap \{[\s\S]*?\n  \}/) || [''])[0];
const stage = (html.match(/#stage \{[\s\S]*?\n  \}/) || [''])[0];

console.log('=== #stageWrap 规则 ===');
console.log(wrap.trim());
console.log('\n=== #stage 规则 ===');
console.log(stage.trim());

const ART_W = 906, ART_H = 704;
const MIN_SCALE = 0.20, MAX_SCALE = 1.00;

console.log('\n=== 各档位：画布是否超出窗口上边界 ===');
console.log('scale  窗口(逻辑)      画布(CSS)       画布底边  画布顶边  超出顶部?');
for (let pct = 20; pct <= 100; pct += 5) {
  const s = pct / 100;
  if (s < MIN_SCALE || s > MAX_SCALE) continue;
  const winW = ART_W * s, winH = ART_H * s;
  const cw = ART_W * s, ch = ART_H * s;
  // #stageWrap: fixed, bottom:0, left:50%, translateX(-50%)
  // 画布底边贴在窗口底边 -> 底边 y = winH，顶边 y = winH - ch
  const top = winH - ch;
  const overflow = top < 0;
  console.log(
    `${String(pct).padStart(3)}%   ${winW.toFixed(1)}x${winH.toFixed(1)}`.padEnd(22) +
    `${cw.toFixed(1)}x${ch.toFixed(1)}`.padEnd(16) +
    `${winH.toFixed(1)}`.padEnd(10) +
    `${top.toFixed(1)}`.padEnd(10) +
    (overflow ? ' YES  <-- 裁头' : ' no')
  );
}
