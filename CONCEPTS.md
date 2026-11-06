# 概念与模块

这一份回答两件事：**东西放在哪**、**为什么这么分**。
具体的界面与交互看 `UX.md`，硬性契约（谁必须保证什么）看 `SCHEME.md`。

## 一、一句话

深蓝鲸是一个跑在本机的 QQ 人格体：通道可以换、记忆不会丢、说出去的话都过闸。

## 二、分层（从上到下，谁依赖谁）

```
            宿主（DSH）── webServer / llm / agents / attachments
                              │
                        index.js  装配层：建运行时、接通道、挂路由、起定时器
                              │
   ┌──────────────┬───────────┼────────────┬──────────────┐
   │              │           │            │              │
 turn.mjs      chat.mjs   activity.mjs  panel-view.mjs   tools.mjs
 （怎么回）    （怎么说）  （自己干嘛）  （面板长什么样） （模型能调什么）
   │              │           │            │              │
   └──────────────┴─────┬─────┴────────────┴──────────────┘
                        │
        ┌───────────────┼────────────────┬──────────────┐
        │               │                │              │
   runtime.mjs      guard.mjs        memory.mjs     lib/qq/*
   （状态与账本）   （说话闸门）      （记得什么）   （传输层）
```

**依赖只准向下**：下层不认识上层。`lib/qq/` 只认协议与进程，不知道什么叫「回话」；
`turn` 只认「拿一条事件、产出一句话」，不知道消息是从 WebSocket 还是从面板来的。
这条规矩由 `scripts/check-layers.mjs` 静态守：断链、成环、越层、绕闸，四条都在里面。

## 三、模块地图

| 文件 | 职责 | 谁在用 |
|---|---|---|
| `index.js` | 唯一的装配点：建实例、挂 `/api/shenlan/*` 路由、起定时器、管生命周期 | 宿主 |
| `lib/runtime.mjs` | 运行时状态：事件流、审计、配置、技能簿、出站闸门 | 几乎所有 |
| `lib/config.mjs` | 配置的唯一形状：默认值、扁平化、迁移、读写 | `index.js` / `panel.mjs` |
| `lib/panel.mjs` | 每个配置键的中文名、校验、分组、风险等级 | `config.mjs` / `panel-view.mjs` |
| `lib/panel-view.mjs` | 面板数据（同步、纯函数，不发网络请求） | `index.js` 路由 |
| `lib/client.js` | 浏览器端界面（宿主静态加载，不走 import 图） | 宿主前端 |
| `lib/turn.mjs` | 一轮对话：解析工具调用、执行工具环、决定说还是不说 | `index.js` |
| `lib/chat.mjs` | 独立对话：面板里直接聊，不经过 QQ | `index.js` |
| `lib/behavior.mjs` | 「这条消息该不该接」：叫没叫我、聊没聊到我 | `turn.mjs` |
| `lib/guard.mjs` | 说话闸门：频率、条数、夜间；合并窗口待接入 | `turn.mjs` / 定时器 |
| `lib/typing.mjs` | 出站节奏：按字数等、全局单飞、分条留缝、正在输入 | `turn.mjs` |
| `lib/attention.mjs` | 群聊注意力账本：按人开窗、换人判据、到轮关窗 | `turn.mjs` |
| `lib/rules.mjs` | 此刻生效的规则清单 + 已知缺口（面板「规则」区的唯一来源） | `panel-view.mjs` / 测试 |
| `lib/say.mjs` | 把一段话拆成几条、清洗标记、拼卡片 | `turn.mjs` / `chat.mjs` |
| `lib/style.mjs` | 语气与长度的落地规则 | `turn.mjs` |
| `lib/memory.mjs` | 事实记忆 + 人物档案 + 联想网络 | `turn.mjs` / 面板 |
| `lib/induction.mjs` | 从聊天里归纳「这个人是谁」 | 定时器 |
| `lib/skill.mjs` | 技能簿：出厂技能、教的技能、开关与统计 | `runtime.mjs` |
| `lib/tools.mjs` | 工具表：模型能调什么、怎么调、失败怎么说 | `turn.mjs` |
| `lib/journal.mjs` | 审计：只追加、可过滤、不删不改 | `runtime.mjs` |
| `lib/log.mjs` | 日志两轴：终端级别 + 审计类型，一处判 | `index.js` |
| `lib/event.mjs` | 事件的唯一形状（谁、什么、什么时候、哪条） | 全链路 |
| `lib/qq/onebot.mjs` | OneBot 11：连、断、事件翻译、发动作 | `index.js` |
| `lib/qq/napcat.mjs` | 协议端：启动、登录阶段、重试、端口探活 | `index.js` |
| `lib/qq/backfill.mjs` | 掉线补回：按时间窗把漏掉的消息补进事件流 | `index.js` |
| `lib/qqview.mjs` | 会话视图：事件流 → 对话列表 / 线程（纯展示） | `panel-view.mjs` |
| `lib/usage.mjs` | 花销账本：token → 钱 → 预算 | `turn.mjs` / 面板 |
| `lib/sandbox.mjs` | 沙箱：配额、超时、熔断、工作区（草稿纸） | `tools.mjs` |
| `lib/browser.mjs` / `cdp.mjs` | 浏览器能力（CDP）与本机控制 | `tools.mjs` |
| `lib/web.mjs` | 联网：白名单、配额、正文提取 | `tools.mjs` / 定时器 |
| `lib/stickers.mjs` | 表情包收藏与挑选 | `tools.mjs` |
| `lib/media.mjs` | 图片本体落盘：收图即存、按内容去重、定期清理 | `index.js` / `tools.mjs` / `turn.mjs` |
| `lib/activity.mjs` | 自主活动：没人叫的时候自己做什么 | 定时器 |
| `lib/evolve.mjs` | 权重进化：按结果微调，可回滚 | 定时器 / 面板 |
| `lib/refusals.mjs` | 拒绝记录：哪些事不该做、为什么 | `turn.mjs` |
| `lib/wants.mjs` | 想做的事（被动攒着，主动才做） | `activity.mjs` |
| `lib/host.mjs` | 宿主能力适配（生成器、工作区） | `index.js` |
| `lib/taxonomy.mjs` | 面板的概念地图：七个域、十个区域、详情形状 | `panel.mjs` / `panel-view.mjs` |
| `lib/reminders.mjs` | 到点提醒 | 定时器 |
| `lib/core.mjs` | 与宿主无关的纯工具（时间、文本、去重） | 多个模块 |

