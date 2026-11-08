/**
 * 页面骨架的离线用例。
 *
 * 这里测的不是「React 画得对不对」，而是三件更早出错、更难发现的事：
 *   1. **点得进去**：每张模块卡都带 detail id，且这个 id 真的能取到内容。
 *      少写一个 detail 分支，用户看到的就是「点了没反应」，而日志里一片安静。
 *   2. **口径唯一**：同一状态不能有两种说法；档位必须是中文、数字必须带单位。
 *   3. **两处一致**：侧边栏几何与导航文案，宿主侧和浏览器侧各有一份字面量，
 *      必须说的是同一组数 —— 这种重复靠人记必然漂移。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SIDEBAR,
  panelView,
  detailView,
  countText,
  moneyText,
  spanText,
  agoText,
  rateText,
  channelFace,
  skillFace,
  withUnit,
} from '../view/index.mjs'
import { DETAIL_KIND_LIST, REGIONS } from '../truth/index.mjs'
import { assetUrl } from '../lib/structure.mjs'
import { Runtime } from '../app/index.mjs'
import { PANEL_ITEMS, optionLabelsOf } from '../truth/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push({ name, err })
    console.log(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

const EVENTS = [
  { id: 's1', at: 5000, from: 'self', type: 'message', scope: 'private', conversation: 'private:1001', text: '我在的', sender: '我' },
  { id: 'a2', at: 4000, from: '1001', type: 'message', scope: 'private', conversation: 'private:1001', text: '在吗', sender: '小明' },
  { id: 'g1', at: 3000, from: '3003', type: 'message', scope: 'group', conversation: 'group:2002', text: '今天谁值班', sender: '阿花' },
  { id: 'h1', at: 2000, type: 'heartbeat', scope: 'group', conversation: 'group:2002', text: '' },
]

/** 假日志：新的在前 + 支持 filter/limit，与真 Journal 读法一致 */
function fakeJournal(rows, { pageSize = 100 } = {}) {
  return {
    read({ limit = 50, before, filter } = {}) {
      const hit = rows.filter((row) => (typeof filter === 'function' ? filter(row) : true))
      const start = before ? Number(String(before).split(':')[0]) || 0 : 0
      const slice = hit.slice(start, start + Math.min(limit, pageSize))
      const next = start + slice.length < hit.length ? `${start + slice.length}:0` : null
      return { rows: slice, nextBefore: next, hasMore: next !== null }
    },
    count: (filter) => rows.filter((row) => (typeof filter === 'function' ? filter(row) : true)).length,
  }
}

function fakeRuntime(options = {}) {
  const config = {
    channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001?access_token=SECRET', selfId: '', login: { mode: 'qr' } },
    persona: { name: '镜', verbosity: 'normal', maxParts: 3 },
    guard: { perMinute: 3 },
    usage: { budgetPerDay: 2, currency: 'CNY', inputPerM: 1, outputPerM: 2 },
    memory: { maxEntries: 500 },
    sandbox: { mode: 'ask', hourlyMax: 10, dailyMax: 40, timeoutMs: 5000, memMb: 256, maxCodeBytes: 4096, fuseAfter: 3, fuseHours: 6 },
    evolve: { window: 20, ema: 0.15, clamp: 0.15, keepVersions: 50 },
  }
  return {
    config,
    // 执行器：面板只调 status()。数值与下面的 config.sandbox 对得上，
    // 免得「面板说 3 次、配置说 40 次上限」这种对不上的假数据混进用例。
    sandbox: {
      status: () => (options.sandboxMissing ? null : {
        wired: true,
        mode: 'ask',
        hourlyMax: 10,
        dailyMax: 40,
        hour: 1,
        today: 3,
        fuseUntil: 0,
        fuseLeftMs: 0,
        violations: 0,
        confirmSeconds: 60,
        approvals: { pending: 1, asked: 4, allowed: 2, denied: 1, timedOut: 1, remember: null },
        last: { kind: 'run', at: 5_260_000, ok: true, reason: '', message: '', ms: 1200 },
      }),
      approvals: {
        stats: () => ({ pending: 1, timeoutSeconds: 60, asked: 4, allowed: 2, denied: 1, timedOut: 1, remember: null }),
        recent: () => ([
          { kind: 'approval', at: 5_400_000, id: 'a1', decision: 'allow', allow: true, reason: '', hash: 'abcdef1234567890', bytes: 42, label: '算个数', project: '深蓝鲸', purpose: '算一次乘法' },
          { kind: 'approval', at: 5_300_000, id: 'a1', decision: 'asked', allow: null, reason: '', hash: 'abcdef1234567890', bytes: 42, label: '算个数' },
          { kind: 'approval', at: 5_200_000, id: 'a0', decision: 'timeout', allow: false, reason: '超时未确认（等了 60 秒，按拒绝处理）', hash: 'deadbeef', bytes: 12, label: '', project: '深蓝鲸', purpose: '打印一行字' },
        ]),
      },
    },
    events: fakeJournal(EVENTS),
    audit: fakeJournal(
      [
        { id: 'au2', at: 5200, kind: 'config', key: 'guard.perMinute', before: 15, after: 3, actor: 'panel' },
        { id: 'au1', at: 5100, kind: 'turn_failed', error: '接口 500' },
      ],
      // pageSize 给足，这样「limit:1 验分页」和「limit:5 验失败标红」两条能同时成立；
      // 之前写死 1，第二条查询只拿到 config 那条，找不到失败项，是夹具太紧不是实现错。
      { pageSize: 10 },
    ),
    cot: fakeJournal([{ id: 'c1', at: 5300, title: '第 1 轮', steps: ['看消息', '决定回', '说了半句'], ms: 1200 }]),
    // 行为账本：「为什么没回」的来源。以前它只在磁盘上，面板里没有任何入口。
    behaviors: fakeJournal(
      [
        { ts: 5400, kind: 'behavior', eventId: 'e3', behavior: 'reply', trigger: 'night', ok: false, reason: '现在是夜间静音时段', scope: 'private', conversation: 'pr:123' },
        { ts: 5300, kind: 'behavior', eventId: 'e2', behavior: 'reply', trigger: 'over_budget', ok: false, reason: '日预算用完了', scope: 'group', conversation: 'gr:555' },
        { ts: 5200, kind: 'behavior', eventId: 'e1', behavior: 'reply', trigger: 'private', ok: true, lines: 1, scope: 'private', conversation: 'pr:123' },
      ],
      { pageSize: 10 },
    ),
    status() {
      if (options.statusThrows) throw new Error('状态算不出来')
      return {
        'status.version': '1.0.0',
        'status.uptime': 3_725_000,
        'status.todayMessages': 42,
        'status.totalTokens': 130_000,
        'status.evolveVersion': 7,
        'status.evolveCount': 3,
        'status.skillOn': 2,
        'status.skillLearned': 1,
        'status.skillBlocked': 3,
        'status.auditCount': 2,
        'status.cotCount': 1,
        'status.pendingConfig': 27,
      }
    },
    skills() {
      return {
        line: '会 2 项，其中练熟了 1 项',
        counts: { total: 18, on: 2, off: 13, blocked: 3, notWired: 3, learned: 1, taught: 0 },
        groups: [
          {
            id: 'talk',
            label: '说话',
            desc: '怎么开口',
            items: [
              { id: 'talk.reply', name: '接话', what: '有人找他/她，就回一句', state: 'on', why: '能用', wired: true, uses: 5, rate: 0.8, mastery: 'learned', masteryLabel: '学会了', risk: 'low' },
              { id: 'do.code', name: '自己写代码跑', what: '写代码跑出结果', state: 'blocked', why: '还没接上：exec_sandbox', wired: false, uses: 0, rate: 0, mastery: 'new', masteryLabel: '没试过', risk: 'high' },
            ],
          },
        ],
        learned: [],
        blocked: [{ id: 'do.code', name: '自己写代码跑', why: '还没接上：exec_sandbox', wired: false }],
      }
    },
    evolver: {
      summary: () => ({
        version: 7,
        paused: false,
        pausedUntil: 0,
        changes: 3,
        versions: 4,
        weights: {
          toolWeight: { 'talk.reply': 1.12 },
          behaviorWeight: { reply: 1.05, proactive: 0.9, activity: 1 },
          styleParams: { maxParts: 3 },
          netDecay: 0.82,
        },
      }),
      history: () => [
        { version: 7, at: 5000 },
        { version: 6, at: 4000 },
      ],
    },
  }
}

