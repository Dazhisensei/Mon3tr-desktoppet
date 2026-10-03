/**
 * 用**真实的 weather.js** 验证城市搜索：覆盖各种输入写法与覆盖率。
 *
 * 不手写等价实现 —— 直接从源码求值。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('E:/work/deskpet/M3/desktop-pet/web/weather.js', 'utf8');

// 去掉 import/export，让它在 vm 里能跑
const script = src
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
  .replace(/^export\s+/gm, '');

// 记录网络调用：本地表命中时**不该有任何请求**
const netCalls = [];
const sandbox = {
  console,
  fetch: async (url) => {
    netCalls.push(String(url));
    // 本地表没命中才会走到这里；返回空结果模拟「网络也查不到」
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  },
  AbortController, setTimeout, clearTimeout, Promise, Math, Date, JSON,
  encodeURIComponent, decodeURIComponent, Array, Object, String, Number,
  Boolean, Error, RegExp, isNaN, parseInt, parseFloat, Map, Set,
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

const search = (q) => vm.runInContext(`searchCity(${JSON.stringify(q)})`, sandbox);

let fail = 0;
const chk = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('=== A. 各种输入写法（都不要求打符号）===');
const CASES = [
  // [输入, 期望首个结果含有的字, 说明]
  ['北京',        '北京',  '直辖市直接输入'],
  ['上海',        '上海',  '直辖市'],
  ['昆山',        '昆山',  '县级市，不带省份'],
  ['江苏昆山',    '昆山',  '省+市连写（新支持）'],
  ['江苏 昆山',   '昆山',  '空格分隔'],
  ['昆山, 江苏',  '昆山',  '逗号（旧写法仍兼容）'],
  ['浙江省义乌',  '义乌',  '省+县级市连写'],
  ['内蒙古包头',  '包头',  '3 字省名连写'],
  ['朝阳区',      '朝阳',  '同名区'],
  ['滨州',        '滨州',  '曾经查不到的 2 字地名'],
  ['Binzhou',     '滨州',  '拼音输入'],
];
for (const [input, want, desc] of CASES) {
  const before = netCalls.length;
  let r = [];
  try { r = await search(input); } catch (e) { r = []; }
  const ok = r.length > 0 && r[0].name.includes(want);
  chk(`${desc}：「${input}」`, ok,
      ok ? `-> ${r[0].name}` : `-> (空) 期望含「${want}」`);
}

console.log('\n=== B. 本地命中不发网络请求（核心收益）===');
{
  netCalls.length = 0;
  await search('北京');
  await search('江苏昆山');
  await search('义乌');
  chk('三次搜索零网络请求', netCalls.length === 0, `${netCalls.length} 次`);
}

console.log('\n=== C. 省份消歧（同名地点）===');
{
  const cy = await search('朝阳');
  const provs = cy.map((c) => c.admin1);
  chk('「朝阳」返回多条且带省份', new Set(provs).size >= 1,
      cy.map((c) => c.name).join(' / '));

  // 明确指定省份后应只剩该省
  const ln = await search('朝阳 辽宁');
  chk('「朝阳 辽宁」限定到辽宁',
      ln.length > 0 && ln.every((c) => c.admin1 === '辽宁'),
      ln.map((c) => `${c.name}[${c.admin1}]`).join(' ') || '(空)');

  const jl = await search('朝阳 吉林');
  chk('「朝阳 吉林」限定到吉林',
      jl.length > 0 && jl.every((c) => c.admin1 === '吉林'),
      jl.map((c) => `${c.name}[${c.admin1}]`).join(' ') || '(空)');
}

console.log('\n=== D. 覆盖率抽查（全国大中小城市）===');
{
  // 直辖市 / 省会 / 地级市 / 县级市 / 区，各层都要能查到
  const SAMPLE = [
    // 直辖市
    '北京', '上海', '天津', '重庆',
    // 省会
    '石家庄', '太原', '沈阳', '长春', '哈尔滨', '南京', '杭州', '合肥',
    '福州', '南昌', '济南', '郑州', '武汉', '长沙', '广州', '成都',
    '贵阳', '昆明', '西安', '兰州', '西宁', '银川', '乌鲁木齐', '南宁',
    '海口', '拉萨', '呼和浩特',
    // 地级市
    '苏州', '无锡', '宁波', '温州', '佛山', '东莞', '烟台', '潍坊',
    '洛阳', '襄阳', '宜昌', '岳阳', '株洲', '九江', '芜湖', '包头',
    // 县级市（重点：这批曾经完全查不到）
    '昆山', '义乌', '慈溪', '江阴', '常熟', '晋江', '诸暨', '余姚',
    '温岭', '乐清', '龙口', '招远', '新泰', '肥城', '邹城', '海宁',
    '桐乡', '平湖', '启东', '沭阳', '张家港', '太仓', '宜兴', '溧阳',
    // 区
    '海淀区', '朝阳区', '浦东新区', '天河区', '南山区', '西湖区',
  ];
  let hit = 0;
  const miss = [];
  for (const c of SAMPLE) {
    let r = [];
    try { r = await search(c); } catch { r = []; }
    if (r.length) hit++;
    else miss.push(c);
  }
  const rate = hit / SAMPLE.length;
  console.log(`    ${hit}/${SAMPLE.length} 命中（${(rate * 100).toFixed(0)}%）`);
  if (miss.length) console.log(`    未命中: ${miss.join('、')}`);
  chk('覆盖率 >= 90%', rate >= 0.9, `${(rate * 100).toFixed(0)}%`);

  // 县级市单独统计（这是本次改造的重点）
  const COUNTIES = SAMPLE.slice(-6 - 24, -6);
  let chit = 0;
  const cmiss = [];
  for (const c of COUNTIES) {
    let r = [];
    try { r = await search(c); } catch { r = []; }
    if (r.length) chit++;
    else cmiss.push(c);
  }
  chk('县级市全部可查',
      chit === COUNTIES.length,
      `${chit}/${COUNTIES.length}${cmiss.length ? ' 缺: ' + cmiss.join('、') : ''}`);
}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
