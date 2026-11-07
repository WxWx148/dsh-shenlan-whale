# 深蓝鲸 · 模块划分与结构重构方案（v2 / 0.44）

> 本版取代同日 v1 与本仓库其余设计文档（`CONCEPTS` `SCHEME` `PLAN` `UX` `OPTIMIZE` `REWRITE`）。  
> 设计只留这一份。变更留 `CHANGELOG.md`。数字由命令生成，不手抄。
>
> **v2 相对 v1 的三处升级**（v1 的诊断、清理清单、迁移判据仍然有效，已并入）：
>
> 1. 从"40 个平铺模块"改为 **12 个父模块 + 内聚子模块**的四级层级，并给出**可静态检查的调用规则**；
> 2. 合并同类项的标准从"文件变少"改为"**契约变少、跨模块边变少**"——文件数会变多，跨模块边会减半；
> 3. 新增第 5 章「参数可达性」：**每一个不能默认运行的参数**，逐个列出它现在为什么用不了、在界面上哪一格、几步能修好。已实证出 3 个"读了却没登记"的幽灵键。

---

## 0. 结论

**功能已经够了，是结构在拖它。**

54 个模块、24,719 行（不含入口）、53 个用例全绿、5 个检查脚本全绿。问题不在缺能力，而在三件事：

| # | 判断                              | 依据                                                                                                |
| - | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1 | 12 个父级职责被摊平成 54 个平铺模块 + 入口 + 前端 | 大小差 36 倍（2,234 行 vs 62 行），谁是父谁是子看不出来                                                              |
| 2 | 同一个决定散在多个文件，且互相喂参数              | "能不能说"在 `route` 与 `outbound` 各判一次；节奏三处口径取 `max`                                                   |
| 3 | 参数齐全但不可发现，甚至有"幽灵键"              | 96 键都在面板，但 `channel.qrcodePath` **读了却没登记**；`modelProvider`/`model` 曾同类，已补（见 §8.0） |

**这版要做的三件事**：把 56 个代码文件收成 **12 个父模块**；让父子关系与调用方向**可检查**；让每一个"默认跑不起来"的参数**在界面上有位置、有解释、有一步修好**。

目标形态：顶层单元 56 → **13**（12 父 + 入口）；跨父模块 import 边 279 → **≤110**；单文件 2,234 → **≤450**（业务）/ 750（能力·通道）；最长函数 1,450 → **≤200**；真源 5 张清单 → **1 张**；设计文档 6 份 → **1 份**；幽灵键 1 → **0**。

---

## 1. 现状复核

### 1.1 体量（可复现）

| 项        | 值                                                                                 | 复现                                                 |
| -------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| 入口       | `index.js` 1,810 行                                                                | `wc -l index.js`                                   |
| 运行时      | 54 模块 / 24,719 行（另 `client.js` 2,755 行）                                           | `cat lib/*.mjs lib/qq/*.mjs \| wc -l`              |
| 最大三件     | `turn` 2,234 · `panel-view` 2,210 · `index` 1,810（合计 6,254 = 24%）                 | `wc -l lib/*.mjs index.js \| sort -rn`             |
| 最薄五件     | `refusals` 62 · `intent` 79 · `ticker` 107 · `capabilities` 117 · `selfcheck` 118 | 同上                                                 |
| 最长函数     | `Turn.handle()` 1,450 行                                                           | `turn.mjs:780–2234`                                |
| 依赖边      | 279 条 / 125 文件                                                                    | `node scripts/check-layers.mjs`                    |
| 出度最高     | `index` 27 · `turn` 19 · `runtime` 18                                             | 同上                                                 |
| 配置 / 面板  | 96 键 / 123 项（可改 96、只读 27、高危 5、需重启 3）                                              | `check-config-consumers.mjs`、`panel.summary()`     |
| 能力 / 规则  | 41 技能 / 65 工具 / 6 组；24 条规则 + 3 缺口                                                 | `CATALOG.length`、`createTools({}).names()`、`RULES` |
| 路由 / 定时器 | 41 条 / 11 个                                                                       | `grep -c "route === " index.js`、`ticker.every`     |
| 测试 / 检查  | 53 用例全过；5 个脚本全绿；`chain.test` 63 项                                                 | `npm test`、`npm run check`                         |

### 1.2 三处新实证（v1 没查到的）

| 现象             | 证据                                                                                                                                    | 后果                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **幽灵键**        | `host.mjs:43` 读 `config.modelProvider` / `config.model`；`index.js:1392` 读 `config.channel?.qrcodePath` —— **三个键都不在 `DEFAULTS`，也不在面板** | 代码在等一个没人声明的配置                                                                    |
| **提示指向不存在的入口** | `host.mjs:96` 报错原文："请先在对话页选择模型，或在配置里填 `modelProvider`/`model`"                                                                        | 用户照做 → `migrate()` 只保留 `DEFAULTS` 里的键 → **填了也会被丢掉**（`config.mjs` 的 `dropped` 分支） |
| **默认值写死作者机器**  | `channel.napcatBat` 默认 `E:\深蓝鲸\启动NapCat.bat`，面板 placeholder 也是同一路径                                                                    | 换机器/换目录后自动登录静默失败，用户不知道是"路径不对"                                                    |

### 1.3 五个结构病（保留 v1 证据，压缩表述）

| # | 病        | 硬证据                                                                                                                                          | 目标                   |
| - | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1 | 装配层变第二内核 | `index.js` 1,810 行：41 路由 + 11 定时器 + 出站闸门 + 自发去重 + 审批投递                                                                                       | 入口 ≤220；路由/定时/出站各归其位 |
| 2 | 一轮对话是单函数 | `handle()` 1,450 行，靠 15 段注释分节；`turn` 出度 19                                                                                                   | 7 段，每段 ≤250，可单测      |
| 3 | 发言决策被切六份 | `route()` 收 `guardAllowed`、`outbound()` 又调 `guard.check()`（顺序相反）；两套去重（`index.js:293–370` vs `dedupe.mjs`）；节奏三口径取 `max` 致 `firstDelayMs` 可能无效 | 一条 8 道闸门链 + 统一节奏公式   |
| 4 | 五张平行清单   | `config` 93 / `panel` 120 / `taxonomy` 7 域 / `rules` 24 / `skill` 41+`tools` 65，靠 5 个脚本对账；`capabilities.mjs:41` 引用了**不存在**的 `group_patrol`   | 一张清单派生六处             |
| 5 | 文档即第二代码库 | 6 份设计文档 1,992 行；`PLAN.md` 引用 5 个不存在的模块 + 不存在的 `webui/`；`CONCEPTS.md` 模块表缺 16 项；注释 171 处"以前/旧版/历史"                                            | 设计 1 份 + 变更 1 份      |

---

## 2. 模块怎么分、怎么连

### 2.1 一条判据

> **一个模块 = 一个可以被单独否定的决定。**

- 能单独说"这块不要了"而不影响别的 —— 它是一个模块（如 `voice`：不要人话层，直接把原文发出去，系统仍然成立）。
- 说"不要它"就必须同时改另一个文件的判断 —— 它们本来是一个模块（如 `guard` 与 `typing`：都在算"这条什么时候发"）。
- 不能单独否定、也不承载决定的 —— 它是子模块或一段函数（如 `cnNumber`、`msOf`）。

这条判据同时管住两头：**不会把一件事拆成两个模块**（边界清晰），**也不会把两件事塞进一个模块**（职责不混）。

### 2.2 四级层级

| 级      | 是什么                                    | 命名                    | 能不能跨级调用               |
| ------ | -------------------------------------- | --------------------- | --------------------- |
| **L0** | 入口                                     | `index.js`            | 只调 `app`              |
| **L1** | 父模块（11 个）                              | 一个目录，含 `index.mjs` 门面 | 只能调更下游的父模块门面          |
| **L2** | 子模块（内聚，嵌在父目录内）                         | `父/子.mjs`             | 同一父内可互调；**外部只能经过父门面** |
| **L3** | 段（stage / gate / handler / timer task） | 函数，不跨文件               | 只在同文件内调用              |

```
L0  index.js
     │
L1   app ──▶ turn ──▶ decide ──▶ voice ──▶ mind ──▶ ability ──▶ facts ──▶ truth ──▶ base
     │        │                                              ▲
     ├──▶ life ──────────────────────────────────────────────┘
     ├──▶ view ──▶ facts / truth
     └──▶ channel ──▶ facts / base
L2   父模块内部的子模块（外部看不见）
L3   子模块内部的段（闸门、阶段、处理器）
```

### 2.3 五条调用规则（全部可静态检查）

| #      | 规则                                                                                        | 检查方式                                          | 现状                                                     |
| ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| **R1** | 跨父模块只能 `import` 对方的 `index.mjs`；不许 `../foo/bar.mjs` 直插子模块                                 | 扫 import 路径：跨父路径末段必须是 `index.mjs`             | **0 违例（0.46.0）**；门面纪律已全覆盖                                  |
| **R2** | 同一父模块内的子模块可互相 import，不限方向                                                                 | 白名单（同父路径豁免）                                   | —                                                      |
| **R3** | 只能向下调用。唯一例外：`ability` 需要上层能力时**不许 import**，由装配层注入 `ctx.mind.*` / `ctx.life.*` | 检测 `ability` 是否 import 了 `mind`/`life`/`turn` | **0 违例（0.46.0）**：`createTools({ mind, life })` 注入，缺了报 `not_wired` |
| **R4** | 只有 `facts/ledger` 与 `view` 可以**读账本**；写账本只有 `facts` 自己                                     | 扫 `.append(` / `.read(` 调用点                   | `index`、`sandbox`、`approvals` 都在写，属违规                  |
| **R5** | 能力层不许 import 表达层                                                                          | 禁用边 `ability → voice`                         | **0 违例（0.46.0）**：`guardPlan` 迁 `decide/speech.mjs`，边消失       |

R1/R3/R5 三条 0.46.0 全部收敛为 0 违例；它们与其余守卫的口径统一登记在 `truth/audit.mjs`
（`npm run audit` 一条命令，红/绿明确，11 道）。R4 在迁移期分批收敛，不一次卡死。

### 2.4 允许的协作（三条横向 + 一条反向）

- **横向一：`turn → decide`** —— 一轮对话向"该不该说"要一个结论。这是唯一允许的高频横向调用。
- **横向二：`app → 所有`** —— 装配层本来就是"把大家接起来"的，它调谁都不算越界。
- **横向三：`view → facts`（只读）** —— 界面必须能读账本，但不能写。
- **反向一：`facts` 的事件/审计是唯一"由下往上"的信息流** —— 下层不回调上层，但下层可以往账本里写，上层下一轮自己读。这就是"协作但不耦合"的实现方式：**用账本解耦，而不是用回调**。

现在系统里 `runtime.outbound` 这类"下层调上层"的回调口，全部收进 `app`，不再作为运行时的公共方法暴露。

---

## 3. 目标结构

### 3.1 目录树（父模块 = 目录，`index.mjs` = 门面）