const fakeUsage = {
  today: () => ({ input: 1200, output: 800, calls: 4, cost: 0.12, budget: 2, currency: 'CNY', over: false, left: 1.88 }),
  total: () => ({ input: 90_000, output: 40_000, tokens: 130_000, calls: 300, cost: 3.2, currency: 'CNY', since: '2026-09-01', days: 60, lifetime: true }),
  line: () => '今天用了 2k token，约 ¥0.12',
}
const fakeGuard = { stats: () => ({ lastMinute: 1, lastHour: 7, quiet: true }) }
const fakeChannel = { state: () => 'online' }

/** 假的独立对话：已经接上生成器、有两句历史 */
const fakeChat = {
  ready: true,
  history: () => ({
    rows: [
      { id: 'me_1', at: 1000, from: 'me', text: '在吗', parts: [], tone: '' },
      { id: 'self_1', at: 1100, from: 'self', text: '在的', parts: ['在的'], tone: '' },
    ],
    hasMore: false,
    nextBefore: null,
  }),
}

const view = () => panelView({ runtime: fakeRuntime(), chat: fakeChat, usage: fakeUsage, guard: fakeGuard, channel: fakeChannel, at: 1 })

console.log('\n页面骨架')

await check('七个页面，顺序与命名固定，每一项都说清「点进去看什么」', () => {
  // 10 → 7：花费并进总览、学习并进心智、规则并进能力，另外保留一个诊断页。
  // 合并的判据是「这两页回答的是不是同一个问题」，不是"数量少好看"。
  assert.equal(REGIONS.length, 7)
  assert.deepEqual(REGIONS.map((one) => one.id), ['overview', 'talk', 'mind', 'ability', 'channel', 'settings', 'process'])
  for (const region of REGIONS) {
    assert.ok(region.label && /[\u4e00-\u9fa5]/.test(region.label), `${region.id} 的名字要用中文`)
    assert.ok(region.hint && region.hint.trim(), `${region.id} 缺 hint`)
    assert.ok(region.icon, `${region.id} 缺图标`)
  }
})

await check('几何：展开宽于轨道，断点顺序合理', () => {
  assert.ok(SIDEBAR.expanded > SIDEBAR.collapsed)
  assert.ok(SIDEBAR.min <= SIDEBAR.expanded && SIDEBAR.expanded <= SIDEBAR.max)
  assert.ok(SIDEBAR.compactAt < SIDEBAR.autoCollapseAt)
  assert.equal(SIDEBAR.autoCollapseAt, 720)
})

await check('每个区域都有模块卡；每张卡都带 detail id（否则点了没反应）', () => {
  const page = view()
  for (const region of REGIONS) {
    const one = page.regions[region.id]
    assert.ok(one, `${region.id} 没算出来`)
    assert.ok(one.modules.length > 0, `${region.id} 一张卡都没有`)
    for (const module of one.modules) {
      assert.ok(module.detail && module.detail.includes('.'), `${region.id} 里有个模块没有 detail：${module.label}`)
      assert.ok(module.label, `${module.detail} 缺名字`)
      assert.ok(module.desc, `${module.detail} 缺一句说明`)
    }
  }
})

await check('卡片点得进去：所有 detail id 都能取到内容，不能有死链', () => {
  const page = view()
  const items = []
  for (const region of REGIONS) for (const module of page.regions[region.id].modules) items.push(module.detail)

  const ctx = { runtime: fakeRuntime(), chat: fakeChat, usage: fakeUsage, guard: fakeGuard, channel: fakeChannel, at: 1 }
  for (const id of items) {
    const detail = detailView({ ...ctx, id })
    assert.equal(detail.ok, true, `${id} 打不开`)
    assert.ok(DETAIL_KIND_LIST.includes(detail.kind), `${id} 的 kind 不认识：${detail.kind}`)
    assert.ok(detail.title, `${id} 没有标题`)
  }
  // 同一个 id 走两遍必须结果一样：详情是纯读，不能有隐藏状态
  const again = detailView({ ...ctx, id: items[0] })
  assert.equal(again.title, detailView({ ...ctx, id: items[0] }).title)
})

