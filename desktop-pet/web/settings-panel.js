/**
 * 设置面板
 *
 * 设置**不是独立窗口**，而是主窗口内的一个覆盖面板。
 *
 * 原因：创建独立的设置窗口时，WebView2 在同一用户数据目录下建第二个
 * webview 环境会出问题——实测要么创建失败（`os error 5`），要么留下
 * 「空白且无法关闭」的僵尸窗口。
 *
 * 主窗口的渲染链路已验证可用，因此：
 *   打开 -> Rust 把窗口临时放大到能容纳面板的尺寸，面板铺满窗口
 *   关闭 -> Rust 还原窗口尺寸与位置
 */

let invokeFn = null;

/** 地理编码：把用户输入的地名变成候选地点（由 main.js 注入）。 */
let searchCityFn = async () => [];

/**
 * 主窗口提供的「直连」回调。
 *
 * 设置面板与主窗口其实是**同一个窗口**，`settings:*` 事件只是沿用了
 * 早期「两个 webview」设计的历史包袱。事件链路一旦被 ACL 拒绝，
 * 设置里的改动就会静默失效——曾因为没有 capabilities 文件，
 * 语言切换与试听完全无反应。
 *
 * 因此这里保留一条**直连通道**：直接调用主窗口的函数。
 * 两条路都走，任一可用即可生效，不再依赖单一通道。
 */
let hooks = { onLangChange: null, onVolumeChange: null, onPreview: null, onCitiesChange: null };

/**
 * 最多可配置的城市数（由 main.js 注入，默认 3）。
 *
 * 刻意不叫 `MAX_CITIES`：weather.js 已导出同名常量，
 * 两者在打包器/测试把模块拼接进同一作用域时会**重复声明报错**。
 */
let CITY_LIMIT = 3;

/** 面板打开前的窗口尺寸（逻辑像素），用于恢复 */
export const PANEL_W = 440;
export const PANEL_H = 560;

const $ = (id) => document.getElementById(id);

let cfg = null;
let isOpen = false;
let onOpenChange = null;

/** 各月的天数（2 月按 29 天，兼容闰年生日）。 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* ---------- 生日下拉 ---------- */

/**
 * 生成「月 / 日」下拉的选项。
 * 只做一次，之后靠 render() 设置选中值。
 */
function buildBirthdaySelects() {
  const mSel = $('setBirthMonth');
  const dSel = $('setBirthDay');
  if (!mSel || !dSel) return;

  mSel.innerHTML = '';
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = String(m);
    o.textContent = `${m} 月`;
    mSel.appendChild(o);
  }

  // 日的选项随月份变化（避免出现 2 月 31 日这种非法日期）
  const fillDays = () => {
    const keep = parseInt(dSel.value, 10);
    fillDaysFor(mSel, dSel);
    const days = DAYS_IN_MONTH[(parseInt(mSel.value, 10) || 1) - 1];
    if (keep && keep <= days) dSel.value = String(keep);
  };

  mSel.addEventListener('change', fillDays);
  fillDays();
}

/** 把配置里的生日写进下拉框。 */
function renderBirthday() {
  const mSel = $('setBirthMonth');
  const dSel = $('setBirthDay');
  if (!mSel || !dSel) return;

  const b = cfg?.birthday;
  if (b && b.month && b.day) {
    mSel.value = String(b.month);
    // 月份变化后日的选项范围也要跟着更新
    mSel.dispatchEvent(new Event('change'));
    dSel.value = String(b.day);
  } else {
    // 未设置：显示回到 1 月 1 日作为占位。
    //
    // 这里**只改选项范围、不触发 change**：`renderBirthday` 是纯粹的
    // 显示同步，触发 change 会让「清除生日」立刻又被写回 1 月 1 日。
    fillDaysFor(mSel, dSel);
    dSel.value = '1';
  }
}

/** 按月份重建「日」的选项（不触发任何事件）。 */
function fillDaysFor(mSel, dSel) {
  const m = parseInt(mSel.value, 10) || 1;
  const days = DAYS_IN_MONTH[m - 1];
  dSel.innerHTML = '';
  for (let d = 1; d <= days; d++) {
    const o = document.createElement('option');
    o.value = String(d);
    o.textContent = `${d} 日`;
    dSel.appendChild(o);
  }
}

/* ---------- 所在地区 ---------- */

/** 当前已配置的城市（最多 3 个）。 */
let cities = [];

