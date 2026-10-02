/**
 * 农历节日判定
 *
 * 桌宠启动时需要知道「今天是不是春节」，但浏览器/WebView 只有公历。
 * 完整农历算法（朔望月 + 定气）体积大且容易出错，而这里的需求很窄：
 * **只需要农历除夕与正月初一两天**。因此改用一张预先算好的对照表，
 * 一次覆盖十余年，确定且无需联网。
 *
 * 表中日期为公历（本地时区），除夕 = 正月初一的前一天。
 * 覆盖范围外的年份会自动降级：只判断公历节日，不影响其他功能。
 */

/**
 * 农历正月初一对应的公历日期，格式 'YYYY-MM-DD'。
 * 覆盖 2025–2035，之后需要续表（春节最早 1/21、最晚 2/20）。
 */
export const LUNAR_NEW_YEAR = {
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
  2031: '2031-01-23',
  2032: '2032-02-11',
  2033: '2033-01-31',
  2034: '2034-02-19',
  2035: '2035-02-08',
};

/** 春节庆祝天数：正月初一至初三，加上除夕共 4 天。 */
export const SPRING_FESTIVAL_DAYS = 3;

/** 周年庆典：固定公历 5 月 1 日至 5 月 4 日。 */
export const ANNIVERSARY = { month: 5, from: 1, to: 4 };

/** 把 Date 归一化为 'YYYY-MM-DD'（本地时区，不能用 toISOString——那是 UTC）。 */
export function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' -> Date（本地零点）。避免 new Date(str) 被当 UTC 解析。 */
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 日期加减天数，返回新的 Date（本地零点）。 */
function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * 判断是否是春节假期（除夕 ~ 正月初三）。
 * @param {Date} date
 * @returns {boolean}
 */
export function isSpringFestival(date) {
  const year = date.getFullYear();
  const today = new Date(year, date.getMonth(), date.getDate());

  // 春节假期可能跨年：当年 1 月初可能属于**上一年**的春节末尾，
  // 当年的春节也可能延续到次年 1 月，因此前后各查一年。
  for (const y of [year - 1, year, year + 1]) {
    const key = LUNAR_NEW_YEAR[y];
    if (!key) continue;
    const newYearDay = parseDateKey(key);          // 正月初一
    const eve = addDays(newYearDay, -1);           // 除夕
    const last = addDays(newYearDay, SPRING_FESTIVAL_DAYS - 1); // 初三

    if (today >= eve && today <= last) return true;
  }
  return false;
}

/** 判断是否是周年庆典（公历 5/1–5/4）。 */
export function isAnniversary(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return m === ANNIVERSARY.month && d >= ANNIVERSARY.from && d <= ANNIVERSARY.to;
}

/**
 * 判断今天是否是用户的生日。
 * @param {Date} date
 * @param {{month:number, day:number}|null} birthday
 */
export function isBirthday(date, birthday) {
  if (!birthday || !birthday.month || !birthday.day) return false;
  return date.getMonth() + 1 === birthday.month && date.getDate() === birthday.day;
}

/**
 * 判定今天命中的**节日**语音（不含生日）。
 *
 * 返回 'newyear' | 'anniversary' | null。
 * 春节与周年庆理论上不会重叠，但仍给出明确优先级：
 * 春节更罕见、更「特殊」，优先。
 *
 * @param {Date} date
 */
export function festivalOf(date) {
  if (isSpringFestival(date)) return 'newyear';
  if (isAnniversary(date)) return 'anniversary';
  return null;
}