await check('总览：先给一排状态牌，再给入口卡（含状态全表）', () => {
  const page = view()
  assert.ok(page.sections.overview.tiles.length >= 6)
  const modules = page.regions.overview.modules
  // 「消费/单价与预算」不再是独立页，接在总览入口卡后面。
  // 顺序说明：先回答"它现在怎么样"（入口卡），再回答"今天花了多少"（账）。
  assert.deepEqual(
    modules.map((one) => one.detail),
    ['usage.today', 'talk.qq', 'skills.all', 'process.audit', 'rules.all', 'status.all', 'usage.price'],
  )
})

await check('对话区：独立对话与 QQ 两张卡，状态各自说清', () => {
  const modules = view().regions.talk.modules
  assert.deepEqual(modules.map((one) => one.detail), ['talk.local', 'talk.qq'])
  assert.match(modules[0].desc, /不用 QQ/)
})

await check('独立对话：接上生成器就能发；没接上就只读并说明原因', () => {
  const ready = detailView({ runtime: fakeRuntime(), chat: fakeChat, at: 1, id: 'talk.local' })
  assert.equal(ready.kind, 'chat')
  assert.equal(ready.chat.source, 'local')
  assert.equal(ready.chat.canSend, true)
  assert.equal(ready.chat.rows.length, 2)
  // 气泡字段必须和前端组件对齐：我说的靠右、它回的靠左，而且各有称呼
  assert.equal(ready.chat.rows[0].self, true)
  assert.equal(ready.chat.rows[0].who, '我')
  assert.equal(ready.chat.rows[1].self, false)
  assert.equal(ready.chat.rows[1].who, '镜')

  const cold = detailView({ runtime: fakeRuntime(), chat: null, at: 1, id: 'talk.local' })
  assert.equal(cold.chat.canSend, false)
  assert.match(cold.chat.disabledReason, /生成能力还没接上/)
})

await check('QQ 会话：列出谁在说、在哪说、最后一句，并标明能不能发', () => {
  const page = detailView({ runtime: fakeRuntime(), channel: fakeChannel, at: 1, id: 'talk.qq' })
  assert.equal(page.kind, 'rows')
  assert.equal(page.rows.length, 2)
  const priv = page.rows.find((row) => row.id === 'private:1001')
  assert.equal(priv.title, '小明')
  assert.match(priv.meta, /私聊/)
  assert.equal(priv.desc, '我在的')
  assert.equal(priv.open, 'qq:private:1001', '每一行都要能点进那段会话')

  const offline = detailView({ runtime: fakeRuntime(), channel: { state: () => 'offline' }, at: 1, id: 'talk.qq' })
  assert.match(offline.notice, /发不出去|掉线/)
})

await check('单个 QQ 会话：老的在上、新的在下，离线时输入框被锁', () => {
  const one = detailView({ runtime: fakeRuntime(), channel: fakeChannel, at: 1, id: 'qq:private:1001' })
  assert.equal(one.kind, 'chat')
  assert.deepEqual(one.chat.rows.map((row) => row.text), ['在吗', '我在的'])
  assert.equal(one.chat.rows[1].self, true)
  assert.equal(one.chat.canSend, true)

  const offline = detailView({ runtime: fakeRuntime(), channel: { state: () => 'off' }, at: 1, id: 'qq:private:1001' })
  assert.equal(offline.chat.canSend, false)
  assert.ok(offline.chat.disabledReason)
})

await check('群聊第一页默认 100 条，翻页时按同一页大小继续', () => {
  const one = detailView({ runtime: fakeRuntime(), channel: fakeChannel, at: 1, id: 'qq:group:2002' })
  assert.equal(one.chat.pageSize, 100, '40 条只够看半屏，翻消息第一页就到底')
  const big = detailView({ runtime: fakeRuntime(), channel: fakeChannel, at: 1, id: 'qq:group:2002', limit: 30 })
  assert.equal(big.chat.pageSize, 30, '显式传了就以传的为准')
})

await check('群会话标题显示群名，群号退到副标题；没有名字才只显示号', () => {
  const named = detailView({
    runtime: fakeRuntime(),
    channel: { state: () => 'online', groupNameOf: (id) => (id === '2002' ? '观鸟小分队' : '') },
    at: 1,
    id: 'qq:group:2002',
  })
  assert.equal(named.title, '观鸟小分队', '群名才是给人看的')
  assert.match(named.subtitle, /2002/, '群号仍要留着，排查时用得上')

  const unnamed = detailView({ runtime: fakeRuntime(), channel: fakeChannel, at: 1, id: 'qq:group:2002' })
  assert.equal(unnamed.title, '群 2002', '拿不到名字就退回群号，不能空着')
})

await check('技能详情：一行一个技能，能开的带开关，接不上的不给开关', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'skills.talk' })
  assert.equal(one.kind, 'rows')
  const reply = one.rows.find((row) => row.id === 'talk.reply')
  const code = one.rows.find((row) => row.id === 'do.code')
  assert.equal(reply.skill.toggleable, true)
  assert.equal(code.skill.toggleable, false)
  assert.match(code.desc, /exec_sandbox/)
})