/** 渲染已添加的城市列表。 */
function renderCities() {
  const box = $('setCityList');
  if (!box) return;
  box.innerHTML = '';

  if (!cities.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '尚未添加';
    box.appendChild(empty);
    return;
  }

  cities.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'city';

    const left = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = c.name;
    left.appendChild(name);

    // 省份/国家用于区分同名地点
    const sub = [c.admin1, c.country].filter(Boolean).join(' · ');
    if (sub) {
      const s = document.createElement('span');
      s.className = 'csub';
      s.textContent = sub;
      left.appendChild(s);
    }
    row.appendChild(left);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      cities.splice(i, 1);
      await saveCities();
    });
    row.appendChild(del);

    box.appendChild(row);
  });
}

/** 把城市列表写回配置。 */
async function saveCities() {
  const saved = await invokeFn('set_weather_cities', { cities });
  if (Array.isArray(saved)) cities = saved;
  renderCities();
  hooks.onCitiesChange?.(cities);
}

/** 显示一行提示（如搜索结果为空、已达上限）。 */
function cityHint(text, warn = false) {
  const h = $('setCityHint');
  if (!h) return;
  h.textContent = text || '';
  h.classList.toggle('warn', !!warn);
}

/** 渲染地理编码的候选列表，点一条即添加。 */
function renderCityResults(results) {
  const box = $('setCityResults');
  if (!box) return;
  box.innerHTML = '';

  results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'city pick';

    const left = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = r.name;
    left.appendChild(name);

    const sub = [r.admin1, r.country].filter(Boolean).join(' · ');
    if (sub) {
      const s = document.createElement('span');
      s.className = 'csub';
      s.textContent = sub;
      left.appendChild(s);
    }
    row.appendChild(left);

    const add = document.createElement('button');
    add.textContent = '添加';
    add.addEventListener('click', async (e) => {
      e.stopPropagation();
      await addCity(r);
    });
    row.appendChild(add);

    row.addEventListener('click', () => addCity(r));
    box.appendChild(row);
  });
}

/** 添加一个城市（去重 + 上限检查）。 */
async function addCity(r) {
  if (cities.length >= CITY_LIMIT) {
    cityHint(`最多只能添加 ${CITY_LIMIT} 个地区`, true);
    return;
  }
  // 同名同坐标视为重复
  const dup = cities.some(
    (c) => c.name === r.name &&
           Math.abs(c.latitude - r.latitude) < 1e-6 &&
           Math.abs(c.longitude - r.longitude) < 1e-6);
  if (dup) {
    cityHint('这个地区已经添加过了', true);
    return;
  }

  cities.push({
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    admin1: r.admin1 || '',
    country: r.country || '',
  });

  await saveCities();
  $('setCityResults').innerHTML = '';
  $('setCityInput').value = '';
  cityHint('已添加');
}

/* ---------- 渲染 ---------- */

function render() {
  if (!cfg) return;
  $('setTop').checked = !!cfg.always_on_top;
  $('setPassthrough').checked = !!cfg.click_through;
  $('setVolume').value = cfg.volume;
  $('setVolumeVal').textContent = cfg.volume;

  // 尺寸：整数百分比滑条（20~100）
  const sc = Math.round((cfg.scale || 0.35) * 100);
  $('setScale').value = sc;
  $('setScaleVal').textContent = `${sc}%`;

  document.querySelectorAll('#setLangSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === cfg.voice_lang);
  });

  renderBirthday();
  renderCities();
}

async function reload() {
  const c = await invokeFn('get_config');
  if (c) {
    cfg = c;
    cities = Array.isArray(c.weather_cities) ? c.weather_cities.slice() : [];
    render();
  }
}

/* ---------- 打开 / 关闭 ---------- */

export async function openSettings() {
  if (isOpen) return;
  isOpen = true;

  // 先放大窗口，再显示面板（顺序反了会看到面板被裁切）
  await invokeFn('enter_settings_ui', { width: PANEL_W, height: PANEL_H });
  await reload();

  $('settings').classList.add('show');
  $('stage').style.display = 'none';   // 隐藏桌宠画面
  onOpenChange?.(true);
}

export async function closeSettings() {
  if (!isOpen) return;
  isOpen = false;

  $('settings').classList.remove('show');
  $('stage').style.display = '';

  await invokeFn('exit_settings_ui');
  onOpenChange?.(false);
}

export function settingsOpen() {
  return isOpen;
}

/* ---------- 交互绑定 ---------- */

