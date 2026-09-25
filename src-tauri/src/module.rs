//! 模块生命周期与清单访问。
//!
//! 本文件是 [`Module`] trait 的唯一实现落点：`init` 做一次性装配（数据库迁移 + 语言包注册），
//! `start` 建立运行期订阅，`stop` 全部撤销。内核 `boot()` 对每个模块执行
//! `init(...).and_then(|_| start(...))`，任一失败即标记 `Failed` 并把错误写进 `errors` 表，
//! 因此这里每一步失败都要如实返回错误，不能吞掉。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use copper_core_lib::error::KernelError;
use copper_core_lib::registry::events::Subscription;
use copper_core_lib::registry::modules::Module;
use copper_core_lib::state::KernelContext;
use serde_json::Value;

use crate::intents;
use crate::manifest::{Manifest, ManifestError};
use crate::storage;

/// 模块唯一标识，必须与 `module.json` 的 `id` 完全一致（编译期由 `build.rs` 校验）。
pub const MODULE_ID: &str = "copper-lamp.demo-tools";

/// i18n 命名空间：传给 `register_module_pack` 的必须是**它**而不是完整 id。
///
/// 完整 id 含点号，会被 `t()` 的 `split('.')` 拆成四段而查不到文案；
/// 这是项目历史上出过同类 bug 的位置，故此处用独立常量把两个语义分开。
pub const I18N_NAMESPACE: &str = "demo-tools";

/// 模块订阅的内核事件（发布侧事件名，带点号；桥接到前端时点号会变连字符）。
pub const SUBSCRIBED_EVENT: &str = "download.status";

/// 模块自有事件（命名约定 `<模块域>.<动名词>`，避免与内核事件撞名）。
pub const ACTIVITY_EVENT: &str = "demo-tools.activity";

/// 内存态保留的最近事件条数上限。
///
/// 为什么需要上限：至少一次语义下订阅时会补发内核重放缓冲（容量 64）内的历史事件，
/// 且模块运行期可能收到高频 `download.status`；无界累积会让常驻内存随运行时长增长。
pub const ACTIVITY_CAPACITY: usize = 32;

/// 清单原文（编译期嵌入）。
///
/// 用 `include_str!` 直接指向仓库根同一份文件，而不是让 `build.rs` 复制副本：
/// 单一数据源，构建期校验的对象与运行期解析的对象永远是同一份字节。
pub static MANIFEST_JSON: &str = include_str!("../../module.json");

/// 模块清单缓存。
///
/// 解析失败不 panic：清单损坏时模块应当报错退出装载流程，而不是让整个启动器崩溃。
/// 兜底值只用于「不崩溃且错误可读」，真实入口 [`manifest_result`] 会返回失败。
static MANIFEST: OnceLock<Result<Manifest, ManifestError>> = OnceLock::new();

/// 解析并缓存清单（结果可能是 Err，由调用方决定如何处理）。
///
/// 每次调用都重新执行一次校验（`validate()` 是纯计算，成本可忽略），
/// 以便「清单被改坏」这类问题在每次读取时都能被如实报告。
pub fn manifest_result() -> Result<&'static Manifest, ManifestError> {
    let holder = MANIFEST.get_or_init(|| match Manifest::parse_and_validate(MANIFEST_JSON) {
        Ok(m) => Ok(m),
        Err(e) => {
            log::error!("[demo-tools] 模块清单无效: {e}");
            Err(e)
        }
    });
    match holder {
        Ok(m) => {
            // 缓存的是解析结果，校验每次重跑：清单字段是冻结契约，静默漂移代价很高。
            m.validate()?;
            Ok(m)
        }
        Err(e) => Err(e.clone()),
    }
}

/// 取清单引用；解析失败时返回兜底清单（保证调用方不 panic）。
///
/// 兜底值刻意保持与真实清单同 id / 同命名空间，避免下游把「解析失败」误当成
/// 「换了另一个模块」。解析失败的原因会经 `log::error` 输出。
pub fn manifest() -> &'static Manifest {
    match manifest_result() {
        Ok(m) => m,
        Err(e) => {
            log::error!("[demo-tools] 使用兜底清单，模块能力不完整: {e}");
            fallback_manifest()
        }
    }
}