await check('教过的技能：行上带「改名」，不只是「忘掉」', () => {
  // 教坏了一条（名字变问号）时，以前只有「忘掉」——重教会换新 id，
  // 开关和成功率一起清零。改一个错字不该付出这个代价，所以行上必须有「改名」。
  const base = fakeRuntime()
  const runtime = {
    ...base,
    skills() {
      const view = base.skills()
      view.groups[0].items.push({
        id: 'taught.1', name: '自定义一课', what: '主人教的一课', group: 'talk', source: 'taught',
        state: 'on', why: '能用', wired: true, uses: 0, rate: null, mastery: 'new',
        masteryLabel: '没试过', risk: 'low', canForget: true,
      })
      return view
    },
  }
  const one = detailView({ runtime, at: 1, id: 'skills.talk' })
  const taught = one.rows.find((row) => row.id === 'taught.1')
  assert.ok(taught, '教过的要出现在列表里')
  const actions = (taught.actions || []).map((action) => action.action)
  assert.deepEqual(actions, ['edit-skill', 'forget-skill'], '改名在前、忘掉在后')
  assert.equal(taught.skill.what, '主人教的一课', '改名表单要能带回原来的说明')

  const builtin = one.rows.find((row) => row.id === 'talk.reply')
  assert.deepEqual(builtin.actions, [], '出厂技能不给改名（改了下次启动就变回去）')
})

await check('设置详情：一组的项都在，档位有中文名，数字带单位', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'settings.sandbox' })
  assert.equal(one.kind, 'form')
  const mode = one.form.items.find((item) => item.key === 'sandbox.mode')
  assert.ok(mode.optionLabels, '自治档位必须有中文名')
  for (const option of mode.options) assert.ok(mode.optionLabels[option], `${option} 没有中文名`)
  assert.match(mode.optionLabels.free, /自由/)

  const timeout = one.form.items.find((item) => item.key === 'sandbox.timeoutMs')
  assert.equal(timeout.unit, '毫秒')
  const perHour = one.form.items.find((item) => item.key === 'sandbox.hourlyMax')
  assert.equal(perHour.unit, '次/小时')
})

await check('生效徽标：每项都有机器值与中文，要重启的项说清楚', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'settings.channel' })
  assert.equal(one.kind, 'form')
  const rows = one.form.items
  assert.ok(rows.length > 0, '这一组一项都没有，用例等于没测')
  for (const row of rows) {
    assert.ok(['pending', 'readonly', 'restart', 'next'].includes(row.effect), `${row.key} 没有生效时机`)
    assert.ok(row.badge, `${row.key} 没有中文徽标`)
  }
  const ws = rows.find((row) => row.key === 'channel.wsUrl')
  assert.ok(ws, '连接组少了 wsUrl')
  assert.equal(ws.effect, 'restart')
  assert.equal(ws.badge, '重启后生效')
  assert.equal(ws.needRestart, true, '旧字段不能与新徽标打架')
  const live = rows.find((row) => row.effect === 'next')
  assert.ok(live, '全是重启项？常态项也该有「下一轮生效」')
  assert.equal(live.badge, '下一轮生效')
})

await check('换算比例要一起给前端：标着「秒」的项必须带 scale', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'settings.guard' })
  assert.equal(one.kind, 'form')
  const spec = PANEL_ITEMS.find((item) => item.key === 'guard.firstDelayMs')
  assert.equal(spec.scale, 1000, '这一项本来就是按秒显示、按毫秒存的')
  const item = one.form.items.find((row) => row.key === 'guard.firstDelayMs')
  assert.ok(item, '设置页少了这一项')
  assert.equal(item.scale, 1000, '没把 scale 给前端，前端就不会换算')
  assert.equal(item.unit, '秒')
  // 存的是毫秒：前端要拿它除 1000 才是给人看的秒
  assert.equal(Number(item.value) / item.scale, Number(item.value) / 1000)
  // 所有带 scale 的项都必须透传，漏一个就是一处「填 10 秒存成 10 毫秒」
  for (const other of PANEL_ITEMS.filter((row) => row.scale)) {
    const row = one.form.items.find((cell) => cell.key === other.key)
    if (row) assert.equal(row.scale, other.scale, `${other.key} 的 scale 没透传`)
  }
})

await check('单位与档位是全局要求：每个数字项有单位，每个枚举项有中文档位名', () => {
  const missingUnit = PANEL_ITEMS.filter((item) => item.kind === 'number' && !item.unit).map((item) => item.key)
  assert.deepEqual(missingUnit, [], '这些数字项没标单位，用户没法核对')

  const badEnum = PANEL_ITEMS.filter((item) => item.kind === 'enum').filter((item) => {
    const labels = item.optionLabels || null
    if (!labels) return true
    return (item.options || []).some((option) => !labels[option])
  })
  assert.deepEqual(badEnum.map((item) => item.key), [], '这些枚举项缺中文档位名')
})

await check('过程区：数据与调试、沙箱、确认、审计、判断、活动、看图自检、没回的时候八个入口都在', () => {
  const modules = view().regions.process.modules
  assert.deepEqual(modules.map((one) => one.detail), ['process.debug', 'process.sandbox', 'process.approvals', 'process.audit', 'process.cot', 'process.activity', 'process.skips', 'process.vision'])
})

await check('档位名只有一处：视图层不许再抄一份硬编码副本', () => {
  // 这不是在测渲染结果，是在测「同一句给人看的话有没有第二个出处」。
  // 抄一份的代价只在改名时现形 —— 「跑代码」改「沙箱」那次，源码和面板分组都改了，
  // 唯独视图层抄的那份没动，界面于是继续显示旧名，而没人会先怀疑文案写了两遍。
  const text = readFileSync(new URL('../view/panel-view.mjs', import.meta.url), 'utf8')
  const labels = optionLabelsOf('sandbox.mode')
  assert.ok(labels && Object.keys(labels).length === 3, '这一项应当有档位名')
  for (const label of Object.values(labels)) {
    assert.ok(!text.includes(`'${label}'`), `视图层抄了一份档位名「${label}」，改名时会漏掉`)
  }
})

await check('沙箱详情：档位说中文，次数报真实值，限额带单位', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'process.sandbox' })
  assert.equal(one.kind, 'cards')
  const mode = one.cards.find((card) => card.label === '自治档位')
  assert.match(mode.value, /先问我/)
  const timeout = one.cards.find((card) => card.label === '单次超时')
  assert.match(timeout.value, /毫秒/)
  const today = one.cards.find((card) => card.label === '今天跑了')
  assert.match(today.value, /3 \/ 40/)
  assert.doesNotMatch(one.notice, /还没写/, '执行器已经接上了，不能再写「还没写」')
  assert.match(one.notice, /弹一次确认/, '「先问我」现在真有确认界面了，横幅要说清它会弹窗')
  assert.match(one.notice, /秒/, '要写明默认等多久')
  assert.doesNotMatch(one.notice, /等于不跑/, '确认界面已经做了，不能再写着等于不跑')
})

