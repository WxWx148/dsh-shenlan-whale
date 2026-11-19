/**
 * scripts/check-ui.mjs — 界面与结构的一致性守卫。
 *
 * 为什么需要它：
 *   界面里最容易烂的不是样式，是**事实**。规则页手抄路径、页面清单写三处、
 *   前缀写三处 —— 这些在结构搬动时不会报错，只会慢慢对不上。
 *   单元测试也拦不住：它们测的是"算得对"，不是"说的和结构一致"。
 *
 * 五条规则，全静态：
 *   R1 界面代码除 import/注释外，不许出现 `.mjs` 字面量（堵死"抄路径"）
 *   R2 规则的 parent 必须存在，symbol 必须是那个父模块真的导出的
 *   R3 每个页面必须有卡片提供者；每个详情类型必须有渲染分支
 *   R4 界面调的每个接口都必须真的注册过
 *   R5 结构快照必须与源码一致（忘了重新生成就红）
 *
 * 用法：node scripts/check-ui.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULES, GAPS } from '../lib/rules.mjs'
import { REGIONS, DETAIL_KIND_LIST } from '../truth/index.mjs'
import { PAGE_CARDS, CARD_PARTS } from '../view/index.mjs'
import { ALIASES } from '../lib/blueprint.mjs'
import {
  STRUCTURE,
  API_BASE,
  hasRoute,
  hasSymbol,
  parentOf,
} from '../lib/structure.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const problems = []
const notes = []

/** 去掉整行注释与块注释，避免把解释文字当成代码 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// ── R1 界面不许抄路径 ─────────────────────────────────────────────
for (const file of ['lib/client.panel.js', 'view/panel-view.mjs']) {
  const src = stripComments(read(file))
  const lines = src.split('\n')
  lines.forEach((line, index) => {
    // import / export 里的 .mjs 是模块装配，不是"写给人看的路径"，放行
    if (/^\s*(import|export)\b/.test(line)) return
    const hit = line.match(/['"`][^'"`]*\.mjs[^'"`]*['"`]/)
    if (hit) problems.push(`R1 ${file}:${index + 1} 出现了源码路径 ${hit[0]}（应当从 structure 查）`)
  })
}

// ── R2 规则必须指向真实存在的符号 ────────────────────────────────
for (const one of [...RULES, ...GAPS]) {
  const label = one.id || one.title || '(未命名)'
  if (!one.parent) {
    if (!one.module) problems.push(`R2 ${label}：既没有 parent 也没有 module`)
    continue
  }
  const owner = parentOf(one.parent)
  if (!owner) {
    problems.push(`R2 ${label}：parent「${one.parent}」不在 12 个父模块里`)
    continue
  }
  // 还没搬的父模块没有文件，符号当然查不到 —— 这时候只要求「有个能落地的旧路径」
  if (owner.status === 'planned') {
    if (!one.pendingModule) problems.push(`R2 ${label}：${one.parent} 还没落地，但没写 pendingModule，规则会指向空`)
    continue
  }
  if (one.symbol && !hasSymbol(one.parent, one.symbol)) {
    problems.push(`R2 ${label}：${one.parent} 没有导出 ${one.symbol}`)
  }
  // 结构已经能解析了，就说明目录搬完了 —— pendingModule 该删了
  if (one.locatedBy === 'structure' && one.pendingModule) {
    notes.push(`${label}：父模块 ${one.parent} 已落地，可以删掉 pendingModule（${one.pendingModule}）`)
  }
}

// ── R3 每个页面有卡片组合、每个详情类型有渲染分支 ────────────────
// 这里不再用正则刮源码里的 `xxx(modules, ctx) {`：页面和片段已经分成两层，
// 用正则就要求"键名必须长成函数的样子"，等于把实现细节写进守卫。
// 直接问 panel-view 要那张表 —— 它导出了，就是给自己人查的。
const viewSrc = read('view/panel-view.mjs')
const CARD_PART_NAMES = new Set(Object.keys(CARD_PARTS))
for (const region of REGIONS) {
  const parts = PAGE_CARDS[region.id]
  if (!parts || !parts.length) problems.push(`R3 页面「${region.label}」(${region.id}) 没有卡片组合`)
  else for (const part of parts) {
    if (!CARD_PART_NAMES.has(part)) problems.push(`R3 页面 ${region.id} 引用了不存在的片段 ${part}`)
  }
}
// 反向：PAGE_CARDS 里有、REGIONS 里没有 = 一页卡片永远不会被显示
const pageIds = new Set(REGIONS.map((one) => one.id))
for (const id of Object.keys(PAGE_CARDS)) {
  if (!pageIds.has(id)) problems.push(`R3 PAGE_CARDS 里的 ${id} 不在页面清单里（这页永远不会显示）`)
}

// ── R7 别名必须指向真实页面（旧深链不能断）──────────────────────
for (const [from, to] of Object.entries(ALIASES)) {
  if (pageIds.has(from)) problems.push(`R7 别名 ${from} 与真实页面重名（这个 id 到底指哪页？）`)
  if (!pageIds.has(to)) problems.push(`R7 别名 ${from} → ${to}，但 ${to} 不是页面`)
  if (from === to) problems.push(`R7 别名 ${from} 指向自己，是噪声`)
}

// 详情：rows 走的是兜底分支，其余必须显式出现
const clientSrc = read('lib/client.panel.js')
const FALLBACK_KIND = 'rows'
for (const kind of DETAIL_KIND_LIST) {
  if (kind === FALLBACK_KIND) {
    if (!clientSrc.includes('DetailRows')) problems.push('R3 详情兜底分支（DetailRows）不见了')
    continue
  }
  if (!clientSrc.includes(`detail.kind === '${kind}'`)) problems.push(`R3 详情类型 ${kind} 没有渲染分支`)
}

// ── R4 界面调的接口必须真的存在 ─────────────────────────────────
const apiTargets = new Set()
for (const m of clientSrc.matchAll(/api\('([^']+)'/g)) apiTargets.add(m[1].split('?')[0])
for (const file of ['lib/client.panel.js', 'view/panel-view.mjs']) {
  for (const m of read(file).matchAll(/['"](\/api\/shenlan[^'"]*)['"]/g)) {
    apiTargets.add(m[1].slice(API_BASE.length).split('?')[0] || '/')
  }
}
for (const target of apiTargets) {
  if (!target || target === '/') continue
  const clean = target.startsWith('/') ? target : '/' + target
  if (!hasRoute(clean)) problems.push(`R4 界面调了不存在的接口 ${clean}`)
}

// ── R6 发布包必须包含所有已落地的父模块 ──────────────────────────
// `files` 是静态清单，搬目录时同样会漏。漏了的表现和副本缺目录一样：
// 装完插件 ERR_MODULE_NOT_FOUND，而本地 `npm test` 一切正常。
const pkg = JSON.parse(read('package.json'))
for (const one of STRUCTURE.parents.filter((item) => item.status === 'landed')) {
  const listed = (pkg.files || []).some((entry) => entry === one.dir || entry === one.dir + '/')
  if (!listed) problems.push(`R6 package.json 的 files 漏了 ${one.dir}/（发布包会缺文件）`)
}

// ── R8 样式表必须是完整的 CSS ────────────────────────────────────
// 这条是踩出来的：一次手工补样式时少写了一个 `}`，后面**整段样式全部失效** ——
// 页面还是那个 DOM，只是没有边框、没有间距，看起来像"样式没加载"。
// 浏览器不会报错，控制台也不会有任何一行红字，只能靠眼睛发现。
// 静态检查一遍花括号，比任何截图比对都便宜。
{
  const src = read('lib/client.panel.js')
  const start = src.indexOf('const CSS = [')
  const end = src.indexOf('].join', start)
  if (start < 0 || end < 0) problems.push('R8 找不到 client.panel.js 里的 CSS 数组')
  else {
    const block = src.slice(start + 13, end)
    const parts = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
    const css = parts.join('')
    let depth = 0
    let lowest = 0
    for (const ch of css) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth < lowest) lowest = depth }
    }
    if (depth !== 0) problems.push(`R8 样式表花括号不平衡（结束时深度 ${depth}）：后面所有规则都会失效`)
    if (lowest < 0) problems.push('R8 样式表里有多余的 `}`')
    if (!css.includes('.slj-root{')) problems.push('R8 样式表第一条规则不见了（拼串顺序可能被改坏）')
  }
}

// ── R9 聊天输入栏必须常驻底部；几何必须做系统缩放补偿 ──────────────
// 这两条都是"改回去也不会报错、只是又看不见了"的那种回归：
// 底栏回到普通流，消息一多就把它顶出屏幕；删掉 dpr 补偿，125% 缩放下
// 整块底栏落在窗口外，而页面内部 elementFromPoint 还命中 textarea。
{
  const src = read('lib/client.panel.js')
  const contracts = [
    ['.slj-chatWrap{position:relative', '聊天区要当定位上下文，否则底栏会跟着消息流跑'],
    ['.slj-composer{position:absolute', '输入栏要绝对定位在聊天区底部，不吃 flex 高度链'],
    ['.slj-content:has(.slj-chatWrap){display:block', '聊天页外层不能是可滚动的 flex 列（高度链会退化成内容高度）'],
    ['dprFix', '系统缩放补偿不能删：125% 缩放下输入框会整块落在窗口外'],
    ['setGeom((prev) =>', '每次拉面板要把现场几何回填，首屏那一次常常量不到 outerWidth'],
    ['el.style.width = w', '根节点收缩要落在实际 DOM 上，只改 state 会卡在首屏那份旧几何'],
  ]
  for (const [needle, why] of contracts) {
    if (!src.includes(needle)) problems.push(`R9 少了 ${needle}：${why}`)
  }
}

// ── R10 生效徽标必须在数据侧与界面侧成对存在；死接口不许回来 ────────
// 「改完没反应」以前只能靠用户猜。数据侧给 effect、界面侧摆出来，
// 少任何一边都等于没做。两条死接口也没有任何调用方，回来就是纯负担。
{
  const pv = read('view/panel-view.mjs')
  const client = read('lib/client.panel.js')
  const idx = read('index.js')
  if (!pv.includes("restart: '改后需重启'")) problems.push('R10 pane-view 少了重启项的中文标签')
  if (!pv.includes('const effect = effectOf(item, pending)')) problems.push('R10 设置项没算生效时机')
  if (!client.includes("'.slj-effect{")) problems.push('R10 前端没有渲染生效徽标的样式')
  if (!client.includes("item.effect === 'pending'")) problems.push('R10 前端没按生效时机分轻重')
  if (idx.includes("route === '/brief'") || idx.includes("route === '/hotnews/test'")) {
    problems.push('R10 死接口 /brief 或 /hotnews/test 又回来了（没有任何调用方）')
  }
}

// ── R11 事件流必须两端成对，且降级路径不能丢 ───────────────────────
// SSE 最危险的失败不是「连不上」，是「连不上又没兜底」—— 界面会静静地
// 停在旧数据上，没有任何报错。所以守卫同时检查新旧两条路都在。
{
  const idx = read('index.js')
  const client = read('lib/client.panel.js')
  if (!idx.includes("route === '/events'")) problems.push('R11 宿主没挂 /events，前端会一直连不上')
  if (!idx.includes('createEventHub') || !idx.includes('eventKeyOf')) problems.push('R11 宿主没接事件摘要')
  if (!client.includes('new window.EventSource(ES_URL)')) problems.push('R11 前端没建事件流')
  if (!client.includes('source.onerror') || !client.includes('startFallback(5000)')) {
    problems.push('R11 事件流断了没有降级轮询，界面会停在旧数据上')
  }
  if (!client.includes('startFallback(20000)')) problems.push('R11 连上了也该留低频兜底，摘要覆盖不到的字段才不会永远不刷新')
  if (client.includes('window.setInterval(pull, 5000)')) problems.push('R11 旧的 5 秒整包轮询还在，SSE 等于白接')
}

// ── R12 只读列表只走 /list/:kind，旧路径不许散在别处 ────────────────
// 七个分支合并后最容易出现的状态是「服务端收了、界面和探针还在调旧路径」，
// 而且旧路径会安静地 404 —— 页面看起来只是少了块数据，没有一行报错。
{
  const idx = read('index.js')
  const listSrc = read('view/list-view.mjs')
  const client = read('lib/client.panel.js')
  const pvSrc = read('view/panel-view.mjs')
  const probe = read('probes/probe11.mjs')
  if (!idx.includes("route.startsWith('/list/')")) problems.push('R12 宿主没挂 /list/:kind')
  if (!listSrc.includes('export const LIST_KINDS')) problems.push('R12 列表清单不是唯一真源')
  for (const kind of ['skills', 'groups', 'memory', 'status', 'usage', 'approvals', 'policy']) {
    if (!listSrc.includes("'" + kind + "'")) problems.push(`R12 列表清单漏了 ${kind}`)
    if (idx.includes("route === '/" + kind + "'")) problems.push(`R12 旧路由 /${kind} 还留着`)
  }
  const leftovers = [
    [client, "api('/policy')", '设置页还调旧 /policy'],
    [client, "api('/approvals')", '确认弹窗还调旧 /approvals'],
    [pvSrc, "'/api/shenlan/groups'", '群列表详情还写死旧路径'],
    [probe, "'/api/shenlan/policy'", '探针还调旧 /policy'],
    [probe, "'/api/shenlan/status'", '探针还调旧 /status'],
  ]
  for (const [src, needle, why] of leftovers) {
    if (src.includes(needle)) problems.push('R12 ' + why)
  }
}

// ── R13 写操作只走 /action，op 名必须与清单一致 ─────────────────────
// 参数映射写错不会报错，只会「点了没反应」或改错数据。这里至少保证
// 每个调用点的 op 都在清单里、旧路由不会悄悄回来。
{
  const idx = read('index.js')
  const act = read('app/action.mjs')
  const client = read('lib/client.panel.js')
  const probe = read('probes/probe11.mjs')
  const block = act.slice(act.indexOf('export const ACTION_OPS'), act.indexOf('])', act.indexOf('export const ACTION_OPS')))
  const declared = [...block.matchAll(/'([^']+)'/g)].map((one) => one[1])
  if (!idx.includes("route === '/action'")) problems.push('R13 宿主没挂 /action')
  if (declared.length !== 22) problems.push(`R13 动作清单应是 22 项，实际 ${declared.length}`)
  const legacy = [
    '/memory/remember', '/memory/edit-self', '/memory/forget-self', '/memory/remember-self',
    '/memory/edit', '/memory/edit-person', '/memory/edit-group', '/memory/forget',
    '/memory/forget-person', '/memory/forget-group', '/reminder/cancel', '/reminder/update',
    '/approvals/decide', '/approvals/forget', '/chat/reset', '/qq/send',
    '/skill/forget', '/skill/amend', '/skill/teach', '/skill', '/config/reload',
  ]
  for (const route of legacy) {
    if (idx.includes(`route === '${route}' && req.method === 'POST'`)) problems.push(`R13 旧写路由 ${route} 还留着`)
    if (client.includes(`api('${route}'`)) problems.push(`R13 前端还调旧写路由 ${route}`)
    if (probe.includes(`/api/shenlan${route}'`)) problems.push(`R13 探针还调旧写路由 ${route}`)
  }
  const used = [
    ...[...client.matchAll(/action\('([^']+)'/g)].map((m) => ['前端', m[1]]),
    ...[...probe.matchAll(/op: '([^']+)'/g)].map((m) => ['探针', m[1]]),
  ]
  for (const [where, op] of used) {
    if (!declared.includes(op)) problems.push(`R13 ${where} 用了清单里没有的 op：${op}`)
  }
  if (!client.includes("api('/action'")) problems.push('R13 前端没有统一的 action helper')
}

// ── R14 资源口必须两端成对；旧资源路径与写死前缀不许回来 ────────────
// 界面上的 `src` 是数据不是样式：改了服务端不跟着改调用点，表现是「一块空白」
// 而不是报错。所以这里同时钉住「有没有这个资源名」「前缀有没有写死」「旧
// 路径有没有复活」三件事，外加 QR 与探针这两处容易漏的调用点。
{
  const idx = read('index.js')
  const pv = read('view/panel-view.mjs')
  const napcat = read('channel/napcat.mjs')
  const probe = read('probes/probe11.mjs')
  const assetFile = 'app/asset.mjs'
  const assetSrc = read(assetFile)

  if (!idx.includes("route.startsWith('/asset/')")) problems.push('R14 服务端没有注册 /asset/:name')
  if (!idx.includes('assetOf(name, { dir: runtime.dir, qrPath })')) problems.push('R14 /asset 路由没走统一分派')
  if (idx.includes("route.startsWith('/media/')") || idx.includes("route === '/napcat/qr'")) {
    problems.push('R14 旧资源路由 /media/* 或 /napcat/qr 又回来了')
  }
  if (!assetSrc.includes("key.includes('..')")) problems.push('R14 资源口少了整条路径级的穿越防护')
  if (!assetSrc.includes('mediaPath(ctx.dir, fileName)')) problems.push('R14 媒体没走 mediaPath 的文件名白名单')

  // 界面拼资源/数据地址一律经 structure，不许再出现前缀字面量。
  // 前端那一个 API 常量是「连上宿主之前」的自举，属于唯一例外。
  for (const [file, src] of [['view/panel-view.mjs', pv], ['channel/napcat.mjs', napcat]]) {
    if (src.includes("'/api/shenlan")) problems.push(`R14 ${file} 又写死了接口前缀，改用 apiUrl / assetUrl`)
  }

  const assetCalls = [...pv.matchAll(/assetUrl\('([^']+)'\)/g)].map((m) => m[1])
  if (!assetCalls.includes('napcat/qr')) problems.push('R14 二维码没走 assetUrl')
  for (const name of assetCalls) {
    const known = name === 'napcat/qr' || name.startsWith('media/')
    if (!known) problems.push(`R14 assetUrl('${name}') 不在 app/asset.mjs 的分派表里`)
  }
  // JSON 数据源只消前缀，不能混进资源口
  for (const pathname of [...pv.matchAll(/apiUrl\('([^']+)'\)/g)].map((m) => m[1])) {
    if (pathname.startsWith('/asset/')) problems.push(`R14 ${pathname} 是数据源，不能塞进资源口`)
    if (!hasRoute(pathname)) problems.push(`R14 apiUrl('${pathname}') 指向不存在的接口`)
  }
  if (!napcat.includes("assetUrl('napcat/qr')")) problems.push('R14 登录层下发的二维码地址没走统一资源口')
  if (!probe.includes('/api/shenlan/asset/media/')) problems.push('R14 探针还在调旧 /media/ 路径')
  if (!hasRoute('/asset/napcat/qr')) problems.push('R14 结构快照里没有 /asset/* 路由：跑 npm run structure')

  // 前缀的两处定义必须说同一个数。assetUrl() 读 structure.api.base（来自
  // blueprint），宿主挂路由读 index.js 的 ROUTE_PREFIX。改一处忘另一处的表现是
  // 「所有资源 404」，而 R4 因为共用同一个 base 反而查不出来 —— 只能在这里钉。
  const hostPrefix = (idx.match(/const ROUTE_PREFIX = '([^']+)'/) || [])[1] || ''
  if (!hostPrefix || hostPrefix !== API_BASE) {
    problems.push(`R14 前缀两处不一致：宿主挂载 ${hostPrefix || '(没找到)'} / 界面拼 URL ${API_BASE}`)
  }
}

// ── R15 统一错误体：出口、形状、界面拼接三处成对 ───────────────────
// 错误体最危险的回归不是「报错」，是「那句话变成 [object Object]」：
// 界面 30+ 处按字符串读 result.error，一旦有人照文档把 error 改成嵌套对象，
// npm test 全绿、控制台无红字，只有用户看到一堆方块。所以这里把形状钉死。
{
  const idx = read('index.js')
  const action = read('app/action.mjs')
  const fmRaw = read('app/failure.mjs')
  // 文件头注释里正好写了 `error:{code,message,hint,field}` 作为「不采用」的反例，
  // 检测嵌套前必须剥掉注释，否则会把说明文字当成代码。
  const fm = stripComments(fmRaw)
  const client = read('lib/client.panel.js')

  // 1) HTTP 出口不许再手写 { ok:false, error:'…' }
  const handWritten = [...idx.matchAll(/sendJson\(res,\s*\d+,\s*\{\s*ok:\s*false/g)].length
  if (handWritten) problems.push(`R15 还有 ${handWritten} 处手写错误响应，改用 failure()`)
  if ([...action.matchAll(/\{\s*ok:\s*false,\s*error:/g)].length) {
    problems.push('R15 app/action.mjs 还有手写错误体，改用 failure()')
  }
  // 引入来源允许是 app 门面或（历史）直连文件：钉的是「有 normalizeFailure 这个词」，
  // 不是「从哪个路径引入」——路径会随父模块迁移而变，形状不会。
  if (!/import \{[^}]*normalizeFailure[^}]*\} from '[^']*(?:app\/index|lib\/failure)\.mjs'/.test(idx)) {
    problems.push('R15 index.js 没引入 normalizeFailure：业务透传的错误会漏掉结构化字段')
  }
  if (!idx.includes('normalizeFailure(value)')) problems.push('R15 sendJson 没做最后一道归一')

  // 2) 形状：error 只能是字符串，且每个登记码都要有中文说明与 hint
  if (!fm.includes('const message = String(') || !fm.includes('error: message,')) {
    problems.push('R15 failure() 没保证 error 是字符串')
  }
  if (/error:\s*\{/.test(fm)) problems.push('R15 error 变回嵌套对象了：界面 30+ 处会显示 [object Object]')
  if (!fm.includes('export function normalizeFailure')) problems.push('R15 缺 normalizeFailure')

  // 3) 界面要让用户真的看见 hint，否则结构化字段只是摆设
  if (!client.includes('function readableError(')) problems.push('R15 前端没有统一拼接 hint 的入口')
  if (!client.includes("body.error = readableError(body)")) problems.push('R15 200 响应的业务错误没拼 hint')
  if (!client.includes("throw new Error(readableError(body")) problems.push('R15 非 2xx 错误没拼 hint')

  // 4) 登记表不许出现「正确的废话」，且 hint 要指向真实入口
  const hints = [...fm.matchAll(/hint:\s*'([^']+)'/g)].map((m) => m[1])
  if (hints.length < 15) problems.push(`R15 错误码登记表只有 ${hints.length} 条 hint，检查是否漏登记`)
  for (const hint of hints) {
    if (/^(请重试|稍后再试|请检查后重试)$/.test(hint)) problems.push('R15 hint 不能是正确的废话：' + hint)
  }
}

// ── R5 快照与源码一致 ────────────────────────────────────────────
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-structure.mjs'), '--check'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
} catch {
  problems.push('R5 lib/structure.generated.json 落后于源码：跑 npm run structure')
}

// ── 汇报 ─────────────────────────────────────────────────────────
const parents = STRUCTURE.parents.filter((one) => one.status === 'landed').length
if (problems.length) {
  console.error(`✗ 界面一致性：${problems.length} 处问题`)
  for (const one of problems) console.error('  - ' + one)
  for (const one of notes) console.error('  · ' + one)
  process.exit(1)
}
console.log(
  `✓ 界面一致性：R1 无手抄路径 / R2 ${RULES.length + GAPS.length} 条规则有出处 / `
  + `R3 ${REGIONS.length} 页 ${DETAIL_KIND_LIST.length} 类详情齐全 / R4 接口全部存在 / R5 快照一致 / R6 发布清单齐全 / R7 别名有效 / R8 样式表完整 / R9 底栏与缩放补偿齐全 / R10 生效徽标成对 / R11 事件流与降级齐全 / R12 列表统一入口 / R13 写操作统一入口 / R14 资源口两端成对 / R15 统一错误体`,
)
console.log(`  结构：${parents} 个父模块落地 / ${STRUCTURE.stats.files} 个文件 / ${STRUCTURE.stats.routes} 条路由`)
for (const one of notes) console.log('  · ' + one)
