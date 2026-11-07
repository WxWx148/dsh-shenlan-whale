/**
 * mind/index.mjs — 心智：记忆、人格、意愿、以及「从发生过的事里学」。
 *
 * 这一层只回答「他/她记得什么、是谁、想要什么、学到什么」，
 * 不决定这一句回不回（那是 decide/），也不拼 prompt（那是 turn/）。
 *
 * 落地现状（0.46.0）：
 *   memory.mjs        事实/人物/自我/群的长期记忆
 *   persona.mjs       人设文件（分节 + 版本 + 回滚）
 *   wants.mjs         短期意愿本
 *   refusals.mjs      「这一阵子不想理谁」的登记簿
 *   learn/            从发生过的事里学 —— 设计里的四分法，这一批真拆开了：
 *     induction.mjs     从事件流/行为流归纳可验证的结论
 *     habits.mjs        说话习惯基线
 *     selfcheck.mjs     自查结论账本
 *     weights.mjs       四个旋钮的形状：上下限 / 默认值 / 校验 / 单步钳制（纯函数）
 *     evolve.mjs        怎么学：证据、窗口、版本、回滚（有状态）
 *
 * `weights` 独立出来是 0.46.0 的事。判据：把 weights.mjs 单独拎出来，
 * 它应该能在任何地方跑 —— 面板想显示「记忆留多久」不该先造一个 Evolver。
 * 之前它和进化编排挤在一起，两个职责都说得通，于是两边都不好改。
 *
 * 注意：learn/evolve.mjs 末尾 `export { BEHAVIOR }` 是从 decide/ 转发的，门面不再转一次——
 * BEHAVIOR / TUNABLE_BEHAVIORS 的唯一出处是 decide/，别让同一个符号有两个父模块出口。
 *
 * 依赖方向：learning 三件（induction / habits / weights）只依赖 decide 的纯表与
 * 自己；evolve 依赖 weights。没有一件反向依赖 turn / ability / app。
 */

export { WhaleMemory, memoryCommand } from './memory.mjs'

export {
  CORE_SECTIONS,
  PersonaBook,
  matchSection,
  parseSections,
  readDefaultPersona,
  renderSections,
} from './persona.mjs'

export { addWant, dropWant, listWants, resolveWant, wantStats } from './wants.mjs'

export { isRefused, refuse } from './refusals.mjs'

export { deriveRewards, induce, isDeclining, line } from './learn/induction.mjs'

export {
  HabitObserver,
  gapLines,
  gaps,
  hasParticle,
  measure,
  observe,
  splitGroups,
} from './learn/habits.mjs'

export { SelfCheckBook } from './learn/selfcheck.mjs'

export { BOUNDS, defaultWeights, normalizeWeights, weightLabel } from './learn/weights.mjs'

export { Evolver } from './learn/evolve.mjs'