await check('沙箱详情：没有执行器时如实说没有，不编 0', () => {
  const one = detailView({ runtime: fakeRuntime({ sandboxMissing: true }), at: 1, id: 'process.sandbox' })
  const today = one.cards.find((card) => card.label === '今天跑了')
  assert.equal(today.value, '—')
  assert.match(one.notice, /没接上执行环境/)
})

await check('审计：一条一条读，能翻页，失败类标红', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'process.audit', limit: 1 })
  assert.equal(one.rows.length, 1)
  assert.equal(one.hasMore, true, '给了 2 条、只取 1 条，必须说还有')
  assert.ok(one.nextBefore, '要给出下一页游标')
  const fail = detailView({ runtime: fakeRuntime(), at: 1, id: 'process.audit', limit: 5 }).rows.find((row) => row.title.includes('接口') || row.meta.includes('turn_failed'))
  assert.equal(fail.tone, 'bad')
})

await check('审计：默认按设置里的级别筛，并且明说「磁盘上一条没删」', () => {
  const base = fakeRuntime()
  const strict = { ...base, config: { ...base.config, log: { ...base.config.log, auditLevel: 'warn' } } }
  const one = detailView({ runtime: strict, at: 1, id: 'process.audit', limit: 10 })
  // config 那条是 info 级，被门槛挡住；turn_failed 是 error，留着
  assert.equal(one.rows.some((row) => row.meta.includes(' · config')), false, 'info 级不该出现')
  assert.equal(one.rows.some((row) => row.meta.includes('turn_failed')), true, 'error 级必须留着')
  assert.match(one.subtitle, /一条没删/, '必须说清「没记少」，否则用户以为数据丢了')
  assert.equal(one.filter.level, 'warn')
  assert.ok(one.filter.levels.length >= 4, '档位表由服务端给，前端别再抄一份')

  // 页面上临时点「全部」= 显式参数，压过设置里的默认
  const wide = detailView({ runtime: strict, at: 1, id: 'process.audit', level: 'debug' })
  assert.equal(wide.rows.some((row) => row.meta.includes(' · config')), true, '临时放宽要看得到')
  assert.equal(wide.filter.level, 'debug')
})

await check('审计：噪音默认折叠，显式点名或关掉折叠才看得到', () => {
  const base = fakeRuntime()
  const noisy = {
    ...base,
    config: { ...base.config, log: { ...base.config.log, auditLevel: 'debug' } },
    audit: {
      // 真 Journal.read 会把 filter 用在「读的时候」，过滤在这儿发生。
      // 假日志也得照着做，否则测的是「面板没筛」而不是「筛得对不对」。
      read: ({ limit = 40, filter } = {}) => {
        const all = [
          { id: 'n1', at: 5400, kind: 'channel_state', after: 'online' },
          { id: 'n2', at: 5300, kind: 'config', key: 'guard.perMinute', after: 3 },
        ]
        const rows = typeof filter === 'function' ? all.filter(filter) : all
        return { rows: rows.slice(0, limit), nextBefore: null, hasMore: false }
      },
    },
  }
  const folded = detailView({ runtime: noisy, at: 1, id: 'process.audit' })
  assert.equal(folded.rows.some((row) => row.meta.includes('channel_state')), false, '噪音默认折叠')
  const opened = detailView({ runtime: noisy, at: 1, id: 'process.audit', noise: '0' })
  assert.equal(opened.rows.some((row) => row.meta.includes('channel_state')), true, '关掉折叠就要给')
  assert.match(opened.subtitle, /含心跳与通道状态/)
})

await check('记忆：标题是内容本身，带时间与次数，并给出撤销所需的数据', () => {
  const base = fakeRuntime()
  const now = Date.now()
  const runtime = {
    ...base,
    memory: {
      facts: () => [
        { id: 'F1', text: '我在重庆', at: now - 3 * 3600_000, hits: 2 },
        { id: 'F2', text: '主人喜欢观鸟', at: now - 60_000, hits: 1 },
      ],
      data: { people: { 2239: { uin: '2239', name: '阿蓝', impression: '熟人', notes: ['爱开玩笑'], lastAt: now - 7200_000 } }, groups: { 300000001: { groupId: '300000001', label: '观鸟小分队', topics: ['候鸟'], lastAt: now - 3600_000 } } },
      selfNotes: () => [{ text: '我不爱说废话', at: now - 600_000 }],
    },
  }
  const one = detailView({ runtime, at: now, id: 'memory.facts' })
  const fact = one.rows[0]
  assert.equal(fact.title, '我在重庆', '标题就是内容，不该写「事实」两个字')
  assert.match(fact.meta, /小时前/)
  assert.match(fact.meta, /提到过 2 次/)
  assert.deepEqual(fact.undo, { type: 'fact', text: '我在重庆' }, '撤销要能拿到原文')
  assert.deepEqual(fact.actions.map((action) => action.action), ['edit-fact', 'forget-fact'])
  assert.match(one.subtitle, /删除要点两下/, '得先告诉人删除有确认')

  const all = detailView({ runtime, at: now, id: 'memory.all' })
  assert.match(all.subtitle, /事实 2 · 人物 1 · 群 1 · 自我 1/, '四类各多少条要一眼看到')
  const person = all.rows.find((row) => row.id === 'person-2239')
  assert.equal(person.undo.type, 'person')
  assert.equal(person.undo.name, '阿蓝')
  assert.match(person.meta, /上次说话/)
})

await check('思维链：把步骤拼成一句，而不是甩一个对象', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'process.cot' })
  assert.equal(one.rows.length, 1)
  assert.match(one.rows[0].desc, /看消息 → 决定回 → 说了半句/)
})

