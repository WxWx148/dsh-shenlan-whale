/**
 * truth/index.mjs — 「这件事的口径是什么」这一层的门面。
 *
 * 五份纯真源（config / panel / taxonomy / capabilities / manifest 的投影所依赖的三份），
 * 都不做 IO、不读运行时业务数据，回答的都是同一个问题：
 * **形状与清单由谁说了算**。
 *
 *   config        96 个配置键的默认值、扁平化、迁移、读写
 *   panel         面板项清单（分组 / 风险 / 生效等级 / 是否只读）
 *   taxonomy      七个域、七个页面、详情类型与旧 id 归属
 *   capabilities  自述口径（能看见什么、该怎么做、进度话术）
 *
 * 依赖闭包：config → panel → taxonomy → blueprint（后者是**设计声明**，
 * 按 §10.2 留在 lib/，生成器要读它）。capabilities 无内部依赖。
 * 本层不许 import 任何运行时模块（runtime / turn / channel / …）。
 *
 * ### 三件齐了（0.46.0）
 *
 * 设计里 truth 是 `manifest / config / audit`：
 *   config    四份真源里的配置形状（下面第一段）
 *   manifest  `panel` + `taxonomy` 的合并投影：data / derive / check（truth/manifest.mjs）。
 *             **不是第四个真源**，三处都是现算的；改 panel 一行，check() 立刻跟着变。
 *   audit     全部对账的清单与口径（truth/audit.mjs）：哪几条、各自证明什么、去哪跑。
 *             它只列「该查什么」，跑还是 scripts/audit-all.mjs 跑 ——
 *             truth 层不读磁盘、不起进程，这条线不能为了「看起来整齐」破掉。
 *
 * ### 一个既有技术债，本批没有假装解决
 *
 * `base/core.mjs` 反向 import 了本层的 `DEFAULTS / clone / migrate / report`
 * （底座读默认配置）。按层级图 truth 在 base 之上，这个方向是错的；
 * 但它在我搬之前就存在，修它要改 `loadConfig` 的注入方式，属于另一批的
 * 重构。这里如实标出，不因为搬了目录就说「层级已经干净」。
 */

// 合并投影：数据 / 派生 / 对账
export {
  MANIFEST_SCHEMA,
  manifest,
  manifestCheck,
  manifestData,
  manifestDerive,
} from './manifest.mjs'

// 对账清单（只描述「查什么」，不含执行）
export { AUDITS, auditOf, auditSummary } from './audit.mjs'

// 配置形状
export {
  DEFAULTS,
  applyInto,
  clone,
  flatten,
  unflatten,
  get,
  set,
  defaultKeys,
  migrate,
  diff,
  report,
} from './config.mjs'

// 面板项清单
export {
  LEVEL,
  RISK,
  PANEL_GROUPS,
  PENDING_KEYS,
  isPending,
  optionLabelsOf,
  PANEL_ITEMS,
  itemsOf,
  editable,
  readonlyItems,
  needsConfirm,
  needsRestart,
  find,
  describe,
  validate,
  coverage,
  summary,
} from './panel.mjs'

// 概念地图
export {
  DOMAINS,
  DOMAIN_IDS,
  REGIONS,
  REGION_IDS,
  DETAIL_KINDS,
  NAV_SECTIONS,
  DETAIL_KIND_LIST,
  regionOfDetail,
  domainLabel,
} from './taxonomy.mjs'

// 自述口径
export {
  VISIBILITY,
  capabilityBrief,
  CAPABILITY_RULE,
  SELF_CHECK_RULE,
  CORRECTION_RULE,
  PROGRESS_WORDS,
} from './capabilities.mjs'