```
深蓝鲸/
├── index.js                      180   宿主契约：name / inject / apply / dispose
│
├── app/                          装配面（0.45.28 已落地，门面导出 23 符号）
│   ├── index.mjs                 62    门面
│   ├── runtime.mjs               1,570 Runtime：依赖容器 + 组装顺序 + 生命周期 + 定时
│   │                                  （设计里 index / context / timers 三件合在一处）
│   ├── chat.mjs                  288   出站唯一门：模型调用、工具循环、分条（设计里的 outbound）
│   ├── host.mjs                  213   模型适配
│   ├── events.mjs                92    SSE 事件流（/events 的推送侧）
│   ├── action.mjs                162   `POST /action {op,args}` 的写操作统一入口
│   ├── asset.mjs                 65    `GET /asset/:name` 的二进制资源分派
│   ├── failure.mjs               168   统一错误体（16 码登记表 + 归一）
│   └── build-info.mjs            211   「现在跑的到底是哪一份代码」
│
│   注：根 `index.js`（路由 + 组装入口）**没搬**——它是 `package.json` 的 `main`，
│   宿主按这个路径加载插件，搬进 `app/` 就要改宿主注册，而当前 429 无真机窗口。
│   设计里 `routes.mjs`（41 条路由一张表）也是把 1,500 行路由改写成表，属重构。
│   `lib/blueprint.mjs` / `structure.mjs` / `rules.mjs` 三者都是**真源**
│   （父模块声明 / 结构查询 / 规则登记），归 `truth/` 第二批，不塞进 app。
│   `RISK` 不在门面再导出：唯一出处是 truth/（同 BEHAVIOR、REGIONS）。
│
├── turn/                         一轮对话（门面：handle / chat；0.45.23 已落地）
│   └── index.mjs                 2,236  整轮实现（当前是单体，尚未拆 7 段）
│   （设计目标：index.mjs 只做编排，把 intake/understand/recall/compose/
│     generate/tools-loop/emit 七段拆到 stages/，属重构，留 turn 第二批。
│     拆分不动外部导入 —— 大家始终只认 turn/index.mjs）
│
├── decide/                       纯判断（无 IO、无模型；0.45.22 落地，0.46.0 补 speech）
│   ├── index.mjs                 76    门面（八件原样透出）
│   ├── behavior.mjs              205   事件 → 行为，只有一张路由表说了算
│   ├── attention.mjs             341   群里「现在在跟谁说话」的注意力账本
│   ├── intent.mjs                79    主人要办什么 + 我能看到什么
│   ├── speech.mjs                44    出口闸门：执行前必须先说一句人话（guardPlan）
│   ├── guard.mjs                 264   该不该说话、该等多久
│   ├── burst.mjs                 243   连发合并
│   ├── cadence.mjs               173   说话节奏：什么时候开口、隔多久说一次
│   └── dedupe.mjs                264   出口去重：同一件事，不发第二遍
│   （speech 之前长在 voice/say.mjs 里，于是 ability/sandbox 为了跑代码得 import
│     表达层 —— 方向是反的。0.46.0 搬过来，`ability → voice` 这条边消失。
│     设计里 route 与 intent 的合并仍未做：那是改判定表，不是搬家。）
│
├── voice/                        人话层（门面：render）
│   ├── index.mjs                 140   编排 + 卡片
│   ├── split.mjs                 180   按语义断句
│   ├── tone.mjs                  160   长度 / 语气 / 密度
│   └── clean.mjs                 140   标记清洗 / 防空 / 脱敏
│
├── mind/                         心智（0.45.24 落地，0.46.0 拆出 learn/；门面导出 32 符号）
│   ├── index.mjs                 62    门面
│   ├── memory.mjs                601   事实 / 人物 / 自我 / 群 + 网络游走
│   ├── persona.mjs               431   人设文件（分节 + 历史 + 回滚）
│   ├── wants.mjs                 120   需求本
│   ├── refusals.mjs              63    「这一阵子不想理谁」的登记簿
│   └── learn/                         从发生过的事里学（设计里的四分法）
│       ├── induction.mjs         181   从事件流/行为流归纳可验证的结论
│       ├── habits.mjs            385   说话习惯基线
│       ├── selfcheck.mjs         119   自查结论账本
│       ├── weights.mjs           132   四个旋钮的形状：上下限/默认值/校验/单步钳制（纯）
│       └── evolve.mjs            330   怎么学：证据、窗口、版本、回滚（有状态）
│
│   注：`weights.mjs` 是 0.46.0 从 `evolve.mjs`（原 493 行）里剥出来的。
│   判据是「把它单独拎出来能不能跑」—— 纯函数不该被绑在一个有状态的进化器上，
│   面板想显示「记忆留多久」也不该先造一个 Evolver。
│   `learn/evolve.mjs` 末尾 `export { BEHAVIOR }` 是从 decide/ 转发的，门面不再转一次。
│
├── ability/                      能做事（0.45.25 已落地，门面导出 82 符号）
│   ├── index.mjs                 124   门面（tools/ exec/ media/ 三组子目录未拆）
│   ├── skill.mjs                 937   会什么、练到什么程度、关没关（设计里的 registry）
│   ├── tools.mjs                 1,712 工具表：注册表 + 参数校验 + 失败翻译 + 实现
│   ├── sandbox.mjs               685   沙箱：闸门 + 独立进程 + 配额熔断（设计拆 exec/ 四件）
│   ├── approvals.mjs             438   悬挂 / 等人 / 超时 / 记住
│   ├── coding.mjs                510   读/改/跑自己的源码
│   ├── media.mjs                 242   收图即存 / 去重 / 清理（设计里的 media/images）
│   ├── stickers.mjs              299   表情库
│   ├── forward.mjs               171   合并转发展开
│   ├── web.mjs                   354   联网（driver 化，浏览器可选）
│   ├── browser.mjs               442   CDP + 有状态浏览
│   └── cdp.mjs                   241   本机浏览器的 CDP 通道
│
│   注：设计里的 `tools/`（index + 5 个域）、`exec/`（gate/runner/breaker/approvals）、
│   `media/`（images/stickers/forward）三组子目录仍平铺。拆 tools 要按域切开 1,715 行
│   并重做注册表（65 个工具的取用方式全变），拆 exec 要把 sandbox 里「闸门/进程/配额」
│   三段判定分开 —— 都是重构，功能零收益，0.46.0 复核后仍不做。
│   两个 `LIMITS` 撞名：skill 的保持 `LIMITS`，coding 的以 `CODING_LIMITS` 导出。
│   **0.46.0：本层不再 import 任何父模块**（truth 除外，那是纯真源）。需求本与提醒
│   解析由装配层注入 `createTools({ mind, life })`，缺了就是 `not_wired`。
│
├── life/                         自主（0.45.26 已落地，门面导出 11 符号）
│   ├── index.mjs                 36    门面
│   ├── activity.mjs              191   三段式活动（没人叫时做真的事）
│   ├── reminders.mjs             359   到点提醒 + 自然语言时间
│   └── activity-usage.mjs        236   活动自己的 token 账（设计里的 meter，刻意不改名）
│
│   注：设计与实现的对应关系有两处偏差，都是刻意保留：
│   ① 设计里 `meter.mjs` 就是 `activity-usage.mjs`。改名不影响行为，但会把
│      「账本落盘文件 activity-usage.json」和「详情行 id activity-usage」这两处
│      数据契约的关系搞乱，收益为零。
│   ② 设计里 `life/index.mjs`（160 行编排）没有独立文件，三段式活动本身由
│      `runActivityStep()` 串起来，再套一层编排只会变成空转发。
│   `ability → life` 这条边在 0.46.0 已经没有了（改成装配层注入）：
│   以前 activity 用联网、tools 用 reminders，两边都走门面会成环，
│   于是 tools 指向 `life/reminders.mjs` 具体文件断环 —— 现在不需要这个例外。
│   现状是单向：`life → ability`（联网），没有反向。
│
├── view/                         呈现（0.45.27 已落地，门面导出 22 符号）
│   ├── index.mjs                 51    门面
│   ├── panel-view.mjs            2,318 面板载荷 + 十区模块卡 + 详情（设计里 index + cards 合一）
│   ├── qqview.mjs                231   会话列表 / 线程 / 概览（设计里的 qq）
│   ├── debug.mjs                 219   诊断项清单与自检
│   └── list-view.mjs             104   七条只读列表的整形（/list/:kind 数据侧）
│
│   注：`client.panel.js`（3,427 行浏览器端，设计里的 `view/client.js`）**没搬**。
│   宿主按 `package.json` 的 `dsh.client` 静态加载它，搬目录必须同时改宿主入口配置，
│   而当前宿主 429 限流、没有真机窗口 —— 白屏无法发现。等能打开界面时再动，
│   届时它也该按视图拆成 1,200 行左右，属重写不属于搬迁。
│   `lib/rules.mjs`（规则登记表 + 定位）也没塞进 view：它是**真源**不是规则页，
│   与 truth/ 同性质，等 truth 第二批一起归位。
│   `REGIONS` 不在门面再导出：唯一出处是 truth/，panel-view 里那句只是历史转发。
│
├── channel/                      通道（门面：createChannel）
│   ├── index.mjs                 120   连接生命周期 + 出站队列
│   ├── onebot.mjs                1,060 协议：连、断、翻译、发动作
│   ├── napcat.mjs                1,120 进程与登录
│   └── backfill.mjs              180   掉线补回
│
├── facts/                        事实（门面：event / usage；0.45.20 已落地）
│   ├── index.mjs                      门面，导出 15 个符号
│   ├── event.mjs                 260   打标
│   └── usage.mjs                 460   token → 钱 → 预算
│   └─ ledger **未抽出**：四本账是 lib/runtime.mjs 用 base/journal.mjs 开的
│      events/behaviors/audit/cot/activities，读写散在 Runtime 里；
│      等拆 runtime 那一批按真实边界抽，不先造一层空转发
│
├── truth/                        控制面（0.45.21 落地，0.46.0 补 manifest/audit；43 → 52 导出）
│   ├── index.mjs                      门面：三件（config / manifest / audit）统一出口
│   ├── config.mjs                414   96 键形状 / 迁移 / 读写
│   ├── panel.mjs                 648   面板项清单（分组 / 风险 / 生效等级）
│   ├── taxonomy.mjs             131   七域 / 七页 / 详情类型
│   ├── capabilities.mjs         117   自述口径
│   ├── manifest.mjs             163   data / derive / check 三个投影（**全是现算的**）
│   └── audit.mjs                200   11 道守卫的口径清单（只描述，不执行）
│
│   `manifest` 不是第四个真源：它是 panel + taxonomy 的一次合并投影。
│   改 `panel.mjs` 一行，`check()` 立刻跟着变 —— 没变就说明这里藏了副本。
│   `audit` 同理：它只回答「有几道、各证明什么」，跑由 `scripts/audit-all.mjs` 负责 ——
│   truth 层不读盘、不起进程，这条线不为「看起来整齐」破。
│
└── base/                         无业务（直接 import，无门面）
    ├── io.mjs                    160   原子写 / 坏文件 / 路径
    ├── journal.mjs               490   追加账本 + 游标
    ├── log.mjs                   200   两轴日志
    └── ticker.mjs                110   定时器重入闸
```


**数字**：12 个父模块（`base` 无门面）+ 1 个入口；代码文件 56 → 82（门面/索引 17、实现 65）。

