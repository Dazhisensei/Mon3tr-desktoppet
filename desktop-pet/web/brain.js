/**
 * 行为状态机
 *
 * 桌面宠物的自主行为：
 *   - 大部分时间处于「待机」，循环播放 idle
 *   - 待机一段时间后，随机决定下一步：继续待机 / 休息 / 行走
 *   - 行走时真正移动窗口；靠近某一侧时朝另一侧走，碰到边缘则掉头
 *   - 用户交互（拖拽/单击）优先级最高，会打断当前自主行为
 *
 * 设计：所有时长与概率集中在 BEHAVIOR 常量里，便于调节手感。
 */

/** 行为参数：调这些数就能改变桌宠的「性格」。 */
export const BEHAVIOR = {
  /** 待机持续时长的随机范围（毫秒） */
  idleMin: 4000,
  idleMax: 12000,

  /** 休息持续时长的随机范围（毫秒） */
  restMin: 5000,
  restMax: 15000,

  /** 一次行走持续时长的随机范围（毫秒） */
  walkMin: 3000,
  walkMax: 9000,

  /** 长途行走的概率：这类行走会一直走到屏幕边缘才转向 */
  pLongWalk: 0.25,

  /** 长途行走的最长持续时间（毫秒），防止一直在走 */
  longWalkMax: 25000,

  /** 长途行走抵达边缘后再走多久结束（毫秒） */
  afterEdgeWalk: 2500,

  /** 待机结束后继续待机的概率（让待机占主导） */
  pIdleAgain: 0.45,

  /**
   * 一次决策中，选「休息」的概率（其余为行走）。
   *
   * 注意：这只是**候选概率**——实际还要满足「安静足够久」
   * （见 `restIdleMs`），否则只会待机或行走。
   */
  pRest: 0.45,

  /**
   * 触发休息所需的「无操作」时长（毫秒）。
   *
   * 需求是「大约每十分钟无任何操作才休息」，因此设为 10 分钟。
   * 用户拖拽、点击、开菜单都会刷新计时（见 `noteUserActivity`），
   * 于是频繁操作时休息基本不会出现。
   */
  restIdleMs: 10 * 60 * 1000,

  /** 行走速度：每秒移动多少像素（逻辑像素） */
  walkSpeed: 60,

  /**
   * 跟随鼠标时的移动速度（逻辑像素/秒）。
   *
   * 比自主行走略快，跟手一些；但仍设上限，避免瞬移感。
   */
  followSpeed: 130,

  /**
   * 跟随的死区：光标相对窗口中心的水平偏移小于该比例时不移动。
   *
   * 没有死区的话，光标恰在中心附近会左右抖动（每帧方向翻转）。
   */
  followDeadZone: 0.06,

  /**
   * 距离增益：光标离窗口中心越远，走得越快。
   *
   * `rel_x` 的偏移量最大约 0.5（半个窗口宽），乘上该增益后
   * 速度最多提升到 `1 + 0.5 * 1.0 = 1.5` 倍。
   * 这样"指针在屏幕另一头"时能明显追上，而不是匀速慢慢挪。
   */
  followSpeedGain: 1.0,

  /** 跟随的速度上限（逻辑像素/秒），避免远距离时快得像瞬移。 */
  followSpeedMax: 320,

  /** 碰到屏幕边缘后的掉头停顿（毫秒） */
  turnPause: 350,

  /**
   * 边缘区域比例：窗口中心处于屏幕最左/最右该比例范围内时，
   * 起步就朝反方向走。0.25 表示左右各 25% 的区域。
   */
  edgeZone: 0.25,

  /**
   * 用户交互（拖拽）后暂停自主行为的时间（毫秒）。
   * 单击不适用此值——单击只是播个特效，不应让桌宠发呆。
   */
  dragHold: 2500,
};

/** 状态枚举 */
export const S = {
  IDLE: 'idle',
  REST: 'rest',
  WALK: 'walk',
  /** 一次性特效等，播完回到常规行为 */
  ONESHOT: 'oneshot',
  /**
   * 坐着：**持续性状态**，不会自行结束。
   *
   * 与 ONESHOT 的区别：ONESHOT 到点自动回待机；SIT 一直保持，
   * 直到用户再次切换（或点击后播出一次性动画再回到坐）。
   */
  SIT: 'sit',
  /**
   * 跟随鼠标：持续性状态，按光标水平方向移动，直到用户关闭。
   */
  FOLLOW: 'follow',
};

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 行为控制器。
 * 通过回调把「要做什么」通知给渲染层与窗口层，自身不直接操作 DOM。
 */
