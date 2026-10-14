//! 桌宠核心逻辑
//!
//! 1. 透明无边框窗口，置顶且不出现在任务栏。
//! 2. 手动实现窗口拖拽，并区分「拖拽」与「单击」。
//! 3. 动作数据驱动，新增动作只需改 actions.json + 放入帧目录。
//!
//! 诊断：关键步骤写入 exe 同目录的 pet.log。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const DRAG_THRESHOLD: f64 = 5.0;

/// 缩放范围（与前端设置里的滑条一致，见 web/index.html 的 #setScale）。
///
/// 下限 20%：再小角色就只剩几个像素，点击穿透也难命中。
/// 上限 100%：素材原尺寸 906×704，比这更大就开始明显糊了。
const MIN_SCALE: f64 = 0.20;
const MAX_SCALE: f64 = 1.00;

fn log_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("pet.log");
            if OpenOptions::new().create(true).append(true).open(&p).is_ok() {
                return p;
            }
        }
    }
    std::env::temp_dir().join("pet.log")
}

fn log(msg: &str) {
    eprintln!("[pet] {msg}");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{msg}");
    }
}

/// 拖拽状态。
///
/// 只用于区分「点击」与「拖动」—— 窗口位置已交给系统原生拖动，
/// 因此不再需要记录窗口起始坐标。
#[derive(Default)]
struct DragState {
    active: bool,
    start_cursor: (f64, f64),
    moved: f64,
}

/// 打开设置面板前的窗口几何，用于关闭时还原。
#[derive(Clone, Copy)]
struct UiBackup {
    w: f64,
    h: f64,
    x: i32,
    y: i32,
}

struct AppState {
    drag: Mutex<DragState>,
    /// 设置面板占用窗口期间的备份
    ui_backup: Mutex<Option<UiBackup>>,
}

/* ---------- 设置面板（复用主窗口） ---------- */

/// 进入设置界面：把主窗口临时放大到能容纳设置面板的尺寸。
///
/// ## 为什么复用主窗口而不是新开一个窗口
///
/// 曾尝试创建独立的设置窗口，但 WebView2 对「同一用户数据目录下创建
/// 多个 webview 环境」很敏感：实测设置窗口要么创建失败
/// （`os error 5`），要么出现**空白且无法关闭**的僵尸窗口。
///
/// 主窗口的渲染链路已经验证可用，因此设置改为**主窗口内的面板**：
/// 打开时把窗口临时放大、铺满设置界面，关闭时还原。
/// 这条路不依赖第二次 webview 创建，可靠性高得多。
#[tauri::command]
fn enter_settings_ui(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;

    // 记下原几何 —— **全部换算成逻辑像素**。
    //
    // `outer_position` / `outer_size` 返回的是**物理**像素，
    // 而还原时用的是 `LogicalPosition`。若这里存物理值、还原时
    // 按逻辑解释，在 125%/150% 缩放下位置会偏到 (x/1.25, y/1.25)，
    // 原本在屏幕右下角的窗口会跑到别处、甚至**移出屏幕**
    // —— 表现为「关闭设置后桌宠消失，但进程还在」。
    //
    // 早期版本这里 w/h 除了 sf 而 x/y 没有，是漏改。
    {
        let mut b = state.ui_backup.lock().map_err(|e| e.to_string())?;
        *b = Some(UiBackup {
            w: size.width as f64 / sf,
            h: size.height as f64 / sf,
            x: (pos.x as f64 / sf).round() as i32,
            y: (pos.y as f64 / sf).round() as i32,
        });
    }

    let w = width.max(320.0);
    let h = height.max(320.0);

    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;

    // 放大后可能超出屏幕，夹回工作区内
    if let Ok(Some(monitor)) = window.current_monitor() {
        let wa = monitor.work_area();
        let to_logical = |v: i32| -> f64 { v as f64 / sf };
        let work_x = to_logical(wa.position.x);
        let work_y = to_logical(wa.position.y);
        let work_w = to_logical(wa.size.width as i32);
        let work_h = to_logical(wa.size.height as i32);
        let cur = window.outer_position().map_err(|e| e.to_string())?;
        let cx = to_logical(cur.x);
        let cy = to_logical(cur.y);
        let nx = cx.min(work_x + work_w - w).max(work_x);
        let ny = cy.min(work_y + work_h - h).max(work_y);
        let _ = window.set_position(tauri::LogicalPosition::new(nx, ny));
    }

    log(&format!("enter settings ui: {w}x{h}"));
    Ok(())
}

