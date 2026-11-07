/**
 * facts/index.mjs — 「发生过什么」这一层的门面。
 *
 * 三件里目前落地两件：
 *   event  把通道收到的一坨原始数据打成一条**只读事实**（不判断回不回）
 *   usage  token → 钱 → 预算（只记账，不决定能不能花）
 *
 * `ledger`（四本账 + trace(eventId)）**这一批没有单独抽出来**：它现在不在一个
 * 独立文件里，而是 `app/runtime.mjs` 用 `base/journal.mjs` 开的 events /
 * behaviors / audit / cot / activities 五个账本，散在 Runtime 的构造与读写方法里。
 * 硬造一个 ledger.mjs 只会变成一层什么都没管的转发 —— 门面看着齐了，判断还是
 * 在 runtime 里，下次搬账本时又得再改一遍。等 P1 拆 runtime 那一批再按真实的
 * 调用边界抽，这里先不假装它存在。
 *
 * 名字相近但**不属于本层**的两件，别因为看着像就往里搬：
 *   app/events.mjs        SSE 状态摘要与订阅推送（接口层，不记录事实）
 *   life/activity-usage.mjs 自主活动自己的 token 小账（属 life/meter）
 *
 * 依赖方向：本层只依赖 node 内置与 base/，不许反向依赖 turn / mind / channel。
 * channel/ 反过来会读本层的 KIND / SCOPE 常量——那是「协议层按事实枚举打标」，
 * 属于从下往上读常量，不是事实层依赖通道。
 */

export {
  SOURCE,
  KIND,
  SCOPE,
  TAG,
  parseWindow,
  inWindow,
  conversationOf,
  repairGroupConversations,
  EventTagger,
  has,
  kindOf,
  needsReply,
} from './event.mjs'

export { USAGE_SOURCES, splitUsage, Usage } from './usage.mjs'