export class Brain {
  constructor({ onAction, onMove, onTurn, getScreen, getCursor } = {}) {
    // 回调一律给出安全默认值。
    // 曾经因为漏赋 this.getScreen 导致 enterWalk 抛 TypeError，
    // 整个「行走」功能静默失效（按钮看起来像死的）。
    // 有默认值后，缺哪个回调只会让对应功能降级，不会连带崩掉其他功能。
    const fn = (f, fallback) => (typeof f === 'function' ? f : fallback);

    this.onAction = fn(onAction, () => {});        // (actionKey, opts) => void
    this.onMove = fn(onMove, () => {});            // (x, y) => void
    this.onTurn = fn(onTurn, () => {});            // (dir) => void
    this.getScreen = fn(getScreen, () => null);    // () => screenInfo | null

    this.state = S.IDLE;
    this.until = 0;                 // 当前状态持续到什么时候（由 enterIdle 设置）
    this.plannedSpan = 0;           // 当前状态的计划时长
    this.dir = 1;                   // 行走方向：1 向右，-1 向左
    this.longWalk = false;
    this.holdUntil = 0;             // 拖拽后的短暂静默（基于时间戳，必然过期）
    /**
     * 最近一次用户交互的时间戳。
     *
     * 用于判断「安静了多久」——休息只在长时间无操作后才触发。
     * 初值 0 表示「从未交互」：启动瞬间就算作已安静很久吗？
     * 不是。构造函数里无法拿到 now，因此这里保留 0，
     * 由 boot 后的 `noteUserActivity(now)` 初始化成启动时刻。
     */
    this.lastUserAt = 0;

    /**
     * 是否处于「坐着」的持续状态。
     *
     * 单独用标志记录，而不是只看 `state === SIT`：
     * 点击时会进入 ONESHOT 播放特效，但**坐的意图**应当保留，
     * 特效播完要回到坐而不是待机。因此用这个标志记住「用户想坐着」。
     */
    this.sitting = false;

    /** 是否正在跟随鼠标。 */
    this.following = false;

    /**
     * 提供光标位置的函数（返回 { inside, rel_x, rel_y } 或 null）。
     *
     * 跟随功能靠它拿方向；由 main.js 注入（原生侧 get_cursor_rel）。
     */
    this.getCursor = fn(getCursor, () => null);    // () => {inside, rel_x} | null
  }

  /**
   * 记录一次用户交互（拖拽/点击/开菜单）。
   *
   * 会**推迟**休息的触发——用户刚操作过就不该马上休息。
   */
  noteUserActivity(now = performance.now()) {
    this.lastUserAt = now;
  }

  /** 已安静了多久（毫秒）。 */
  quietMs(now = performance.now()) {
    return now - this.lastUserAt;
  }

  /** 用户开始拖拽：暂停自主行为。 */
  holdUser() {
    this.holdUntil = performance.now() + BEHAVIOR.dragHold;
  }

  /** 立即进入待机。 */
  enterIdle(now) {
    // 坐着时不回到待机动画：坐是持续状态，自主行为不应打断它
    if (this.sitting) {
      this.state = S.SIT;
      this.until = Infinity;
      this.onAction('sit');
      return;
    }
    this.state = S.IDLE;
    this.plannedSpan = rand(BEHAVIOR.idleMin, BEHAVIOR.idleMax);
    this.until = now + this.plannedSpan;
    this.onAction('idle');
  }

  /* ---------- 坐（持续性状态） ---------- */

  /**
   * 进入坐姿。
   *
   * 坐是**持续状态**：`until = Infinity`，不会被自主行为打断。
   * 期间：
   *   - 天气、关心语句等功能照常工作（它们只用到气泡，与行为状态无关）
   *   - 点击仍会播一次性特效，播完**回到坐**而不是待机
   */
  enterSit(now = performance.now()) {
    this.sitting = true;
    this.following = false;      // 坐与跟随互斥
    this.state = S.SIT;
    this.until = Infinity;
    this.plannedSpan = 0;
    this.onAction('sit', { force: true });
  }

  /** 退出坐姿，回到待机。 */
  exitSit(now = performance.now()) {
    this.sitting = false;
    if (this.state === S.SIT) {
      this.state = S.IDLE;
      this.enterIdle(now);
    }
  }

  /* ---------- 跟随鼠标（持续性状态） ---------- */