**为什么文件变多还要做**：新增的 26 个文件里，14 个是把 3 个巨物拆成的段（`turn` 7、`speech` 3、`manifest` 4），12 个是门面/索引。**真正的复杂度指标是"跨模块边"和"最大文件"，不是文件个数**：边 279 → ≤110，最大文件 2,234 → ≤750。

### 3.2 父模块契约表

| 父模块       | 门面导出（外部只能用这些）                                                          | 子模块                          | 允许调（门面）                                                | 绝对不许                                 |
| --------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `app`     | `createApp(ctx) → {routes, timers, outbound, dispose}`                 | 6                            | 所有                                                     | 不许有业务判断                              |
| `turn`    | `handle(raw)` / `chat(text)`                                           | index + 7 段                  | decide / voice / mind / ability / facts / truth / base | 不许直接 `channel.say`、不许自己算节奏           |
| `decide`  | `route(event, ctx)` / `planSpeech(parts, ctx)` / `intentOf(text)`      | route / intent / speech(3)   | facts / truth / base                                   | 不许发消息、不许写盘、不许调模型                     |
| `voice`   | `render(text, opts) → parts[]`                                         | split / tone / clean         | truth / base                                           | 不许判断该不该说                             |
| `mind`    | `memory` / `persona` / `learn` / `wants` 四个对象                          | 4 + learn(4)                 | facts / truth / base                                   | 不许发消息、不许改配置                          |
| `ability` | `registry` / `tools` / `exec` / `coding` / `web` / `browser` / `media` | 11                             | facts / truth / base + **`ctx` 注入（mind / life 由装配层给）** | 不许 import mind / life / turn / voice（0.46.0 起真的做到了） |
| `life`    | `tick(now)` / `plan(now)`                                              | activity / reminders / meter | ability / mind / facts / truth / base                  | 不许绕过闸门直接发                            |
| `channel` | `createChannel(cfg)` → `{start, stop, say, state}`                     | onebot / napcat / backfill   | facts / base                                           | 不许知道"回话"是什么                          |
| `view`    | `panelView()` / `detailView(id)`                                       | cards / rules / qq / client  | facts / truth / base                                   | 不许发网络请求、不许写                          |
| `facts`   | `event` / `ledger` / `usage` 三个对象                                      | 3                            | truth / base                                           | 不许解释语义、不许做统计结论                       |
| `truth`   | `manifest` / `config` / `audit`                                        | manifest / config / panel / taxonomy / capabilities / audit | base                                    | 不许执行、不许读业务数据、不许起进程                      |
| `base`    | 各文件直接导出                                                                | 4                            | 无                                                      | 不许认识任何业务字段                           |

### 3.3 三条主链（父子展开版）

**入站**

```
channel/index ──raw──▶ facts/event.tag ──▶ facts/ledger.append
                                              │
                                    turn/index.handle
                                              ├─ stages/intake      （去重/合并/拒绝/预算）
                                              ├─ decide/route       （该不该产生行为）
                                              ├─ stages/understand  （意图/引用/附件/转发）
                                              ├─ stages/recall      （mind.memory + mind.learn + persona）
                                              ├─ stages/compose     （提示词预算）
                                              ├─ stages/generate    （app/host）
                                              ├─ stages/tools-loop  （ability/tools + exec）
                                              └─ stages/emit        （voice/split + tone）
                                                        │
                                              decide/speech.plan（8 闸 + trace）
                                                        │ pass
                                              app/outbound（pacing → channel.say → ledger + usage）
```

**出站（定时器/提醒/审批/代发）**

```
app/timers ──▶ life/tick ──▶ decide/speech.plan ──▶ app/outbound ──▶ channel
view 代发 ─────────────────▶ app/outbound（跳过 pacing，不跳闸门）
```

**自主**

```
base/ticker ──▶ life/plan ──▶ ability（跑工具/沙箱）或 mind（读记忆）
                    └──▶ mind/learn.record（因果 + 权重版本 +1，可回滚）
```

### 3.4 合并账：为什么这些合、那些不合

| 合并（进同一个父模块）                                                   | 子模块怎么分                                 | 判据（能不能单独否定）                          |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `guard` `typing` `burst` `cadence` `dedupe` → `decide/speech` | 五道纯判定进 `gates.mjs`；"等多久"进 `pacing.mjs` | 不能。它们共同回答"这句什么时候发"，拆开就会互相喂参数（今天正是如此） |
| `say` `style` `semantic` → `voice`                            | 断句 / 语气长度 / 清洗，各一个文件                   | 不能。都是"把意思变成人话"的连续步骤，中间没有决定           |
| `behavior` `attention` → `decide/route`                       | 合为一个文件                                 | 不能。"这条话是不是冲我来的"只有一个答案                |
| `intent` `capabilities` → `decide/intent`                     | 一个文件                                   | 不能。都是"我该按哪种口径回答"                     |
| `induction` `habits` `evolve` `selfcheck` → `mind/learn`      | 四个子模块                                  | 不能。都从"发生过的事"里学，且都要能回滚                |
| `wants` `refusals` → `mind/wants`                             | 一个文件                                   | 不能。都是短期状态，都带过期                       |
| `sandbox` `approvals` → `ability/exec`                        | gate / runner / breaker / approvals    | 不能。确认只服务于 `ask` 档，分开会有"确认了但没执行"的空档   |
| `browser` `cdp` → `ability/browser`                           | 一个文件                                   | 不能。一个是通道一个是操作，操作依赖通道                 |
| `media` `stickers` `forward` → `ability/media`                | images / stickers / forward            | 不能。都是"把附件变成能读的东西"                    |
| `activity` `activity-usage` `reminders` → `life`              | activity / meter / reminders           | 不能。都是"到点做一件事"                        |
| `panel` `taxonomy` `capabilities` → `truth/manifest`          | data / derive / check                  | 不能。它们本来就是同一张清单的三个投影                  |
| `skill` → `ability/registry`                                  | 一个文件                                   | 收窄：只留技能簿，定义来自清单                      |
| `chat` → `turn`（`chat()`）                                     | 同一套 7 段                                | 不能。就是"不经 QQ 的一轮对话"                   |
| `debug` → `app/routes`                                        | 路由里的一组                                 | 不能。调试台就是"跑一次看结果"的路由                  |
| `qqview` → `view/qq`                                          | 一个文件                                   | 不能。会话视图属于呈现                          |

**不合并的（各留一个父模块）**：`base` 四件、`channel` 三件、`facts` 三件、`mind/memory` 与 `mind/persona`、`ability/coding` 与 `ability/exec`。

理由都是同一条：**它们各自能被单独否定**（不要通道 → 面板仍能用；不要 persona → 记忆仍成立；不要 coding → 沙箱仍能跑）。

### 3.5 能力清单（manifest）——唯一的定义处

一条记录描述一项能力的全部事实：

```js
{
  id: 'net.search',
  label: '上网搜一下',
  domain: 'skill', group: 'tools',
  tools: ['web_search', 'web_fetch'],
  needs: ['net'],
  config: {
    'net.allowlist': {
      label: '联网白名单', type: 'list', level: 'live', risk: 'medium', default: [],
      blocking: true,                        // ← 默认值会让本能力不可用
      fixHint: '至少加一个域名，例如 bing.com', // ← 一句话怎么修
      probe: 'net',                          // ← 能力体检里跑哪一项
    },
    'net.quotaPerHour': { label: '每小时上网次数', type: 'number', default: 60, min: 0, max: 200, unit: '次/小时' },
  },
  gates: ['net.allowlist', 'net.quota'],
  rule: '联网必须过白名单与每小时配额；被拦时说清是哪一道。',
  effect: '能查到时给结论；查不到说清缺哪一环。',
}
```

派生六处，全部自动：

```
manifest ─▶ config.DEFAULTS + validate + migrate
         ├▶ panel.PANEL_ITEMS（label/hint/unit/level/risk/group）
         ├▶ taxonomy（7 域 / 10 区 / 13 组）
         ├▶ view/rules（rule + 闸门现场值 + 缺口）
         ├▶ ability/registry（状态/熟练度/归属）+ /policy
         ├▶ decide/intent 自述（按 tools 真实注册表说话）
         └▶ docs 数字块 + 能力体检卡
```

---

## 4. 父子模块说明

格式：**意图**（为什么存在）· **边界**（不许做什么）· **逻辑**（输入→处理→输出）· **效果**（怎么算做到了）。

### 4.1 `app` —— 把大家接起来

| 子模块        | 意图              | 边界                           | 逻辑                                                                             | 效果                                             |
| ---------- | --------------- | ---------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `index`    | 组装与生命周期         | 不许有业务分支                      | `createApp(ctx)` → context → routes/timers → 返回 dispose；任一块失败只降级               | 卸载后 0 定时器 0 监听（`process._getActiveHandles` 断言） |
| `context`  | 构造顺序只写一次；向上注入能力 | 不许实现业务                       | 按 base→truth→facts→…→app 建；把 `mind.*` / `life.*` 塞进 `ctx` 供工具用（解 R3）           | 任一可选能力缺失仍可启动，面板能说清缺哪块                          |
| `routes`   | 41 条路由 = 一张表    | 单 handler ≤15 行              | `{method, path, role, handler}` + revision 中间件                                 | 新增路由改 1 行；未登记路由 404 且记审计                       |
| `timers`   | 11 个任务 = 一张表    | 任务体 ≤60 行、不许自己 `setInterval` | `{name, every, enabledKey, run}` + ticker 重入闸                                  | 每个任务在"过程"区有一行：上次跑 / 跳过几次 / 耗时                  |
| `outbound` | 出站唯一门           | 不生成内容、不判路由、不算节奏              | `speech.plan` → `voice.render` → `pacing` → `channel.say` → `ledger` + `usage` | 所有出站同一条 trace；"说过没记账"结构上不可能                    |
| `host`     | 一次模型调用          | 不管重试（在 `generate`）           | `ctx.llm` → `{text, usage}`；无模型时给人话 + 指向面板的模型设置                                | 模型不可用说清"哪一环没接上"，不抛内部错误                         |

### 4.2 `turn` —— 一轮对话

> 当前落地态（0.45.23）：`lib/turn.mjs` 整体迁入 `turn/index.mjs`（2,236 行单体），
> 判断/生成代码一行未动。下表是重构目标态（index 只编排、七段落位 `stages/`），
> 留 turn 第二批 —— 拆分要重写 `Turn` 类里重度共享 `this` 状态的方法，属判定链重构，
> 无真机窗口时不碰。拆分不动外部导入：大家始终只认 `turn/index.mjs`。

`index` 只编排；每段吃 `TurnState` 吐 `TurnState`；`handle()` ≤80 行。

| 段            | 意图                  | 边界       | 效果                                    |
| ------------ | ------------------- | -------- | ------------------------------------- |
| `intake`     | 这条要不要真的跑一轮          | 不解析内容    | 去重/合并/拒绝/预算四项各有断言；合并窗口=0 就是 0         |
| `understand` | 变成"要回答什么"           | 不检索、不调模型 | 引用/转发/附件/群上下文四类夹具，输出结构固定              |
| `recall`     | 取回"需要知道的事"          | 不拼提示词    | 记忆/归纳/习惯/自我四段可分别关，缺一段不崩               |
| `compose`    | 在预算内拼提示词            | 不调模型     | 超预算按固定优先级截断（现在散在 `buildPrompt` 300 行） |
| `generate`   | 调用 + 重试 + 超时 + 记账   | 不解析工具    | 只思考没正文重试一次；两次空给人话（保留 0.43.1）          |
| `tools-loop` | 解析 `[tool:x]`、执行、回灌 | 不自造工具名   | 未知工具回一行"没有这个"；轮数上限可配（0=不限）            |
| `emit`       | 分几条、交出去             | 不判断该不该说  | 拆几条只占一条额度（保留 0.43.1）                  |

