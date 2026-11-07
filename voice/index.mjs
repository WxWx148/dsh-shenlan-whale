/**
 * voice/index.mjs — 「怎么说」这一层的门面。
 *
 * 一个决定：**这句话出来是什么样子**。它不管该不该说（那是 decide/答不答），
 * 也不管从哪个通道发（那是 channel/）。外面只从这里取，不直接摸内部四件：
 *
 *   say      成形与分条（卡片、去 Markdown、按通道渲染、错误说人话）
 *   style    语气档与断句节奏（长短、段数、句末口气）
 *   semantic 断在哪不破句义（标点之外的那条线）
 *   typing   打字台（真人节奏的等待与缝隙，负责「等多久」，不负责「说什么」）
 *
 * 为什么不设四个门面：这四件合起来才叫「一句话」。单独拿 say 出来用，
 * 就会出现「有成形、没节奏」的半成品，正是旧版两种气质（回话像人、播报像广播）的来源。
 *
 * 依赖方向：本层只允许依赖 base/ 与 lib/ 的纯工具（config、usage 之类），
 * 不许反向依赖 turn/ 或 channel/。
 *
 * 0.46.0：`guardPlan`（执行前必须先说人话）搬去了 `decide/speech.mjs`。
 * 它不是「怎么说」，是「该不该说」—— 放在这里的时候，`ability/sandbox.mjs`
 * 为了跑一段代码不得不 import 表达层，方向是反的。现在这条边没有了。
 */

export {
  explainError,
  fmtMs,
  artifactNote,
  card,
  render,
  forQq,
  askCard,
  askText,
} from './say.mjs'

export { STYLE_PROFILE, styleGuide, splitBursts, hardWrap } from './style.mjs'

export { STICKY, standsAlone, canStart, findBreak, splitByMeaning } from './semantic.mjs'

export { TYPING, typingDelayMs, typingOnlyMs, partGapMs, TypingDesk } from './typing.mjs'