## 四、数据落盘

全部在 `~/.dsh/shenlan-whale/`，都是纯文本、都能用编辑器打开：

| 文件 | 里面是什么 |
|---|---|
| `config.json` | 配置（密码与令牌只在这里，面板与日志都不回显） |
| `events.jsonl` | 事件流：收到的、发出的，一行一条 |
| `audit.jsonl` | 审计：谁改了什么、哪次被拒、哪次没发出去 |
| `memory.json` / `skills.json` | 记忆与技能簿 |
| `usage.json` | 花销账本 |
| `groups.json` | 群号 → 群名缓存（连上就刷一次） |
| `behaviors.jsonl` / `activity.jsonl` / `cot.jsonl` | 行为、自主活动、思维链 |

## 五、五条不能破的纪律

1. **配置只有一个形状**：`DEFAULTS` 与面板逐键对账，多一个少一个测试当场红。
2. **出站只有一个门**：要发话走 `runtime.outbound`；只有 `lib/qq/` 能碰协议层的发送接口。
3. **日志两轴分开**：`level` 管终端打多细，`audit*` 管审计页显示什么；磁盘上的审计一条不删。
4. **技能与工具不是一回事**：技能是「会不会」，工具是「能不能调」；一个工具可以属于多项技能。
5. **不假装**：不知道就说不知道，没接上就说没接上，失败要留痕。

## 六、出问题先看哪

| 现象 | 先看 |
|---|---|
| QQ 收不到、发不出 | 面板「QQ 连接」的那句话 → `audit.jsonl` 的 `send_failed` |
| 登录成功但通道掉线 | 面板会直说端口有没有人听；再看 `napcat/config/onebot11_<QQ号>.json` |
| 该回不回 / 回太多 | `guard`（频率与夜间）、`behavior`（有没有叫到我） |
| 记忆乱了 | `memory.json` 与面板「记忆」页的编辑/撤销 |
| 钱不对 | `usage.json` 与 `audit.jsonl` 的 `usage` 行 |
| 面板某个开关改了没用 | `npm run audit:config`（配置键必须有消费者） |
