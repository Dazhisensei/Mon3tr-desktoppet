# 打包免安装版
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File _work\build_release.ps1
#
# ## 它做了什么
#
#   1. 把前端**代码**复制到 desktop-pet\web-dist\（不含素材）
#   2. 把 PNG 序列转成 WebP，连同语音组装到 dist\Mon3trPet\
#   3. 离线编译 release
#   4. 把 exe 放进 dist\Mon3trPet\，打成 ZIP
#
# ## 为什么素材要外置
#
# 素材（342 帧 + 38 条语音）原本内嵌在 exe 里，使 exe 达 73 MB，
# 而程序本体只有 2 MB —— 97% 都是素材。现在素材放在 exe 同目录的
# assets\ 与 audio\ 下，exe 只内嵌 web-dist\（约 160 KB 代码）。
#
# 效果：exe 73.73 MB -> 3.76 MB，整包 71.58 MB -> 21.7 MB。
#
# 细节见 _work/build_assets.py 的说明。

$ErrorActionPreference = 'Stop'

$ROOT     = Split-Path -Parent $PSScriptRoot
$TAURI    = Join-Path $ROOT 'desktop-pet'
$WEB      = Join-Path $TAURI 'web'
$WEBDIST  = Join-Path $TAURI 'web-dist'
$OUT      = Join-Path $ROOT 'dist\Mon3trPet'
$ZIP      = Join-Path $ROOT 'dist\Mon3trPet-0.1.0-win64.zip'
$OFFLINE  = Join-Path $PSScriptRoot 'cargo-offline.toml'

$env:CARGO_HOME  = Join-Path $PSScriptRoot 'rust\cargo'
$env:RUSTUP_HOME = Join-Path $PSScriptRoot 'rust\rustup'
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"

$PY = if ($env:DSH_PYTHON) { $env:DSH_PYTHON } else { 'python' }

Write-Host '=== 1/4 生成 web-dist（只含代码）===' -ForegroundColor Cyan
if (Test-Path $WEBDIST) { Remove-Item $WEBDIST -Recurse -Force }
New-Item -ItemType Directory -Path $WEBDIST -Force | Out-Null
Get-ChildItem $WEB -File | Copy-Item -Destination $WEBDIST -Force
$codeSize = (Get-ChildItem $WEBDIST -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("  代码 {0:N0} KB（素材不在其中）" -f ($codeSize / 1KB))

Write-Host '=== 2/4 转换素材为 WebP 并组装 ===' -ForegroundColor Cyan
& $PY (Join-Path $PSScriptRoot 'build_assets.py')
if ($LASTEXITCODE -ne 0) { throw "素材转换失败" }

Write-Host '=== 3/4 编译 release ===' -ForegroundColor Cyan
# 要进到 src-tauri（Cargo.toml 所在），不是 desktop-pet
Push-Location (Join-Path $TAURI 'src-tauri')
try {
    & cargo build --release --offline --config $OFFLINE
    if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host '=== 4/4 组装并打包 ===' -ForegroundColor Cyan
Copy-Item (Join-Path $TAURI 'src-tauri\target\release\desktop-pet.exe') `
          (Join-Path $OUT 'Mon3trPet.exe') -Force

# 使用说明
$readme = Join-Path $ROOT 'dist\使用说明.md'
if (Test-Path $readme) { Copy-Item $readme (Join-Path $OUT '使用说明.md') -Force }

if (Test-Path $ZIP) { Remove-Item $ZIP -Force }
Compress-Archive -Path (Join-Path $OUT '*') -DestinationPath $ZIP -CompressionLevel Optimal

$exeMB    = (Get-Item (Join-Path $OUT 'Mon3trPet.exe')).Length / 1MB
$assetsMB = (Get-ChildItem (Join-Path $OUT 'assets') -Recurse -File |
             Measure-Object Length -Sum).Sum / 1MB
$audioMB  = (Get-ChildItem (Join-Path $OUT 'audio') -Recurse -File |
             Measure-Object Length -Sum).Sum / 1MB
$zipMB    = (Get-Item $ZIP).Length / 1MB

Write-Host ''
Write-Host '完成：' -ForegroundColor Green
Write-Host ("  exe         : {0,6:N2} MB" -f $exeMB)
Write-Host ("  assets/     : {0,6:N2} MB" -f $assetsMB)
Write-Host ("  audio/      : {0,6:N2} MB" -f $audioMB)
Write-Host ("  ----------------------")
Write-Host ("  解压后合计  : {0,6:N2} MB" -f ($exeMB + $assetsMB + $audioMB))
Write-Host ("  ZIP         : {0,6:N2} MB" -f $zipMB)
