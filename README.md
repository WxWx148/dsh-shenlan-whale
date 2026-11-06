# 深蓝鲸 · dsh-shenlan-whale

> **长在本地的人格体：通道可换，记忆不丢。**

一个跑在你电脑上的 QQ 人格体插件，接在 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）里。
它不是「接个机器人框架 + 写死提示词」，而是把**记忆、语气、作息、注意力**当成会一直长下去的东西：
聊过的人有档案，说过的话过闸门，夜里会闭嘴，换个通道还是它。

- 版本：`0.40.0`
- 许可：MIT
- 平台：Windows 10/11（x64）+ DSH 桌面版
- 状态：个人项目，长期自用中，接口会变

---

## 它到底能干什么

| 能力 | 说明 |
|---|---|
| **接 QQ** | OneBot 11 协议，经 [NapCat](https://github.com/NapNeko/NapCatQQ) 登录；私聊、群聊都能聊 |
| **记得住** | 事实记忆 + 人物档案 + 联想网络（最多 8000 条，每 200 条自动归纳一次），重启、换会话都不丢 |
| **像人在打字** | 先等 2.5 秒再回、按字数等、连发留缝 1.8 秒、3 秒内的消息合并成一段（不会刷屏式秒回） |
| **有闸门** | 每小时最多 60 条、每分钟 15 条、夜间时段沉默；说出去的话统一走出站闸门 |
| **群聊有注意力** | 按人开窗、换人要判据，不抢话；话题、追更、冷场都有自己的账本 |
| **自己会过日子** | 活动心跳、主动搭话、早晚报、热榜（默认关，可在面板开） |
| **有个面板** | 88 个配置项全中文、分 10 个区，能看「最近发生了什么」、一键复制诊断信息 |
| **会干活** | 联网、浏览器（CDP）、代码沙箱、可教的技能簿 |

一句话：**它更像一个住在你 QQ 里的熟人，而不是一个问答接口。**

---

## 前置条件

1. **DSH 桌面版**（Windows）。插件跑在 DSH 的 profile 里，单独拿不走。
2. **一个 QQ 小号**。强烈建议不要用主号：机器人会读聊天、会主动说话，号被风控/封了很麻烦。
3. **NapCat**。QQ 协议端，负责把 QQ 消息翻译成 OneBot 事件。
4. 不需要单独装 Node：DSH 自带（要求 Node ≥ 22）。

---

## 安装

### 方式 A：下载压缩包（推荐给群友）

1. 在群文件 / Release 页下载 `dsh-shenlan-whale-0.40.0.zip`，解压到一个**固定位置**，例如 `D:\dsh-shenlan-whale`。
   > 位置别选桌面或下载目录，后面升级、重装都靠这个路径找回来。
2. 打开 DSH，进入 **设置 → 插件**（插件管理）。
3. 添加一个 bundle，安装源填：

   ```
   file:D:\dsh-shenlan-whale
   ```

   注意是斜杠 `/` 或反斜杠 `\` 都能认，但**不要带引号**。
4. 重启 DSH。侧边栏出现「深蓝鲸」面板即成功。

### 方式 B：从仓库安装（想跟更新的）

```powershell
git clone https://github.com/xwxw773-debug/W-x-x-W.git D:\dsh-shenlan-whale
```

然后在设置 → 插件里填 `file:D:\dsh-shenlan-whale`，或在 profile 的 `package.json` 里加依赖（见方式 C）。

### 方式 C：手动改 profile（插件管理器界面不一致时的兜底）

编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`（通常是 `desktop`）：

```json
{
  "dependencies": {
    "dsh-shenlan-whale": "file:D:/dsh-shenlan-whale"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-shenlan-whale"
      ]
    }
  }
}
```

保存后重启 DSH。DSH 启动时会在 profile 里跑一次 pnpm 安装，把 `file:` 依赖**复制**进 `node_modules`。

---

## 第一次配置（大约 10 分钟）

### 1. 装 NapCat

去 [NapCat 仓库](https://github.com/NapNeko/NapCatQQ) 下载 Windows 版本，按官方说明装好并登录你的 QQ 小号。
常见安装位置（插件会自动找这里）：

```
%USERPROFILE%\.dsh\qq-fish\napcat\<版本号>\
```

### 2. 在 NapCat 里开一个 WebSocket 服务端

NapCat → 网络配置 → **WebSocket 服务端**：

| 项 | 填什么 |
|---|---|
| 端口 | `3001`（和面板默认一致就行） |
| 主机 | `127.0.0.1` |
| Token | 可留空；填了就要和面板里的 Token 一模一样 |

### 3. 面板里把三样对上

| 面板项 | 配置键 | 说明 |
|---|---|---|
| 机器人 QQ 号 | `channel.selfId` | 必须和小号一致。**号对不上**会「登录成功但永远等通道」，因为 NapCat 的 OneBot 配置是按 QQ 号分开存的 |
| 通道地址 | `channel.wsUrl` | 默认 `ws://127.0.0.1:3001` |
| 令牌 | `channel.token` | 和 NapCat 里填的一致，没填就空着 |

### 4. 启动

面板上点「启动协议端」；或者直接双击仓库里的 `启动NapCat.bat`（先把里面的 `YOUR_QQ` 改成你的小号）。

状态灯变成「已连着 xx 小时」就通了。拿自己的大号给小号发条「在吗」试试。

---

## 常用配置

全部 88 个键都能在面板里改，这里是容易踩坑的几个：

| 键 | 默认 | 说明 |
|---|---|---|
| `channel.selfId` | 空 | 机器人 QQ 号，必须填 |
| `channel.wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端 |
| `channel.autoStartNapcat` | `false` | 开 DSH 时自动拉起 NapCat |
| `channel.napcatBat` | 空 | 留空 = 自动找；装在非常规目录才填绝对路径 |
| `guard.replyQuotaPerHour` | 60 | 每小时最多说几句 |
| `guard.perMinute` | 15 | 每分钟最多几句 |
| `guard.nightWindow` | `23:00-07:00` | 夜间沉默时段，`off` 可关 |
| `guard.firstDelayMs` | 2500 | 收到消息先等多久（毫秒） |
| `memory.maxEntries` | 8000 | 记忆上限 |
| `proactive.enabled` | `false` | 主动搭话（默认关，想让它像人再开） |
| `activity.tickMinutes` | 45 | 自主心跳间隔 |
| `tools.whitelist` | 空 | **空 = 全部允许** |
| `net.allowlist` | 空 | **空 = 全部拒绝**（这两个空值含义相反，最容易搞混） |

配置文件在 `%USERPROFILE%\.dsh\shenlan-whale\config.json`，面板改的就是它。
想换数据目录：设环境变量 `SHENLAN_DATA_DIR`。

---

## 数据都在哪

```
%USERPROFILE%\.dsh\shenlan-whale\
├── config.json       # 配置
├── memory.json       # 记忆（事实、人物档案、联想）
├── journal.jsonl     # 审计流水（只追加，不删不改）
├── events.jsonl      # 事件流水
└── usage.json        # 用量账本
```

**不会上传任何东西**。但要注意：聊天内容会进记忆、会作为上下文发给模型——用哪个模型、花谁的钱，是你在 DSH 里配的。

---

## 目录结构

```
index.js              装配层：建运行时、挂 /api/shenlan/* 路由、起定时器
lib/
  runtime.mjs         运行时状态：事件流、审计、配置、技能簿、出站闸门
  config.mjs          配置的唯一形状：默认值 / 扁平化 / 迁移 / 读写
  panel.mjs           每个配置键的中文名、校验、分组、风险等级
  panel-view.mjs      面板数据（纯函数）
  client.js           浏览器端界面
  turn.mjs            一轮对话：工具环、说还是不说
  chat.mjs            面板里直接聊，不经过 QQ
  behavior.mjs        「这条消息该不该接」
  guard.mjs           说话闸门
  typing.mjs          出站节奏：按字数等、单飞、留缝、正在输入
  attention.mjs       群聊注意力账本
  memory.mjs          记忆：事实 + 人物 + 联想
  induction.mjs       从聊天里归纳「这个人是谁」
  skill.mjs           技能簿
  tools.mjs           模型能调什么、怎么调
  journal.mjs / log.mjs   审计与日志
  event.mjs           事件的唯一形状
  qq/onebot.mjs       OneBot 11：连、断、事件翻译、发动作
  qq/napcat.mjs       NapCat 进程、安装目录、WebUI 登录
tests/                40 个用例文件 + 三个静态守卫
scripts/              check-*.mjs（守卫）、sync-to-profile.mjs（部署）、smoke 等
```

设计文档：[CONCEPTS.md](CONCEPTS.md)（东西放哪、为什么这么分）、[SCHEME.md](SCHEME.md)（硬性契约）、[UX.md](UX.md)（界面取舍的推理过程）、[CHANGELOG.md](CHANGELOG.md)。

---

## 开发

```powershell
npm test          # 40 个用例 + 三个守卫（文案/归属/分层）
npm run smoke     # 全链路冒烟
npm run probe     # 真实进程里的面板路由
npm run check     # 只跑静态守卫
```

一个**必须知道的坑**：profile 里 `file:` 依赖 pnpm 是**复制**不是软链。改了源码，宿主加载的还是旧副本。

```powershell
node scripts/sync-to-profile.mjs           # 同步到宿主
node scripts/sync-to-profile.mjs --check   # 只比对
```

改完源码 → 同步 → 重启 DSH，界面才会变。

---

## 常见问题

**登录成功，但面板一直「等通道连上」**
`channel.selfId` 和 NapCat 里那个号的 OneBot 配置不一致。NapCat 按 QQ 号分文件存配置（`onebot11_<QQ号>.json`），号错了就是「登录成功、没有 WebSocket 服务端」。

**提示找不到 NapCat / 启动不了协议端**
面板「NapCat 启动脚本」留空时按常见位置找；装别处就填 `napcat.bat` 的绝对路径。注意两份 NapCat 会抢 6099 和 3001 端口。

**面板是空的 / 界面没变化**
`file:` 依赖是复制：源码改了要先 `node scripts/sync-to-profile.mjs`，再重启 DSH。

**它不理人 / 话太多**
先看闸门：`guard.replyQuotaPerHour`、`guard.nightWindow`。再看 `behavior` 的两条判据（叫没叫我、聊没聊到我）。群聊里还要看 `group.interests` 白名单。

**想让它主动说话**
`proactive.enabled` 打开，再调 `intervalMinutes` / `perDay` / `startHour–endHour`。默认是关的，怕吵。

**会不会把我的聊天传出去**
不会主动传。但记忆和上下文会进模型请求，走的是你在 DSH 里配的模型服务。介意就别把私密群交给它。

---

## 用它之前请想清楚

- 这是**个人自用**项目，不是产品。接口、配置键、数据格式都可能在版本间变，升级前看 [CHANGELOG.md](CHANGELOG.md)。
- **用 QQ 小号，不用主号。** 自动发言、主动搭话都有被风控的可能，风险在你自己。
- 群里的言行由**你**负责。别拿它去骚扰、刷屏、冒充真人做坏事。
- 它读得到你给它的群和私聊。别把不该给机器人看的群接进去。
- 按 MIT 提供，**不提供任何担保**。

---

## 参与

issue / PR 都欢迎，但请先读 [CONTRIBUTING.md](CONTRIBUTING.md)：这个项目有几条硬规矩（依赖只准向下、文案与配置逐键对账、测试必须全绿），不为风格吵架。

---

## 许可

[MIT](LICENSE) © 2026 深蓝鲸项目

QQ 协议端 [NapCat](https://github.com/NapNeko/NapCatQQ) 是独立项目，有它自己的许可；本项目只是调用它。
