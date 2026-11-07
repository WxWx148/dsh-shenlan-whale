/**
 * app/index.mjs — 装配面：把大家接起来，并对宿主暴露那几个入口。
 *
 * 这一层只回答「谁在什么时候被构造、请求怎么进来怎么出去」，
 * 不含业务判断（那些在 decide/ turn/ ability/ 里），也不含呈现（那是 view/）。
 *
 * 落地现状（0.45.28）：
 *   runtime.mjs      Runtime：依赖容器 + 组装顺序 + 生命周期（设计里的 index + context + timers 合在一处）
 *   chat.mjs         出站唯一门：模型调用、工具循环、分条（设计里的 outbound）
 *   host.mjs         模型适配
 *   events.mjs       SSE 事件流（/events 的推送侧）
 *   action.mjs       `POST /action {op,args}` 的写操作统一入口
 *   asset.mjs        `GET /asset/:name` 的二进制资源分派
 *   failure.mjs      统一错误体（16 码登记表 + 归一）
 *   build-info.mjs   「现在跑的到底是哪一份代码」
 *
 * 三处刻意留在原地：
 *   ① 根 `index.js`（路由 + 组装入口）：它是 `package.json` 的 `main`，宿主按这个路径
 *      加载插件。搬进 `app/` 要改宿主注册，而当前 429 无真机窗口 —— 与 `client.panel.js`
 *      同一个理由。设计里 `routes.mjs`（41 条路由一张表）也是把 1,500 行路由改写成表，
 *      属重构不属于搬迁。
 *   ② `lib/blueprint.mjs` / `lib/structure.mjs` / `lib/rules.mjs`：三者都是**真源**
 *      （父模块声明、结构查询、规则登记），归 `truth/` 第二批，不塞进 app。
 *   ③ `lib/persona.default.md`：默认人设，归 `mind/`，不是代码。
 *
 * `RISK` 不在门面再导出：runtime 里那句 `export { RISK }` 是历史转发，
 * 唯一出处是 `truth/`（同 0.45.24 的 `BEHAVIOR`、0.45.27 的 `REGIONS`）。
 */

export { Runtime } from './runtime.mjs'

export { Chat } from './chat.mjs'

export {
  cleanReply,
  createHostRunner,
  resolveModel,
  sessionIdOf,
  workspaceOf,
} from './host.mjs'

export { createEventHub, eventKeyOf } from './events.mjs'

export { ACTION_OPS, runAction } from './action.mjs'

export { ASSET_KINDS, assetOf } from './asset.mjs'

export {
  FAILURES,
  FAILURE_CODES,
  failure,
  failureFrom,
  normalizeFailure,
} from './failure.mjs'

export {
  SELF_DIR,
  brokenImports,
  buildInfo,
  runtimeFingerprint,
  sourceDirOf,
} from './build-info.mjs'