await check('心智页的学习段：说话方式、退回上一次、调整规则三张卡，数值用技能名显示', () => {
  // 学习不再是独立页，它是心智的一部分；这里只取 evolve.* 那一段核对
  const modules = view().regions.mind.modules.map((one) => one.detail).filter((id) => id.startsWith('evolve.'))
  assert.deepEqual(modules, ['evolve.weights', 'evolve.history', 'evolve.policy'])
  const weights = detailView({ runtime: fakeRuntime(), at: 1, id: 'evolve.weights' })
  const row = weights.cards.find((card) => card.label === '接话')
  assert.equal(row.value, '×1.12')
  const policy = detailView({ runtime: fakeRuntime(), at: 1, id: 'evolve.policy' })
  assert.match(policy.cards.find((card) => card.label === '多久看一次结果').value, /句对话/)
})

await check('花费区：今天的账每格都能对上，单价带「每百万 token」', () => {
  const today = detailView({ runtime: fakeRuntime(), usage: fakeUsage, at: 1, id: 'usage.today' })
  assert.equal(today.cards.find((card) => card.label === '合计').value, '2.0k')
  assert.equal(today.cards.find((card) => card.label === '今天花了').value, '¥0.12')
  const price = detailView({ runtime: fakeRuntime(), at: 1, id: 'usage.price' })
  assert.match(price.cards.find((card) => card.label === '输入单价').value, /百万 token/)
})

await check('没有这个页面时明确说，不装作有', () => {
  const one = detailView({ runtime: fakeRuntime(), at: 1, id: 'nope.nothing' })
  assert.equal(one.ok, false)
  assert.match(one.empty, /可能已经被删掉/)
})

await check('一栏算崩了：只报那一栏，其余照常（不整页白屏）', () => {
  const page = panelView({
    runtime: fakeRuntime({ statusThrows: true }),
    chat: fakeChat,
    usage: fakeUsage,
    guard: fakeGuard,
    channel: fakeChannel,
    at: 1,
  })
  assert.equal(page.ok, true)
  assert.equal(page.notices.length, 1)
  assert.equal(page.notices[0].section, 'status')
  assert.equal(page.sections.overview.tiles.find((tile) => tile.label === '今日收发').value, '—')
  assert.ok(page.regions.ability.modules.length > 0, '状态崩了，能力页仍要在')
})

await check('什么都没给也不崩：七个页面齐全，总览入口卡仍在（导航锚点不依赖数据）', () => {
  const page = panelView({})
  assert.equal(page.ok, true)
  assert.equal(Object.keys(page.regions).length, 7)
  for (const region of REGIONS) {
    const one = page.regions[region.id]
    assert.ok(one, `${region.id} 没算出来`)
    assert.ok(Array.isArray(one.modules), `${region.id} 的 modules 得是数组`)
  }
  // 总览是导航首页：入口卡是「去哪儿」的锚点，本就不依赖运行时数据，
  // 所以没有数据时它们照样在 —— 否则用户对着一张空白首页发呆。
  // 真正要验的是「结构不散」：这些卡在空输入下点进去必须安全返回，不能抛。
  const overview = page.regions.overview.modules
  assert.ok(overview.length > 0, '总览至少要给出去处')
  for (const module of overview) {
    const detail = detailView({ id: module.detail })
    assert.equal(detail.ok, true, `${module.detail} 在空输入下打不开`)
  }
})

await check('格式化：不出现 0 秒前 / 0% 这种假精确', () => {
  assert.equal(countText(999), '999')
  assert.equal(countText(1200), '1.2k')
  assert.equal(countText(undefined), '—')
  assert.equal(moneyText(0.5), '¥0.50')
  assert.equal(spanText(3_725_000), '1 小时 2 分')
  assert.equal(agoText(0), '还没有')
  assert.equal(rateText(0, 0), '还没试过')
  assert.equal(withUnit(5, '次/小时'), '5 次/小时')
  assert.equal(withUnit(undefined, '次'), '—')
})

await check('通道四种状态四种说法，不能混成一句「未连接」', () => {
  assert.equal(channelFace('online').label, '在线')
  assert.equal(channelFace('offline').label, '掉线了')
  assert.equal(channelFace('unknown').label, '还没连上')
  assert.equal(channelFace('off').label, '已关闭')
})

await check('登录状态：票据失效时把二维码摆出来，并给出可点的动作', () => {
  const runtime = fakeRuntime()
  runtime.napcat = {
    snapshot: () => ({
      phase: 'waiting_qr',
      phaseLabel: '等扫码',
      tone: 'warn',
      hint: '票据没成功，已自动出二维码；用手机 QQ 扫一下',
      online: false,
      mode: 'ticket',
      modeLabel: '票据',
      qrSuppressed: false,
      qr: { path: 'C:/x/qrcode.png', exists: true, at: 4000, ageMs: 1000, ageText: '刚刚', usable: true, src: assetUrl('napcat/qr') },
      warnings: [],
      lastAttempt: null,
    }),
  }
  const view = detailView({ runtime, channel: { state: () => 'offline' }, id: 'connection.status', at: 5000 })
  assert.equal(view.kind, 'rows')
  const state = view.rows.find((row) => row.id === 'state')
  assert.equal(state.meta, '等扫码')
  assert.match(state.desc, /票据没成功/)
  assert.ok(state.actions.some((action) => action.action === 'login-retry'))
  assert.ok(state.actions.some((action) => action.action === 'login-refresh'))
  const qrRow = view.rows.find((row) => row.id === 'qr')
  assert.equal(qrRow.open, 'connection.qr')
  const qr = detailView({ runtime, channel: { state: () => 'offline' }, id: 'connection.qr', at: 5000 })
  assert.equal(qr.kind, 'image')
  assert.match(qr.src, /ts=4000/)
  assert.equal(qr.login.phase, 'waiting_qr')
})

