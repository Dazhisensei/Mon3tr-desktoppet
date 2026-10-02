# 构建与打包

> 本文由原 README 拆出，内容未改动。
> 返回 [项目首页](../README.md)。

构建环境、离线构建、打包成安装程序、目录结构、如何扩充新动作。

---

## 运行

```
desktop-pet\src-tauri\target\debug\desktop-pet.exe
```

## 目录结构

```
M3/
├─ src/                      ProRes 母版（1500x1000，12bit，带 alpha）
│   ├─ 待机.mov  移动.mov  休息.mov  点击.mov
├─ assets/                   运行时资源（PNG 序列）
│   ├─ actions.json          动作清单（运行时读取）
│   ├─ idle/  move/  rest/  click/  sit/
├─ sfx/                      音效素材（尚未接入）
│   ├─ click/  talk/  move/  rest/  ui/  ambient/
│   └─ README.md
└─ desktop-pet/              Tauri 项目
    ├─ web/                  前端
    │   ├─ index.html        主界面（透明画布 + 菜单 + 设置面板）
    │   ├─ main.js           渲染 / 交互 / 点击穿透
    │   ├─ brain.js          行为状态机
    │   ├─ voice.js          语音播放与触发规则
    │   ├─ calendar.js       农历春节 / 节日判定
    │   ├─ weather.js        天气查询（Open-Meteo）与格式化
    │   ├─ bubble.js         对话气泡
    │   ├─ care.js           50 条随机关心语句（含时段标签）
    │   ├─ preview.html      素材预览页（浏览器打开）
    │   ├─ audio/            语音副本（audio.json + jp/ + zh/）
    │   └─ assets/           前端用的资源副本
    └─ src-tauri/            Rust 部分
        ├─ src/lib.rs        窗口、拖拽、配置、屏幕信息
        ├─ src/main.rs       入口
        ├─ capabilities/     ACL 权限（事件监听必需，见[踩坑记录](TROUBLESHOOTING.md) 第 15 条）
        ├─ tauri.conf.json   窗口与打包配置
        └─ icons/            图标
```

## 素材规格

| 动作 | 帧数 | 时长 | 说明 |
|---|---|---|---|
| idle（待机）| 81 | 2.70 s | 循环 |
| move（移动）| 41 | 1.37 s | 循环 |
| rest（休息）| 51 | 1.70 s | 循环 |
| click（点击）| 67 | 2.23 s | 单次，首尾姿态一致可无缝衔接 |
| sit（坐）| 101 | 3.37 s | 循环，持续性状态 |

- 统一画布 **906×704**，30 fps
- 裁切自原始 1500×1000，各动作共用同一裁切框，**相对位置关系保持不变**
- alpha 通道完整（约 84% 全透明，0.7~0.9% 半透明边缘）
- `sit.mov` 源文件在 `F:\SSV\m3\`，其余在 `M3\src\`

## 扩充新动作

1. 把新的 `.mov` 放入 `src/`（或 `F:\SSV\m3\` 并加进 `EXTRA_FILES`）
2. 在 `_work/export_png.py` 的 `ACTIONS` 列表里加一行
3. 运行 `_work/export_png.py` —— 会重新生成 `assets/` 与 `actions.json`
4. 把 `assets/` 整个复制到 `desktop-pet/web/assets/`
5. 重新编译

**渲染代码无需改动**——动作是数据驱动的。

> 新增**持续性**动作（如「坐」）则需要在 `brain.js` 里加状态与
> enter/exit 方法，并在 `main.js` 挂菜单项——那是行为层的事，
> 不只是素材。

## 关键实现说明

### 为什么 WebView2 数据目录要显式指定

原版 Tauri 默认把 WebView2 用户数据放在 `%LOCALAPPDATA%\<应用标识>`。
该路径在部分环境下不可写，会导致窗口创建失败：

```
Failed to setup app: 拒绝访问。(os error 5)
```

因此 `lib.rs` 中改为手动建窗，并用 `.data_directory()` 指定到
**exe 同目录的 `webview-data\`**。这是本项目能正常启动的关键。

### 日志

运行日志写在 **exe 同目录的 `pet.log`**，包含启动、建窗、panic 等信息，
便于排查闪退类问题。

### 配置文件

`pet-config.json`（exe 同目录）保存窗口位置与缩放：

```json
{ "x": 100, "y": 100, "scale": 0.35, "always_on_top": true }
```

## 构建环境

| 组件 | 版本 |
|---|---|
| Rust | 1.99.0 |
| cargo | 1.99.0 |
| MSVC | 14.44.35207 |
| Windows SDK | 10.0.26100.0 |
| WebView2 | 153.0.4234.48 |
| Node | 24.21.0 |

Rust 与 cargo 安装在 `_work/rust/`（非默认路径），编译时需设置：

```powershell
$env:CARGO_HOME = "E:\work\deskpet\M3\_work\rust\cargo"
$env:RUSTUP_HOME = "E:\work\deskpet\M3\_work\rust\rustup"
```

### 网络受限时的依赖拉取

cargo 内置 schannel，在受限环境下可能无法完成 TLS 握手
（`SEC_E_NO_CREDENTIALS`）。此时可启动本地中继：

```powershell
python _work\crates_relay.py
```

它监听 `127.0.0.1:8901`，通过上游代理访问 crates 索引。
`src-tauri/.cargo/config.toml` 已配置指向该中继。

### 完全离线构建（无网络出口时）

依赖已全部解压在 `_work/rust/cargo/registry/src/` 下，可以直接当
**目录源**使用，不需要索引、不需要中继：

```powershell
cargo build --offline --config _work\cargo-offline.toml `
  --manifest-path desktop-pet\src-tauri\Cargo.toml
```

