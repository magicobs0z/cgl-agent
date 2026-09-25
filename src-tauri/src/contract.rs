//! 模块对外契约常量：id、i18n 命名空间、收发的事件、声明的意图。
//!
//! 这些值必须与仓库根 `module.json` **逐字一致**——清单是内核侧的唯一权威，代码里的
//! 常量是插件侧的使用点，两侧漂移的表现是"运行起来没反应"（事件收不到、意图调不通）。
//! 因此这里既集中声明，又用 [`tests`] 把清单原文解析出来逐项对照，让漂移在 `cargo test`
//! 阶段就暴露，而不是等到装进启动器。
//!
//! 说明：本文件**不重复实现清单校验器**。清单的字段、枚举与跨字段一致性由内核装载器
//! 与 `build.rs` 各自负责；插件侧再抄一份校验逻辑只会多出一份会漂移的真相。

/// 模块唯一标识，必须与 `module.json` 的 `id` 完全一致（编译期由 `build.rs` 校验）。
pub const MODULE_ID: &str = "copper-lamp.demo-tools";

/// i18n 命名空间：前端拼 `module.<namespace>.<扁平键>`，必须是**单段**而非完整 id。
///
/// 完整 id 含点号，会被 `t()` 的 `split('.')` 拆成四段而查不到文案；
/// 这是项目历史上出过同类 bug 的位置，故此处用独立常量把两个语义分开。
pub const I18N_NAMESPACE: &str = "demo-tools";

/// 订阅的内核事件（发布侧事件名，带点号；桥接到前端时点号会变连字符）。
///
/// 宿主只按清单一侧声明的 `events.subscribe` 订阅；插件侧收到的是
/// `event.<事件名>` 形式的一次命令调用（见 [`crate::lib`] 的分发）。
pub const SUBSCRIBED_EVENT: &str = "download.status";

/// 模块自有事件（命名约定 `<模块域>.<动名词>`，避免与内核事件撞名）。
///
/// 发布要走能力 `events.publish`，且必须出现在清单 `events.publish` 声明的上界内。
pub const ACTIVITY_EVENT: &str = "demo-tools.activity";

/// 本模块声明的意图名（模块自有命名空间，不与内核意图冲突）。
pub const INTENT_PING: &str = "demo-tools.ping";

/// 内核已有意图：由内置 `home` 模块声明，本模块**只发起、不声明**。
pub const INTENT_EXPOSE_VERSION: &str = "expose.version";

/// 内存态保留的最近事件条数上限。
///
/// 为什么需要上限：模块运行期可能收到高频 `download.status`；无界累积会让常驻内存
/// 随运行时长增长，而"最近活动"面板只需要最近若干条。
pub const ACTIVITY_CAPACITY: usize = 32;

/// 清单原文（编译期嵌入）。
///
/// 用 `include_str!` 直接指向仓库根同一份文件，而不是让 `build.rs` 复制副本：
/// 单一数据源，构建期校验的对象与这里对照的对象永远是同一份字节。
pub static MANIFEST_JSON: &str = include_str!("../../module.json");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn manifest() -> Value {
        serde_json::from_str(MANIFEST_JSON).expect("仓库根 module.json 必须是合法 JSON")
    }

    #[test]
    fn manifest_identity_matches_the_constants() {
        let m = manifest();
        assert_eq!(m["id"], MODULE_ID);
        assert_eq!(m["i18n_namespace"], I18N_NAMESPACE);
        // 命名空间绝不能等于完整 id：那会让 t() 把键拆成四段而回退键名。
        assert_ne!(I18N_NAMESPACE, MODULE_ID);
    }

    #[test]
    fn declared_events_match_the_code() {
        let m = manifest();
        let subscribe = m["events"]["subscribe"]
            .as_array()
            .expect("module.json 必须声明 events.subscribe");
        let publish = m["events"]["publish"]
            .as_array()
            .expect("module.json 必须声明 events.publish");

        assert_eq!(
            subscribe,
            &vec![Value::from(SUBSCRIBED_EVENT)],
            "清单订阅上界与代码里的订阅事件必须一致"
        );
        assert_eq!(
            publish,
            &vec![Value::from(ACTIVITY_EVENT)],
            "清单发布上界与代码发布的事件必须一致"
        );
    }

    #[test]
    fn declared_intents_match_the_code() {
        let m = manifest();
        let intents = m["intents"]
            .as_array()
            .expect("module.json 必须声明 intents");
        assert_eq!(intents, &vec![Value::from(INTENT_PING)]);
    }

    #[test]
    fn module_does_not_claim_kernel_intents() {
        // 内核已有意图只能发起、不能声明：重复声明会让本模块装载失败并影响其它模块。
        let m = manifest();
        let intents = m["intents"].as_array().cloned().unwrap_or_default();
        assert!(!intents.iter().any(|i| i == INTENT_EXPOSE_VERSION));
    }

    #[test]
    fn own_names_use_the_module_namespace() {
        // 自有事件与自有意图都必须带模块域前缀，避免与内核 / 其它模块撞名。
        assert!(ACTIVITY_EVENT.starts_with("demo-tools."));
        assert!(INTENT_PING.starts_with("demo-tools."));
        assert!(I18N_NAMESPACE.starts_with("demo-tools"));
    }
}