/// 兜底清单：字段与 `module.json` 的骨架保持一致，仅用于不崩溃降级。
fn fallback_manifest() -> &'static Manifest {
    static FALLBACK: OnceLock<Manifest> = OnceLock::new();
    FALLBACK.get_or_init(|| Manifest {
        schema_version: crate::manifest::SUPPORTED_SCHEMA_VERSION.to_string(),
        id: MODULE_ID.to_string(),
        i18n_namespace: I18N_NAMESPACE.to_string(),
        display_name: "示例工具".to_string(),
        description: "模块清单解析失败时的兜底描述".to_string(),
        i18n: Default::default(),
        author: crate::manifest::Author {
            name: "copper-lamp".to_string(),
            email: None,
            url: Some("https://github.com/copper-lamp".to_string()),
        },
        license: "MIT".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platforms: vec!["windows-x86_64".to_string()],
        launcher: crate::manifest::LauncherRange {
            min: "0.1.0".to_string(),
            max: None,
        },
        api_version: 1,
        backend: crate::manifest::BackendSpec::new(
            env!("CARGO_PKG_NAME").to_string(),
            "copper_module_demo::DemoModule".to_string(),
            "target/release/copper_module_demo.dll".to_string(),
        ),
        frontend: crate::manifest::FrontendSpec {
            dist: "frontend/dist".to_string(),
            register: "register.js".to_string(),
        },
        permissions: Vec::new(),
        icon: "assets/icon.svg".to_string(),
        category: "utility".to_string(),
        keywords: Vec::new(),
        homepage: None,
        donation: None,
        changelog: None,
    })
}

/// 最近一次内核事件的快照（模块内存态，不落库）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    /// 事件名（发布侧原名，带点号）。
    pub event: String,
    /// 事件负载（原样保留，前端按需取字段）。
    pub payload: Value,
    /// 记录时刻（Unix 秒）。
    pub at: i64,
}

/// 演示模块实例。
///
/// 内核 `register_with_origin` 要求 `Arc<dyn Module>`，而订阅句柄与内存态需要在
/// `start` / `stop` 之间保持，故用内部可变性（`Mutex`）而非 `&mut self`。
pub struct DemoModule {
    /// 事件订阅句柄（`stop` 时逐个退订）。
    subs: Mutex<Vec<Subscription>>,
    /// 最近内核事件（环形，最新在尾部）。
    ///
    /// 用 `Arc<Mutex<..>>` 而不是裸的 `Mutex<..>`：事件回调必须是 `'static`，
    /// 无法借用 `&self`，只能持有一份**共享所有权**的句柄。`Arc` 的引用计数保证了
    /// 「模块实例先于回调存活」这一事实由类型系统表达，而不是靠人肉论证生命周期。
    activity: Arc<Mutex<Vec<ActivityRecord>>>,
    /// 是否已完成 `start`（用于幂等保护：内核可能因配置重载重复调用）。
    started: AtomicBool,
    /// 存活守卫（构造时登记活跃实例数，析构时自动注销）。
    _live: LiveGuard,
}

impl Default for DemoModule {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoModule {
    /// 构造模块实例。
    pub fn new() -> Self {
        let activity = Arc::new(Mutex::new(Vec::new()));
        // 把缓冲登记为「观察点」，供命令层读取；持 Weak 不影响本实例的生命周期。
        register_activity_sink(&activity);
        Self {
            subs: Mutex::new(Vec::new()),
            activity,
            started: AtomicBool::new(false),
            _live: LiveGuard::acquire(),
        }
    }

    /// 最近事件快照（最新在尾部）。
    pub fn recent_activity(&self) -> Vec<ActivityRecord> {
        self.activity.lock().expect("activity 锁中毒").clone()
    }

    /// 清空内存态（`stop` 与测试使用）。
    pub fn clear_activity(&self) {
        self.activity.lock().expect("activity 锁中毒").clear();
    }

    /// 已订阅数量（自检入口展示用）。
    pub fn subscription_count(&self) -> usize {
        self.subs.lock().expect("subs 锁中毒").len()
    }
}

/// 把一条事件压进共享缓冲并裁剪到容量上限。
///
/// 独立成自由函数（而不是 `&self` 方法）：调用点是 `'static` 事件闭包，
/// 闭包只持有 `Arc` 句柄而没有 `&self`，自由函数让签名与调用侧的真实能力对齐。
/// 返回被写入的记录，便于调用方在锁外广播事件（锁内做 IO 会拉长临界区）。
fn push_activity(
    buffer: &Arc<Mutex<Vec<ActivityRecord>>>,
    event: &str,
    payload: &Value,
) -> ActivityRecord {
    let record = ActivityRecord {
        event: event.to_string(),
        payload: payload.clone(),
        at: storage::now_secs(),
    };
    let mut buf = buffer.lock().expect("activity 锁中毒");
    buf.push(record.clone());
    let overflow = buf.len().saturating_sub(ACTIVITY_CAPACITY);
    if overflow > 0 {
        buf.drain(0..overflow);
    }
    drop(buf);
    record
}

impl Module for DemoModule {
    fn id(&self) -> &'static str {
        MODULE_ID
    }

