// 语音链路最终校验：真实读取 audio.json + 真实文件名，逐一核对路径与文件是否都成立。
// 目的：Node 桩测试证明「逻辑对」，这个脚本证明「文件真的在」。
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/work/deskpet/M3';
const WEB  = path.join(ROOT, 'desktop-pet', 'web');
const AUD  = path.join(WEB, 'audio');

const manifest = JSON.parse(readFileSync(path.join(AUD, 'audio.json'), 'utf8'));

let pass = 0, fail = 0;
const chk = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

console.log('=== 1. audio.json 与实际文件一一对应 ===');
for (const lang of ['zh', 'jp']) {
  const items = manifest.languages[lang].items;
  const names = Object.keys(items);
  const missing = [], sizeBad = [];
  for (const n of names) {
    const f = path.join(AUD, items[n].file);
    if (!existsSync(f)) { missing.push(n); continue; }
    // 清单里的字节数必须与磁盘一致，否则说明清单过期
    if (statSync(f).size !== items[n].bytes) sizeBad.push(n);
  }
  chk(`${lang}: ${names.length} 条文件全部存在`, missing.length === 0,
      missing.length ? `缺失=${missing.join(',')}` : '');
  chk(`${lang}: 清单字节数与磁盘一致`, sizeBad.length === 0,
      sizeBad.length ? `不一致=${sizeBad.join(',')}` : '');
}

console.log('\n=== 2. 双语文件名一一对应 ===');
const zh = Object.keys(manifest.languages.zh.items).sort();
const jp = Object.keys(manifest.languages.jp.items).sort();
chk('中/日文件名集合完全相同',
    zh.length === jp.length && zh.every((n, i) => n === jp[i]),
    `zh=${zh.length} jp=${jp.length}`);

console.log('\n=== 3. 目录下没有清单之外的多余文件 ===');
const { readdirSync } = await import('node:fs');
for (const lang of ['zh', 'jp']) {
  const items = manifest.languages[lang].items;
  const declared = new Set(Object.values(items).map(v => path.basename(v.file)));
  const actual = readdirSync(path.join(AUD, lang)).filter(f => f.endsWith('.ogg'));
  const extra = actual.filter(f => !declared.has(f));
  chk(`${lang}: 目录无未登记文件`, extra.length === 0,
      extra.length ? `多余=${extra.join(',')}` : `${actual.length} 个文件`);
}

console.log('\n=== 4. 必须存在的特殊语音 ===');
// 与 web/voice.js 的 SPECIAL_CLIPS 保持一致
const SPECIAL = ['戳一下', '任命助理', '周年庆典', '新年祝福', '生日', '天气', '天气失败'];
for (const lang of ['zh', 'jp']) {
  const names = Object.keys(manifest.languages[lang].items);
  const miss = SPECIAL.filter(s => !names.includes(s));
  chk(`${lang}: ${SPECIAL.length} 条特殊语音齐全`, miss.length === 0,
      miss.length ? `缺失=${miss.join(',')}` : '');
}

console.log('\n=== 5. 交谈池 = 19 - 7 = 12 ===');
const pool = Object.keys(manifest.languages.zh.items).filter(n => !SPECIAL.includes(n));
chk('交谈池 12 条', pool.length === 12, `实际=${pool.length}`);
console.log(`     ${pool.join(' / ')}`);

console.log('\n=== 6. web/audio 与 audio/ 源目录一致 ===');
const SRC = path.join(ROOT, 'audio');
for (const lang of ['zh', 'jp']) {
  const a = readdirSync(path.join(SRC, lang)).filter(f => f.endsWith('.ogg')).sort();
  const b = readdirSync(path.join(AUD, lang)).filter(f => f.endsWith('.ogg')).sort();
  chk(`${lang}: 源与前端副本一致 (${b.length} 个)`,
      a.length === b.length && a.every((n, i) => n === b[i]));
}

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
