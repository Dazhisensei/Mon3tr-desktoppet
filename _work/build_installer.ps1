# 构建 Windows 安装程序（NSIS）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File _work\build_installer.ps1
#
# ## 它做了什么
#
#   1. 设置 Rust 环境变量（本项目的 rust 装在 _work\rust\，非默认路径）
#   2. 确保 NSIS 工具链就位（缺失则走代理下载并校验 SHA1）
#   3. 用**离线**配置调用 cargo tauri build --bundles nsis
#   4. 把产物复制到 dist\
#
# ## 为什么离线
#
# 本机 cargo 的内置 schannel 在受控网络下无法完成 TLS 凭证交换
# （SEC_E_NO_CREDENTIALS），直连 crates.io 必失败。
# _work/cargo-offline.toml 把源指向已解压的 crate 源码目录，
# 并配合 _work/make_checksums.py 生成的 .cargo-checksum.json，
# 全程不联网即可编译。
#
# ## 如果需要联网（拉新依赖）
#
#   1. 挂上代理（默认 127.0.0.1:7897）
#   2. 启动中继：  python _work\crates_relay.py
#   3. 改用中继配置：把下面的 OFFLINE_TOML 换成 _work\cargo-relay.toml，
#      并去掉 --offline 参数
#
# 注意：PS 注释里不要出现反引号，它会被当作转义字符吞掉下一行。

$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot
$TAURI_DIR = Join-Path $ROOT 'desktop-pet'
$DIST = Join-Path $ROOT 'dist'
$OFFLINE_TOML = Join-Path $PSScriptRoot 'cargo-offline.toml'

Write-Host '=== 1/4 设置 Rust 环境 ===' -ForegroundColor Cyan
$env:CARGO_HOME = Join-Path $PSScriptRoot 'rust\cargo'
$env:RUSTUP_HOME = Join-Path $PSScriptRoot 'rust\rustup'
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "找不到 cargo，检查 $env:CARGO_HOME\bin"
}
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Warning 'cargo-tauri 未安装。联网后执行：'
    Write-Warning '  cargo install tauri-cli --version "^2" --locked --config _work\cargo-relay.toml'
    throw '缺少 cargo-tauri'
}

Write-Host '=== 2/4 确保 NSIS 工具链 ===' -ForegroundColor Cyan
$nsisDir = Join-Path $TAURI_DIR 'src-tauri\target\.tauri\NSIS'
if (-not (Test-Path (Join-Path $nsisDir 'makensis.exe'))) {
    Write-Host 'NSIS 未就位，尝试下载（需要代理）...'
    $py = if ($env:DSH_PYTHON) { $env:DSH_PYTHON } else { 'python' }
    & $py (Join-Path $PSScriptRoot 'fetch_nsis.py')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS 准备失败' }
} else {
    Write-Host "NSIS 已就位: $nsisDir"
}

Write-Host '=== 3/4 构建安装程序 ===' -ForegroundColor Cyan
Push-Location $TAURI_DIR
try {
    & cargo tauri build --bundles nsis -- --offline --config $OFFLINE_TOML
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build 失败 (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host '=== 4/4 复制产物到 dist ===' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $DIST -Force | Out-Null

# 安装程序文件名由 tauri.conf.json 的 productName + version 决定，
# 这里直接读配置拼出来 —— 改名后不必再手改本脚本。
$confPath = Join-Path $TAURI_DIR 'src-tauri\tauri.conf.json'
$conf = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$setupName = '{0}_{1}_x64-setup.exe' -f $conf.productName, $conf.version
Write-Host "产品名: $($conf.productName)  版本: $($conf.version)"

$setup = Join-Path $TAURI_DIR "src-tauri\target\release\bundle\nsis\$setupName"
if (-not (Test-Path $setup)) { throw "找不到安装程序: $setup" }
Copy-Item $setup $DIST -Force

$f = Get-Item (Join-Path $DIST $setupName)
Write-Host ''
Write-Host '完成：' -ForegroundColor Green
Write-Host ("  {0}  ({1:N2} MB)" -f $f.FullName, ($f.Length / 1MB))