/// 退出设置界面：还原窗口尺寸与位置。
#[tauri::command]
fn exit_settings_ui(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let backup = {
        let mut b = state.ui_backup.lock().map_err(|e| e.to_string())?;
        b.take()
    };

    if let Some(bk) = backup {
        // 面板期间可能改过缩放，此时按配置里的最新缩放还原，
        // 否则会把用户刚选的尺寸覆盖回旧值。
        const ART_W: f64 = 906.0;
        const ART_H: f64 = 704.0;
        let cfg_now = load_config();
        let s = cfg_now.scale.clamp(MIN_SCALE, MAX_SCALE);
        let w = ART_W * s;
        let h = ART_H * s;

        // 若缩放没变，就还原成原来的尺寸（可能是用户手动改过的状态）
        let restore_w = if (w - bk.w).abs() < 0.5 { bk.w } else { w };
        let restore_h = if (h - bk.h).abs() < 0.5 { bk.h } else { h };

        window
            .set_size(tauri::LogicalSize::new(restore_w, restore_h))
            .map_err(|e| e.to_string())?;

        // 还原位置前先夹回工作区。
        //
        // 即便坐标单位已经统一，仍可能因为「面板期间屏幕分辨率变化」
        // 「显示器插拔」「多屏切换」等原因，让原位置落在当前工作区之外。
        // 那种情况下窗口会**跑到屏幕外**，用户看到的就是
        // 「桌宠消失了，但任务管理器里进程还在」。
        //
        // 这里做一次兜底：把位置约束到当前显示器工作区内。
        let sf = window.scale_factor().unwrap_or(1.0);
        let mut px = bk.x as f64;
        let mut py = bk.y as f64;

        if let Ok(Some(monitor)) = window.current_monitor() {
            let wa = monitor.work_area();
            let to_logical = |v: i32| -> f64 { v as f64 / sf };
            let work_x = to_logical(wa.position.x);
            let work_y = to_logical(wa.position.y);
            let work_w = to_logical(wa.size.width as i32);
            let work_h = to_logical(wa.size.height as i32);

            let min_x = work_x;
            let max_x = work_x + work_w - restore_w;
            let min_y = work_y;
            let max_y = work_y + work_h - restore_h;

            let cx = px.max(min_x).min(max_x.max(min_x));
            let cy = py.max(min_y).min(max_y.max(min_y));

            if (cx - px).abs() > 1.0 || (cy - py).abs() > 1.0 {
                log(&format!(
                    "exit settings: 位置越界，夹回工作区 ({px:.0},{py:.0}) -> ({cx:.0},{cy:.0})"
                ));
            }
            px = cx;
            py = cy;
        }

        let _ = window.set_position(tauri::LogicalPosition::new(px, py));

        // 还原后把位置写回配置（与正常拖动一致）
        //
        // 注意写的是**夹取后**的坐标：否则下次启动仍会回到屏幕外。
        let mut cfg = load_config();
        cfg.x = px.round() as i32;
        cfg.y = py.round() as i32;
        save_config(&cfg);

        // **必须在这里补发缩放事件**。
        //
        // 面板打开期间用户拖过尺寸滑条时，`set_scale` 走的是「延迟」分支：
        // 只写了配置，**没有广播** `settings:scale`。真正生效是在这行
        // `set_size` —— 也就是现在。若此时不补发，前端的 `userScale`
        // 会一直停在旧值，画布按旧的大尺寸绘制，而窗口已经变小，
        // 于是画布从上方溢出被裁 —— 表现为「只有窗口缩小、桌宠头部被截断」。
        //
        // 放在 set_size 之后发：确保前端收到事件时窗口尺寸已是最终值，
        // fitStage 读到的 innerWidth/innerHeight 才是正确的。
        let _ = app.emit("settings:scale", s);

        log(&format!("exit settings ui -> {restore_w}x{restore_h} (scale {s})"));
    }
    Ok(())
}

#[tauri::command]
fn get_window_pos(window: WebviewWindow) -> Result<(i32, i32), String> {
    let p = window.outer_position().map_err(|e| e.to_string())?;
    Ok((p.x, p.y))
}

/// 开始拖拽 —— 交给**操作系统**处理。
///
/// ## 为什么不再自己算位移
///
/// 早期实现是前端 `mousemove` -> IPC -> `set_position` 手动模拟：
///
///     window.addEventListener('mousemove', e =>
///       invoke('drag_move', { x: e.screenX, y: e.screenY }));
///
/// 三个问题叠加，表现为用户反馈的「拖动不跟手、会漂移」：
///
///   1. **鼠标移出窗口就收不到事件**。窗口追着鼠标跑，鼠标移动快于
///      窗口跟进时指针就到了窗口外，`mousemove` 立刻停止触发，
///      窗口卡住；指针回来才继续 —— 观感就是一顿一顿地漂。
///   2. 每次移动都跨进程 IPC，受 WebView 事件频率限制，
///      低于鼠标实际采样率。
///   3. 没有 pointer capture，指针离开元素后事件就断了。
///
/// 现在改为 `start_dragging()`：tao 在 Windows 上走的是
/// `handle_os_dragging(HTCAPTION)` —— 向窗口投递 `WM_NCLBUTTONDOWN`，
/// 由系统进入**原生拖动循环**。位置由 OS 直接更新，
/// 不经过 JS、不经过 IPC，因此无漂移、无延迟。
///
/// ## 为什么这次可以用原生方案
///
/// README 记录过「原生右键菜单」失败：`TrackPopupMenu` 是**同步阻塞**的，
/// 会冻住消息循环。而 `handle_os_dragging` 用的是 `PostMessageW`
/// （投递消息、立即返回），**不阻塞**，因此没有那个问题。
///
/// `ReleaseCapture()` 由 tao 内部调用，使后续 `WM_NCLBUTTONDOWN` 生效；
/// 拖动期间窗口会临时获得鼠标捕获 —— 这正是「指针移出窗口仍能继续拖」
/// 的保证，也是修复漂移的关键。
#[tauri::command]
fn drag_start(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    // 记录起点**仅用于** drag_end 判断「这是点击还是拖动」。
    // 位置更新已交给系统，不再需要记录 start_window。
    {
        let mut d = state.drag.lock().map_err(|e| e.to_string())?;
        d.active = true;
        d.start_cursor = (x, y);
        d.moved = 0.0;
    }

    window.start_dragging().map_err(|e| {
        log(&format!("start_dragging failed: {e}"));
        e.to_string()
    })
}

/// 拖动过程中前端上报位置（**仅用于区分点击/拖动**）。
///
/// 不再移动窗口 —— 位置由系统原生拖动循环负责。
/// 保留这个命令是为了不改前端调用点，同时让「拖动距离超过阈值
/// 就不算点击」这个判定继续有效。
#[tauri::command]
fn drag_move(
    _window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    let mut d = state.drag.lock().map_err(|e| e.to_string())?;
    if !d.active {
        return Ok(false);
    }
    let dx = x - d.start_cursor.0;
    let dy = y - d.start_cursor.1;
    d.moved = (dx * dx + dy * dy).sqrt();
    Ok(true)
}

