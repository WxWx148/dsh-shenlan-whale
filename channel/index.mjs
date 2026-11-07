/**
 * channel —— 通道层门面。
 *
 * 外界只认这个文件：谁要连 QQ、谁要发消息、谁要补历史，都从这里拿。
 * 里面三个子模块各自只管一件事：
 *   onebot  协议（连、断、事件翻译、发动作）
 *   napcat  协议端的进程与登录（启动、阶段、重试、探活）
 *   backfill 掉线补回（按时间窗把漏掉的消息补进事件流）
 *
 * 这一层**不知道什么叫「回话」**：它只把 raw 递出去、把 send 发出去。
 * 判断与措辞都在上层（turn / voice），所以这里没有一句提示词、没有一条人话。
 */

export * from './onebot.mjs'
export * from './napcat.mjs'
export * from './backfill.mjs'
