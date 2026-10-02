/**
 * 对话气泡
 *
 * ## 定位策略：从窗口顶部往下铺，固定高度 + 内部滚动
 *
 * 经历过一次「为气泡扩展窗口」的尝试，最终**放弃**了：
 *
 *   - 角色头顶以上的空白只占窗口高度的约 20%（20% 档仅 29px），
 *     气泡几乎总是放不下
 *   - 扩窗要联动原点偏移、画布缩放、穿透坐标换算，环节多、
 *     任何一个出错都会表现为「角色被截断」——实测反复踩坑
 *   - 小尺寸下即使扩窗成功，窗口也可能顶到屏幕边缘而放不下
 *
 * 现在的做法简单且可预测：
 *
 *   - 气泡**固定**在窗口顶部往下铺，高度取窗口的 60%
 *   - 内容超出就在气泡**内部滚动**
 *   - 窗口尺寸**完全不变** → 角色永远不会被裁
 *
 * 代价是小窗口下气泡会盖住角色头部，但这是**可预期**的：
 * 用户看到气泡时本来就在读字，不需要同时看角色。
 *
 * ## 为什么用 DOM 而不是图片素材
 *
 * 角色素材是 906×704 的整幅画布。DOM 的好处是文字自动换行、
 * 随窗口缩放、可滚动、可点击关闭，不必为每句话出图。
 *
 * ## 与点击穿透的关系
 *
 * 点击穿透按「光标处像素是否透明」判断，而气泡是 DOM 元素，
 * **不参与画布的 alpha 采样**。因此气泡显示期间要显式禁止穿透
 * （见 main.js 的 pollPassthrough），否则气泡点不动。
 */

const HOLD_MS = 8000;      // 默认停留时长
const FADE_MS = 300;       // 淡出时长

let el = null;
let timer = 0;
let fadeTimer = 0;
let visible = false;

/** 当前是否正在显示（供点击穿透判断）。 */
export function isBubbleVisible() {
  return visible;
}

/** 初始化（由 main.js 调用一次）。 */
export function initBubble() {
  el = document.getElementById('bubble');
  if (!el) return;

  // 点气泡直接收起，避免挡视线
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    hideBubble();
  });
}

/**
 * 显示气泡。
 *
 * @param {string|string[]} lines 一行或多行文本
 * @param {{hold?: number, kind?: string}} opts
 *        hold 停留毫秒数；kind 用于附加样式（如 'error' 走警示色）
 */
export function showBubble(lines, opts = {}) {
  if (!el) return;

  const arr = Array.isArray(lines) ? lines : [lines];
  const hold = opts.hold ?? HOLD_MS;

  // 用 DOM 节点逐行渲染，避免把文本当 HTML 解析
  el.textContent = '';
  const kind = opts.kind || '';
  arr.forEach((line, i) => {
    const div = document.createElement('div');

    let cls = 'bubble-line';
    if (i === 0) {
      // 首行是标题/问候语
      cls += ' bubble-title';
    } else if (/^\s/.test(line)) {
      // 缩进开头的是生活提醒，用较弱样式区分
      cls += ' bubble-advice';
    } else if (kind === 'weather') {
      // 天气报告里，非缩进行交替出现「城市行 / 数据行」。
      // 第一行（i=1）是城市，之后每两行一组。
      cls += ((i - 1) % 3 === 0) ? ' bubble-city' : ' bubble-metrics';
    }

    div.className = cls;
    div.textContent = line;
    el.appendChild(div);
  });
  el.dataset.kind = kind;

  clearTimeout(timer);
  clearTimeout(fadeTimer);
  // 每次显示都回到顶部：上一次滚动的位置不该影响新内容
  el.scrollTop = 0;
  el.classList.remove('hide');
  el.classList.add('show');
  visible = true;

  if (hold > 0) {
    timer = setTimeout(() => hideBubble(), hold);
  }
}

/** 收起气泡（带淡出）。 */
export function hideBubble() {
  if (!el || !visible) return;
  clearTimeout(timer);
  visible = false;
  el.classList.add('hide');
  fadeTimer = setTimeout(() => {
    el.classList.remove('show');
    el.classList.remove('hide');
    el.textContent = '';
    el.scrollTop = 0;
  }, FADE_MS);
}

/**
 * 用「查询中」占位，并在等待期间保持显示。
 */
export function showPending(text = '正在查询天气…') {
  showBubble([text], { hold: 0, kind: 'pending' });
}

/** 内容是否超出气泡（供提示用户可滚动）。 */
export function isOverflowing() {
  if (!el) return false;
  return el.scrollHeight > el.clientHeight + 1;
}