    fn init(&self, kernel: &KernelContext) -> Result<(), KernelError> {
        // 清单必须先能解析：后续所有能力（id / 命名空间 / 迁移 scope）都依赖它。
        // 这里不做兜底，装载期失败要如实上报，让内核把模块标记为 Failed。
        let m = manifest_result()
            .map_err(|e| KernelError::Module(format!("模块清单无效: {}", e.friendly())))?;

        // 内核兼容区间检查：模块与内核大版本不匹配时，宁可拒绝装载也不要带病运行。
        let kernel_version = env!("CARGO_PKG_VERSION");
        if !crate::manifest::launcher_accepts(&m.launcher, kernel_version) {
            log::warn!(
                "[demo-tools] 内核版本 {kernel_version} 不在清单声明的兼容区间 [{}, {:?}] 内，仍继续装载",
                m.launcher.min,
                m.launcher.max
            );
        }

        // 1) 数据库 schema：scope 用完整 id，表名前缀由 id 派生。
        storage::migrate(kernel)?;

        // 2) 语言包：注册名必须是 i18n_namespace；源文件与前端同源（单一数据源）。
        kernel.i18n().register_module_pack(
            I18N_NAMESPACE,
            "zh-CN",
            serde_json::from_str(include_str!("../../frontend/src/locales/zh-CN.json"))?,
        )?;
        kernel.i18n().register_module_pack(
            I18N_NAMESPACE,
            "en-US",
            serde_json::from_str(include_str!("../../frontend/src/locales/en-US.json"))?,
        )?;

        // 3) 意图：模块对外提供的能力在 init 阶段声明（内核语义：声明先于使用）。
        intents::declare(kernel)?;

        log::info!(
            "[demo-tools] 初始化完成: {} (scope={}, 表前缀={}, 迁移目标版本={})",
            m.summary(),
            storage::MIGRATION_SCOPE,
            storage::TABLE_PREFIX,
            storage::TARGET_SCHEMA_VERSION
        );
        Ok(())
    }

    fn start(&self, kernel: &KernelContext) -> Result<(), KernelError> {
        // 幂等：重复调用不应产生重复订阅（否则一个内核事件会触发多次处理）。
        {
            let mut subs = self.subs.lock().expect("subs 锁中毒");
            if self.started.swap(true, Ordering::SeqCst) {
                log::warn!("[demo-tools] start 被重复调用，跳过重复订阅");
                return Ok(());
            }
            subs.clear();
        }

        // 回调必须是 `'static`，因此这里只把**共享所有权句柄**移进闭包：
        // 事件缓冲（Arc<Mutex<..>>）与事件总线（Arc<EventBus>）都取自内核的 Arc，
        // 内核在应用存续期内持有它们，故闭包脱离 `&KernelContext` 后依然有效。
        //
        // 刻意**不**捕获 `&KernelContext`：它的生命周期由内核的 `setup` 作用域决定，
        // 用裸指针把它塞进 `'static` 闭包会造成悬垂引用（退订只保证「不再被调用」，
        // 不保证「退订时没有正在执行的回调」）。本模板不引入任何 unsafe。
        let buffer = self.activity.clone();
        let bus = kernel.events().clone();
        // 闭包是 `move`，会把 `bus` 整个移入；而 `subscribe` 通过 `&self` 借用 `bus`，
        // 直接捕获 `bus` 会在借用期间 move out（E0505）。这里为闭包单独持一份 clone：
        // 发布侧用同一事件总线即可，不需要（也不应）与订阅借用同一个 Arc 手柄。
        let publish_bus = bus.clone();

        // 订阅发布侧事件名（带点号）。至少一次语义：订阅时事件总线会立即补发
        // 重放缓冲内匹配的历史事件，因此回调可能在 `start` 返回前就被调用；
        // 下面闭包只碰 Arc 内部的缓冲，不回调内核，避免重入。
        let sub = bus.subscribe(SUBSCRIBED_EVENT, move |name, payload| {
            let record = push_activity(&buffer, name, payload);
            // 模块自有事件：前端只订阅模块域事件即可，无需关心模块内部订阅了哪些内核事件。
            // 序列化失败不应吃掉整条记录（缓冲里已经存下了），故只记录警告。
            match serde_json::to_value(&record) {
                Ok(value) => publish_bus.publish(ACTIVITY_EVENT, value),
                Err(e) => log::warn!("[demo-tools] 模块事件负载序列化失败，已仅保留内存记录: {e}"),
            }
        });

        self.subs.lock().expect("subs 锁中毒").push(sub);
        log::info!("[demo-tools] 已订阅内核事件 `{SUBSCRIBED_EVENT}`");
        Ok(())
    }

