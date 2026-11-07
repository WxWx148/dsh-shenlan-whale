/**
 * view/index.mjs — 呈现：把运行态翻译成界面能直接画的结构。
 *
 * 这一层只回答「这一页该显示什么、这一条长什么样」，
 * 不判断业务（那是各父模块），也不发请求（请求由 index.js 路由进、浏览器自己发出去）。
 *
 * 落地现状（0.45.27）：
 *   panel-view.mjs  面板载荷 + 十区模块卡 + 详情视图（设计里的 index + cards 合在一处）
 *   qqview.mjs      会话列表 / 线程 / 概览（设计里的 qq）
 *   debug.mjs       诊断项与自检（设计里没单列，但它是「呈现自检现场」，归这里）
 *   list-view.mjs   七条只读列表的整形（/list/:kind 的数据侧）
 *
 * 两处**没搬**，各有硬理由：
 *   ① `lib/client.panel.js`（3,427 行浏览器端，设计里的 view/client.js）：
 *      宿主按 `package.json` 的 `dsh.client` 静态加载它，搬目录必须同时改宿主入口配置。
 *      当前宿主 429 限流、没有真机窗口，白屏无法发现 —— 等能打开界面时再动。
 *      另外设计里它是 1,200 行、按视图拆开的重写，本身就是重构。
 *   ② `lib/rules.mjs`（规则登记表 + 定位）：它是**真源**不是规则页，
 *      与 `truth/` 同性质。等 truth 第二批一起归位，别塞进 view 里制造新的错位。
 *
 * `REGIONS` 不在这里再导出一次：它的唯一出处是 `truth/`，panel-view 里那句
 * `export { REGIONS }` 只是历史转发，外部全部从 truth 拿。
 */

export {
  CARD_PARTS,
  PAGE_CARDS,
  SIDEBAR,
  agoText,
  channelFace,
  countText,
  detailView,
  moneyText,
  panelView,
  rateText,
  skillFace,
  spanText,
  withUnit,
} from './panel-view.mjs'

export {
  THREAD_PAGE_SIZE,
  listConversations,
  overviewOf,
  peerOf,
  thread,
} from './qqview.mjs'

export { DEBUG_ITEMS, runDebug } from './debug.mjs'

export { LIST_KINDS, listOf } from './list-view.mjs'