### 4.3 `decide` —— 只判断，不执行

> 当前落地态（0.45.22）：`behavior` / `attention` / `intent` / `guard` / `burst` / `cadence` / `dedupe` 七件**原样**迁入门面，判断代码一行未动。下表是重构目标态（route / intent / speech 三件合并），留 decide 第二批，无真机窗口时不碰判定逻辑。

| 子模块             | 意图              | 边界                      | 逻辑                                                                       | 效果                                                 |
| --------------- | --------------- | ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `route`         | 该不该产生行为、哪一类、回给谁 | **不再接收 `guardAllowed`** | 纯函数：event + 开关 + 注意力窗口 → `{behavior, trigger, reason}`                   | 同一批 200 条真实事件，trigger 分布与今天 `behaviors.jsonl` 逐条一致 |
| `intent`        | 主人要办什么 + 我能看到什么 | 不生成文案                   | 意图表 + 自述由 registry 派生                                                    | 自述里的工具名 100% 存在（现在 `group_patrol` 不存在）             |
| `speech/index`  | 链的编排 + trace    | 不发消息、不写盘、不调模型（节奏算法除外）   | 8 道闸顺序执行 → `{parts, at, trace}`                                          | 每次拦截带 code + 人话 + 配置键                              |
| `speech/gates`  | 五道纯判定           | 不 sleep、不发送             | claim / will / budget / quota / repeat，各自 `(ctx) → pass \| hold \| drop` | 顺序被测试钉住；重复+超额的事件，`repeat` 必须先出现                    |
| `speech/pacing` | **唯一**的"等多久"    | 不改内容                    | 打字时长 + 间隔缺口 + 积压惩罚，夹到 [200ms, 15s]，扣掉生成耗时                                | 调大 `firstDelayMs`，实际等待必须变长（6 条断言）                  |

### 4.4 `voice` / `mind`

| 子模块            | 意图                     | 边界          | 效果                                    |
| -------------- | ---------------------- | ----------- | ------------------------------------- |
| `voice/split`  | 按语义断句，不按字数硬切           | 不改意思        | 「10 分钟前」这类时间词不被切断（保留现有用例）             |
| `voice/tone`   | 长度与语气（只留"跟模型默认不一样"的几条） | 不写人设        | 默认不渲染代码、不出现内部过程词                      |
| `voice/clean`  | 清洗标记 / 防空 / 脱敏         | 不改结构        | QQ 与面板只差外形                            |
| `mind/memory`  | 记住事实与人，按对话取一小段         | 不自动猜、不塞整段聊天 | 取回内容可解释（哪条、为什么被选中）                    |
| `mind/persona` | "我是谁"这份文件              | 不写"怎么说话"    | 改坏能退回任一版本（现在 `persona_versions` 面板只读） |
| `mind/wants`   | 短期意愿与拒绝                | 不做永久黑名单     | 到点自动失效，主人随时解除                         |
| `mind/learn/*` | 归纳 → 习惯 → 权重 → 自查，都可回滚 | 不改人格、不改规则   | 每次权重变化带证据行；连续变差自动回滚                   |

### 4.5 `ability` —— 能做事

| 子模块              | 意图                | 边界                   | 效果                            |
| ---------------- | ----------------- | -------------------- | ----------------------------- |
| `registry`       | 会什么、练到什么程度、关没关    | 不实现工具                | "你会什么"与技能页数字同源（不会一边 41 一边 39） |
| `tools/index`    | 注册表 + 参数校验 + 失败翻译 | 不判断该不该用              | 未登记工具不可调；失败给人话不抛栈             |
| `tools/*`（5 个域）  | 实现                | 只通过 `ctx` 拿上层能力（R3）  | 65 工具一个不少，按域可读                |
| `exec/gate`      | 静态闸门 + 路径边界       | 不执行                  | 命中即拒，原因写审计                    |
| `exec/runner`    | 独立进程 + 权限模型 + 超时  | 不管配额                 | 越界读写直接失败，不是"事后发现"             |
| `exec/breaker`   | 配额 + 熔断           | 不判内容                 | 连续越界降档 24h，面板红条               |
| `exec/approvals` | 悬挂 / 等人 / 超时 / 记住 | 只服务 `ask` 档          | QQ 私聊 + 面板两条路，60 秒超时按拒绝       |
| `coding`         | 读/改/跑自己的源码        | 不碰启动文件、不许无备份写        | 每次可一键还原；保护名单外一律拒              |
| `web`            | 联网                | 不绕白名单；**不把浏览器当默认路径** | 被拦说清是白名单还是配额                  |
| `browser`        | 有状态浏览             | 不许常驻不关               | 会话超时必回收；没浏览器时降级为"没接上"         |
| `media/*`        | 图片 / 表情 / 转发      | 不许无限落盘               | 一张图只存一份；超配额先清最旧               |

### 4.6 `life` / `channel` / `view` / `facts` / `truth` / `base`

| 父         | 子模块                                 | 意图                | 关键边界               | 效果                             |
| --------- | ----------------------------------- | ----------------- | ------------------ | ------------------------------ |
| `life`    | `activity`                          | 没人叫时做真的事          | 中间步骤必须有真实动作（不许编经历） | 活动日志每条带真实产物与消耗                 |
|           | `reminders`                         | 到点提醒              | 不做周期任务（那是 timers）  | "明天 9 点"能解析；取消能取消              |
|           | `meter`                             | 活动自己的 token 账     | 不重复计总账             | 概览卡数字来自独立账本，不是从思维链里数           |
| `channel` | `onebot`                            | 协议：连、断、翻译、发动作     | 不知道"回话"            | 掉线期间发消息进队、连上补发                 |
|           | `napcat`                            | 进程与登录             | 不碰消息               | 等扫码时绝不重启；每小时 ≤2 次              |
|           | `backfill`                          | 补历史               | 只记事实               | 补回来的不进回复链                      |
| `view`    | `cards`                             | 十区模块卡             | 不发请求、不判业务          | 首屏 3 秒；同一数据两处字面量一致             |
|           | `rules`                             | 规则页               | 不手写规则内容            | 规则条数 = 清单里 rule 数              |
|           | `qq`                                | 会话视图              | 不另存聊天记录            | 与 QQ 界面对得上                     |
| `facts`   | `event`                             | 打标                | 不判断回不回             | 同一批原始包 → 逐字段相同的 event（0.45.20 已落地） |
|           | `ledger`                            | 四本账 + trace       | 不做统计结论             | **目标态**：一条消息用一个 id join 全到。当前仍在 `lib/runtime.mjs`，见上方目录树注 |
|           | `usage`                             | token → 钱 → 预算    | 不决定"能不能花"          | 面板数字与账本逐条对得上（0.45.20 已落地） |
| `truth`   | `manifest`                          | 唯一定义处             | 不执行、不读业务数据         | 新增能力改 1 处；check 0 漂移           |
|           | `config`                            | 配置形状              | 不解释业务含义            | 96 键迁移幂等；**未知键不再静默丢弃**         |
|           | `audit`                             | 一条命令查八件事（含 R1–R5） | 只读                 | ≤10 秒出结论                       |
| `base`    | `io` / `journal` / `log` / `ticker` | 磁盘、账本、日志、定时器      | 不认识业务字段            | 断电不出现半个 JSON；轮转后翻页不重复          |


## 5. 参数可达性：不能默认运行的，界面上必须有位置

这一章回答一句话：**"想调，但找不到入口" 不许再发生。**

### 5.1 三类"默认不可运行"

| 类 | 定义 | 例子 | 问题 |
|---|---|---|---|
| **A · 空值即死** | 默认值是空的，而空 = 能力关闭 | `net.allowlist = []`（空=全拒）、`identity.ownerId = ''`（空=指令全废） | 面板有输入框，但**没有一处说"现在是死的"** |
| **B · 必填无默认** | 必须有值才能跑，但默认是空串或作者机器路径 | `channel.napcatBat = E:\深蓝鲸\…`、`browser.path = ''` | 失败信息只说"连不上 / 没接上"，不说"去填哪一格" |
| **C · 依赖外部条件** | 参数对了，但环境不具备 | NapCat 没装、Chrome 找不到、协议端不提供 `send_qzone_msg` | 面板不显示依赖是否具备，只能靠试 |

### 5.2 逐项清单（实测；状态按本轮改动更新）

| # | 参数 | 默认 | 默认会阻断什么 | 面板位置 | 状态 |
|---|---|---|---|---|---|
| 1 | `identity.ownerId` | `''` | 主人指令 / 审批回执 / 私聊豁免 / 回复优先级全失效（`route` 的 `IS_OWNER` 永远为假） | 身份「我的 QQ 号」 | **待补**：未配置横幅 + 一键"用当前私聊的 QQ 号填入" |
| 2 | `net.allowlist` | `[]` | 联网**全部拒绝**（`web.checkNet`：空 = 全拒） | 能力开关「联网白名单」 | **待补**：体检卡"0 个域名 = 不可用" + 推荐值一键写入 |
| 3 | `channel.napcatBat` | `E:\深蓝鲸\启动NapCat.bat`（**作者机器路径**） | 换机器后自动登录失败 | QQ 连接「NapCat 启动脚本」 | **待补**：默认改为自动探测 + 显示文件是否存在 |
| 4 | `browser.path` | `''` | 找不到 Chrome/Edge 且无处指定时，浏览器能力全死 | 能力开关「浏览器程序」 | **已补**：新键 + 面板项 + 传进 `findBrowser`；错误话术改为指向面板 |
| 5 | `modelProvider` / `model` | `''` / `''` | 宿主没选模型时，模型调用直接不可用 | 设置 →「模型」组 | **已补**：登记进 `DEFAULTS`、面板可改、报错改为指向该组 |
| 6 | `channel.token` | `''` | 协议端开校验时连不上 | QQ 连接「OneBot 令牌」 | **待补**：连接状态直接说"token 未配置，开校验就连不上" |
| 7 | `channel.selfId` | `''` | 多账号下无法确认"我是谁" | QQ 连接「登录的 QQ 号」 | **已补**：补 hint 说明"留空 = 用协议端当前登录的号" |
| 8 | `proactive.enabled` | `false` | 主动开口整块关闭（合理默认） | 自主活动「主动开口」 | **待补**：概览状态牌显示"现在是关的"+ 一键开 |
| 9 | `channel.watchdogEnabled` | `false` | 掉线不自愈 | QQ 连接「掉线自愈」 | **待补**：掉线时状态页提示"自愈未开" |
| 10 | `SHENLAN_DATA_DIR` | 环境变量 | 数据目录不可在界面改 | — | **接受现状**：只读显示当前目录 + 说明改法（不新增可写键） |

### 5.3 机制：三件套 + 两个检查

每个"能阻断能力"的配置项，在 `manifest` 里必须带三个字段：