  /**
   * 开始跟随鼠标。
   *
   * 与坐互斥（同时跟随又坐着没有意义）。
   */
  enterFollow(now = performance.now()) {
    this.following = true;
    this.sitting = false;
    this.state = S.FOLLOW;
    this.until = Infinity;
    this.plannedSpan = 0;
    this.onAction('move', { force: true });
    this.dir = 1;
    this.onTurn(this.dir);
  }

  /** 停止跟随，回到待机。 */
  exitFollow(now = performance.now()) {
    this.following = false;
    if (this.state === S.FOLLOW) {
      this.state = S.IDLE;
      this.enterIdle(now);
    }
  }

  /**
   * 跟随推进：按光标相对窗口中心的水平方向移动。
   *
   * 用一个**死区**避免光标恰好在中心时来回抖动。
   */
  stepFollow(now, dtMs) {
    const sc = this.getScreen();
    if (!sc) return;

    const cur = this.getCursor();
    if (!cur) return;

    // 光标在窗口**之外**时，不能直接不管。
    //
    // 这里曾写成「不在窗口内就 return」，结果是：指针离桌宠较远时
    // （正常情况！），窗口每帧都判定「光标不在窗口内」而完全不动，
    // 但动画仍在播——表现就是**原地踏步**，永远追不上指针。
    //
    // 正确做法：用 `rel_x` 仍能判断方向（它在窗口外时会是 <0 或 >1），
    // 于是朝该方向一直走，直到指针进入窗口范围。
    const dx = cur.rel_x - 0.5;
    if (Math.abs(dx) < BEHAVIOR.followDeadZone) return;   // 死区

    const dir = dx > 0 ? 1 : -1;
    if (dir !== this.dir) {
      this.dir = dir;
      this.onTurn(dir);
    }

    // 离得越远走得越快（有上限），这样远处能快点追上，
    // 近处又不会一冲而过。距离按窗口宽度折算成"几个窗口身位"。
    const dist = Math.abs(dx);   // 0.5 表示半个窗口宽
    const speed = Math.min(
      BEHAVIOR.followSpeed * (1 + dist * BEHAVIOR.followSpeedGain),
      BEHAVIOR.followSpeedMax,
    );

    const step = (speed * dir * dtMs) / 1000;
    let nx = sc.win_x + Math.round(step);

    // 与自主行走一样，约束在工作区内
    const left = sc.work_x;
    const right = sc.work_x + sc.work_w - sc.win_w;
    if (nx < left) nx = left;
    else if (nx > right) nx = right;

    this.onMove(nx, sc.win_y);
  }

  enterRest(now) {
    this.state = S.REST;
    this.plannedSpan = rand(BEHAVIOR.restMin, BEHAVIOR.restMax);
    this.until = now + this.plannedSpan;
    this.onAction('rest');
  }

  enterWalk(now) {
    this.state = S.WALK;
    // 小概率为长途行走：这类行走不预设短时长，而是走到边缘才转向
    this.longWalk = Math.random() < BEHAVIOR.pLongWalk;
    this.plannedSpan = this.longWalk
      ? BEHAVIOR.longWalkMax
      : rand(BEHAVIOR.walkMin, BEHAVIOR.walkMax);
    this.until = now + this.plannedSpan;
    this.dir = this.pickDirection();
    this.onTurn(this.dir);
    this.onAction('move');
  }

  /**
   * 选择行走方向。
   * 若已靠近屏幕某一侧（处于该侧的 edgeZone 比例范围内），
   * 则朝另一侧走，避免一出发就撞墙或原地徘徊。
   */
  pickDirection() {
    const sc = this.getScreen();
    if (!sc) return Math.random() < 0.5 ? -1 : 1;

    const left = sc.work_x;
    const right = sc.work_x + sc.work_w - sc.win_w;
    const span = Math.max(1, right - left);
    // 当前窗口中心在可移动范围内的归一化位置：0 = 最左，1 = 最右
    const t = (sc.win_x - left) / span;

    if (t < BEHAVIOR.edgeZone) return 1;        // 太靠左 -> 向右
    if (t > 1 - BEHAVIOR.edgeZone) return -1;   // 太靠右 -> 向左
    return Math.random() < 0.5 ? -1 : 1;        // 中间 -> 随机
  }

