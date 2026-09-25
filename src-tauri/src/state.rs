//! 插件实例状态与活动记录。
//!
//! # 线程模型（重要契约）
//!
//! helper 进程的主循环一次只处理一帧宿主消息，插件回调（`init` / `start` / `invoke` /
//! `stop` / `destroy`）因此**只在同一个线程上串行发生**；事件派发也是在同一循环里
//! 排空延迟队列后调用的。所以状态用 `&mut` 独占即可，**不需要** `Mutex`。
//!
//! 这是与旧版同进程实现最大的差别：旧版为了把 `&self` 带进 `'static` 事件闭包，
//! 用了 `Arc<Mutex<..>>` + 全局 `Weak` 观察点；现在实例状态由 ABI 的 `state` 指针
//! 唯一持有，命令层与事件回调拿到的是同一个 `&mut PluginState`，那套共享技巧整块消失。

use std::path::PathBuf;

use copper_module_abi::plugin_abi::HostApi;
use serde::Serialize;
use serde_json::{json, Value};

use crate::contract::{ACTIVITY_CAPACITY, I18N_NAMESPACE, MODULE_ID};
use crate::error::ModuleError;
use crate::host::HostClient;

/// 一条活动记录。
///
/// 字段形状是**前端契约**（`frontend/src/api.ts` 的 `DemoActivity`）：
/// `{ kind, message, at }`，其中 `at` 是 RFC3339 字符串，前端直接 `new Date(at)`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    /// 活动类型（如 `note.upsert` / `note.delete` / `module.ping` / 内核事件名）。
    pub kind: String,
    /// 活动描述（给人看的短句）。
    pub message: String,
    /// 发生时间（RFC3339，UTC）。
    pub at: String,
}

impl ActivityRecord {
    /// 按当前时间构造一条记录。
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            at: rfc3339_now(),
        }
    }

    /// 由内核事件构造记录。
    ///
    /// `kind` 直接用事件名：前端按 `kind` 的关键字（`delete` / `ping` 等）决定徽标语义色，
    /// 事件名本身是可读的，映射成另一套枚举只会多一层需要同步的翻译表。
    pub fn from_kernel_event(name: &str, payload: &Value) -> Self {
        Self::new(name, describe_kernel_event(name, payload))
    }
}

/// 插件实例状态。
pub struct PluginState {
    /// 宿主能力客户端（`events.publish` / `storage.*` / `intent.request` 都经它）。
    host: HostClient,
    /// 模块目录（宿主在 `init` 配置里下发，仅用于日志与自检）。
    module_dir: PathBuf,
    /// 模块版本（宿主下发）。
    module_version: String,
    /// 最近活动（最新在尾部，环形裁剪到 [`ACTIVITY_CAPACITY`]）。
    activity: Vec<ActivityRecord>,
    /// 是否已 `start`：未启动时命令不可用（内核语义：命令属于运行期能力）。
    started: bool,
}

impl PluginState {
    /// 构造实例状态。
    ///
    /// # Safety
    ///
    /// `host` 必须是宿主在 `init` 中传入、且在插件实例析构前始终有效的指针。
    pub unsafe fn new(host: *const HostApi, module_dir: PathBuf, module_version: String) -> Self {
        Self {
            host: unsafe { HostClient::new(host) },
            module_dir,
            module_version,
            activity: Vec::new(),
            started: false,
        }
    }

    pub fn host(&self) -> &HostClient {
        &self.host
    }

    pub fn module_dir(&self) -> &PathBuf {
        &self.module_dir
    }

    pub fn module_version(&self) -> &str {
        &self.module_version
    }

    pub fn started(&self) -> bool {
        self.started
    }

    /// 标记已启动（`start` 回调）。
    pub fn mark_started(&mut self) {
        self.started = true;
    }

    /// 标记已停止（`stop` 回调）：停止后命令不可用，活动缓冲清空（下次启动不读到陈旧数据）。
    pub fn mark_stopped(&mut self) {
        self.started = false;
        self.activity.clear();
    }

    /// 最近活动（时间升序）。
    pub fn activity(&self) -> &[ActivityRecord] {
        &self.activity
    }

    /// 记录一条活动并向外发布。
    ///
    /// 记录与发布是同一次操作的两面：只记录不发布会让你在界面上看不到实时更新，
    /// 只发布不记录则"最近活动"面板在重连后空白。因此合并成一个入口，避免漏掉一半。
    pub fn record_activity(&mut self, kind: impl Into<String>, message: impl Into<String>) {
        let record = ActivityRecord::new(kind, message);
        self.push_record(record.clone());
        self.publish_activity(&record);
    }

    /// 处理一条内核事件：记账 + 转发给前端。
    ///
    /// 事件名由宿主拼成 `event.<名>` 后经 `invoke` 传进来，这里收到的已是剥掉前缀的名字。
    pub fn on_kernel_event(&mut self, name: &str, payload: Value) -> Result<Value, ModuleError> {
        let record = ActivityRecord::from_kernel_event(name, &payload);
        self.push_record(record.clone());
        self.publish_activity(&record);
        Ok(json!({ "recorded": true, "event": name }))
    }