#[tauri::command]
fn drag_end(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut d = state.drag.lock().map_err(|e| e.to_string())?;
    let was_click = d.active && d.moved < DRAG_THRESHOLD;
    d.active = false;
    Ok(was_click)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/* ---------- 屏幕与行走 ---------- */

#[derive(serde::Serialize)]
struct ScreenInfo {
    /// 当前显示器工作区（不含任务栏）左上角
    work_x: i32,
    work_y: i32,
    work_w: i32,
    work_h: i32,
    /// 窗口自身位置与尺寸
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
}

/// 获取屏幕工作区与窗口几何信息（供前端做行走边界判断）。
///
/// **全部返回逻辑像素**，与 move_window 的坐标语义一致。
/// 工作区在部分平台上以物理像素给出，这里按 scale_factor 换算，
/// 否则在 125% 等缩放下，前端算出的目标位置会与窗口实际坐标系错位，
/// 表现为行走时原地踏步。
#[tauri::command]
fn get_screen_info(window: WebviewWindow) -> Result<ScreenInfo, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;

    let sf = monitor.scale_factor();
    let wa = monitor.work_area();
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    // 统一换算为逻辑像素
    let to_logical = |v: i32| -> i32 { (v as f64 / sf).round() as i32 };

    Ok(ScreenInfo {
        work_x: to_logical(wa.position.x),
        work_y: to_logical(wa.position.y),
        work_w: to_logical(wa.size.width as i32),
        work_h: to_logical(wa.size.height as i32),
        win_x: to_logical(pos.x),
        win_y: to_logical(pos.y),
        win_w: to_logical(size.width as i32),
        win_h: to_logical(size.height as i32),
    })
}

/* ---------- 点击穿透 ---------- */

/// 开关点击穿透。
///
/// 开启后窗口不再接收鼠标事件，点击会落到桌面/下层窗口上。
/// 前端根据「光标处的像素是否透明」自动切换，使角色可点、
/// 空白处穿透。
#[tauri::command]
fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct CursorInfo {
    /// 光标相对窗口左上角的**归一化**位置（0~1）。
    /// 用比例而非像素，前端可直接乘以画布尺寸，免受 DPI 影响。
    /// 若光标在窗口外，则落在区间之外。
    rel_x: f64,
    rel_y: f64,
    /// 光标是否在窗口范围内
    inside: bool,
}

/// 获取光标相对窗口的位置（供点击穿透的透明检测使用）。
///
/// 之所以需要后端提供：一旦开启穿透，webview 就收不到 mousemove，
/// 前端无法自行知道光标位置，必须由原生侧查询。
#[tauri::command]
fn get_cursor_rel(window: WebviewWindow) -> Result<CursorInfo, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    let w = size.width as f64;
    let h = size.height as f64;
    if w <= 0.0 || h <= 0.0 {
        return Ok(CursorInfo { rel_x: -1.0, rel_y: -1.0, inside: false });
    }

    // cursor_position 与 outer_position 都是物理像素，直接相减即可
    let rx = (cursor.x - pos.x as f64) / w;
    let ry = (cursor.y - pos.y as f64) / h;
    let inside = (0.0..1.0).contains(&rx) && (0.0..1.0).contains(&ry);

    Ok(CursorInfo { rel_x: rx, rel_y: ry, inside })
}

/// 把窗口移动到指定坐标（行走时调用）。
///
/// 坐标语义：**逻辑像素**。
/// 前端用 get_screen_info 拿到的也是逻辑像素（见该函数的换算说明），
/// 两边统一，避免 DPI 缩放下出现位移被抵消（原地踏步）。
#[tauri::command]
fn move_window(window: WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    window
        .set_position(tauri::LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| {
            log(&format!("move_window({x},{y}) failed: {e}"));
            e.to_string()
        })
}

/* ---------- 配置持久化（记住窗口位置等） ---------- */

#[derive(serde::Serialize, serde::Deserialize)]
struct PetConfig {
    x: i32,
    y: i32,
    /// 缩放比例：素材高度 704 对应窗口高度的倍率。
    scale: f64,
    always_on_top: bool,
    /// 点击穿透：透明处是否让点击落到桌面
    #[serde(default = "default_true")]
    click_through: bool,
    /// 音量 0~100
    #[serde(default = "default_volume")]
    volume: u8,
    /// 语音语言："zh" | "jp"
    #[serde(default = "default_lang")]
    voice_lang: String,
    /// 用户生日（月/日）。为 None 表示未设置，生日语音不会触发。
    /// 只存月日、不含年份——生日每年重复，年份没有意义。
    #[serde(default)]
    birthday: Option<Birthday>,
    /// 所在地区（最多 3 个）。存名字与经纬度，查询天气时直接用坐标，
    /// 不必每次重新做地理编码。
    #[serde(default)]
    weather_cities: Vec<City>,
    /// 是否允许桌宠**自主走动**。
    ///
    /// 关闭后桌宠不再在屏幕上位移，但待机/休息/互动/语音全部照常。
    /// 与「暂停自主活动」不同：那个是全部自主行为停摆。
    #[serde(default = "default_true")]
    walk_enabled: bool,
    /// 开机自动启动。默认关闭（绿色版不该擅自改用户的开机项）。
    #[serde(default)]
    autostart: bool,
    /// 智能避让：有其他程序在前台时自动靠边坐下，回到桌面再站起来。
    #[serde(default)]
    smart_dodge: bool,
}