  /**
   * 待机结束后决定下一步。
   * 有 pIdleAgain 的概率继续待机（让桌宠大部分时间处于待机），
   * 否则在休息与行走之间按比例选择。
   *
   * **休息需要「安静足够久」**：只有距上次用户交互超过
   * `restIdleMs` 时才可能休息。否则只走「继续待机 / 行走」。
   * 这样休息不会在用户刚点完、刚拖完就频繁触发。
   */
  decideNext(now) {
    const r = Math.random();
    if (r < BEHAVIOR.pIdleAgain) {
      this.enterIdle(now);
      return;
    }

    const r2 = (r - BEHAVIOR.pIdleAgain) / (1 - BEHAVIOR.pIdleAgain);

    // 只有长时间无操作才允许休息
    const quiet = now - this.lastUserAt;
    const canRest = quiet >= BEHAVIOR.restIdleMs;

    if (canRest && r2 < BEHAVIOR.pRest) {
      this.enterRest(now);
    } else {
      this.enterWalk(now);
    }
  }

  /**
   * 播放一次性动作（如点击特效）。
   * 结束后回到待机，且**不会**受拖拽暂停影响——
   * 这样点击动画播完立刻接着待机，不会出现静止空档。
   */
  playOneshot(now, ms, actionKey = 'click') {
    this.state = S.ONESHOT;
    this.until = now + ms;
    this.holdUntil = 0;             // 清除拖拽暂停，避免播完发呆
    this.onAction(actionKey, { force: true });
  }

  /**
   * 通知「动作已真正生效」。
   *
   * 因为切换动作可能被延迟到当前循环播完（避免姿态跳动），
   * 显示层在切换真正发生时会调用这里，让计时起点与画面对齐，
   * 否则待机/行走的持续时间会被这段延迟悄悄吃掉。
   */
  notifyActionApplied(now) {
    if (this.state === S.ONESHOT) return;
    const span = this.plannedSpan;
    if (span && span > 0) {
      this.until = now + span;
      this.plannedSpan = 0;
    }
  }

  /**
   * 每帧调用，推进状态机。
   *
   * 注意：这里**没有任何"永久暂停"分支**。
   * 早期版本有 paused / pausedByUser 两个标志，只要有一个没被复位，
   * 状态机就静默死掉（表现为动画卡死）。现在只保留 holdUntil——
   * 它是基于时间戳的，一定会自动过期，不存在永久卡死的可能。
   */
  tick(now, dtMs) {
    // 拖拽后的短暂静默：基于时间戳，必然过期
    if (now < this.holdUntil && this.state !== S.ONESHOT) return;

    if (this.state === S.ONESHOT) {
      if (now >= this.until) {
        // 一次性动作结束：**回到坐**（若用户仍处于坐姿），否则回待机。
        // enterIdle 内部会检查 this.sitting，这里无需重复判断。
        this.enterIdle(now);
      }
      return;
    }

    // 坐：持续状态，不自行结束，也不被自主行为打断
    if (this.state === S.SIT) return;

    // 跟随：持续状态，按光标方向移动
    if (this.state === S.FOLLOW) {
      this.stepFollow(now, dtMs);
      return;
    }

    if (this.state === S.IDLE) {
      if (now >= this.until) this.decideNext(now);
      return;
    }

    if (this.state === S.REST) {
      if (now >= this.until) this.enterIdle(now);
      return;
    }

    if (this.state === S.WALK) {
      this.stepWalk(now, dtMs);
      if (now >= this.until) this.enterIdle(now);
    }
  }

  /** 行走：移动窗口，并在触边时掉头。 */
  stepWalk(now, dtMs) {
    const sc = this.getScreen();
    if (!sc) return;

    const dx = (BEHAVIOR.walkSpeed * this.dir * dtMs) / 1000;
    let nx = sc.win_x + Math.round(dx);

    // 工作区左右边界（窗口不能越界）
    const left = sc.work_x;
    const right = sc.work_x + sc.work_w - sc.win_w;

    let hitEdge = false;
    if (nx <= left) {
      nx = left;
      this.dir = 1;
      hitEdge = true;
    } else if (nx >= right) {
      nx = right;
      this.dir = -1;
      hitEdge = true;
    }

    if (hitEdge) {
      this.onTurn(this.dir);
      if (this.longWalk) {
        // 长途行走抵达边缘后，再走一小段就结束
        this.longWalk = false;
        this.until = Math.min(this.until, now + BEHAVIOR.afterEdgeWalk);
      } else {
        // 普通行走撞边：短暂停顿后继续
        this.until = Math.max(this.until, now + BEHAVIOR.turnPause);
      }
    }

    this.onMove(nx, sc.win_y);
  }
}