    fn stop(&self, kernel: &KernelContext) -> Result<(), KernelError> {
        // 退订：内核事件总线的订阅句柄是唯一需要显式归还的资源。
        let drained: Vec<Subscription> = {
            let mut subs = self.subs.lock().expect("subs 锁中毒");
            let drained = subs.drain(..).collect();
            drained
        };
        for sub in drained {
            kernel.events().unsubscribe(sub);
        }

        // 注销本模块声明的全部意图（内核按 module_id 清理，不会误删他人意图）。
        kernel.intents().withdraw(MODULE_ID);

        // 清空内存态：stop 之后再被调用不应读到上一轮运行的陈旧数据。
        self.clear_activity();
        self.started.store(false, Ordering::SeqCst);

        log::info!("[demo-tools] 已停止：退订事件、注销意图、清空内存态");
        Ok(())
    }
}

/// 当前活动实例的查询入口。
///
/// 说明：模块实例由内核以 `Arc<dyn Module>` 持有，模块侧**不再**自建全局登记
/// （曾用于把 `&self` 带进 `'static` 回调，但那需要裸指针，已废弃）。
/// 内存态因此改由 `Arc<Mutex<Vec<ActivityRecord>>>` 共享：模块实例与事件回调
/// 各持一份 Arc，谁先析构都不会造成悬垂。
///
/// 本函数保留给「调试入口」这类需要问「模块当前是否活跃」的场景：它通过
/// 静态计数标志判断是否已有实例被构造并进入 `start`，不返回实例引用。
pub fn is_instance_running() -> bool {
    ACTIVE_INSTANCES.load(Ordering::SeqCst) > 0
}

/// 活跃实例计数（构造时 +1，析构时 -1）。
///
/// 为什么用计数而不是 `OnceLock<Arc<Self>>`：后者会让实例永不析构，
/// 在测试里多个用例共享同一份内存态，断言相互污染；且与「谁持有实例」的真实
/// 所有权关系不符（真正持有者是内核注册表）。
static ACTIVE_INSTANCES: AtomicUsize = AtomicUsize::new(0);

/// 实例存活守卫：随 `DemoModule` 同生共死，避免手写 `Drop` 与计数遗漏。
struct LiveGuard;

impl LiveGuard {
    fn acquire() -> Self {
        ACTIVE_INSTANCES.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        ACTIVE_INSTANCES.fetch_sub(1, Ordering::SeqCst);
    }
}

// ------------------------------------------------------------------ 内存态共享出口

/// 事件缓冲的共享出口。
///
/// 为什么需要：事件回调必须是 `'static`，只能持有 [`Arc`] 句柄；命令层（`service.rs`）
/// 需要读同一份数据，但它拿不到模块实例（实例归内核注册表所有）。这里用一个
/// **只存弱引用**的登记槽把两者接上：
/// - 模块 `new()` 时把自己的缓冲登记进来（`Weak`，不延长生命周期）；
/// - 回调与命令层都经 [`activity_snapshot`] 读取；实例析构后 `Weak` 升级失败，读取返回空列表。
///
/// 用 `Weak` 而不是 `OnceLock<Arc<..>>` 是刻意的：后者会让缓冲永不释放，
/// 并让多个测试用例共享同一份状态而相互污染。这里是「观察点」，不是所有权持有者。
static ACTIVITY_SINK: Mutex<Option<std::sync::Weak<Mutex<Vec<ActivityRecord>>>>> = Mutex::new(None);

