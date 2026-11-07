/**
 * life/index.mjs — 自主：没人叫的时候做什么、到点提醒、以及活动自己花掉多少。
 *
 * 这一层只回答「现在有没有事该做、什么时候该提醒、这次花了多少」，
 * 不判断该不该跟人说（那是 decide/），也不负责把结果发出去（那是 turn/）。
 *
 * 落地现状（0.45.26）：
 *   activity.mjs        自主活动：自己的时间，做真的事（设计里的 index/activity 合在一处）
 *   reminders.mjs       到点提醒 + 自然语言时间（「明天 9 点」）
 *   activity-usage.mjs  活动自己的 token 账（设计里的 meter）
 *
 * 两处命名与设计不同，刻意保留原名：
 *   - 设计里 `meter.mjs` 就是 `activity-usage.mjs`。改名不影响任何行为，
 *     但会把「账本落盘文件 activity-usage.json」和「详情行 id activity-usage」
 *     这两处**数据契约**的关系搞乱，收益为零。职责对齐即可，名字不必一致。
 *   - 设计里 `life/index.mjs`（160 行编排）没有独立文件，三段式活动本身就由
 *     `runActivityStep()` 串起来，再套一层编排只会变成空转发。
 *
 * 与 ability/ 的关系是**双向**的，这里要小心：
 *   activity.mjs 用 ability 的联网（走 `../ability/index.mjs` 门面）；
 *   ability/tools.mjs 用 reminders 的时间解析（走 `../life/reminders.mjs` 具体文件）。
 * 两处都走门面会立刻成环（ability/index → tools → life/index → activity → ability/index），
 * 所以后者刻意退让到文件级。改这个方向前先跑 `npm run check` 看调用链。
 */

export { runActivityStep } from './activity.mjs'

export { Reminders, cnNumber, describeAt, parseReminder, parseWhen } from './reminders.mjs'

export {
  ACTIVITY_KINDS,
  activitySpend,
  activityUsageView,
  meterOf,
  usageOf,
} from './activity-usage.mjs'
