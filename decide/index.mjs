/**
 * decide/index.mjs — 「决定」父模块门面。
 *
 * 这里只收「纯判断、无 IO、无模型」的七件：
 *   - behavior  事件 → 行为，只有一张路由表说了算
 *   - attention 群里「现在在跟谁说话」的注意力账本
 *   - intent    「主人这句话是要我办什么事」的唯一判定表
 *   - guard     该不该说话、该等多久
 *   - burst     连发合并
 *   - cadence   说话节奏：什么时候开口、隔多久说一次
 *   - dedupe    出口去重：同一件事，不发第二遍
 *
 * speech 是 0.46.0 从 `voice/say.mjs` 搬来的出口闸门（guardPlan）：
 * 沙箱执行前先要一句人话，这是判断不是表达 —— 搬过来之后 `ability → voice` 那条边消失。
 *
 * 设计文档曾设想把它们合并成 route / intent / speech 三件（重构），
 * 但本批按「只搬不改」纪律整件迁移，合并留到 decide 第二批，避免
 * 在宿主 429 限流、无真机窗口时动判定逻辑。门面把七件的全部导出
 * 原样透出，调用方改一行 import 即可，判断代码一行不动。
 *
 * 依赖方向（L1 层级）：decide 只向下依赖 facts / truth / base，
 * 不反向、不横向。behavior / guard 依赖 facts（事件/窗口），
 * intent 依赖 truth（能力/修正/自检规则），均合法。
 */

export { guardPlan } from './speech.mjs'

export {
  BEHAVIOR,
  BEHAVIOR_LIST,
  TUNABLE_BEHAVIORS,
  route,
  record,
} from './behavior.mjs'

export {
  ATTENTION,
  textOverlaps,
  addressesSelf,
  AttentionDesk,
} from './attention.mjs'

export {
  INTENTS,
  matchIntent,
  isSelfReferential,
  skipWebSearch,
} from './intent.mjs'

export {
  MIN_DELAY_MS,
  Guard,
} from './guard.mjs'

export {
  DEFAULT_MERGE_WINDOW_MS,
  MAX_MERGED,
  mergeTexts,
  BurstLedger,
} from './burst.mjs'

export {
  DEFAULT_MIN_GAP_MINUTES,
  DEFAULT_MAX_GAP_MINUTES,
  DEFAULT_SKIP_CHANCE,
  pickGapMs,
  shouldSpeak,
  Cadence,
} from './cadence.mjs'

export {
  DUP_TEXT_MS,
  DUP_MSG_MS,
  normalize,
  sameUtterance,
  Dedupe,
} from './dedupe.mjs'