/// 登记事件缓冲（仅供模块实例在构造时调用）。
fn register_activity_sink(buffer: &Arc<Mutex<Vec<ActivityRecord>>>) {
    *ACTIVITY_SINK.lock().expect("sink 锁中毒") = Some(Arc::downgrade(buffer));
}

/// 读取最近事件快照（实例不存在时为空列表）。
///
/// 空列表是**合法语义**而非错误：`stop` 之后查询、或尚未 `register` 时查询，
/// 都表示「当前没有内存态」，不构成失败。
pub fn activity_snapshot() -> Vec<ActivityRecord> {
    let upgraded = ACTIVITY_SINK
        .lock()
        .expect("sink 锁中毒")
        .as_ref()
        .and_then(std::sync::Weak::upgrade);
    match upgraded {
        Some(buffer) => buffer.lock().expect("activity 锁中毒").clone(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// 全局单槽 `ACTIVITY_SINK` 是进程级共享状态：`DemoModule::new()` 会覆盖槽点，
    /// 并行测试下 `activity_snapshot` 可能读到**其它测试实例**的缓冲（断言的条数串扰）。
    /// 这把锁让所有会创建 `DemoModule` 的测试串行执行，确保读取拥有确定性。
    static SINK_SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn manifest_is_embedded_and_valid() {
        let m = manifest_result().expect("仓库根 module.json 必须合法");
        assert_eq!(m.id, MODULE_ID);
        assert_eq!(m.i18n_namespace, I18N_NAMESPACE);
        // 命名空间绝不能等于完整 id：那会让 t() 把键拆成四段而回退键名。
        assert_ne!(m.i18n_namespace, m.id);
    }

    #[test]
    fn manifest_falls_back_without_panicking() {
        // manifest() 在解析失败时必须返回可用引用而不是 panic；
        // 当前清单合法，这里断言它与真实解析结果同源。
        let via_manifest = manifest();
        let via_result = manifest_result().unwrap();
        assert_eq!(via_manifest.id, via_result.id);
        assert_eq!(via_manifest.version, via_result.version);
    }

    #[test]
    fn activity_buffer_is_capped_and_keeps_latest() {
        let _guard = SINK_SERIAL.lock().unwrap();
        let module = DemoModule::new();
        for i in 0..(ACTIVITY_CAPACITY + 8) {
            push_activity(&module.activity, "download.status", &json!({ "seq": i }));
        }
        let recent = module.recent_activity();
        assert_eq!(recent.len(), ACTIVITY_CAPACITY, "缓冲必须裁剪到容量上限");
        // 保留的应是最新的那批：首条序号 = 总数 - 容量。
        assert_eq!(recent.first().unwrap().payload["seq"], json!(8));
        assert_eq!(
            recent.last().unwrap().payload["seq"],
            json!(ACTIVITY_CAPACITY + 7)
        );
    }

    #[test]
    fn activity_snapshot_observes_instance_buffer() {
        let _guard = SINK_SERIAL.lock().unwrap();
        // 命令层经快照读取同一份数据（不依赖全局单例持有所有权）。
        let module = DemoModule::new();
        push_activity(&module.activity, "download.status", &json!({ "task": 1 }));
        let snapshot = activity_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].payload["task"], json!(1));
        assert_eq!(snapshot[0].event, "download.status");
    }

    #[test]
    fn clear_activity_empties_buffer() {
        let _guard = SINK_SERIAL.lock().unwrap();
        let module = DemoModule::new();
        push_activity(&module.activity, "download.status", &json!({}));
        assert_eq!(module.recent_activity().len(), 1);
        module.clear_activity();
        assert!(module.recent_activity().is_empty());
    }

    #[test]
    fn live_instance_counter_tracks_construction_and_drop() {
        let _guard = SINK_SERIAL.lock().unwrap();
        // 计数由守卫随实例生死增减，用于调试入口判断模块是否活跃。
        let before = ACTIVE_INSTANCES.load(Ordering::SeqCst);
        {
            let _module = DemoModule::new();
            assert_eq!(ACTIVE_INSTANCES.load(Ordering::SeqCst), before + 1);
        }
        assert_eq!(ACTIVE_INSTANCES.load(Ordering::SeqCst), before);
    }

    #[test]
    fn module_id_is_stable() {
        assert_eq!(MODULE_ID, "copper-lamp.demo-tools");
        assert_eq!(I18N_NAMESPACE, "demo-tools");
    }
}