/// 已配置的城市。
///
/// `latitude` / `longitude` 来自设置时的地理编码结果并**持久化**，
/// 这样每次查天气只需一个请求（否则每个城市都要先解析一次地名）。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct City {
    /// 显示用名称（中文）
    name: String,
    latitude: f64,
    longitude: f64,
    /// 省/州，用于区分同名地点
    #[serde(default)]
    admin1: String,
    #[serde(default)]
    country: String,
}

/// 最多可配置的城市数。
const MAX_CITIES: usize = 3;

/// 生日（公历月/日）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct Birthday {
    month: u8,
    day: u8,
}

impl Birthday {
    /// 是否是一个合法的公历月日。
    fn is_valid(&self) -> bool {
        if self.month < 1 || self.month > 12 || self.day < 1 {
            return false;
        }
        // 允许 2/29（闰年才真正生效），用闰年上限放宽校验
        let max = match self.month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => 29,
            _ => return false,
        };
        self.day <= max
    }
}

fn default_true() -> bool {
    true
}
fn default_volume() -> u8 {
    70
}
fn default_lang() -> String {
    "zh".to_string()
}

impl Default for PetConfig {
    fn default() -> Self {
        Self {
            x: 100,
            y: 100,
            scale: 0.35,
            always_on_top: true,
            click_through: true,
            volume: default_volume(),
            voice_lang: default_lang(),
            birthday: None,
            weather_cities: Vec::new(),
            walk_enabled: true,
            autostart: false,
            smart_dodge: false,
        }
    }
}

/// 配置文件路径：exe 同目录，便于用户直接查看与修改。
fn config_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("pet-config.json"))
}

fn load_config() -> PetConfig {
    let Some(p) = config_path() else {
        return PetConfig::default();
    };
    // 按**字节**读，而不是 read_to_string。
    //
    // pet-config.json 里含中文（城市名、省份），用户很可能用记事本
    // 手工编辑它，而记事本的「ANSI」保存会写出 GBK 字节。
    // `read_to_string` 遇到非 UTF-8 会整体失败，配置**静默回落到默认值**
    // —— 表现为「窗口位置、缩放、语音语言、天气城市全丢了」，
    // 且日志里只有一行 save 记录，很难联想到编码。
    //
    // 因此这里自己解码：能解成 UTF-8 就用，否则退回 GBK（中文 Windows
    // 的 ANSI 码页）。都不行才用 lossy 兜底，保证**永远能读出一份配置**。
    let Ok(bytes) = std::fs::read(&p) else {
        return PetConfig::default();
    };

    if let Ok(s) = std::str::from_utf8(&bytes) {
        if let Ok(cfg) = serde_json::from_str(s) {
            return cfg;
        }
    }

    let s = String::from_utf8_lossy(&bytes);
    match serde_json::from_str(&s) {
        Ok(cfg) => {
            log("config: file is not UTF-8, decoded lossily");
            cfg
        }
        Err(e) => {
            log(&format!("config parse failed: {e}"));
            PetConfig::default()
        }
    }
}

fn save_config(cfg: &PetConfig) {
    let Some(p) = config_path() else { return };
    let Ok(s) = serde_json::to_string_pretty(cfg) else {
        return;
    };
    // 显式以 UTF-8 字节写入（serde_json 产出的 String 本身就是 UTF-8，
    // 这里取 as_bytes 是为了避免任何平台默认编码的介入）。
    //
    // 先写临时文件再改名：配置在每次移动窗口/改设置时都会重写，
    // 直接覆盖时若进程被杀（本项目频繁重启调试），
    // 磁盘上会留下**半截 JSON**，下次启动就整体回落到默认值。
    // 改名在同一分区上是原子操作，要么旧文件、要么新文件。
    let tmp = p.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, s.as_bytes()) {
        log(&format!("save_config write failed: {e}"));
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &p) {
        // 改名失败（如被占用）时退回直接写，至少让配置生效
        log(&format!("save_config rename failed: {e}, falling back"));
        if let Err(e2) = std::fs::write(&p, s.as_bytes()) {
            log(&format!("save_config failed: {e2}"));
        }
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 读取当前配置（前端可用于初始化界面状态）。
#[tauri::command]
fn get_config() -> PetConfig {
    load_config()
}

/* ---------- 设置项 ---------- */

/// 设置音量（0~100）并广播给所有窗口。
#[tauri::command]
fn set_volume(app: tauri::AppHandle, value: u8) -> Result<(), String> {
    let v = value.min(100);
    let mut cfg = load_config();
    cfg.volume = v;
    save_config(&cfg);
    let _ = app.emit("settings:volume", v);
    Ok(())
}

/// 设置语音语言（"zh" | "jp"）并广播。
#[tauri::command]
fn set_voice_lang(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let l = if lang == "jp" { "jp" } else { "zh" }.to_string();
    let mut cfg = load_config();
    cfg.voice_lang = l.clone();
    save_config(&cfg);
    let _ = app.emit("settings:voice-lang", l);
    Ok(())
}

/// 设置点击穿透开关，并广播（主窗口与设置窗口需要同步显示）。
#[tauri::command]
fn set_passthrough_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.click_through = enabled;
    save_config(&cfg);
    let _ = app.emit("settings:passthrough", enabled);
    Ok(())
}

/// 设置生日（月/日）。
///
/// `month` / `day` 传 0 表示**清除**生日（改为未设置）。
/// 前端只允许选合法日期，这里仍做一次校验，避免脏数据写进配置。
#[tauri::command]
fn set_birthday(app: tauri::AppHandle, month: u8, day: u8) -> Result<(), String> {
    let mut cfg = load_config();

    if month == 0 || day == 0 {
        cfg.birthday = None;
    } else {
        let b = Birthday { month, day };
        if !b.is_valid() {
            return Err(format!("非法日期: {month} 月 {day} 日"));
        }
        cfg.birthday = Some(b);
    }

    save_config(&cfg);
    let _ = app.emit("settings:birthday", cfg.birthday);
    Ok(())
}

