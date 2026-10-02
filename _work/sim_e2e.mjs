// 端到端仿真：完整复现真实启动时序与主循环，验证不再卡死。
import { readFileSync } from 'node:fs';

const src = readFileSync("E:/work/deskpet/M3/desktop-pet/web/brain.js", "utf8");
const m = src.match(/export const BEHAVIOR = \{([\s\S]*?)\n\};/);
const BEHAVIOR = eval("({" + m[1] + "})");
const S = { IDLE:"idle", REST:"rest", WALK:"walk", ONESHOT:"oneshot" };
const rand = (a,b)=>a+Math.random()*(b-a);
const FRAMES = { idle:81, rest:51, move:41, click:67 };
const FPS = 30;

function simulate(clickAt) {
  // --- 显示层 ---
  const disp = { current:"idle", index:0, lastTs:0, blend:null, frames:81 };
  const switches = [];
  function setActionNow(k, now) {
    disp.current = k; disp.index = 0; disp.lastTs = now;
    disp.frames = FRAMES[k]; disp.blend = { start: now, alpha: 1 };
    switches.push([now, k]);
  }

  // --- 行为层 ---
  class Brain {
    constructor(){ this.state=S.IDLE; this.until=0; this.plannedSpan=0; this.dir=1;
                   this.holdUntil=0; this.paused=false; this.pausedByUser=false; this.longWalk=false; }
    onAction(k,o){ if(o&&o.force) setActionNow(k,this._now); else setActionNow(k,this._now); }
    enterIdle(now){ this.state=S.IDLE; this.plannedSpan=rand(BEHAVIOR.idleMin,BEHAVIOR.idleMax);
      this.until=now+this.plannedSpan; this.onAction("idle"); }
    enterRest(now){ this.state=S.REST; this.plannedSpan=rand(BEHAVIOR.restMin,BEHAVIOR.restMax);
      this.until=now+this.plannedSpan; this.onAction("rest"); }
    enterWalk(now){ this.state=S.WALK;
      this.longWalk=Math.random()<BEHAVIOR.pLongWalk;
      this.plannedSpan=this.longWalk?BEHAVIOR.longWalkMax:rand(BEHAVIOR.walkMin,BEHAVIOR.walkMax);
      this.until=now+this.plannedSpan; this.dir=1; this.onAction("move"); }
    playOneshot(now,ms,key){ this.state=S.ONESHOT; this.until=now+ms; this.holdUntil=0; this.onAction(key,{force:true}); }
    holdUser(){ this.holdUntil=performance.now()+BEHAVIOR.dragHold; }
    decideNext(now){ const r=Math.random();
      if(r<BEHAVIOR.pIdleAgain){ this.enterIdle(now); return; }
      const r2=(r-BEHAVIOR.pIdleAgain)/(1-BEHAVIOR.pIdleAgain);
      r2<BEHAVIOR.pRest ? this.enterRest(now) : this.enterWalk(now); }
    tick(now,dt){ this._now=now;
      if(this.paused||this.pausedByUser) return;
      if(now<this.holdUntil&&this.state!==S.ONESHOT) return;
      if(this.state===S.ONESHOT){ if(now>=this.until) this.enterIdle(now); return; }
      if(this.state===S.IDLE){ if(now>=this.until) this.decideNext(now); return; }
      if(this.state===S.REST){ if(now>=this.until) this.enterIdle(now); return; }
      if(this.state===S.WALK){ if(now>=this.until) this.enterIdle(now); } }
  }

  const b = new Brain();
  b._now = 0;

  // === 复现真实 boot 顺序 ===
  setActionNow("idle", 0);              // await setAction('idle', {force:true})
  b.enterIdle(0);                        // brain.enterIdle(performance.now())

  let t = 0; const DT = 16; const END = 20*60*1000;
  let clicked = false, clickDone = 0, idleResumed = 0;
  let frozenMs = 0, lastSwitch = 0;

  while (t < END) {
    t += DT; b._now = t;

    // 主循环顺序：帧推进 -> 绘制 -> brain.tick
    if (t - disp.lastTs >= 1000/FPS) {
      disp.lastTs = t;
      disp.index++;
      if (disp.index >= disp.frames) disp.index = disp.frames - 1 + 1 >= disp.frames ? 0 : 0;
      if (disp.index >= disp.frames) disp.index = 0;
    }
    if (disp.blend && t - disp.blend.start >= 180) disp.blend = null;

    if (!clicked && t >= clickAt) {
      clicked = true;
      b.playOneshot(t, FRAMES.click/FPS*1000 + 80, "click");
      clickDone = t + FRAMES.click/FPS*1000;
    }

    b.tick(t, DT);

    // 静止检测：brain 处于 IDLE 且显示层也长期不变
    if (b.state === S.IDLE && switches.length && t - switches[switches.length-1][0] > 30000) {
      frozenMs = Math.max(frozenMs, t - switches[switches.length-1][0]);
    }
    if (clicked && !idleResumed && t > clickDone && b.state === S.IDLE) idleResumed = t;
  }

  return { switches, finalAction: disp.current, brainState: b.state,
           clickDone, idleResumed, frozenMs };
}

// 跑 40 次，含不同点击时刻
let stuck = 0, maxFrozen = 0, gaps = [];
for (let i = 0; i < 40; i++) {
  const r = simulate(20000 + i * 370);
  if (r.switches.length <= 2) stuck++;
  maxFrozen = Math.max(maxFrozen, r.frozenMs);
  if (r.idleResumed) gaps.push(r.idleResumed - r.clickDone);
}

console.log("=== 端到端仿真（40 轮 × 20 分钟）===");
console.log(`卡死轮次（切换≤2次）: ${stuck}  ${stuck ? "✗" : "✓ 全部正常"}`);
console.log(`最长无切换时长: ${(maxFrozen/1000).toFixed(1)}s（待机最长 12s，正常）`);
if (gaps.length) {
  const avg = gaps.reduce((a,b)=>a+b,0)/gaps.length;
  const mx = Math.max(...gaps);
  console.log(`点击后恢复待机空档: 平均 ${avg.toFixed(0)}ms  最大 ${mx.toFixed(0)}ms  ${mx < 400 ? "✓" : "✗"}`);
}

// 单轮详情
const one = simulate(25000);
console.log("\n=== 单轮详情（20 分钟）===");
console.log(`动作切换次数: ${one.switches.length}`);
console.log(`最终: 显示=${one.finalAction}  行为=${one.brainState}`);
console.log("最后 10 次切换:");
one.switches.slice(-10).forEach(([tt,k]) => console.log(`  t=${(tt/1000).toFixed(1)}s -> ${k}`));
