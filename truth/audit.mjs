/**
 * truth/audit.mjs — 「凭什么说它对」的清单。
 *
 * 这个项目有十几道守卫，散在 `scripts/check-*.mjs`、`tests/`、`probes/` 里。
 * 它们各自是好的，但没人能一口答出：**现在到底有几道、各证明什么、少跑一道会漏什么**。
 * 于是每次「应该没问题吧」都变成重新读一遍 package.json。
 *
 * 所以这里只做一件很小但一直被跳过的事：把口径写下来。
 *
 *   AUDITS        每一道叫什么、证明什么、跑哪条命令、快还是慢
 *   auditOf(id)   取一条（脚本判断「这道在不在」用）
 *   auditSummary() 几条、几条是快的（提交前跑）、几条是慢的（发版前跑）
 *
 * **这里不执行任何东西。** truth 层是纯真源：不读磁盘、不起进程、不看时钟。
 * 真正跑的是 `scripts/audit-all.mjs` —— 它按这份清单 spawn 子进程，
 * 这样「该查什么」只有一个出处，「怎么跑」只有一处实现。
 *
 * 判据（也是本文件存在的意义）：删掉 AUDITS 里任意一条，`npm run audit` 就少跑一道；
 * 而少跑的那一道，没有任何别的地方会补上。清单即覆盖。
 */

/**
 * @typedef {object} Audit
 * @property {string} id       稳定的短名（--only 用）
 * @property {string} label    一句话说它查什么
 * @property {string} proves   它证明了什么（漏了会怎样）
 * @property {string} script   要跑的脚本
 * @property {string[]} args   额外参数
 * @property {'fast'|'slow'} speed 快 = 提交前跑；慢 = 发版前跑
 */

/** @type {Audit[]} */
export const AUDITS = Object.freeze([
  {
    id: 'tests',
    label: '用例全量',
    proves: '每条被写下来的行为断言都还成立；改了判定/文案/路径而没改用例，这里先红',
    script: 'tests/all.mjs',
    args: [],
    speed: 'slow',
  },
  {
    id: 'identity',
    label: '归属与署名',
    proves: '没有别的项目的署名混进来（旧版复制粘贴留下的作者、仓库名）',
    script: 'scripts/check-identity.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'copy',
    label: '文案一致性',
    proves: '对用户的称呼统一，没有把「她」单独留在某一句里',
    script: 'scripts/check-copy.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'layers',
    label: '调用链',
    proves: '没有断链 / 循环依赖 / 越层 / 绕过人话层直接发消息；也没有写完没接上的模块',
    script: 'scripts/check-layers.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'ui',
    label: '界面一致性 R1–R15',
    proves: '界面没有手抄源码路径；每条规则的 parent+symbol 真的存在；接口两端成对；统一错误体',
    script: 'scripts/check-ui.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'structure',
    label: '结构快照',
    proves: 'lib/structure.generated.json 与源码一致（改了文件没重生成，界面读到的就是旧结构）',
    script: 'scripts/gen-structure.mjs',
    args: ['--check'],
    speed: 'fast',
  },
  {
    id: 'config',
    label: '配置消费者',
    proves: '96 个配置键每一个都有真实读取者；面板上能改的，改了真的会有反应',
    script: 'scripts/check-config-consumers.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'dead',
    label: '死码',
    proves: '没有「导出了但没人用、也没有测试」的符号继续堆积',
    script: 'scripts/check-dead-code.mjs',
    args: [],
    speed: 'fast',
  },
  {
    id: 'copy-load',
    label: '副本加载',
    proves: '宿主真正加载的那份副本，每个模块都能真实 import 成功（漏部署父模块会在这里炸）',
    script: 'scripts/verify-copy-load.mjs',
    args: [],
    speed: 'slow',
  },
  {
    id: 'http',
    label: 'HTTP 往返',
    proves: '14 条路由在真实 socket 上返回正确状态/内容类型/统一错误体；旧路由真的 404；/asset 取得到字节',
    script: 'scripts/verify-http.mjs',
    args: [],
    speed: 'slow',
  },
  {
    id: 'probes',
    label: '联调探针',
    proves: '装进假宿主之后，面板/对话/动作/资源/事件流真的能跑通（单元测试测不到接线）',
    script: 'probes/all.mjs',
    args: [],
    speed: 'slow',
  },
])

const BY_ID = new Map(AUDITS.map((one) => [one.id, one]))

export function auditOf(id) {
  return BY_ID.get(String(id)) || null
}

export function auditSummary() {
  const fast = AUDITS.filter((one) => one.speed === 'fast')
  const slow = AUDITS.filter((one) => one.speed === 'slow')
  return {
    total: AUDITS.length,
    fast: fast.map((one) => one.id),
    slow: slow.map((one) => one.id),
    line: `${AUDITS.length} 道对账：${fast.length} 道快（提交前）+ ${slow.length} 道慢（发版前）`,
  }
}