```js
blocking: true             // 默认值会不会让所属能力不可用
fixHint: '至少加一个域名'    // 一句话怎么修
probe: 'net'               // 能力体检里跑哪一项（可空）
```

面板侧新增三样东西（不新增区域，都挂在既有区域里）：

| 位置 | 内容 | 为什么放这 |
|---|---|---|
| **概览 · 能力体检卡** | 一行一项能力：可用 / 缺什么 / 去改（跳到具体设置项） | "我现在到底能干什么"是用户第一个问题 |
| **设置 · 未配置横幅** | 只在 A/B 类项未填时出现在该分组顶部 | 就地解释，不让用户自己关联 |
| **每个配置项 · 三行证据** | 谁在读 / 读了几次 / 最近生效时间 | 把"改了有没有用"从猜变成看（见 §6.1） |

`truth/audit` 新增两条硬检查：

> **① `blocking: true` 的项，必须同时有面板入口、`fixHint`、所在能力的体检行。缺一即红。**
> **② 错误提示 / `fixHint` 里出现的配置键，必须能在 `panel` 里找到同名项。**

### 5.4 三条硬规则

1. **不许有幽灵键**：代码读的每个键必须在 `DEFAULTS` 里；`audit` 扫 `config.x` / `config.x.y` 与 `cfg()`，未登记即红。现存 1 个：`channel.qrcodePath`（只是个兜底读取，直接删）。
2. **不许静默丢键**：`migrate()` 丢弃未知键时写一条 `config_unknown_keys` 审计，并在面板显示"有 N 个未知键被忽略"。现在是静默。
3. **不许"能看不能改"**：只读项（27 个）必须写明"为什么不给改"（由谁决定），否则视为分类错误。

### 5.5 验收

| 项 | 现在 | 目标 |
|---|---|---|
| `blocking: true` 项的三件套 | 0%（字段不存在） | 100% |
| 幽灵键 | 1（`channel.qrcodePath`） | 0 |
| 提示指向不存在的入口 | 0（`modelProvider` 已修） | 0 |
| 10 个空值默认项里说明了"空等于什么"的 | 5（`net.allowlist` `tools.whitelist` `log.auditKinds` `browser.cdpUrl` `channel.selfId`） | 10/10 |
| 用户可调面（96 项）缺失 | 0 | 0（**不许回退**） |
| 每个键"改了会变"的断言 | 15 项关键开关 | 96 |

---

## 6. 控制面

### 6.1 运行时读取证明

现在 `audit:config` 静态扫描"这个键在代码里出现过"，并自己承认"只证明出现过，不等于改了会变"。改成访问器：

```js
const perMinute = cfg('guard.perMinute')      // 读一次，记一次
// consumerMap.get(key).add(module); hits++; lastUsedAt = now
```

面板每一项显示：**谁在读 / 读了几次 / 最近一次生效时间**。改完值，下一次行为就让 `hits` 涨 —— 这才是"真的被用上"的证据。

### 6.2 三档生效 + 危险项 + 回滚

| 机制   | 现状                                     | 重构后                              |
| ---- | -------------------------------------- | -------------------------------- |
| 生效时机 | `live` / `restart` / `readonly`，3 项需重启 | 保留；`restart` 项在面板给"重启后生效"按钮      |
| 高危确认 | 5 项二次确认 + 审计                           | 保留；确认框附带"影响范围"（闸门 / 技能 / 会话）     |
| 回滚   | 快照在 `.snapshots`，但不在发布包里               | 配置版本化（每次保存留一版，可回退到任一版）；代码回滚靠 git |
| 熔断   | 只有沙箱                                   | 扩到联网与通道：连续失败自动收紧并告知              |

### 6.3 权限四域五件套

| 域   | 范围          | 配额          | 审批      | 熔断          | 审计                                   |
| --- | ----------- | ----------- | ------- | ----------- | ------------------------------------ |
| 发消息 | 私聊/群/空间     | 分钟/小时/天     | 主人可静音   | 掉线进队，5 分钟过期 | `send_failed` / `outbound_duplicate` |
| 跑代码 | 沙箱工作区       | 次数/时长/内存/长度 | `ask` 档 | 连续越界降档 24h  | `sandbox_*`                          |
| 联网  | 域名白名单       | 次/小时        | —       | 连续被拦告警      | `net_denied`                         |
| 改自己 | 插件目录（保护名单外） | 每次备份        | 高危二次确认  | 写坏一键还原      | `code_write` + 备份路径                  |

### 6.4 面板信息架构

后端重构（P0–P4）期间**不动布局**：十个区域、248px 展开 / 56px 轨道、断点 720/480 全部保留，这一版只改"数据从哪来"。

界面本身的改造单独排在 **§10（UI--1 到 UI-4）**，与后端迁移解耦：先让数据先收口，再动皮。两个工程同时改会互相挡——重构期一旦布局也变，"这里怎么不一样了"就分不清是 bug 还是设计。

---

## 7. 死残留

判据只有一条：**它是不是还在描述现在**。

### 7.1 代码

| 位置                                                       | 问题                                            | 处置                                     |
| -------------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `index.js:223–237`                                       | 两段**完全重复**的孤儿注释                               | 删                                      |
| `index.js:265–274`                                       | `outbound` 的说明挂在这里，函数在 300 行且无注释              | 移到 `app/outbound` 函数头                  |
| `lib/browser.mjs:4`                                      | 写"和 `render.mjs` 的区别"——文件不存在                  | 改写                                     |
| `lib/qq/napcat.mjs:2` / `onebot.mjs:2` / `index.js:1406` | 三处指向不存在的旧路径                                   | 改新路径                                   |
| `host.mjs:43` / `index.js:1392`                          | 读了未登记的键（`modelProvider` `model` `qrcodePath`） | 要么登记，要么删（§5.2 #5）                      |
| 全库 98"以前" / 40"历史" / 27"旧版" / 6"曾经"                      | 讲"上一版怎么错"                                     | **保留"为什么不能那样做"的约束，删掉故事**；故事进 CHANGELOG |

判例：`// 旧版只存了「谁、什么时候」，于是面板答不了"他刚才跟谁聊了什么"` → 删前半，留 `// 正文必须落下来：面板与上下文都靠它`。

### 7.2 文档

| 文件                                                | 处置 | 说明                                        |
| ------------------------------------------------- | -- | ----------------------------------------- |
| `PLAN.md` 748                                     | 归档 | 整份失效（5 个不存在的模块 + `webui/` + 旧数据目录 + 84 键） |
| `SCHEME.md` 340                                   | 归档 | 数字由脚本生成                                   |
| `CONCEPTS.md` 110                                 | 删除 | 模块地图由 manifest 生成到面板                      |
| `UX.md` 468                                       | 归档 | 保留三条硬规则（三档术语 / 数字带单位 / "他/她"）             |
| `OPTIMIZE.md` + `REWRITE.md` 326                  | 归档 | 两轮已结束的推演                                  |
| `PARITY.md` 113                                   | 归档 | 对照停在 0.27.0，现 0.43.1                      |
| `CHANGELOG.md` 968                                | 改头 | "只有一个版本"与 16 个版本正文二者取一                    |
| `docs/changes.html` 226KB / `docs/reconcile-*.md` | 归档 | 与 CHANGELOG 重复 / 一次性记录                    |

结果：设计文档 6 份 1,992 行 → 1 份。

### 7.3 仓库

| 位置                  | 现状                                 | 处置                                |
| ------------------- | ---------------------------------- | --------------------------------- |
| `E:\深蓝`             | 0.40.0，**有 git**，落后 3 版            | 定唯一真源：git 迁到 `E:\深蓝鲸`，`深蓝` 降为发布镜像 |
| `E:\深蓝鲸\.snapshots` | 7.2MB / 390 文件 = 体积 72%，且被审计脚本当源码扫 | 移出项目根，回滚交 git                     |
| `probes/` 4 个       | 仍被 `npm run probe` 用               | 移入 `tests/probes/`                |

---

## 8. 迁移五期

每期独立验收、可回滚。**不做一次性重写**（这项目已重写一次：37,788 → 26,529 行）。

### 8.0 进度（2026-11-08 05:30）

