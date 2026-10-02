# 构建

> 返回 [项目首页](../README.md)。

构建环境、离线构建、目录结构、如何扩充新动作。

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
├─ assets/                   素材母版（PNG 序列，342 帧 68 MB）
│   ├─ actions.json          动作清单
│   ├─ idle/  move/  rest/  click/  sit/
├─ audio/                    语音母版（Opus，38 条 3.4 MB）
├─ sfx/                      音效素材（尚未接入）
│   ├─ click/  talk/  move/  rest/  ui/  ambient/
│   └─ README.md
├─ dist/                     发布产物（gitignore）
│   └─ Mon3trPet/            解压即用的成品
│       ├─ Mon3trPet.exe     启动器，3.8 MB
│       ├─ assets/           转好的 WebP（342 帧 14 MB）
│       └─ audio/            语音副本
└─ desktop-pet/              Tauri 项目
    ├─ web/                  前端源码（开发时用，含素材副本）
    │   ├─ index.html        主界面（透明画布 + 菜单 + 设置面板）
    │   ├─ main.js           渲染 / 交互 / 点击穿透
    │   ├─ brain.js          行为状态机
    │   ├─ voice.js          语音播放与触发规则
    │   ├─ calendar.js       农历春节 / 节日判定
    │   ├─ weather.js        天气查询（Open-Meteo）与格式化
    │   ├─ bubble.js         对话气泡
    │   ├─ care.js           50 条随机关心语句（含时段标签）
    │   ├─ preview.html      素材预览页（浏览器打开）
    │   ├─ audio/            语音副本（开发用）
    │   └─ assets/           素材副本（开发用）
    ├─ web-dist/             打包用前端（**只有代码**，构建时生成）
    └─ src-tauri/            Rust 部分
        ├─ src/lib.rs        窗口、拖拽、配置、屏幕信息、素材服务
        ├─ src/main.rs       入口
        ├─ capabilities/     ACL 权限（事件监听必需，见[踩坑记录](TROUBLESHOOTING.md) 第 15 条）
        ├─ tauri.conf.json   窗口与前端资源位置
        └─ icons/            图标
```

> **`web/` 与 `web-dist/` 的区别**：`web/` 是开发用的完整目录（含素材
> 副本，浏览器里能直接开 `preview.html`）；`web-dist/` 是打包用的，
> **只含代码**（约 160 KB），构建时由 `build_release.ps1` 自动生成。
>
> `tauri.conf.json` 的 `frontendDist` 指向 `web-dist`，所以 exe 里
> **只有代码、没有素材** —— 这正是 exe 能从 73 MB 降到 3.8 MB 的原因。

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
- 母版为 PNG（`assets/`），**发布包用 WebP**（见下节）
- `sit.mov` 源文件在 `F:\SSV\m3\`，其余在 `M3\src\`

## 扩充新动作

1. 把新的 `.mov` 放入 `src/`（或 `F:\SSV\m3\` 并加进 `EXTRA_FILES`）
2. 在 `_work/export_png.py` 的 `ACTIONS` 列表里加一行
3. 运行 `_work/export_png.py` —— 会重新生成 `assets/` 与 `actions.json`
4. 在 `_work/build_assets.py` 的 `ACTIONS` 列表里加同名一项
5. 运行 `_work/build_release.ps1` —— 会自动转 WebP、编译、打包

**渲染代码无需改动**——动作是数据驱动的。

> 素材要放到 `desktop-pet/web/assets/` 供**开发时**预览，
> 但发布包用的是 `_work/build_assets.py` 转出的 WebP，
> 两者路径不同，不要混淆。

> 新增**持续性**动作（如「坐」）则需要在 `brain.js` 里加状态与
> enter/exit 方法，并在 `main.js` 挂菜单项——那是行为层的事，
> 不只是素材。

## 素材格式：为什么用 WebP 而不是 PNG

原始素材是 342 帧 PNG，共 **68 MB**（平均 200~300 KB/帧）。
对 906×704 的图来说这个体积异常大 —— PNG 对**逐帧动画**效率极低：
每帧独立压缩，帧间冗余完全没利用。

转成 WebP 后（`_work/build_assets.py`，质量 90）：

| 动作 | 帧数 | PNG | WebP | 比例 |
|---|---|---|---|---|
| idle | 81 | 17.22 MB | 3.52 MB | 20.4% |
| move | 41 | 8.61 MB | 1.77 MB | 20.6% |
| rest | 51 | 12.65 MB | 2.59 MB | 20.5% |
| click | 67 | 20.22 MB | 4.29 MB | 21.2% |
| sit | 101 | 9.43 MB | 2.28 MB | 24.2% |
| **合计** | **342** | **68.14 MB** | **14.45 MB** | **21.2%** |

**为什么是质量 90**：做过放大 3 倍的目视对比
（`_work/compare_webp.py` 生成 `docs/images/webp_compare.png`）：

| 质量 | 单帧 | 观感 |
|---|---|---|
| 无损 | 142 KB | 与 PNG 一致 |
| q95 | 58 KB | 肉眼无差别 |
| **q90** | **47 KB** | **肉眼无差别 <- 采用** |
| q85 | 40 KB | 开始出现色块（晶体边缘、发丝过渡） |

q90 是压缩率与画质的平衡点：再往下压画质开始可见地劣化，
往上则体积收益迅速变小。

> 语音无需再压：已是 Opus 48kbps，本身就很紧凑。

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