function bind() {
  $('setClose').addEventListener('click', () => closeSettings());

  // Esc 关闭
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeSettings();
  });

  $('setTop').addEventListener('change', async (e) => {
    cfg.always_on_top = e.target.checked;
    await invokeFn('set_always_on_top', { on: cfg.always_on_top });
  });

  $('setPassthrough').addEventListener('change', async (e) => {
    cfg.click_through = e.target.checked;
    await invokeFn('set_passthrough_enabled', { enabled: cfg.click_through });
  });

  /*
   * 尺寸滑条。
   *
   * 拖动过程中**只更新数字显示、不立刻改窗口**：每拖一格都改窗口
   * 会让设置面板抖动、还可能因面板占用窗口而互相干扰。
   * 松手（change）时才真正写入并调整。
   */
  $('setScale').addEventListener('input', () => {
    $('setScaleVal').textContent = `${$('setScale').value}%`;
  });
  $('setScale').addEventListener('change', async () => {
    const pct = parseInt($('setScale').value, 10);
    cfg.scale = pct / 100;
    // 缩放会改变窗口尺寸，但此刻窗口被设置面板占用，
    // 因此只记录到配置，等关闭面板时由 Rust 端按新尺寸恢复。
    await invokeFn('set_scale', { scale: cfg.scale });
    render();
  });

  $('setBottom').addEventListener('click', async () => {
    // 面板占用窗口时不宜移动，先关闭再移动
    await closeSettings();
    await invokeFn('move_pet_to_bottom');
  });

  const vol = $('setVolume');
  vol.addEventListener('input', () => { $('setVolumeVal').textContent = vol.value; });
  vol.addEventListener('change', async () => {
    const v = parseInt(vol.value, 10);
    cfg.volume = v;
    await invokeFn('set_volume', { value: v });
    hooks.onVolumeChange?.(v);
  });

  document.querySelectorAll('#setLangSeg button').forEach((b) => {
    b.addEventListener('click', async () => {
      cfg.voice_lang = b.dataset.lang;
      await invokeFn('set_voice_lang', { lang: cfg.voice_lang });
      render();
      // 直连优先：不依赖事件是否接通
      hooks.onLangChange?.(cfg.voice_lang);
      // 切换语言后试听一条，便于确认生效
      hooks.onPreview?.();
      await invokeFn('preview_voice');
    });
  });

  /* ---------- 生日 ---------- */

  // 月/日任一变化即保存（下拉让非法日期不可能出现）
  const saveBirthday = async () => {
    const m = parseInt($('setBirthMonth').value, 10) || 0;
    const d = parseInt($('setBirthDay').value, 10) || 0;
    cfg.birthday = { month: m, day: d };
    await invokeFn('set_birthday', { month: m, day: d });
  };

  $('setBirthMonth').addEventListener('change', saveBirthday);
  $('setBirthDay').addEventListener('change', saveBirthday);

  $('setBirthClear').addEventListener('click', async () => {
    cfg.birthday = null;
    // 传 0 表示清除
    await invokeFn('set_birthday', { month: 0, day: 0 });
    render();
  });

  /* ---------- 试听 ---------- */

  $('setPreviewVoice').addEventListener('click', async () => {
    hooks.onPreview?.();
    await invokeFn('preview_voice');
  });

  /* ---------- 所在地区 ---------- */

  const doSearch = async () => {
    const q = $('setCityInput').value.trim();
    if (q.length < 2) {
      cityHint('请输入至少两个字', true);
      return;
    }
    if (cities.length >= CITY_LIMIT) {
      cityHint(`最多只能添加 ${CITY_LIMIT} 个地区`, true);
      return;
    }

    cityHint('搜索中…');
    $('setCityResults').innerHTML = '';

    try {
      const results = await searchCityFn(q);
      if (!results.length) {
        // 提示语要给**不带符号**的例子：早期写的是「朝阳, 辽宁」，
        // 会让人以为必须打逗号。
        cityHint('没有找到这个地名。可试试「江苏昆山」或「朝阳区 辽宁」', true);
        return;
      }
      cityHint(`找到 ${results.length} 个结果，点一条添加到列表`);
      renderCityResults(results);
    } catch (e) {
      // 联网失败要明说，否则用户只看到「没反应」
      cityHint('搜索失败，请检查网络连接', true);
      console.warn('城市搜索失败:', e);
    }
  };

  $('setCitySearch').addEventListener('click', doSearch);
  // 回车即搜索
  $('setCityInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
}

/** 初始化（由 main.js 调用一次）。 */
export function initSettingsPanel({
  invoke, onOpen, onLangChange, onVolumeChange, onPreview, onCitiesChange,
  searchCity, maxCities,
}) {
  invokeFn = invoke;
  onOpenChange = onOpen;
  if (typeof searchCity === 'function') searchCityFn = searchCity;
  if (Number.isFinite(maxCities)) CITY_LIMIT = maxCities;
  // 直连通道：与事件并行，任一生效即可
  hooks = {
    onLangChange: onLangChange || null,
    onVolumeChange: onVolumeChange || null,
    onPreview: onPreview || null,
    onCitiesChange: onCitiesChange || null,
  };
  buildBirthdaySelects();
  bind();
}
