/**
 * 语音播放
 *
 * 素材来自 `audio/audio.json`（34 条，jp/zh 各 17 条，一一对应）。
 * 前端副本在 `web/audio/`，由构建时嵌入。
 *
 * ## 触发规则
 *
 * | 场景 | 语音 |
 * |---|---|
 * | 单击桌宠 | 戳一下 |
 * | 启动 | 生日 / 新年祝福 / 周年庆典 / 任命助理（见 pickStartupClip）|
 * | 菜单「交谈」 | 其余 13 条中随机 |
 *
 * ## 关于时长
 *
 * 语音时长与动画时长**不需要对齐**：语音比动画长（或短）都保持原样，
 * 不做裁剪、不做等待。因此这里只用 `<audio>` 播一次，不与 `brain` 的
 * 状态时长做任何耦合。
 *
 * ## 关于双语
 *
 * 中/日文文件名完全一致，只有目录不同（`audio/zh/` 与 `audio/jp/`）。
 * 语言由设置里的 `voice_lang`（'zh' | 'jp'）决定，切换后立即生效。
 */

import { festivalOf, isBirthday, toDateKey } from './calendar.js';

/** 与 audio.json 保持一致；若读取清单失败则退回这份内置表。 */
export const FALLBACK_CLIPS = [
  '交谈1', '交谈2', '交谈3',
  '任命助理',
  '信赖提升后交谈1', '信赖提升后交谈2', '信赖提升后交谈3',
  '周年庆典',
  '干员报到',
  '戳一下',
  '天气', '天气失败',
  '新年祝福',
  '晋升后交谈1', '晋升后交谈2',
  '生日',
  '精英化晋升1', '精英化晋升2',
  '闲置',
];

/** 特殊用途语音：不参与「交谈」的随机池。 */
export const SPECIAL_CLIPS = new Set([
  '戳一下',      // 单击
  '任命助理',    // 常规启动
  '周年庆典',    // 5/1–5/4 启动
  '新年祝福',    // 除夕 ~ 初三 启动
  '生日',        // 生日当天启动
  '天气',        // 查询天气成功
  '天气失败',    // 查询天气失败
]);

/** 天气相关语音名。 */
export const WEATHER_CLIPS = {
  ok: '天气',
  fail: '天气失败',
};

/** 启动语音与音频条目的对应关系。 */
export const STARTUP_CLIPS = {
  birthday: '生日',
  newyear: '新年祝福',
  anniversary: '周年庆典',
  normal: '任命助理',
};

/* ---------- 模块状态 ---------- */

let manifest = null;       // audio.json
let lang = 'zh';           // 'zh' | 'jp'
let volume = 70;           // 0~100
let ready = false;

/** 当前正在播放的 audio 元素（用于打断上一条） */
let current = null;

/**
 * 当天「生日语音是否已播放过」的记录。
 *
 * 需求：生日当天**第一次启动**必定播生日语音；
 * 之后同一天再启动，则在生日与节日语音之间随机。
 * 因此需要跨启动记住「今天已经播过生日」——用 localStorage。
 */
const BIRTHDAY_KEY = 'pet.birthdayPlayedOn';

/* ---------- 初始化 ---------- */

/**
 * 载入语音清单。
 * 失败不致命：退回内置文件名表，语音仍可用。
 */
export async function initVoice() {
  try {
    const res = await fetch(`${audioBase}audio/audio.json`);
    if (res.ok) manifest = await res.json();
  } catch {
    /* 用内置表兜底 */
  }
  ready = true;
}

/** 设置语音语言（'zh' | 'jp'），立即生效。 */
export function setLang(l) {
  lang = l === 'jp' ? 'jp' : 'zh';
}

/** 设置音量（0~100），立即作用于正在播放的语音。 */
export function setVolume(v) {
  const n = Math.max(0, Math.min(100, Number(v) || 0));
  volume = n;
  if (current) current.volume = n / 100;
}

export function getLang() {
  return lang;
}
export function getVolume() {
  return volume;
}

/* ---------- 清单查询 ---------- */

/** 当前语言下可用的语音名列表。 */
export function clipNames() {
  const items = manifest?.languages?.[lang]?.items;
  if (items && typeof items === 'object') return Object.keys(items);
  return FALLBACK_CLIPS.slice();
}

/**
 * 音频根路径，由 main.js 在启动时按素材实际位置注入。
 *
 * 语音原本内嵌在 exe 里（`./audio/` 相对路径直接读得到）；
 * 现在素材外置到 exe 同目录，需要换成 asset 协议前缀。
 * 默认空串 = 开发时直接读 `web/audio/`。
 */
let audioBase = '';