/// 让主窗口试听一条语音（设置面板用）。
///
/// 音频播放必须在持有 DOM 的主窗口里做，设置面板只是同一窗口的一块
/// 覆盖层，因此这里仅转成事件广播，由 main.js 播放。
#[tauri::command]
fn preview_voice(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app.emit("settings:preview-voice", ());
    Ok(())
}

/* ---------- 自主走动开关 ---------- */

/// 开关桌宠的**自主走动**并持久化。
///
/// 关闭后不在屏幕上位移，但待机、休息、点击互动、语音、
/// 天气、关心语句全部照常 —— 语义比「暂停自主活动」精确得多。
#[tauri::command]
fn set_walk_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.walk_enabled = enabled;
    save_config(&cfg);
    log(&format!("set_walk_enabled = {enabled}"));
    // 广播给主窗口：关闭时它需要立刻切回待机
    let _ = app.emit("settings:walk-enabled", enabled);
    Ok(())
}

/// 开关「智能避让」并持久化。
///
/// 开启后前端会轮询前台窗口：有其他程序在前台时靠边坐下，
/// 回到桌面再站起来。默认关闭 —— 它会移动桌宠，
/// 应当是用户显式开启的行为。
#[tauri::command]
fn set_smart_dodge(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.smart_dodge = enabled;
    save_config(&cfg);
    log(&format!("set_smart_dodge = {enabled}"));
    let _ = app.emit("settings:smart-dodge", enabled);
    Ok(())
}

/* ---------- 开机自启 ---------- */

/// 注册表中自启项的键名。
///
/// **必须带 hive 前缀 `HKCU\`**：`reg.exe` 要求完整路径，
/// 只写 `Software\...` 会报 `ERROR: Invalid key name`。
/// （写注册表 API 时可以省略 hive，但命令行工具不行 ——
/// 这里踩过一次，实测确认。）
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_NAME: &str = "Mon3trPet";

/// 设置开机自启（写 HKCU 的 Run 键）。
///
/// ## 为什么用 HKCU\...\Run 而不是其他方案
///
/// | 方案 | 取舍 |
/// |---|---|
/// | **HKCU Run 键**（选用）| 无需管理员权限；用户可在「任务管理器 → 启动」里自行禁用；失败会明确报错 |
/// | 启动文件夹快捷方式 | 需要创建 .lnk（依赖 COM 或额外 crate），本环境不好实现 |
/// | 任务计划程序 | 功能最强（可延迟启动），但复杂度高得多，对桌宠是过度设计 |
///
/// 路径要**加引号**：安装目录可能含空格，不加引号会被系统按空格拆开。
///
/// 失败时返回 Err 而不是静默 —— 用户点了开关却没生效是最难排查的
/// （README 第 15 条：6 个设置项曾因 ACL 静默失效）。
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.to_string_lossy().to_string();

    let mut cfg = load_config();
    cfg.autostart = enabled;
    save_config(&cfg);

    #[cfg(windows)]
    {
        use std::process::Command;
        // 用 reg.exe 而非 windows crate：写注册表要引入 Win32_System_Registry
        // feature 与一堆 unsafe，而 reg.exe 是系统自带、行为稳定。
        let quoted = format!("\"{path}\"");
        let result = if enabled {
            Command::new("reg")
                .args(["add", AUTOSTART_KEY, "/v", AUTOSTART_NAME,
                       "/t", "REG_SZ", "/d", &quoted, "/f"])
                .output()
        } else {
            Command::new("reg")
                .args(["delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"])
                .output()
        };

        match result {
            Ok(out) if out.status.success() => {
                log(&format!("autostart = {enabled} ({quoted})"));
                let _ = app.emit("settings:autostart", enabled);
                Ok(())
            }
            Ok(out) => {
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                // 关闭时若本来就没这一项，reg 会报「找不到」，属正常
                if !enabled && msg.contains("unable to find") {
                    let _ = app.emit("settings:autostart", false);
                    return Ok(());
                }
                log(&format!("autostart 失败: {msg}"));
                Err(format!("写入开机启动项失败：{msg}"))
            }
            Err(e) => {
                log(&format!("autostart 调用 reg 失败: {e}"));
                Err(format!("无法调用系统命令：{e}"))
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅支持 Windows".to_string())
    }
}

/// 查询当前是否已设置开机自启（以**注册表实际状态**为准，不信配置）。
///
/// 用户可能通过任务管理器禁用了启动项，此时配置里仍是 true，
/// 但实际已不自启 —— 界面要反映真实情况。
#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("reg")
            .args(["query", AUTOSTART_KEY, "/v", AUTOSTART_NAME])
            .output()
        {
            return out.status.success();
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/* ---------- 智能避让：前台窗口检测 ---------- */

/// 前台窗口信息，供「智能避让」判断是否该躲开。
#[derive(serde::Serialize)]
struct ForegroundInfo {
    /// 前台窗口是否是「真正的应用程序」。
    ///
    /// 桌面、任务栏、以及我们自己的窗口**都不算** —— 回到桌面时
    /// 桌宠应当站起来活动，否则它会永远躲在角落。
    is_app: bool,
    /// 前台窗口是否**最大化或全屏**（占据整个工作区）。
    ///
    /// 用户在全屏看视频/打游戏时，桌宠躲开更合适。
    is_maximized: bool,
}

/// 检测当前前台窗口。
///
/// ## 为什么不能用 `window.is_focused()`
///
/// 桌宠窗口是 `skip_taskbar + always_on_top + decorations(false)` 的
/// **永不聚焦**窗口：用户点它也不会持久获得焦点。因此「我们自己是否
/// 聚焦」这个信号对本功能毫无意义，必须查**系统级**的前台窗口。
///
/// ## 必须排除的「伪前台」
///
/// 用户按下 Win+D 或点桌面时，前台窗口会变成桌面/任务栏窗口。
/// 若不排除，会被误判成「有程序在前台」，桌宠就永远不站起来。
///
/// | 类名 | 是什么 |
/// |---|---|
/// | `Progman` | 程序管理器（桌面的宿主）|
/// | `WorkerW` | 桌面图标层（Win10+ 常见）|
/// | `Shell_TrayWnd` | 任务栏 |
/// | `Shell_SecondaryTrayWnd` | 副屏任务栏 |
/// | `Windows.UI.Core.CoreWindow` | Win10 开始菜单/搜索 |
///
/// ## 全屏判定的取舍
///
/// 用「前台窗口矩形 == 显示器工作区」而不是「== 整个屏幕」：
/// 后者在任务栏可见时永远不成立，前者能正确识别最大化窗口。
#[tauri::command]
fn get_foreground_info() -> ForegroundInfo {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, IsZoomed,
        };

        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_invalid() {
                // 没有前台窗口（切换瞬间）-> 当作桌面，让桌宠活动
                return ForegroundInfo { is_app: false, is_maximized: false };
            }

            // 类名
            let mut buf = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut buf);
            let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);

            const SHELL_CLASSES: [&str; 6] = [
                "Progman",
                "WorkerW",
                "Shell_TrayWnd",
                "Shell_SecondaryTrayWnd",
                "Windows.UI.Core.CoreWindow",
                "SysShadow",
            ];
            // 也排除我们自己的窗口（类名由 Tauri 生成，含应用标识）
            let is_shell = SHELL_CLASSES.iter().any(|c| class.eq_ignore_ascii_case(c));
            let is_ours = class.contains("Mon3trPet") || class.contains("tauri");

            // 最大化：IsZoomed 直接问系统，比比矩形可靠
            let is_maximized = IsZoomed(hwnd).as_bool();

            ForegroundInfo {
                is_app: !is_shell && !is_ours,
                is_maximized,
            }
        }
    }

    #[cfg(not(windows))]
    {
        ForegroundInfo { is_app: false, is_maximized: false }
    }
}

