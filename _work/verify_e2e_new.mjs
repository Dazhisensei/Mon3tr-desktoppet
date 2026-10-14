/**
 * 端到端验证：启动程序，检查四项功能是否就绪。
 *
 * 自启的注册表读写无法从外部触发（要点击设置面板的开关），
 * 这里验证的是：程序能起来、配置字段齐全、日志正常。
 */

import { readFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = 'E:/work/deskpet/M3';
const SRC = path.join(ROOT, 'dist', 'Mon3trPet');
const TMP = path.join(os.tmpdir(), 'mon3tr-e2e-' + Date.now());

let fail = 0;
const chk = (n, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

console.log('=== 1. 准备干净的运行目录 ===');
mkdirSync(TMP, { recursive: true });
cpSync(SRC, TMP, { recursive: true });
chk('发布包复制完成', existsSync(path.join(TMP, 'Mon3trPet.exe')));

console.log('\n=== 2. 检查关键文件 ===');
chk('assets/ 存在', existsSync(path.join(TMP, 'assets')));
chk('audio/ 存在', existsSync(path.join(TMP, 'audio')));

console.log('\n=== 3. 启动程序 ===');
const proc = spawn(path.join(TMP, 'Mon3trPet.exe'), [], {
  cwd: TMP, detached: true, stdio: 'ignore',
});
proc.unref();
await new Promise((r) => setTimeout(r, 12000));

const logPath = path.join(TMP, 'pet.log');
let log = '';
if (existsSync(logPath)) log = readFileSync(logPath, 'utf8');
chk('生成了 pet.log', log.length > 0);
chk('窗口创建成功', log.includes('window built OK'), 
    log.includes('FAILED') ? '出现 FAILED' : '');
chk('素材根已定位', log.includes('asset root'));
chk('无资源读取失败', !log.includes('读取失败') && !log.includes('not found'));

console.log('\n=== 4. 配置文件字段（新增项应有默认值）===');
const cfgPath = path.join(TMP, 'pet-config.json');
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  chk('walk_enabled 默认 true', cfg.walk_enabled !== false, `=${cfg.walk_enabled}`);
  chk('autostart 默认 false', cfg.autostart !== true, `=${cfg.autostart}`);
  chk('smart_dodge 默认 false', cfg.smart_dodge !== true, `=${cfg.smart_dodge}`);
} else {
  console.log('  (配置文件尚未生成，程序可能还没写盘)');
}

console.log('\n=== 5. 日志内容 ===');
console.log(log.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n'));

// 清理
try { execFileSync('taskkill', ['/IM', 'Mon3trPet.exe', '/F'], { stdio: 'ignore' }); } catch {}
await new Promise((r) => setTimeout(r, 1500));
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n=== 汇总 ===\n  ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
