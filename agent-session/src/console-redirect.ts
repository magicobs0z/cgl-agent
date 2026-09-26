/**
 * 把 `console.*` 改道 stderr 的**副作用模块**。
 *
 * 必须作为入口的第一个 import：ESM 按 import 声明顺序深度优先求值，因此本模块
 * 会在其余依赖（provider SDK 等）被求值之前完成覆写。顺序一旦被调整，第三方库
 * 的一行日志就会污染 stdout，直接毁掉协议流——所以这里没有写成一个普通函数。
 */

import { installConsoleRedirect } from "./transport.ts";

installConsoleRedirect();