/* ---------- 所在地区（天气） ---------- */

/// 整体替换城市列表。
///
/// 设置面板的增删改最终都走这里，避免为「加一个 / 删一个」各写一个命令。
/// 超过 `MAX_CITIES` 直接报错而不是静默截断——让用户知道为什么加不上。
#[tauri::command]
fn set_weather_cities(app: tauri::AppHandle, cities: Vec<City>) -> Result<Vec<City>, String> {
    if cities.len() > MAX_CITIES {
        return Err(format!("最多只能添加 {MAX_CITIES} 个地区"));
    }

    let mut cfg = load_config();
    cfg.weather_cities = cities;
    save_config(&cfg);

    let _ = app.emit("settings:cities", &cfg.weather_cities);
    Ok(cfg.weather_cities.clone())
}

/// 读取已配置的城市（前端启动时用）。
#[tauri::command]
fn get_weather_cities() -> Vec<City> {
    load_config().weather_cities
}

/// 把桌宠移到屏幕底部居中。
///
/// 放在 Rust 侧是因为设置面板也需要这个操作，
/// 而面板逻辑不便直接操作窗口位置。
#[tauri::command]
fn move_pet_to_bottom(app: tauri::AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    let monitor = pet
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;

    let sf = monitor.scale_factor();
    let wa = monitor.work_area();
    let size = pet.outer_size().map_err(|e| e.to_string())?;

    // 转成逻辑像素后计算，再交回 LogicalPosition
    let to_logical = |v: i32| -> f64 { v as f64 / sf };
    let work_w = to_logical(wa.size.width as i32);
    let work_h = to_logical(wa.size.height as i32);
    let work_x = to_logical(wa.position.x);
    let work_y = to_logical(wa.position.y);
    let win_w = to_logical(size.width as i32);
    let win_h = to_logical(size.height as i32);

    let x = work_x + ((work_w - win_w) / 2.0).round();
    let y = work_y + (work_h - win_h);

    pet.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    let mut cfg = load_config();
    cfg.x = x as i32;
    cfg.y = y as i32;
    save_config(&cfg);
    Ok(())
}

/* ---------- 右键菜单 ---------- */

/// 右键菜单已改回**网页内的 DOM 菜单**，此命令保留仅为兼容旧前端调用。
///
/// 原生菜单被放弃的原因（详见项目 README「右键菜单」一节）：
///
/// - **Tauri 的 `menu.popup()`**：会阻塞主线程（`TrackPopupMenu` 是
///   同步调用，且外层宏做了 `rx.recv()` 等待），导致桌宠停止移动、
///   设置窗口打不开，菜单关闭后积压指令一次性执行（「瞬移」）；
///   同时它用 `TPM_RETURNCMD`，不发送 `WM_COMMAND`，
///   因此 `on_menu_event` 收不到事件。
/// - **自建 Win32 弹出菜单**：实测菜单完全不出现。很可能是
///   `SetForegroundWindow` 在后台线程无效，而 Windows 要求弹出菜单的
///   宿主是前台窗口，否则立刻取消。
///
/// DOM 菜单的固有缺点（随窗口移动、受窗口尺寸限制）改用
/// 「打开菜单时暂停自主行走并切到待机」来规避。
#[tauri::command]
fn show_context_menu() -> Result<(), String> {
    Err("native context menu disabled; using DOM menu".into())
}