| 项 | 状态 | 证据 |
|---|---|---|
| 唯一真源 = `E:\深蓝鲸` + git | **完成** | `git init`；基线 `9e2a9a4` → P0 `dedffb9` → 参数可达性 `e19b339`；`E:\深蓝` 保留为发布镜像 |
| 旧文档删除 | **完成** | 8 份旧文档 + `docs/` 两份已从仓库移除（副本在 `E:\深蓝鲸-archive\2026-11-07-docs\`，git 历史里也有） |
| `.snapshots` 移出 | **完成** | 移到 `E:\深蓝鲸-archive\snapshots-2026-11-07`；仓库 10MB → 4.3MB |
| 注释清理（§7.1 前 4 行） | **完成** | 两段重复孤儿注释、`outbound` 挂错位置的注释、3 处失效路径 |
| `modelProvider` / `model` 补齐 | **完成** | `DEFAULTS` 登记 → 面板「模型」组（2 项）→ 报错改指向该组；配置键 93 → 96 |
| `browser.path` + 两处空值说明 | **完成** | 新增键传入 `findBrowser`；`browser.cdpUrl` / `channel.selfId` 补"留空等于什么" |
| `check-config-consumers` 顶层键误判 | **修复** | 顶层键（无父名）以前永远判"没人读"；补 `config.<key>` 模式后 96/96 |
| **P1 第 1 批：`channel/`** | **完成** | `lib/qq/` 三件 → `channel/`，新增 `channel/index.mjs` 门面；守卫的 `QQ_LAYER` 改为 `channel/`；8 个用例的 import 走门面；126 文件 / 280 条依赖 0 违例 |
| **P1 第 2 批：`base/`** | **完成** | `core` `journal` `log` `ticker` → `base/`（无门面，按方案）；17 个文件的相对路径按新位置重算；基线四件的头注释同步改 |
| **P1 第 3 批：`voice/`** | **完成** | `say` `style` `semantic` `typing` → `voice/`，新增 `voice/index.mjs` 门面；`runtime` / `turn` / `sandbox` / `index` / 5 个用例 / 2 个脚本改走门面；126 文件 / 284 条依赖 0 违例 |
| 死脚本 `changes-board` | **删除** | 输出目录 `docs/` 已删除、基线 `深蓝鲸.bak-*` 不存在，脚本无法运行；`npm run board` 同步移除 |
| 「模型」组没出现 | **已定位并修复** | 不是代码问题：宿主加载的是 `~/.dsh/profiles/desktop/node_modules/` 的**副本**，源码改了没同步。已跑 `sync-to-profile`，副本与源码一致；界面上要看见还需重启 DSH。**长期解法见 §10.3 最后一行** |
| 全量回归 | **绿** | 965 条断言 0 失败；归属/文案/调用链三关全过；死码审计 0 死导出；配置 96/96 有消费者 |
| **UI-3a 可见宽度与对话页** | **完成**（0.45.4） | 断点从「容器宽度」改成「可见宽度」`min(container, viewport-left)`；前端上报扩成 5 个字段（`w/vw/left/ow/geo`），`head.build.client` 一句话回答「右边差多少像素」；真被裁时根节点自己收进可见区；对话页窄屏改成一屏一件事（列表 → 整页对话 + 返回），宽屏仍两栏。实测：窗口 1295 时容器 1002 → 窄屏整页详情；最大化后容器 1256 / 视口 1536 / 左偏移 280 = 刚好放下（`overflow:0`），自动切三栏 |
| **UI-3a′ 系统缩放与聊天底栏** | **完成并真机核对**（0.45.13） | 见 `CHANGELOG 0.45.13`。125% 缩放下宿主把 WebView 位图放大但布局视口没缩，CSS `y>653` 的内容（含输入框）整块落在窗口外；前端自证扩到 `dpr / screenX,Y / computed / elementFromPoint / 9 层 rect / scrollHeight`，定位后按 `inner/dpr` 双向收缩根节点（最后一环改成渲染后直接量 DOM 写 style），聊天底栏改成不依赖高度链的绝对定位。新增 R9 守卫。**实测**：root 1002×776 → 746×613、cut 0×0、输入栏底边物理 791 < 窗口 824，截图确认 textarea 与「发送」完整可见 |
| **UI-3b 接口收敛** | **完成**（0.45.19） | **42 → 14 条路由**（目标 ≤26）：0.45.14 删死接口 `/brief` `/hotnews/test` + 生效徽标（R10）；0.45.15 `/events` SSE 替 5 秒轮询（R11，宿主实测长连接不被掐）；0.45.16 七条只读列表收成 `/list/:kind`（R12，35 条）；0.45.17 二十一条写动词收成 `POST /action {op,args}`（R13 + 27 项参数映射用例）；0.45.18 `/asset/:name` 收两类二进制资源、写死前缀清零（R14 + 8 项用例，15 → 14 条）；0.45.19 统一错误体（R15 + 15 项端到端用例，形状见下注）。**真机 HTTP 核对待宿主 429 恢复**：代码/守卫/副本就绪，副本 63/63 模块真实 import 成功 |
| **P1 第 4 批：`facts/`** | **完成**（0.45.20） | `event` `usage` → `facts/` + 门面（15 导出）；37 处引用改走门面；规则表 `usage.total` 自动从 `pendingModule` 切成 `locatedBy:structure` → `facts/usage.mjs`。`ledger` 未抽出（本就不存在独立文件，见目录树注）。R6 当场报过发布清单漏 `facts/`；副本 73 文件 / 62 模块真实 import 全成功。全绿、无越层 |
| **P1 第 5 批：`truth/`**（第一批） | **完成**（0.45.21） | `config` `panel` `taxonomy` `capabilities` → `truth/` + 门面（43 导出）；37 处引用改走门面；`gen-structure.mjs` 硬编码的 `lib/taxonomy.mjs` 动态 import 同步改（不改会让 `npm run structure` 直接崩）。`blueprint.mjs` 按设计声明留在 `lib/`。**顺带修掉一个既有审计盲区**：`check-config-consumers.mjs` 以前只扫 `lib/`，`channel/base/voice/facts` 全不在视野，7 个键被误报「没人读」；改成从 `blueprint.PARENTS` 派生后核实 7 个键的真实消费者都在父模块目录里，加用例钉住范围不许缩回。删两个死变量。R6 报过发布清单漏 `truth/`；副本 74 文件 / 58 模块真实 import 全成功。**未做**：manifest 三表合一、audit 抽出（见目录树注） |
| P1 第 6–12 批（decide / turn / mind / ability / life / view / app） | **完成（0.45.28）** | 每批一次提交、测试全绿再进下一批。`lib/` 现余 3 个 `.mjs`（blueprint / structure / rules，均为真源）+ `client.panel.js` + `persona.default.md` |
| **P1 收口（0.46.0）**：R3 注入化 + R5 迁 speech + mind/learn + truth 三件 + HTTP 往返守卫 | **完成** | `ability` 不再 import mind/life/voice；`truth/manifest.mjs`（data/derive/check）与 `truth/audit.mjs`（11 道口径）；`npm run verify:http` 真 socket 走 14 条路由 0 问题；`npm run audit` 一条命令 11/11 |
| truth 第二批的剩余项 / turn 第二批（拆 7 段）/ ability 三组子目录 / `client.panel.js` 拆分 | **不做，理由已写死** | 见 `CHANGELOG 0.46.0` §七：前两项是改判定链，后两项要动宿主入口或重做注册表 —— 都不是「收尾」该做的事，不影响能装能跑能改 |
| **UI--1 / UI-1 数据侧** | **完成**（`ae41d11`） | `lib/blueprint.mjs`（12 父模块 / 域映射 / 别名）+ `scripts/gen-structure.mjs`（快照 58 文件 / 42 路由 / 318 导出）+ `lib/structure.mjs`（查询口）；规则 24 条 + 缺口 3 条改 `parent+symbol`，路径由结构解析；`modulesOf` 10 个 if → `CARD_PROVIDERS` 表；7 个域改成零重名（`identity/speech/cognition/autonomy/capability/budget/runtime`）；新增 `npm run check:ui` 六条守卫（R1–R6） |
| **UI-1 / UI-2 界面侧** | **完成**（0.45.0） | 页面 10 → 6（+诊断）：`REGIONS` 定名录、`PAGE_CARDS` 定组合；`ALIASES` 6 条随 `/panel` 下发，浏览器只翻译不抄表；同页重复详情去重（总览与花费都推「今天的账」）；宽屏 ≥1080 三栏常驻、窄屏整页详情带返回；删 `FALLBACK_NAV` / `FALLBACK_LAYOUT`，首帧画骨架；设置页加搜索、只读折叠、「N 项没保存」吸底条，`POST /config {items}` 批量写入。**实测**：宿主内截图确认 7 页与三栏生效；`head.build.client = {rev, width:1256, overflow:0}` |
| 同步脚本漏部署父模块 | **已修复**（`8fe44b6`） | `DEPLOY` 以前手写 6 项，P1 把 core/journal 搬进 `base/` 后没加 → 副本只有 `lib/`，宿主加载 `lib/runtime.mjs` 时 `ERR_MODULE_NOT_FOUND base/core.mjs`，插件整个不激活。现在清单由 `blueprint.PARENTS` 派生（目录存在就部署），并加**同步后模块图自检**：副本里任何相对 import 落不到文件就报错（这次当场列出 23 处）。指纹只比清单内文件，缺整个目录也说"一致"——所以自检不能只靠指纹 |

### P0 · 收口（1–2 天，零行为变更）

| 做什么                                           | 判据                            |
| --------------------------------------------- | ----------------------------- |
| 注释清理（§7.1）                                    | `npm test` 全绿；历史叙事 grep = 0   |
| 文档归档 + 本文上线                                   | 根目录设计文档 = 1                   |
| `.snapshots` 移出                               | 体积 10MB → 2.8MB；静态检查少扫 390 文件 |
| `manifest` 导出快照（96 键 / 123 项 / 41 技能 / 65 工具） | `manifest:dump` 与现状逐字段相等      |

**安全阀（P1–P4 全程）**：先冻结两份快照，重构后 diff 必须为空。

```
panel.dump()  → 123 项 × {key,label,hint,unit,level,risk,group}         ← 用户能改的面
policy.dump() → 65 工具 × {name,skills,off} + 41 技能 × {state,mastery}   ← 用户能关的面
```

### P1 · 立层级（**已完成**，0.45.28）

| 做什么                                                   | 判据                                                    | 结果 |
| ----------------------------------------------------- | ----------------------------------------------------- | --- |
| 建 12 个父目录，文件搬家，每个父加 `index.mjs` 门面（先只 re-export）      | 测试全绿；行为 0 变化                                          | ✓ 12/12 落地，`lib/` 只剩 3 个 `.mjs`（blueprint / structure / rules，都是真源）+ `client.panel.js` |
| 外部 import 一律改为走门面                                     | `check-layers` 新增 R1：跨父 import 末段必须是 `index.mjs`，0 违例 | ✓ 0 例外（0.46.0 之前唯一那个 `ability/tools.mjs → life/reminders.mjs` 已随注入化消失） |
| `ability` 不再 import `mind`/`life`，改由 `context` 注入（R3） | 0 违例；工具行为不变                                           | **✓ 完成（0.46.0）**：`createTools({ mind, life })` 注入，19 处调用改写；缺注入报 `not_wired`，用例钉住 |
| 把 `say.guardPlan` 迁到 `decide/speech`（R5）              | `ability → voice` 边消失                                 | **✓ 完成（0.46.0）**：`decide/speech.mjs`；`voice` 门面不再导出 `guardPlan`，`sandbox` 改从 decide 取 |

批次记录（每批一次提交、测试全绿才进下一批）：

| 批次 | 版本 | 内容 |
| --- | --- | --- |
| 1–3 | — | `channel/` `base/` `voice/` |
| 4 `facts/` | 0.45.20 | `event` `usage` + 门面（15 导出）；`ledger` 不存在独立文件，未造壳 |
| 5 `truth/` | 0.45.21 | `config` `panel` `taxonomy` `capabilities` + 门面（43 导出）；顺带修掉配置审计只扫 `lib/` 的盲区 |
| 6 `decide/` | 0.45.22 | 七件纯判断 + 门面（34 导出）；`route/intent/speech` 合并未做 |
| 7 `turn/` | 0.45.23 | 2,236 行单体迁入 `turn/index.mjs`；同时补齐副本加载验证的目录盲区（`verify:copy`） |
| 8 `mind/` | 0.45.24 | 八件 + 门面（32 导出）；`learn/` 子目录与 `weights.mjs` 未拆（后者不存在） |
| 9 `ability/` | 0.45.25 | 十一件 + 门面（82 导出）；`tools/` `exec/` `media/` 三组子目录未拆 |
| 10 `life/` | 0.45.26 | 三件 + 门面（11 导出）；**撞出并解掉一个真实的双向依赖环** |
| 11 `view/` | 0.45.27 | 四件 + 门面（22 导出）；`client.panel.js` 与宿主入口绑定，未搬 |
| 12 `app/` | 0.45.28 | 八件 + 门面（23 导出）；**修掉 `build-info` 指纹只算 5 个目录的失真** |
| 收口 | 0.46.0 | R3 注入化（19 处）、R5 `decide/speech`、`mind/learn/`（weights 独立）、truth `manifest`+`audit`、`verify:http`、`tests/all.mjs` / `probes/all.mjs`；**修掉结构生成器扫不到子目录的静默失真** |

### P2 · 出站治理（3–4 天）

| 做什么                                      | 判据                           |
| ---------------------------------------- | ---------------------------- |
| `speech` 六合一，先并行跑（新旧同时算，不一致只记日志）         | 录放 200 条真实事件，新旧结论一致率 100%    |
| 两套去重合一；`index.outbound` → `app/outbound` | 自发 90 秒同文仍拦；主人重复提问仍能再答       |
| 节奏统一公式                                   | 6 条断言：调大 `firstDelayMs` 必须变慢 |
| trace 落 `behaviors.jsonl`                | 面板"为什么没回"只读这一条               |

### P3 · 拆巨物（4–6 天）

| 做什么                            | 判据                              |
| ------------------------------ | ------------------------------- |
| `turn` → 7 段；`handle` ≤80      | 每段 ≥3 条单测；`chain.test` 63 项不动全过 |
| `index` → `app/*`；`Runtime` 解体 | 入口 ≤220；`entry.test` 不动全过       |
| `chat` 并入同一条链                  | 面板与 QQ 共用风格/权重/账本               |
| 录放回归（含工具轮/转发/引用/图）             | 出站逐条 diff = 0                   |

### P4 · 接管控制面 + 参数可达性（5–7 天）

| 做什么                                                   | 判据                                                  |
| ----------------------------------------------------- | --------------------------------------------------- |
| `manifest` 接管 config/panel/taxonomy/rules/registry/自述 | 删 `panel.mjs`/`taxonomy.mjs`/`capabilities.mjs` 后全绿 |
| `blocking` / `fixHint` / `probe` 三字段 + 能力体检卡          | §5.2 十项全部有三件套；幽灵键 0                                 |
| 配置访问器 + 消费计数                                          | 96 键全部有运行时证明                                        |
| `truth/audit` 一条命令八项（含 R1–R5）                         | 替代 3 脚本 + 2 测试，结论一致                                 |
| `tools` 按域拆 5 份                                       | 65 工具一个不少，`/policy` 不变                              |

**总工期 16–23 个工作日。** P0/P1 可立即开工；P2 之后每期结束打一个 git tag。

---

## 9. 验收

### 9.1 数字

| 指标              |                  现在 |                           目标 | 怎么量                   |
| --------------- | ------------------: | ---------------------------: | --------------------- |
| 顶层单元            | 57 个代码文件（`lib` 43 模块 + 3 个父模块） |            **13**（12 父 + 入口） | 目录树                   |
| 跨父模块 import 边   |                 279 |                     **≤110** | `check-layers`（同父内不计） |
| 门面违规（R1/R3/R5）  |                 未定义 |                        **0** | `audit`               |
| 单文件             |               2,234 | **≤450** 业务 / **≤750** 能力·通道 | `wc -l`               |
| 最长函数            |               1,450 |                     **≤200** | 各文件最长函数               |
| 入口              |               1,810 |                     **≤220** | `wc -l`               |
| 真源              |               5 张清单 |                        **1** | `manifest.check`      |
| 幽灵键             |                   3 |                        **0** | `audit`               |
| `blocking` 项三件套 |                  0% |                     **100%** | `audit`               |
| 用户可调面           |                  96 |                  **96（不许少）** | `panel.dump()` diff   |
| 设计文档            |         6 份 1,992 行 |                      **1 份** | 根目录                   |

### 9.2 四个动作（一个不懂代码的人能做完）

1. **问"刚才为什么不回我"** → 面板一处看到第几道闸、人话理由、改哪个键。不用开日志。
2. **关掉一项能力**（比如联网）→ 下一句就真调不到，自述里"能查"同步消失。不用重启。
3. **改一个节奏参数** → 下一条回复明显变慢。不再是"改了没反应"。
4. **新装一台机器，只看面板** → 能列出"现在哪些能力不可用、各缺什么、点一下修好"。

---

## 10. 界面：只认一份结构真源

上一版这一章是按「`lib/` 54 个平铺模块」写的。现在 `base/`（4 件）、`channel/`（3 件）、`voice/`（4 件 + 门面）已经落地，`lib/` 只剩 43 个模块。**界面里有四类信息是手抄源码的**，搬一次就失真一次——所以这一版重写，第一条不是布局，是"界面的事实从哪来"。

### 10.0 先认一件事：界面的"手抄"有四种形态

| 形态 | 现场证据 | 结构一动会怎样 |
|---|---|---|
| 抄路径 | `lib/rules.mjs` 24 条规则全是 `module: 'lib/xxx.mjs'` 字符串（分布：`voice` 4、`lib` 9、`channel` 4、根 3、`scripts` 3、`tests` 1）；缺口 3 条同样 | 搬 `voice` 时我**手改了 4 条**；接下来搬 `facts` / `mind` / `ability`，这 24 条会逐条失效，`tests/rules.test.mjs:63` 才事后报红 |
| 抄清单 | 页面清单存在 **3 处**：`taxonomy.REGIONS`（10）、`client.js` 的 `FALLBACK_NAV`（10）、`panel-view.modulesOf` 的 **10 个 `if (regionId === ...)`** | 合并页面要改 3 处，漏一处就是"导航有、内容空" |
| 抄数字 | 侧栏几何 **2 份**（`panel-view.SIDEBAR` 与 `client.FALLBACK_LAYOUT`），注释写着"有用例按字面量对账" | 改一个宽度要改两处，靠用例兜 |
| 抄前缀 | `panel-view.mjs:438` `:1549` `:1743` 写死 `/api/shenlan/...` | 换前缀/加鉴权改三处，漏一处就是白图 |

这四种的共同点：**界面在复述代码，而不是查询结构**。结构改了，界面不会跟着改，只会慢慢对不上——这正是"越用越乱"的机制。

### 10.1 先解决一个真冲突：域和父模块同名不同义

| | 数量 | 取值 | 界面拿它干什么 |
|---|---|---|---|
| `DOMAINS`（概念域） | 7 | `self` `voice` `mind` `life` `skill` `cost` `ops` | 13 个设置组的归类、详情页副标题「属于「心智」」 |
| 父模块（代码结构） | 12（规划） | `base` `channel` `voice` `facts` `decide` `turn` `mind` `ability` `life` `view` `app` `truth` | 目录、门面、调用规则 |

**其中 4 个同名或近名**（`voice` `mind` `life` `skill`≈`ability`），含义不一样：

- 域 `voice`（表达）= 什么时候开口、说几条；父模块 `voice/` = 成形 + 语气 + 断句 + 打字台。
- 域 `mind`（心智）= 记得 / 学 / 改自己；父模块 `mind/` 将来只装记忆与学习。

界面上写「属于「表达」域」时，用户会以为等于 `voice/` 目录。**两套词汇共用名字，是所有"说不清它归哪"的起点。**

改法：域 id 全部换成语义准、且与父模块**零重名**的名字，并显式声明映射（域 → 父模块）：

| 旧 id | 新 id | 中文 | 映射到的父模块 |
|---|---|---|---|
| `self` | `identity` | 身份 | `app`（装配）+ `truth`（自述） |
| `voice` | `speech` | 表达 | `voice` + `decide`（说不说） |
| `mind` | `cognition` | 心智 | `mind` + `facts` |
| `life` | `autonomy` | 自主 | `life` |
| `skill` | `capability` | 能力 | `ability` |
| `cost` | `budget` | 花费 | `facts`（记账）|
| `ops` | `runtime` | 运行 | `base` + `channel` + `view` |

改动面很小：`taxonomy.mjs` 7 行 + `panel.mjs` 13 行（`domain:` 字段），其余全部走 `domainLabel()`，自动跟随。

### 10.2 结构真源：一份 `structure.json`，界面只读它

```
npm run structure            # 扫目录 + import 各父模块门面，生成 lib/structure.generated.json
npm run structure --check    # 与源码比，不一致就退出码 1（CI / 提交前）
```

生成物内容（全部是事实，不含判断）：

| 字段 | 内容 | 谁用 |
|---|---|---|
| `parents` | 12 个父模块 → 文件清单 → **导出符号表**（`import()` 拿 keys，不解析文本） | 规则页、诊断页 |
| `pages` | 6 个页面（含旧 10 个 id 的别名）→ 图标 / 一句话 / 归属域 / 卡片 provider | 导航、中栏、深链 |
| `domains` | 7 个域（新 id）+ 每个域映射到的父模块 | 设置分组、详情副标题 |
| `api` | 前缀 `/api/shenlan`、路由表、8 个 detail kind | 前端拼 URL、守卫 R4 |
| `stats` | 文件数 / 行数 / 规则数 / 技能数 / 工具数 / 配置键数 | 面板上的数字，不再手写 |

**为什么是生成物，不是运行时扫描**：运行时 `readdir` 整棵树要 +200ms 启动开销，而部署包里只有运行时文件（`DEPLOY` 清单），开发目录才有 `tests/` `scripts/`。生成物还能进 git、能 diff、能在提交前发现"忘了重新生成"——这比"运行时碰巧扫对了"可靠。

### 10.3 界面各文件怎么改

| 文件 | 现在 | 之后 | 收益 |
|---|---|---|---|
| `lib/rules.mjs` | 24 条 `module: 'lib/turn.mjs'` 这类路径 | 改成 `parent: 'turn'` + `symbol: 'handleTurn'`；界面显示「表达 · 打字节奏」，路径由 `structure` 解析 | 搬目录**不用改规则表**；符号不存在时守卫当场报，而不是等文件找不到 |
| `lib/panel-view.mjs` | `modulesOf` 里 10 个 `if (regionId === ...)`，每个分支手写卡片 | 一张 `PROVIDERS` 表：`{ overview: buildOverview, mind: buildMind, ... }`，按 `structure.pages[id].provider` 分发 | 加页面 = 加一个 provider + 一条 structure，不改 if 链 |
| `lib/client.js` | `FALLBACK_NAV`（10 条）+ `FALLBACK_LAYOUT`（6 个数字） | **删除**。兜底只画骨架（侧栏灰条 + 内容占位），不抄内容 | 首帧闪烁消失，两份清单变一份 |
| `lib/panel-view.mjs` | 3 处写死 `/api/shenlan/...` | `assetUrl(name)` / `apiUrl(path)`，前缀来自 `structure.api.base` | 改前缀 0 处手改（0.45.18 已落地） |
| `lib/debug.mjs` | 9 条调试项，只有 id/label | 每条加 `parent`（落在哪个父模块），界面显示「检查落点：`channel`」 | 点一项就知道该看哪 |
| `lib/taxonomy.mjs` | 7 个域与父模块同名 | 换成 §10.1 的 7 个新 id + 映射 | 两套词汇不再打架 |
| `/panel` 的 `head` | 只报版本号 | 加 `build: {srcVersion, copyVersion, same, copiedAt}`；不一致时界面横幅「运行的是 20:03 的副本 · 点此同步」→ `POST /action {op:'self.sync'}` | 这次「没有模型」的根因，以后由机器发现，不靠人记 |

**关于"规则页显不显示文件路径"**：显。但它是**从 symbol 解析出来的**，不是写死的。用户看到的仍然是「`voice/typing.mjs` · `typingDelayMs()`」，只是这句话由结构生成——搬目录时它自己跟着变。

### 10.4 一致性守卫：`npm run check:ui`（新增 6 条，全静态）

| # | 规则 | 为什么 |
|---|---|---|
| R1 | `client.js` / `panel-view.mjs` 里除注释外**不许出现 `.mjs` 字面量** | 这一条直接掐死"抄路径" |
| R2 | 每条规则/缺口的 `parent` 必须在 `structure.parents` 里，`symbol` 必须在该父模块的导出表里 | 文案不会指向不存在的东西 |
| R3 | 每个页面必须有 provider；8 个 detail kind 必须各有渲染分支 | 现在靠用例兜，改成守卫兜 |
| R4 | 界面拼出的每个 `/api/...` 必须在 `structure.api.routes` 里 | 掐死"前端调了个不存在的接口" |
| R5 | `structure.generated.json` 与当前源码一致 | 忘了重新生成，当场红 |
| R6 | `package.json` 的 `files` 必须列出每个已落地的父模块目录 | 发布包缺 `base/` 和副本缺 `base/` 是同一个错：本地全绿、装完就崩 |

R1 是这版的核心断言：**只要界面不能写 `.mjs`，它就只能查结构。** 这不是风格要求，是把"偷懒"这条路堵死。

### 10.5 布局（沿用上一版结论，数字按现状校准）

**10 页 → 6 页 + 1 个诊断抽屉**（旧 10 个 id 全留别名，深链不断）：

| 新页 | 吸收 | 回答的问题 |
|---|---|---|
| `overview` 总览 | overview + usage | 它现在怎么样、今天花了多少 |
| `talk` 对话 | talk | 在跟谁说话、说了什么、我要插一句 |
| `mind` 心智 | memory + evolve | 记得什么、学到什么、能不能退回去 |
| `ability` 能力 | skills + rules | 会什么、被允许什么、被什么硬约束 |
| `channel` 连接 | connection | 连上没有、怎么登录、协议端在哪 |
| `settings` 设置 | settings | 我能改什么、什么时候生效 |
| 诊断（抽屉） | process | 出问题时：跑了什么、改过什么、试一次 |

**布局三档**（主内容不再是 880px 居中）：

| 断点 | 结构 | 详情 |
|---|---|---|
| ≥1280 | 导航 232 + 列表 380 + 详情自适应 460–760 | 第三栏常驻，点开**不离开列表** |
| 960–1279 | 导航 + 内容 | 右侧 480 抽屉 |
| <960 | 单栏两级 | 整页 + 明确返回 |

**每页只准四段**：`StatusBar`（3–6 个关键数，一行）/ `Primary` / `Secondary`（默认收起）/ `ActionBar`（有未保存才出现）。

**50 张卡片墙 → 44px ListRow**（设置 13 张变 13 行，一屏放下）。卡片只允许在"确实没有层级"时出现。

### 10.6 设置页重做（123 项 / 13 组 / 0 搜索的正面回应）

| 改动 | 做法 | 现在 → 之后 |
|---|---|---|
| 组列表 | 13 组按 7 个新域归并，每行右侧「可改 17 · 未配置 2」 | 卡片墙 → 一屏列表 |
| 搜索 | 顶栏输入框，匹配 `label` / 键名 / `hint` / 组名，`Ctrl+K`；结果带组名 | 0 → 1，覆盖 123 项 |
| 只读分离 | 27 个只读项折叠进「当前值（只读）」，默认收起 | 27 行不能动的表单 → 0 |
| 批量保存 | 吸底条「3 项未保存 · 保存 / 撤销」，`POST /config` 收数组，**全成功或全失败** | 123 个按钮 → 0 |
| 布尔例外 | 开关即时生效 + 一次「已生效」反馈 | 消灭"点了没反应" |
| 生效徽标 | 每项右上「立即 / 下一轮 / 重启」，数据来自已有 `LEVEL` | 不用再猜 |
| 危险项 | 5 个 `needConfirm` 不进批量，仍逐项确认 | 批量不能变成"一次全改坏" |

### 10.7 接口面（"端口"）

**插件不自己监听 TCP 端口**，路由全挂在宿主 `webServer` 的 `/api/shenlan`（`index.js:49`、`:1268`）。所以"端口"= 接口端点。基线 42 条 → 删 2 条死接口、加 `/events`、七条只读列表收成 `/list/:kind`、二十一条写动词收成 `POST /action`、两条二进制资源路由收成 `/asset/*` 后为 **14 条**（0.45.18），已低于 ≤26 的目标。

| 类 | 现在 | 之后 |
|---|---|---|
| 快照 | `GET /panel` 每 5 秒全量（空载 10 KB，真实 20–40 KB） | `GET /panel?since=<rev>`，未变回 `{rev, unchanged:true}` |
| 详情 | `GET /detail?id=` + 20 条 `/memory/*` 变体 | `GET /detail/:id` + `GET /list/:kind?before&limit` |
| 写 | 28 条，动词在路径里（`/memory/edit-group`、`/skill/amend`、`/memory/forget-self`） | `POST /config`（单条或数组）+ `POST /action {op, args}` |
| 资源 | 3 处写死前缀 | `GET /asset/:name`（0.45.18：只收二维码与落盘图片两类二进制；JSON 数据源走 `apiUrl()`） |
| 流 | 5 秒轮询 | `GET /events`（SSE）推 `rev`；前端 30 秒兜底 |
| 错误 | 各写各的字符串 | `{ok:false, error:'中文人话', code, hint, field?, retry}`（0.45.19）。**`error` 保持字符串、结构化字段并列**：界面 30+ 处按字符串读它，改成嵌套对象会静默显示 `[object Object]`。信息量与嵌套方案相同，`hint` 必须指向真实入口，R15 钉住形状 |

删 `/brief`、`/hotnews/test`（无任何调用方）。`/media/*` 与 `GET /napcat/qr` 已并入 `/asset/*`（探针同步改走 `/asset/media/...`）；`/vision/*` 保留，它是 JSON 自检接口不是资源。

**独立端口（可选，默认关）**：`external.enabled`（默认 `false`）、只绑 `127.0.0.1`、强制 token、只读暴露 `/status` `/usage`。默认关，且面板上写清"开了意味着什么"。

### 10.8 优化清单（这版新增）

| 优化 | 现状 | 之后 | 量级 |
|---|---|---|---|
| 首帧 | 每 5 秒算整棵树（10 个 region 分支 + 50 张卡 + 123 项设置） | 首帧只算 `nav + status`，卡片按区域懒加载 | 首帧 JSON ≤12 KB |
| 轮询 | 5 秒 × 20–40 KB | SSE 增量 + 30 秒兜底 | 一天 170–340 MB → <20 MB |
| 视图重建 | `modulesOf` 10 个分支每次都跑 | 只跑当前 region 的 provider | 每次刷新少 9/10 的工作 |
| 详情 | 整区替换，重拉全部 | 三栏常驻，按 id 增量取 | 切详情 0 次整页重绘 |
| 兜底 | 两份清单 + 两份几何 | 一份（structure） | 改一处生效 |

### 10.9 分期

| 期 | 内容 | 工期 | 验收 |
|---|---|---|---|
| **UI--1** ✅ | `structure.mjs` + `structure.generated.json` + `npm run structure --check` | 0.5 天 | **已完成**：58 文件 / 42 路由 / 318 导出；`--check` 通过 |
| **UI-0** | 抽 `lib/ui/` 骨架（PageShell / StatusBar / ListRow / ActionBar / Inspector），现有页面套壳 | 1 天 | 像素级不变，`client.js` 行数下降 |
| **UI-1** ✅ | 规则表改 `parent+symbol`、`modulesOf` 改 provider 表、域改名、删 FALLBACK、三栏 + 页面 10 → 6（+诊断） | 2 天 | **已完成**：7 个页面、旧 6 个 id 按 `ALIASES` 归位；宽屏三栏常驻、窄屏整页详情带返回；浏览器里 0 份页面清单、0 个断点数字 |
| **UI-2** ✅ | 设置页重做（搜索 / 只读折叠 / 批量保存） | 2 天 | **已完成**：搜索覆盖 123 项；27 个只读项折叠；每行「保存」按钮退成底部一条；`POST /config {items}` 已实测（`{ok, items:[…], failed:[]}`）。**未做**：生效徽标（数据已有 `LEVEL`，等 UI-3 与接口一起收） |
| **UI-3** ✓ | 接口收敛 + 统一错误体 + SSE + 删 2 条死接口 | 2 天 | **已完成**：42 → 14 条路由、5 秒轮询消失、删 2 条死接口、写操作三态齐、资源口统一 + 写死前缀清零、统一错误体（R15）。真机 HTTP 核对已由 `npm run verify:http`（0.46.0）常驻覆盖：真 socket 走 14 条路由 + 旧路由 404 + 错误体四字段，不再依赖「等宿主恢复」 |
| **UI-4** ◐ | `check:ui` 七条守卫（R1–R7）→ **已完成**；副本落后横幅 → **已完成**；`check:sync` 结果进界面 → 待做 | 1 天 | R1–R7 全绿；版本号下方的横幅已上线（磁盘比启动新 / 副本缺模块 / 源码比副本新三种状态）；前端还把实测宽度与溢出量随 `/panel` 上报，`head.build.client` 可查 |

**顺序不能倒**：UI--1 先把结构变成可查的事实，UI-1 才有东西可依。先做三栏再补结构，等于把"手抄"搬进新布局，白改一遍。

### 10.10 验收

| 指标 | 现在 | 目标 |
|---|---|---|
| 界面里的 `.mjs` 字面量 | 24 条规则 + 3 处前缀 + 若干注释 | **0**（R1 守卫） |
| 页面清单的份数 | 3（REGIONS / FALLBACK_NAV / modulesOf 分支） | **1**（structure.pages） |
| 侧栏几何的份数 | 2（SIDEBAR / FALLBACK_LAYOUT） | **1** |
| 改一项设置的交互 | 4 次 | **2** 次 |
| 1440 屏利用率 | 61% | **≥90%** |
| 首帧 JSON | 20–40 KB / 5 秒 | **≤12 KB + 增量** |
| 接口数 / 死接口 | 42 / 2 | **≤26 / 0** |
| 深链兼容 | — | 旧 10 个 region id **全通** |
| 结构搬目录后要手改界面 | 24 条里改 N 条 | **0** |

## 11. 已定与待定

**已拍板（2026-11-07，本轮按此执行）**

| # | 决定 | 落地情况 |
|---|---|---|
| 1 | 唯一真源 = `E:\深蓝鲸`；`E:\深蓝` 降为发布镜像 | 已 `git init`，7 次提交 |
| 2 | 旧文档删除 | 已删（副本在 `E:\深蓝鲸-archive\2026-11-07-docs\`，git 历史保留） |
| 3 | 接受代码文件 56 → 82 | 已确认，P1 按此执行（已完成 `channel` `base` `voice` 三批） |
| 4 | `modelProvider` / `model` 补齐成真配置 + 「模型」组 | 已完成（配置 96 键 / 面板 123 项 / 13 组），并已同步进运行副本 |

**仍待定**

| # | 问题 | 我的建议 |
|---|---|---|
| 5 | P4 要不要一次做完 | **分两半**：先"配置 + 面板"，再"技能 + 规则 + 自述" |
| 6 | P1 的推进方式 | **按父模块分批搬**（channel → base → voice → facts → …），每批一次提交、测试全绿再进下一批；不做一次性搬 54 个文件。**已按此执行 3 批** |
| 7 | 界面 §10 从哪期开工 | **先 UI--1**（`structure.json` + 守卫，界面 0 改动），再 UI-0 抽骨架。理由：先把结构变成可查的事实，后面的三栏与设置页才有东西可依；先改布局等于把手抄搬进新布局 |
| 8 | 6 页合并要不要做 | **做**，但放在 UI-1 之后、与三栏同批验收；旧 id 留别名，深链不断 |
| 9 | 独立端口要不要开 | **默认不开**。真需要就按 §10.7 的条件开：只读、只绑 127.0.0.1、强制 token、面板上有明确开关 |
| 10 | §10 与 P1–P4 谁先 | **穿插**：后端每搬完 2 批，做一期 UI。两条线互不挡，但也不并发改同一个文件（`client.js` 只归 UI 线） |
