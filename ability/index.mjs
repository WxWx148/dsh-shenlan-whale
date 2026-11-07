/**
 * ability/index.mjs — 能做事：会什么、怎么调、在哪儿跑、跑坏了怎么办。
 *
 * 这一层只回答「这件事能不能做、怎么做、做完留下什么」，
 * 不判断「该不该做」（那是 decide/），也不负责把结果说出口（那是 voice/ turn/）。
 *
 * 落地现状（0.45.25）：
 *   skill.mjs      会什么、练到什么程度、关没关（设计里的 registry）
 *   tools.mjs      工具注册表 + 参数校验 + 失败翻译（设计里的 tools/index）
 *   sandbox.mjs    独立进程 + 权限模型 + 配额熔断（把设计里 exec/{gate,runner,breaker} 合在一处）
 *   approvals.mjs  悬挂 / 等人 / 超时 / 记住（设计里的 exec/approvals）
 *   coding.mjs     读写跑自己的源码
 *   media.mjs      收图即存 / 去重 / 清理（设计里的 media/images）
 *   stickers.mjs   表情库
 *   forward.mjs    合并转发展开
 *   web.mjs        联网（driver 化，浏览器可选）
 *   browser.mjs    CDP + 有状态浏览
 *   cdp.mjs        本机浏览器的 CDP 通道
 *
 * 设计里的 `tools/`（5 个域）、`exec/`（4 件）、`media/`（3 件）三组子目录都没拆：
 * 拆 tools 要把 1,712 行按域切开并重做注册表，拆 exec 要把 sandbox 里
 * 「闸门 / 进程 / 配额」三段判定分开，拆 media 要区分 images / stickers / forward。
 * 三者都是重构而非搬迁，等有真机窗口再做。现在平铺，名字与职责一一对应，
 * 不画「目录像设计、代码还是单体」的假结构。
 *
 * 两个 `LIMITS` 撞名：skill 的（技能数量上限）保持 `LIMITS`，coding 的（源码大小上限）
 * 以 `CODING_LIMITS` 导出 —— 门面是唯一出口，不能让同名符号有两个来源。
 */

export {
  CATALOG,
  MASTERY,
  SKILL_GROUPS,
  SOURCE,
  STATE,
  SkillBook,
  allToolNames,
  bindWeights,
  blockedTools,
  brief,
  implementedTools,
  LIMITS,
  lineOf,
  looksBroken,
  masteryOf,
  missingImpl,
  promptLineOf,
  registerTools,
  resolveNeeds,
  skillIdOfTool,
  stateOf,
  toolOwners,
  toolsAllowed,
} from './skill.mjs'

export { calc, createTools, usageSourceOfTool } from './tools.mjs'

export { Sandbox, runnerPlan } from './sandbox.mjs'

export { ApprovalDesk, approvalText } from './approvals.mjs'

export {
  LIMITS as CODING_LIMITS,
  describe,
  isProtected,
  listTree,
  readSource,
  resolveInside,
  restoreBackup,
  rootOf,
  runCommand,
  searchSource,
  writeSource,
} from './coding.mjs'

export {
  attachImages,
  extOf,
  fetchImageBytes,
  mediaDir,
  mediaPath,
  persistImage,
  pruneMedia,
  saveImageBytes,
} from './media.mjs'

export { loadStickers, listStickers, pickSticker, resolveSticker, saveSticker } from './stickers.mjs'

export { FORWARD_READING_RULE, digestForward } from './forward.mjs'

export {
  checkNet,
  configureNet,
  lastNetDenied,
  netStatus,
  normalizeQuery,
  readWeb,
  searchWeb,
  searchWebDetailed,
} from './web.mjs'

export {
  clickIndex,
  closeSession,
  formatPage,
  historyAction,
  openUrl,
  readCurrent,
  screenshot,
  scrollPage,
  typeInto,
  uploadFile,
} from './browser.mjs'

export {
  CdpSession,
  closeTarget,
  findBrowser,
  freePort,
  killTree,
  launchBrowser,
  newTarget,
  waitForDevTools,
} from './cdp.mjs'