/// 保存窗口位置。
#[tauri::command]
fn save_position(window: WebviewWindow) -> Result<(), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let mut cfg = load_config();
    cfg.x = pos.x;
    cfg.y = pos.y;
    save_config(&cfg);
    Ok(())
}

/// 设置缩放：同时调整窗口尺寸，保持素材宽高比。
#[tauri::command]
fn set_scale(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    scale: f64,
) -> Result<(), String> {
    // 素材 906x704，以高度为基准计算
    const ART_W: f64 = 906.0;
    const ART_H: f64 = 704.0;
    let s = scale.clamp(MIN_SCALE, MAX_SCALE);

    let w = ART_W * s;
    let h = ART_H * s;

    let mut cfg = load_config();
    cfg.scale = s;
    save_config(&cfg);

    // 设置面板占用窗口时不能改尺寸（否则面板会被裁切）。
    // 此时只记录到配置，等关闭面板时由 exit_settings_ui 按新尺寸还原。
    let ui_busy = state
        .ui_backup
        .lock()
        .map(|b| b.is_some())
        .unwrap_or(false);

    if !ui_busy {
        // 项目统一使用逻辑坐标：get_screen_info 与 move_window 都是逻辑像素，
        // 窗口尺寸也必须用 LogicalSize，否则边界计算会与尺寸不匹配。
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;

        // 广播：主窗口需要重新取几何信息（窗口尺寸变了，
        // 行走边界依赖 win_w，缓存不同步会导致边界算错）
        let _ = app.emit("settings:scale", s);
        log(&format!("set_scale = {s} -> {w}x{h} (logical)"));
    } else {
        log(&format!("set_scale = {s} (deferred: settings panel open)"));
    }
    Ok(())
}

/* ---------- 素材（外置于 exe 同目录） ---------- */

/// 素材根目录：exe 同目录，且其中确实有 `assets/actions.json`。
///
/// ## 为什么素材要外置
///
/// 素材 342 帧 + 38 条语音约 68 MB，而程序本体只有 2 MB。
/// 内嵌会让 exe 达 73 MB（97% 都是素材），既臃肿又让每次
/// 改一行代码都要重新拷 68 MB。
///
/// 外置后 exe 只有几 MB，素材改动也不必重新编译。
///
/// ## 为什么要检查 actions.json
///
/// 只看目录是否存在是不够的：开发时 exe 在 `target/debug/` 下，
/// 同级并没有素材。检查一个**必定存在**的文件，可以避免把
/// 空目录当成素材根，从而错误地返回 asset 前缀、让前端加载失败。
fn asset_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // 打包后的正常位置：exe 同目录
    if dir.join("assets").join("actions.json").is_file() {
        return Some(dir.to_path_buf());
    }
    // 开发时的备用位置：从 target/<profile>/ 回到项目根的 desktop-pet/
    // （便于直接跑 target/debug/desktop-pet.exe 时也能找到素材）
    let candidates = [
        dir.join("..").join("..").join("web"),
        dir.join("..").join("..").join("..").join("web"),
    ];
    for c in candidates {
        if c.join("assets").join("actions.json").is_file() {
            return c.canonicalize().ok();
        }
    }
    None
}

/// 供前端获取素材基址；没有外部素材时返回空串（前端回落到相对路径）。
#[tauri::command]
fn get_asset_base() -> String {
    match asset_root() {
        Some(_) => "http://petasset.localhost/".to_string(),
        None => String::new(),
    }
}