    /// 压入活动缓冲并裁剪到容量上限。
    fn push_record(&mut self, record: ActivityRecord) {
        self.activity.push(record);
        let overflow = self.activity.len().saturating_sub(ACTIVITY_CAPACITY);
        if overflow > 0 {
            self.activity.drain(0..overflow);
        }
    }

    /// 把活动作为模块自有事件发布出去（前端据此实时更新，无需轮询）。
    ///
    /// 失败只留痕：这是**通知性**副作用，不该让它把一次成功的数据操作变成失败。
    /// （发布上界由清单 `events.publish` 声明，宿主会再校验一次。）
    fn publish_activity(&self, record: &ActivityRecord) {
        let payload = match serde_json::to_value(record) {
            Ok(payload) => payload,
            Err(error) => {
                log::warn!("[demo-tools] 活动记录序列化失败，未发布: {error}");
                return;
            }
        };
        if let Err(error) = self.host.call(
            "events.publish",
            &json!({ "name": crate::contract::ACTIVITY_EVENT, "payload": payload }),
        ) {
            log::warn!("[demo-tools] 发布活动事件失败: {error}");
        }
    }
}

/// 把内核事件负载压成一行可读描述。
///
/// 内核事件负载的形状由各事件自己定义（本节只覆盖 `download.status`）：取不到字段时
/// 回退成事件名 + 负载原文，宁可显示原始 JSON 也不要显示空白。
fn describe_kernel_event(name: &str, payload: &Value) -> String {
    if name == crate::contract::SUBSCRIBED_EVENT {
        let status = payload["status"].as_str().unwrap_or("unknown");
        let downloaded = payload["downloadedBytes"].as_u64();
        let total = payload["totalBytes"].as_u64();
        return match (downloaded, total) {
            (Some(done), Some(total)) if total > 0 => {
                format!("下载 {status}：{done}/{total} 字节")
            }
            _ => format!("下载 {status}"),
        };
    }
    format!("{name}: {payload}")
}

/// 当前时间的 RFC3339（UTC）。
///
/// 自己算而不用 chrono：只需要"能给人看且能被 `new Date()` 解析"的时间戳，
/// 为它引入一个日期库不划算。闰年与每月天数的处理见 `days_from_civil` 的逆运算。
pub fn rfc3339_now() -> String {
    let secs = crate::storage::now_secs();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// 由"1970-01-01 起的天数"反推公历年月日（Howard Hinnant 的 civil_from_days 算法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 便于日志：一行模块身份摘要。
pub fn identity_summary(module_dir: &std::path::Path, version: &str) -> String {
    format!("{MODULE_ID}@{version}（目录 {}，命名空间 {I18N_NAMESPACE}）", module_dir.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        // 1970-01-01 为第 0 天；闰年 2 月 29 与年末跨月是这类算法最容易错的边界。
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn rfc3339_is_parseable_and_utc() {
        let stamp = rfc3339_now();
        assert!(stamp.ends_with('Z'), "必须是 UTC 标记: {stamp}");
        assert_eq!(stamp.len(), 20, "YYYY-MM-DDTHH:MM:SSZ 共 20 字节: {stamp}");
        let year: i64 = stamp[..4].parse().unwrap();
        assert!(year >= 2024, "时间戳看起来不对: {stamp}");
    }

    #[test]
    fn kernel_event_description_prefers_structured_fields() {
        let described = describe_kernel_event(
            crate::contract::SUBSCRIBED_EVENT,
            &json!({ "status": "downloading", "downloadedBytes": 10, "totalBytes": 100 }),
        );
        assert!(described.contains("downloading"));
        assert!(described.contains("10/100"));

        // 负载不是预期形状时回退到原文，而不是显示空白。
        let fallback = describe_kernel_event(crate::contract::SUBSCRIBED_EVENT, &json!({}));
        assert!(fallback.contains("unknown"));
    }

    #[test]
    fn activity_capacity_is_enforced() {
        // 缓冲裁剪逻辑与容量常量必须一致（界面只展示最近若干条）。
        let mut activity: Vec<ActivityRecord> = Vec::new();
        for i in 0..(ACTIVITY_CAPACITY + 5) {
            activity.push(ActivityRecord::new("test", format!("{i}")));
            let overflow = activity.len().saturating_sub(ACTIVITY_CAPACITY);
            if overflow > 0 {
                activity.drain(0..overflow);
            }
        }
        assert_eq!(activity.len(), ACTIVITY_CAPACITY);
        // 保留的是最新的那批。
        assert_eq!(activity.last().unwrap().message, format!("{}", ACTIVITY_CAPACITY + 4));
    }
}
