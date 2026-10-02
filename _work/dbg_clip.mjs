/**
 * 验证「窗口缩小、画布未同步」时的裁剪方向。
 *
 * 复现用户描述的现象：只有透明窗口在缩小，桌宠头部被截断。
 */

import { readFileSync } from 'node:fs';
const html = readFileSync('E:/work/deskpet/M3/desktop-pet/web/index.html', 'utf8');
const wrap = (html.match(/#stageWrap \{[\s\S]*?\n  \}/) || [''])[0];
const stage = (html.match(/#stage \{[\s\S]*?\n  \}/) || [''])[0];

const ART_W = 906, ART_H = 704;
const HEAD_Y = 121;   // 头顶（rest 动作最高，y=121）

console.log('=== 场景：从 45% 缩到 20%，但 userScale 仍是 0.45 ===\n');

const oldScale = 0.45;   // 画布仍按旧值绘制
const newScale = 0.20;   // 窗口已按新值缩小

const winW = ART_W * newScale, winH = ART_H * newScale;
const cw = ART_W * oldScale, ch = ART_H * oldScale;

console.log(`窗口(新)  : ${winW.toFixed(1)} x ${winH.toFixed(1)}`);
console.log(`画布(旧)  : ${cw.toFixed(1)} x ${ch.toFixed(1)}`);

// #stageWrap: position fixed, bottom:0  -> 画布底边贴窗口底边
const canvasBottom = winH;           // 窗口底边
const canvasTop = canvasBottom - ch; // 画布顶边（可能为负）
const visibleTop = Math.max(canvasTop, 0);

console.log(`\n画布底边 y = ${canvasBottom.toFixed(1)}`);
console.log(`画布顶边 y = ${canvasTop.toFixed(1)}  ${canvasTop < 0 ? '<-- 超出窗口顶部！' : ''}`);
console.log(`被裁掉的高度 = ${(Math.max(0, -canvasTop)).toFixed(1)} px`);

// 画布内的角色头顶（在画布坐标系里 y=HEAD_Y*oldScale）
const headInCanvas = HEAD_Y * oldScale;
const headOnScreen = canvasTop + headInCanvas;
console.log(`\n角色头顶在画布内 y = ${headInCanvas.toFixed(1)}`);
console.log(`角色头顶在窗口内 y = ${headOnScreen.toFixed(1)}  ${headOnScreen < 0 ? '<-- 头部在窗口之外，被截断' : 'ok'}`);

console.log('\n=== 结论 ===');
if (canvasTop < 0) {
  console.log('画布锚定 bottom:0，超出的部分只可能从**上方**溢出并裁掉 -> 正是「头部被截断」。');
  console.log('根因：窗口尺寸按新 scale 变了，但 main.js 的 userScale 没有同步更新。');
}