配套脚本 `_work/make_checksums.py` 会从 `.crate` 归档补出 cargo 在
vendored 模式下必需的 `.cargo-checksum.json`（registry 的解压目录里
本身不含该文件，缺了会报
`failed to load checksum .cargo-checksum.json`）。

> 每拉取过新依赖后都要重跑一次 `make_checksums.py`，
> 否则新 crate 缺校验文件会导致离线构建失败。

## 打包

### 产物

| 文件 | 说明 |
|---|---|
| `dist\Mon3trPet_0.1.0_x64-setup.exe` | **NSIS 安装程序**（推荐分发）|
| `dist\Mon3trPet-0.1.0-win64.zip` | 免安装绿色版（解压即用）|

### 一条命令构建安装程序

```powershell
powershell -ExecutionPolicy Bypass -File _work\build_installer.ps1
```

脚本会自动设置 Rust 环境、检查 NSIS、离线编译、把产物复制到 `dist\`。

### 关键配置：`useLocalToolsDir`

`tauri.conf.json` 里设了：

```json
"bundle": { "useLocalToolsDir": true }
```

**这一项是必需的**。Tauri 默认把 NSIS 工具放在
`%LOCALAPPDATA%\tauri\NSIS`，而该路径在受限环境下**不可写**
（`WinError 5 拒绝访问`），会导致下载解包失败。

开启后 tauri-bundler 改用 `cargo metadata` 的 **target 目录**：

```
desktop-pet\src-tauri\target\.tauri\NSIS\
```

注意**不含 profile 层级**（不是 `target\release\.tauri`）——
放错层级会被忽略，Tauri 转而尝试联网下载。

### NSIS 版本必须匹配

Tauri 会校验 NSIS 的 SHA1，版本不符会重新下载（无网络则失败）。
当前 `tauri-bundler 2.10.1` 要求：

| 项 | 值 |
|---|---|
| NSIS | `nsis-3.11.zip` |
| SHA1 | `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D` |
| 必需文件 | `makensis.exe`、`Bin/makensis.exe`、`Plugins\x86-unicode\additional\nsis_tauri_utils.dll` |

`_work/fetch_nsis.py` 会按这些常量下载并**校验 SHA1**，
放到正确位置（`upstream 代理需在 127.0.0.1:7897`）。

### 布局说明：资源已内嵌

`frontendDist: ../web` 会把整个前端（含 68 MB 的 PNG 序列与
3.4 MB 语音）**打进 exe**，因此：

- 绿色版**只需一个 exe**，无需附带 `web/` 目录
- exe 体积约 74 MB，属正常

程序运行时在 **exe 同目录**生成 `pet-config.json` 与 `webview-data\`，
所以**必须放在可写位置**（不要放 `C:\Program Files\`）——
绿色版的使用说明里已明确写出这一点。