await check('自动出码关掉：状态说清楚，但「扫码登录」仍然可点', () => {
  const runtime = fakeRuntime()
  runtime.napcat = {
    snapshot: () => ({
      phase: 'qr_blocked',
      phaseLabel: '需要扫码（自动出码已关）',
      tone: 'warn',
      hint: '票据/密码没成功。自动二维码关着，点「扫码登录」才会出码',
      online: false,
      mode: 'ticket',
      modeLabel: '票据',
      qrSuppressed: true,
      qr: { path: 'C:/x/qrcode.png', exists: true, at: 4000, ageMs: 1000, ageText: '刚刚', usable: true, src: assetUrl('napcat/qr') },
      warnings: [],
      lastAttempt: null,
    }),
  }
  const view = detailView({ runtime, channel: { state: () => 'offline' }, id: 'connection.status', at: 5000 })
  const state = view.rows.find((row) => row.id === 'state')
  assert.match(state.desc, /自动二维码关着/)
  assert.ok(state.actions.some((action) => action.action === 'login-qr'))
  const qrRow = view.rows.find((row) => row.id === 'qr')
  assert.equal(qrRow.meta, '自动出码已关')
  assert.match(qrRow.desc, /自动出码关着/)
})

await check('技能开关只在开/关两态可点', () => {
  assert.equal(skillFace({ state: 'on' }).toggleable, true)
  assert.equal(skillFace({ state: 'off' }).toggleable, true)
  assert.equal(skillFace({ state: 'blocked', wired: false }).toggleable, false)
})

// ── 两份字面量必须说同一组数 ────────────────────────────────────

const clientSource = readFileSync(new URL('../lib/client.panel.js', import.meta.url), 'utf8')

await check('宽度：浏览器样式表里的展开/轨道宽度 === 视图模型的几何', () => {
  const widths = [...clientSource.matchAll(/--slj-nav-w:\s*(\d+)px/g)].map((match) => Number(match[1]))
  const unique = [...new Set(widths)].sort((a, b) => a - b)
  assert.deepEqual(unique, [SIDEBAR.collapsed, SIDEBAR.expanded].sort((a, b) => a - b))
})

await check('前端不再自带几何：断点只有 SIDEBAR 一份', () => {
  // 以前这里是「两个字面量必须相等」。两份相等的代价是：改一处忘另一处，谁也不会发现。
  // 现在浏览器侧一个数字都没有 —— 数据没到时不猜，用 CSS 里的默认宽先撑住。
  assert.equal(/const FALLBACK_LAYOUT/.test(clientSource), false, '兜底几何应当已经删掉')
  assert.equal(/autoCollapseAt:\s*\d+/.test(clientSource), false, '断点数字不该在浏览器里出现')
  assert.match(clientSource, /const layout = \(data && data\.layout\) \|\| null/, '几何应当只认下发值')
})

await check('前端不再自带页面清单：导航全部来自 /panel，旧 id 靠下发别名翻译', () => {
  assert.equal(/const FALLBACK_NAV/.test(clientSource), false, '兜底导航应当已经删掉')
  // 页面合并（10 → 6）之后，浏览器里若还留着一份旧清单，点进去就是空白页 ——
  // 而代码看起来一切正常。这条就是拦这个的。
  for (const region of REGIONS) {
    assert.equal(
      new RegExp("id: '" + region.id + "', label:").test(clientSource),
      false,
      `浏览器里不该再出现页面清单项 ${region.id}`,
    )
  }
  assert.match(clientSource, /aliases\[pref\.region\]/, '旧页面 id 必须经下发别名翻译')
  assert.match(clientSource, /slj-skelRow/, '数据没到时要画骨架，而不是留空或抄一份清单')
})

await check('接进宿主：入口与主面板成对注册，且只用 slj- 前缀', () => {
  assert.match(clientSource, /name:\s*'main'/)
  assert.match(clientSource, /key:\s*PANEL_ID/)
  assert.match(clientSource, /name:\s*'sidebar\.panellist'/)
  assert.match(clientSource, /id:\s*PANEL_ID/)
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(/)
  assert.equal(/body\.style/.test(clientSource), false, '不许改宿主 body 的样式')
})

await check('节奏与注意力：接上之后概览有卡、点开有数；没接上就不画那张卡', () => {
  const typing = {
    stats: () => ({ typed: 12, waiting: 0, lastWaitMs: 2600, overloads: 0, savedMs: 4000, lastKey: 'private:20002', busy: false }),
  }
  const attention = {
    stats: () => ({ conversations: 1, people: 1, handoffs: 2, windowMs: 180000, maxTurns: 5, lastHandoff: { conversation: 'group:1', from: 'A', to: 'B', at: Date.now() - 5000 } }),
    snapshot: () => [{ conversation: 'group:1', who: 'B', turns: 1, max: 5, remainingMs: 120000 }],
  }

  const bare = panelView({})
  assert.equal(bare.regions.overview.modules.some((one) => one.detail === 'overview.rhythm'), false, '没装配就不该画这张卡')

  const view = panelView({ typing, attention })
  const card = view.regions.overview.modules.find((one) => one.detail === 'overview.rhythm')
  assert.ok(card, '装配了就必须有入口')
  assert.match(card.desc, /12 条/, '卡片上要能看到真数字')
  assert.ok(view.sections.overview.tiles.some((tile) => tile.label === '打字台'))
  assert.ok(view.sections.overview.tiles.some((tile) => tile.label === '注意力'))

  const rhythm = detailView({ typing, attention, id: 'overview.rhythm' })
  assert.equal(rhythm.kind, 'cards')
  assert.ok(rhythm.cards.length >= 6, '打字台和注意力都要有卡片')
  assert.ok(rhythm.cards.some((one) => one.label === '省掉的等待'), '体感升级要看得到')

  const windows = detailView({ typing, attention, id: 'overview.attention' })
  assert.equal(windows.kind, 'rows')
  assert.equal(windows.rows.length, 1)
  // 界面只说「还能接着聊多久」，不出现「第 N 轮」这种执行过程描述
  assert.match(windows.rows[0].meta, /还能接着聊/)
  assert.doesNotMatch(windows.rows[0].meta, /第 \d+\/\d+ 轮/)

  const off = detailView({ id: 'overview.rhythm' })
  assert.equal(off.kind, 'rows', '没装配时如实说空，不许抛')
  assert.ok(off.empty)
})