/** 由 main.js 调用，告知语音素材的实际位置。 */
export function setAudioBase(base) {
  audioBase = base || '';
}

/** 语音名 -> 可播放路径。 */
export function clipPath(name) {
  const entry = manifest?.languages?.[lang]?.items?.[name];
  if (entry?.file) return audioBase + 'audio/' + entry.file;
  // 清单缺失时按约定拼路径
  return `${audioBase}audio/${lang}/${name}.ogg`;
}

/**
 * 参与「交谈」随机池的语音：全部语音去掉特殊用途的那些。
 * @returns {string[]}
 */
export function talkPool() {
  const pool = clipNames().filter((n) => !SPECIAL_CLIPS.has(n));
  // 极端情况下（清单异常）保证池子非空
  return pool.length ? pool : ['交谈1'];
}

/* ---------- 播放 ---------- */

/**
 * 播放一条语音。
 *
 * 每次新建 `Audio` 而不复用元素：语音都较短，且这样能自然地
 * 「打断上一条」（旧对象失去引用后被回收）。
 *
 * 注意 `catch`：播放被浏览器拒绝（如无用户手势）不应影响主流程。
 *
 * @param {string} name 语音名（不含扩展名）
 * @returns {Promise<HTMLAudioElement|null>}
 */
export function play(name) {
  if (!name) return Promise.resolve(null);
  try {
    if (current) {
      current.pause();
      current = null;
    }
    const a = new Audio(clipPath(name));
    a.volume = volume / 100;
    current = a;
    const p = a.play();
    // 某些环境返回 undefined（老实现），统一吞掉
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return Promise.resolve(a);
  } catch {
    return Promise.resolve(null);
  }
}

/** 停止当前语音。 */
export function stop() {
  if (current) {
    try { current.pause(); } catch { /* 忽略 */ }
    current = null;
  }
}

/** 从「交谈」池里随机播放一条，返回所播的语音名。 */
export function playRandomTalk() {
  const pool = talkPool();
  const name = pool[Math.floor(Math.random() * pool.length)];
  play(name);
  return name;
}

/* ---------- 启动语音选择 ---------- */

/** 读取「今天是否已播过生日语音」。 */
function birthdayPlayedOn() {
  try {
    return localStorage.getItem(BIRTHDAY_KEY) || '';
  } catch {
    return '';
  }
}

/** 记录「今天已播过生日语音」。 */
function markBirthdayPlayed(dateKey) {
  try {
    localStorage.setItem(BIRTHDAY_KEY, dateKey);
  } catch {
    /* 隐私模式等场景下失败，忽略 */
  }
}

/**
 * 选择启动时要播放的语音。
 *
 * 规则（按用户确认的方案）：
 *
 * 1. **生日当天**
 *    - 当天**第一次**启动：必定播「生日」
 *    - 之后同一天再启动：在「生日」与命中的节日语音之间**随机**
 * 2. 非生日当天
 *    - 命中春节（除夕~初三）-> 「新年祝福」
 *    - 命中周年庆（5/1–5/4）-> 「周年庆典」
 *    - 都不是 -> 「任命助理」
 *
 * 关键点：特殊日期启动时**不会**再播「任命助理」。
 *
 * @param {Date} now
 * @param {{month:number, day:number}|null} birthday 用户设置的生日
 * @returns {{name: string, reason: string}}
 */
export function pickStartupClip(now, birthday) {
  const onBirthday = isBirthday(now, birthday);
  const festival = festivalOf(now);   // 'newyear' | 'anniversary' | null

  if (onBirthday) {
    const today = toDateKey(now);
    const first = birthdayPlayedOn() !== today;
    markBirthdayPlayed(today);

    if (first) {
      return { name: STARTUP_CLIPS.birthday, reason: 'birthday-first' };
    }
    // 当天后续启动：生日与节日随机
    if (festival) {
      const both = [STARTUP_CLIPS.birthday, STARTUP_CLIPS[festival]];
      const name = both[Math.floor(Math.random() * both.length)];
      return { name, reason: name === STARTUP_CLIPS.birthday ? 'birthday-random' : festival };
    }
    return { name: STARTUP_CLIPS.birthday, reason: 'birthday' };
  }

  if (festival) return { name: STARTUP_CLIPS[festival], reason: festival };
  return { name: STARTUP_CLIPS.normal, reason: 'normal' };
}

/**
 * 按启动规则挑一条并播放。
 * @returns {{name:string, reason:string}}
 */
export function playStartupClip(now, birthday) {
  const picked = pickStartupClip(now, birthday);
  play(picked.name);
  return picked;
}

/** 清单是否已就绪（供测试判断）。 */
export function isReady() {
  return ready;
}