/// 归一化路径，用于「防目录穿越」的前缀比较。
///
/// 只做词法处理（不访问文件系统），把 `..` 消解掉后比较，
/// 避免 `assets/../../secret` 这类路径逃出素材根。
fn normalize(p: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            ParentDir => {
                out.pop();
            }
            CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 对 URL 路径做 percent-decoding。
///
/// 语音文件名全是中文（`任命助理.ogg` 等），浏览器发出的请求里
/// 会被编码成 `%E4%BB%BB...`。不解码就会按字面去找文件而失败。
///
/// 自己实现而不引入 `percent-encoding` 依赖：这里只需处理
/// `%XX` 与 `+`，逻辑很短且没有边界情况（素材文件名不含 `+`，
/// 因此**不把 `+` 当空格**，避免误伤）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // 注意边界：需要 i+1 与 i+2 都存在，因此是 i + 2 < len 的
        // 「小于等于」形式 —— 写成 i + 2 < bytes.len() 会漏掉
        // 恰好位于字符串末尾的 %XX。
        if bytes[i] == b'%' && i + 2 <= bytes.len() - 1 {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // 解码后可能是合法 UTF-8（中文），失败则退回有损转换
    String::from_utf8_lossy(&out).into_owned()
}

/// 按扩展名给出 MIME 类型。
///
/// 素材只有图与音频，这里覆盖用到的几种即可；未知类型用
/// `application/octet-stream`，浏览器会按二进制处理。
fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// 构造一个最小的 HTTP 响应（asset 协议用）。
fn http_response(status: u16, body: Vec<u8>, mime: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap_or_else(|_| {
            tauri::http::Response::new(Vec::new())
        })
}

/* ---------- WebView2 数据目录 ---------- */
fn data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("webview-data");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => {
            log(&format!("data_dir = {dir:?}"));
            Some(dir)
        }
        Err(e) => {
            log(&format!("data_dir create failed: {e}"));
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("PANIC: {info}");
        eprintln!("[pet] {msg}");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
            let _ = writeln!(f, "{msg}");
        }
        default_hook(info);
    }));

    log("=== start ===");

    // 关键：禁用 WebView2 / Chromium 的后台与遮挡挂起。
    //
    // 桌宠窗口不获取焦点，Chromium 会判定它「被遮挡 / 不可见」而挂起
    // 渲染任务 —— requestAnimationFrame 完全停止，表现为动画冻结、
    // 只显示第一帧、行走不动、一次性动画播不完。
    //
    // Tauri 的 background_throttling 配置在 Windows 上不生效
    // （官方文档标注 Linux/Windows/Android: Unsupported），
    // 因此改用 WebView2 的启动参数。
    // 必须在创建 webview 之前设置。
    let throttle_flags = concat!(
        "--disable-background-timer-throttling ",
        "--disable-backgrounding-occluded-windows ",
        "--disable-renderer-backgrounding ",
        "--disable-features=CalculateNativeWinOcclusion"
    );
    // 不覆盖用户已有的参数，追加即可
    let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing} {throttle_flags}"),
        _ => throttle_flags.to_string(),
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &merged);
    log(&format!("WEBVIEW2 args = {merged}"));

    // 素材外置：把 exe 同目录作为素材根
    match asset_root() {
        Some(p) => log(&format!("asset root = {}", p.display())),
        None => log("asset root: 未找到外部素材目录，将回落到内嵌资源"),
    }

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(AppState {
            drag: Mutex::new(DragState::default()),
            ui_backup: Mutex::new(None),
        })
        // 把 exe 同目录的素材暴露给前端。
        //
        // ## 为什么需要
        //
        // 素材（342 帧图、38 条语音，约 68 MB）原本内嵌在 exe 里，
        // 使 exe 有 73 MB —— 而程序本体只有 2 MB，97% 都是素材。
        //
        // 改为外置后，前端需要一种方式读取 exe **同目录**的文件。
        // Tauri 的 asset 协议正是干这个的：注册一个自定义协议，
        // 把某个目录映射成 `http://<scheme>.localhost/` 下的 URL。
        //
        // 用 `register_uri_scheme_protocol` 而不是 `asset_protocol` 插件，
        // 是为了少一个依赖，且作用范围更明确（只暴露素材目录）。
        .register_uri_scheme_protocol("petasset", |_app, request| {
            let raw = request.uri().path().trim_start_matches('/');
            // URL 里的中文名是 percent-encoded（如
            // `audio/zh/%E4%BB%BB%E5%91%BD%E5%8A%A9%E7%90%86.ogg`），
            // 直接当文件路径用会找不到文件 —— 语音文件名全是中文，
            // 这个问题必然触发。必须先解码。
            let path = percent_decode(raw);
            let path = path.as_str();
            let Some(root) = asset_root() else {
                return http_response(404, b"asset root not found".to_vec(), "text/plain");
            };
            // 防目录穿越：拼接后必须仍在 root 内
            let full = root.join(path);
            let ok = normalize(&full).starts_with(normalize(&root));
            if !ok {
                log(&format!("asset: 拒绝越界访问 {path}"));
                return http_response(403, b"forbidden".to_vec(), "text/plain");
            }
            match std::fs::read(&full) {
                Ok(bytes) => {
                    let mime = mime_of(path);
                    http_response(200, bytes, mime)
                }
                Err(e) => {
                    log(&format!("asset: 读取失败 {path}: {e}"));
                    http_response(404, b"not found".to_vec(), "text/plain")
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_window_pos,
            drag_start,
            drag_move,
            drag_end,
            quit_app,
            set_always_on_top,
            get_screen_info,
            move_window,
            set_click_through,
            get_cursor_rel,
            get_config,
            save_position,
            set_volume,
            set_voice_lang,
            set_passthrough_enabled,
            set_birthday,
            preview_voice,
            set_walk_enabled,
            set_smart_dodge,
            set_autostart,
            get_autostart,
            get_foreground_info,
            set_weather_cities,
            get_weather_cities,
            get_asset_base,
            enter_settings_ui,
            exit_settings_ui,
            move_pet_to_bottom,
            show_context_menu,
            set_scale,
        ])
        .setup(|app| {
            log("setup: begin");
            let handle = app.handle();

            // 读取上次保存的位置与缩放
            let cfg = load_config();
            log(&format!(
                "config: x={} y={} scale={} top={} vol={} lang={}",
                cfg.x, cfg.y, cfg.scale, cfg.always_on_top, cfg.volume, cfg.voice_lang
            ));

            const ART_W: f64 = 906.0;
            const ART_H: f64 = 704.0;
            let s = cfg.scale.clamp(MIN_SCALE, MAX_SCALE);
            let w = ART_W * s;
            let h = ART_H * s;

            // 手动建窗：可显式指定 WebView2 数据目录
            let mut wb =
                WebviewWindowBuilder::new(handle, "pet", WebviewUrl::App("index.html".into()))
                    .title("Mon3trPet")
                    .inner_size(w, h)
                    .position(cfg.x as f64, cfg.y as f64)
                    .resizable(false)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(cfg.always_on_top)
                    .skip_taskbar(true)
                    .shadow(false)
                    .visible(false);

            if let Some(d) = data_dir() {
                wb = wb.data_directory(d);
            }

            match wb.build() {
                Ok(win) => {
                    log("setup: window built OK");

                    // 窗口移动/关闭时自动保存位置
                    let w2 = win.clone();
                    win.on_window_event(move |ev| match ev {
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. } => {
                            if let Ok(pos) = w2.outer_position() {
                                let mut cfg = load_config();
                                cfg.x = pos.x;
                                cfg.y = pos.y;
                                save_config(&cfg);
                            }
                        }
                        _ => {}
                    });

                    let _ = win.show();
                    log("setup: shown");
                }
                Err(e) => log(&format!("setup: window build FAILED: {e}")),
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    match result {
        Ok(()) => log("=== exit normal ==="),
        Err(e) => log(&format!("=== exit error: {e} ===")),
    }
}