await check('Token 概览：今日与累计两个口径都在，且不混成一个数', () => {
  const overview = view().sections.overview.tiles
  const todayTile = overview.find((tile) => tile.label === '今日 token')
  const totalTile = overview.find((tile) => tile.label === '累计 token')
  assert.ok(todayTile, '概览少了「今日 token」')
  assert.ok(totalTile, '概览少了「累计 token」')
  assert.equal(totalTile.value, '130k')
  assert.match(totalTile.hint, /一共/)

  const page = detailView({ runtime: fakeRuntime(), usage: fakeUsage, at: 1, id: 'usage.today' })
  const lifetime = page.cards.find((card) => card.label === '累计总用量')
  assert.ok(lifetime, '「今天的账」里没有累计总用量')
  assert.equal(lifetime.value, '130k')
  assert.match(lifetime.hint, /2026-09-01/, '累计从哪天算起要写出来')
  assert.match(page.note, /累计/, '备注要说清累计值不随按天裁剪减少')
})

await check('沙箱确认：同一个请求只留最后一条，超时写成「超时拒绝」', () => {
  const page = detailView({ runtime: fakeRuntime(), at: 5_500_000, id: 'process.approvals' })
  assert.equal(page.kind, 'rows')
  assert.match(page.subtitle, /问了 4 次/)
  // a1 在账本里有 asked + allow 两条，只该出现一条（否则一段代码看着像问了两次）
  const ids = page.rows.map((row) => row.id)
  assert.equal(ids.filter((id) => id === 'a:a1').length, 1)
  const timeout = page.rows.find((row) => row.id === 'a:a0')
  assert.match(timeout.title, /超时拒绝/)
  assert.match(timeout.desc, /超时未确认/)
  // 项目与目的要出现在标题/元信息里：只写「某段代码」的记录事后没法复盘
  assert.match(timeout.title, /打印一行字/)
  assert.match(timeout.meta, /深蓝鲸/)
  assert.equal(page.rows[0].id, 'a:a1', '最新的排在最前面')
})

await check('沙箱详情：待确认、确认记录、记住的结论三格都在', () => {
  const page = detailView({ runtime: fakeRuntime(), at: 1, id: 'process.sandbox' })
  const labels = page.cards.map((card) => card.label)
  for (const label of ['等人确认', '确认记录', '记住的结论']) assert.ok(labels.includes(label), '少了「' + label + '」')
  assert.equal(page.cards.find((card) => card.label === '等人确认').value, '1')
  assert.match(page.cards.find((card) => card.label === '确认记录').value, /同意 2 \/ 拒绝 2/)
})

await check('「没回的时候」：只列没回的那些，原因是人话，还带着会话', () => {
  const page = detailView({ runtime: fakeRuntime(), id: 'process.skips' })
  assert.equal(page.kind, 'rows')
  assert.ok(page.title.includes('没回'), '标题要说清这一页看什么')
  // 回了的那条不该出现
  assert.equal(page.rows.length, 2, '只有没回的两条')
  const texts = page.rows.map((row) => row.title)
  assert.ok(texts.some((t) => t.includes('夜间静音')), '夜间要说人话，不是 night')
  assert.ok(texts.some((t) => t.includes('预算')), '预算要说人话，不是 over_budget')
  for (const row of page.rows) {
    assert.ok(!/^(night|over_budget|per_minute|per_hour)$/.test(row.title), '不能把内部代号摆给人看')
  }
  // 会话信息要能看到 —— 知道是哪条消息、哪个会话没回
  assert.ok(page.rows.some((row) => row.meta.includes('私聊')), '要标明是私聊还是群里')
  assert.ok(page.rows.some((row) => row.meta.includes('gr:555')), '要能定位到会话')
})

await check('行为账本补齐会话：只给 eventId 也能定位到哪条消息', () => {
  // turn.mjs 的 20 个 outcome 调用点没有一处传 scope/conversation，
  // 所以账本里这两栏以前永远是空的 —— 「为什么没回」连是哪条都查不出来。
  const dir = mkdtempSync(path.join(tmpdir(), 'skips-'))
  const runtime = new Runtime({ dir, now: () => 1 })
  runtime.logEvent({ id: 'e9', scope: 'private', conversation: 'pr:9', from: 'u1', at: 1, payload: { text: '在吗' }, tags: [] })
  runtime.outcome({ eventId: 'e9', behavior: 'reply', trigger: 'night', ok: false, reason: '夜间' })
  const row = runtime.behaviors.read({ limit: 1 }).rows[0]
  assert.equal(row.scope, 'private', 'scope 要自动补上')
  assert.equal(row.conversation, 'pr:9', 'conversation 要自动补上')
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

await check('前端自报现场：宿主给多宽 / 视口多宽 / 被裁多少，都要原样透传', () => {
  // 这四项是排查"界面右边被切"的唯一事实来源。少透传一项，
  // 界面上就只能靠截图猜 —— 而"猜"正是这一轮反复踩的坑。
  const page = panelView({
    runtime: fakeRuntime(),
    chat: fakeChat,
    usage: fakeUsage,
    guard: fakeGuard,
    channel: fakeChannel,
    at: 1,
    clientProbe: { rev: 'css1234', width: 1256, viewport: 1550, left: 370, overflow: 76, geo: 'nav:248@370 inner:1008@370' },
  })
  const client = page.head.build.client
  assert.equal(client.rev, 'css1234')
  assert.equal(client.width, 1256, '宿主给的宽度')
  assert.equal(client.viewport, 1550, '浏览器视口宽度')
  assert.equal(client.left, 370, '根节点左偏移（决定可见宽度）')
  assert.equal(client.overflow, 76, '被外层裁掉的像素数')
  assert.match(client.geo, /nav:248@370/, '分栏实测要原样透传')
  // 没上报时不许编数字：全 0 才是"还不知道"
  const empty = panelView({ runtime: fakeRuntime(), chat: fakeChat, usage: fakeUsage, guard: fakeGuard, channel: fakeChannel, at: 1 })
  assert.deepEqual(empty.head.build.client, { rev: '', width: 0, viewport: 0, left: 0, overflow: 0, geo: '' })
})

console.log(`\n${failed.length ? '✗' : '✓'} 页面骨架用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)