/**
 * 工具表用例。
 *
 * 重点不在「算得对」，而在「没实现的工具不许登记」——
 * 那一条决定了技能页会不会说谎。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { calc, createTools } from '../ability/index.mjs'
import { skillIdOfTool } from '../ability/index.mjs'
import { addWant, dropWant, isRefused, listWants, refuse, resolveWant, wantStats } from '../mind/index.mjs'
import { digestForward } from '../ability/index.mjs'
import { Reminders, describeAt, parseReminder, parseWhen } from '../life/index.mjs'

// 0.46.0：能力层不再自己 import 心智层 / 生活层，改由装配层注入。
// 用例扮演装配层，给它同一份依赖 —— 少了这份，需求本与提醒工具应当报 not_wired。
const deps = {
  mind: { addWant, dropWant, listWants, resolveWant, wantStats, refuse },
  life: { parseWhen, parseReminder, describeAt },
}

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

await check('四则运算：优先级按数学来，不是从左往右', () => {
  assert.equal(calc('1+2*3').value, 7)
  assert.equal(calc('(1+2)*3').value, 9)
})

await check('小数和负数都对', () => {
  assert.equal(calc('0.1+0.2').text, '0.3', '浮点误差要收掉，不能显示 0.30000000000000004')
  assert.equal(calc('-5+3').value, -2)
  assert.equal(calc('-(2+3)').value, -5)
})

await check('除零不抛异常，给一句人话', () => {
  const result = calc('1/0')
  assert.equal(result.ok, false)
  assert.match(result.error, /除以 0/)
})

await check('不认识字符：指出第几个字，别只说「格式错误」', () => {
  const result = calc('1+abc')
  assert.equal(result.ok, false)
  assert.match(result.error, /第 3 个字符/)
})

await check('括号没配对要说清楚', () => {
  assert.match(calc('(1+2').error, /括号/)
})

await check('空式子、超长式子都拒绝', () => {
  assert.equal(calc('').ok, false)
  assert.equal(calc('1+'.repeat(200)).ok, false)
})

await check('不用 eval：表达式里写代码不会被执行', () => {
  // 这一条是安全底线。如果换成 eval，下面这行会真的执行
  const result = calc('process.exit(1)')
  assert.equal(result.ok, false, '这种输入只能被当成「看不懂的字符」')
})

await check('工具表：只有真能跑的才在里面', () => {
  const tools = createTools(deps)
  assert.deepEqual(tools.names(), [
    'time', 'calc', 'web_search', 'web_fetch', 'digest', 'exec_sandbox', 'self_tune', 'voice_to_text',
    'image_read', 'file_read', 'code_list', 'code_read', 'code_search', 'code_write', 'code_restore',
    'run_command', 'remind', 'set_reminder', 'memory_search', 'people_lookup', 'thread_summary',
    'send_sticker', 'list_stickers', 'save_sticker', 'send_face', 'at_person', 'read_forward_more', 'withdraw_message',
    'recall', 'remember_fact', 'remember_self', 'revise_self', 'forget_self',
    'read_persona', 'revise_persona', 'absorb_habit', 'persona_versions', 'rollback_persona',
    'remember_person',
    'my_memory', 'my_digest', 'my_status', 'person_dossier', 'group_recap', 'who_said',
    'my_activities', 'my_thoughts', 'my_capabilities', 'audit_self', 'my_patch_proposals',
    'propose_patch', 'close_patch', 'my_schedule', 'group_impressions',
    'note_want', 'my_wants', 'resolve_want', 'drop_want', 'view_avatar', 'draw_image', 'news_now', 'hot_news',
    'owner_commands', 'write_notebook', 'read_notebook', 'refuse_person', 'browser',
  ])
  assert.equal(tools.has('calc'), true)
  assert.equal(tools.has('send_sticker'), true)
  assert.equal(tools.has('recall'), true)
})

await check('调没接上的工具：错误码是 not_wired，不是「参数错了」', () => {
  const tools = createTools(deps)
  const result = tools.call('proactive', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_wired')
  assert.match(result.error, /还没接上/)
})

await check('调 calc：走工具表也一样算得对', () => {
  const tools = createTools(deps)
  const result = tools.call('calc', { expression: '6*7' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '42')
})

await check('建表时把「接上了」登记给运行时（技能页才敢说会用）', () => {
  const registered = []
  const tools = createTools({ ...deps, runtime: { registerTools: (names) => registered.push(...names) } })
  assert.ok(registered.includes('calc'))
  assert.equal(tools.has('calc'), true)
})

/** 一个只够跑工具的最小运行时：不碰磁盘、不联网 */
function fakeRuntime(dir, rows = []) {
  const memory = {
    data: { facts: [], people: {}, groups: {}, self: [], summaries: [] },
    facts: () => [],
    selfNotes: () => [],
    digest: () => ({}),
    stats: () => ({ facts: 0, people: 0, groups: 0 }),
    rememberFact: (text) => ({ ok: true, item: { text } }),
    rememberSelf: () => ({ ok: true }),
    updateSelf: () => ({ ok: true }),
    forgetSelf: () => ({ ok: true }),
    rememberPerson: () => ({ ok: true }),
    group: () => null,
  }
  return {
    dir,
    memory,
    config: { tools: { whitelist: [] }, net: { allowlist: [] }, usage: { budgetPerDay: 5 }, proactive: {}, memory: {} },
    events: { read: () => ({ rows }) },
    activities: { read: () => ({ rows: [] }) },
    cot: { read: () => ({ rows: [] }) },
    reminders: { list: () => [], add: () => ({ ok: true }) },
    skills: () => ({ counts: { on: 0, blocked: 0, notWired: 0 } }),
    status: () => ({ 'status.uptime': 1000, 'status.todayMessages': 2, 'status.behaviorCount': 1, 'status.channel': 'online' }),
    registerTools: () => {},
  }
}

await check('发表情：真的把库里的图交给通道，且发在当前会话', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    mkdirSync(path.join(dir, 'stickers'), { recursive: true })
    writeFileSync(path.join(dir, 'stickers', 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
    const sent = []
    const channel = { sendImage: async (scope, target, file) => { sent.push({ scope, target, file }) } }
    const tools = createTools({ ...deps, runtime: fakeRuntime(dir), channel })
    const event = { scope: 'group', from: '42', conversation: 'group:9', payload: { groupId: '9' } }
    const result = await tools.call('send_sticker', { name: 'a.png' }, { event })
    assert.equal(result.ok, true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].scope, 'group')
    assert.equal(sent[0].target, '9')
    assert.match(sent[0].file, /a\.png$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('@人：只在群里生效，私聊里如实拒绝', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const calls = []
    const channel = { sayAt: async (group, qq, text) => calls.push({ group, qq, text }) }
    const tools = createTools({ ...deps, runtime: fakeRuntime(dir), channel })
    const group = { scope: 'group', from: '42', conversation: 'group:9', payload: { groupId: '9' } }
    const ok = await tools.call('at_person', { qq: '10001', text: '在呢' }, { event: group })
    assert.equal(ok.ok, true)
    assert.deepEqual(calls[0], { group: '9', qq: '10001', text: '在呢' })
    const privateEvent = { scope: 'private', from: '42', conversation: 'private:42', payload: {} }
    const no = await tools.call('at_person', { qq: '10001', text: '在呢' }, { event: privateEvent })
    assert.equal(no.ok, false)
    assert.match(no.error, /只能在群聊/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('撤回：只撤自己 2 分钟内、当前会话的最近一条', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-recall-'))
  try {
    const calls = []
    const rows = [{ from: 'self', conversation: 'group:9', messageId: 'm-1', text: '说错了', at: Date.now() }]
    const runtime = fakeRuntime(dir, rows)
    runtime.log = () => {}
    const tools = createTools({ ...deps, runtime, channel: { recall: async (id) => calls.push(id) } })
    const event = { scope: 'group', from: '42', conversation: 'group:9', payload: { groupId: '9' } }
    const out = await tools.call('withdraw_message', {}, { event })
    assert.equal(out.ok, true)
    assert.deepEqual(calls, ['m-1'])
    assert.match(out.text, /说错了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('撤回：next:true 只登记下一条，不立刻撤已有消息', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-recall-next-'))
  try {
    let scheduled = 0
    const tools = createTools({ ...deps, runtime: fakeRuntime(dir), channel: { recall: async () => {} } })
    const event = { scope: 'group', from: '42', conversation: 'group:9', payload: { groupId: '9' } }
    const out = await tools.call('withdraw_message', { next: true }, {
      event,
      scheduleRecall: () => { scheduled += 1; return { ok: true } },
    })
    assert.equal(out.ok, true)
    assert.equal(scheduled, 1)
    assert.match(out.text, /发出去后会撤回/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('改代码：先问我档会先弹确认，群聊要求也不例外', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-ask-'))
  try {
    const runtime = fakeRuntime(dir)
    runtime.config.sandbox = { mode: 'ask', codeMode: 'write' }
    let asked = 0
    runtime.sandbox = {
      approvals: {
        request: async (input) => {
          asked += 1
          assert.match(input.purpose, /群聊 12345/)
          assert.match(input.purpose, /群友/)
          assert.equal(input.origin, 'group:12345')
          return { allowed: false, reason: '主人拒绝了' }
        },
      },
    }
    const tools = createTools({ ...deps, runtime, channel: {} })
    const event = { scope: 'group', from: '42', conversation: 'group:12345', payload: { senderName: '群友', groupId: '12345' } }
    const out = await tools.call('code_write', { path: 'decide/behavior.mjs', content: 'x' }, { event })
    assert.equal(out.ok, false)
    assert.match(out.error, /主人拒绝/)
    assert.equal(asked, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('@人：不能 @ 自己，1000000001 是深蓝自己的号', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-at-self-'))
  try {
    const runtime = fakeRuntime(dir)
    runtime.config.channel = { selfId: '1000000001' }
    const tools = createTools({ ...deps, runtime, channel: { sayAt: async () => {} } })
    const group = { scope: 'group', from: '42', conversation: 'group:9', payload: { groupId: '9' } }
    const out = await tools.call('at_person', { qq: '1000000001', text: '在吗' }, { event: group })
    assert.equal(out.ok, false)
    assert.match(out.error, /不能 @ 自己/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('收藏表情：从聊天图片落库，重复收藏不新增文件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const image = path.join(dir, 'in.png')
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
    const tools = createTools({ ...deps, runtime: fakeRuntime(dir), channel: { sendImage: async () => {} } })
    const event = { scope: 'private', from: '42', conversation: 'private:42', payload: { images: [{ file: image }], text: '存表情 无语' } }
    const first = await tools.call('save_sticker', {}, { event })
    const second = await tools.call('save_sticker', {}, { event })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    const index = JSON.parse(readFileSync(path.join(dir, 'stickers', 'index.json'), 'utf8'))
    assert.equal(index.items.length, 1, '同一张图不该存两份')
    assert.ok(index.items[0].labels.includes('无语'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('看图：当前消息没图时，自动用同会话最近一张', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-see-'))
  try {
    const image = path.join(dir, 'in.png')
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
    const runtime = fakeRuntime(dir, [{ conversation: 'group:1', images: [{ file: image }] }])
    runtime.describeImageFile = async () => ({ ok: true, text: '图里是一张问界 M7 车款表' })
    const tools = createTools({ ...deps, runtime })
    const out = await tools.call('image_read', {}, { event: { conversation: 'group:1', payload: { text: '看看这图' } } })
    assert.equal(out.ok, true)
    assert.match(out.text, /问界 M7/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('回忆：只在说过的原话里找，不编造', () => {
  const rows = [
    { at: 1, scope: 'group', group: '9', from: '42', sender: '老王', text: '上次说的那家店在城南' },
    { at: 2, scope: 'private', from: '42', sender: '老王', text: '今天吃什么' },
  ]
  const tools = createTools({ ...deps, runtime: fakeRuntime('E:/tmp', rows) })
  const hit = tools.call('recall', { query: '那家店' })
  assert.equal(hit.ok, true)
  assert.match(hit.text, /城南/)
  assert.doesNotMatch(hit.text, /吃什么/)
})

await check('设提醒：time/content 这些别名都接得住，重复的只留一条', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const runtime = fakeRuntime(dir)
    runtime.config.identity = { ownerId: '10001' }
    runtime.reminders = new Reminders({ dir })
    const tools = createTools({ ...deps, runtime })
    const event = { scope: 'private', from: '10001', conversation: 'private:10001', payload: { text: '提醒我明天早上9点改毛病' } }

    const first = tools.call('set_reminder', { time: '明天早上 9 点', content: '改毛病' }, { event })
    assert.equal(first.ok, true)
    assert.match(first.text, /明天 09:00/)
    assert.match(first.text, /改毛病/)
    assert.equal(runtime.reminders.list().length, 1)

    const again = tools.call('set_reminder', { at: '明天早上 9 点', text: '改毛病' }, { event })
    assert.equal(again.ok, true)
    assert.match(again.text, /已经记过/)
    assert.equal(runtime.reminders.list().length, 1, '同样内容同一时间不该设两条')

    const noTime = tools.call('set_reminder', { text: '喝水' }, { event })
    assert.equal(noTime.ok, false)
    assert.match(noTime.error, /什么时候/)
    const noText = tools.call('set_reminder', { at: '明天早上 9 点' }, { event: { ...event, payload: {} } })
    assert.equal(noText.ok, false)
    assert.match(noText.error, /什么内容/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('需求本：记一条、改状态、删掉，三步都能查', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const tools = createTools({ ...deps, runtime: fakeRuntime(dir) })
    assert.equal(tools.call('note_want', { what: '想看一本讲鲸鱼的书' }).ok, true)
    assert.match(tools.call('my_wants', {}).text, /鲸鱼/)
    assert.equal(tools.call('resolve_want', { target: '1' }).ok, true)
    assert.match(tools.call('my_wants', {}).text, /done/)
    assert.equal(tools.call('note_want', { what: '想要个新键盘' }).ok, true)
    assert.equal(tools.call('drop_want', { target: '1' }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('没注入心智层/生活层时：明说「没接上」，不是假装参数错了', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const bare = createTools({ runtime: fakeRuntime(dir) })
    const want = bare.call('my_wants', {})
    assert.equal(want.ok, false)
    assert.equal(want.code, 'not_wired')
    assert.match(want.error, /没接上/)
    const reminder = bare.call('set_reminder', { at: '明天早上 9 点', text: '喝水' })
    assert.equal(reminder.code, 'not_wired')
    // 状态工具不该因为少一层就整个失败：少一行，其余照常
    assert.equal(bare.call('my_status', {}).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('不想理某人：登记之后查得到，主人不会被登记', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const runtime = fakeRuntime(dir)
    runtime.config.identity = { ownerId: '10000' }
    const tools = createTools({ ...deps, runtime })
    const event = { scope: 'group', from: '12345', conversation: 'group:9', tags: [] }
    const done = tools.call('refuse_person', { minutes: 30 }, { event })
    assert.equal(done.ok, true)
    assert.equal(isRefused(dir, '12345'), true)
    assert.equal(isRefused(dir, '10000'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('提示词里的工具清单跟着工具表走，不再手写', () => {
  const tools = createTools(deps)
  const line = tools.prompt()
  assert.match(line, /recall/)
  assert.match(line, /send_sticker/)
  assert.match(line, /JSON/)
})

await check('技能关掉之后：模型调不动，清单里也不列（内部调用不受影响）', () => {
  const runtime = {
    registerTools: () => {},
    config: { tools: { whitelist: [] } },
    blockedTools: () => new Set(['web_search']),
  }
  const tools = createTools({ ...deps, runtime })
  // 主动关掉的那一项：模型那条路（byModel）要明确拒绝，并说清是「关掉了」而不是「坏了」
  const blocked = tools.call('web_search', { query: '今天天气' }, { byModel: true })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'skill_off')
  assert.match(blocked.error, /关掉/)
  // 清单里不再出现，免得模型冲着它反复重试
  assert.equal(/web_search/.test(tools.prompt()), false, '关掉的工具还写在提示词里')
  assert.equal(/recall/.test(tools.prompt()), true, '没关的不能跟着一起消失')
  // 主人指令 / 定时器这类内部调用不走这道闸：用户关的是「让它自己用」
  assert.notEqual(tools.call('calc', { expression: '1+1' }, {}).code, 'skill_off')
})

await check('工具白名单同时管执行和清单：列的才给，没列的不提', () => {
  const runtime = {
    registerTools: () => {},
    config: { tools: { whitelist: ['calc', 'time'] } },
    blockedTools: () => new Set(),
  }
  const tools = createTools({ ...deps, runtime })
  assert.equal(tools.call('recall', { query: 'x' }).ok, false)
  assert.match(tools.call('recall', { query: 'x' }).error, /白名单/)
  const line = tools.prompt()
  assert.match(line, /calc/)
  assert.equal(/recall/.test(line), false, '白名单外的工具不该出现在提示词里')
})

await check('每个真工具都能反查到技能：反查不到就永远记不进「用过几次」', () => {
  // 这条是「级别永远显示没试过」的根因守卫。
  // 记账靠工具名 → 技能 id 这一步，映射缺一个，那个能力的履历就永远是空的，
  // 而且不会报错 —— 只能靠这条把缺口钉住。
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tools-map-'))
  try {
    const runtime = {
      config: { channel: { enabled: false }, net: { allowlist: [] }, sandbox: { mode: 'off' }, tools: { whitelist: [] } },
      registerTools: () => {},
      dir,
      log: () => {},
      blockedTools: () => new Set(),
    }
    const tools = createTools({ ...deps, runtime, channel: null, usage: null, dir })
    const names = tools.names()
    assert.ok(names.length >= 40, '工具表不该只剩几个')
    const orphans = names.filter((name) => !skillIdOfTool(name))
    assert.deepEqual(orphans, [], '这些工具没有归属技能：' + orphans.join('、'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('模型编工具名：要递一个真名过去，词序颠倒的也得认出来', () => {
  const tools = createTools({ ...deps, runtime: { log: () => {} }, config: {}, dir: '.' })
  const cases = [
    ['search_web', 'web_search'], // 词都对、顺序反了（编辑距离 8，最容易被漏掉的一种）
    ['fetch_web', 'web_fetch'],
    ['websearch', 'web_search'],
    ['web-search', 'web_search'],
    ['tim', 'time'],
  ]
  for (const [wrong, right] of cases) {
    const result = tools.call(wrong, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not_wired', '拼错名字是「还没接上」，不是「参数错了」')
    assert.match(String(result.error), new RegExp(right), `「${wrong}」应该被指到 ${right}`)
  }
  // 完全不像的名字：别硬猜，给一份可用清单就好
  const none = tools.call('zzzzzz', {})
  assert.equal(none.code, 'not_wired')
  assert.match(String(none.error), /当前可用/, '猜不出来时给清单，不要瞎指一个')
})

// ── 转发：读得完、读得下去 ───────────────────────────────────
const forwardNodes = (count) => {
  const t0 = new Date('2026-11-06T21:00:00+08:00').getTime()
  return Array.from({ length: count }, (_, index) => ({
    sender: ['阿三', '小四', 'ce'][index % 3],
    text: `第${index + 1}条：` + '内容'.repeat(40),
    time: t0 + index * 90_000,
  }))
}

await check('转发整理：报的是原始条数，不是合并后的段数', () => {
  // 线上就是这里对不上：提示词写「共 4 条」，工具说「全部共 18 条」，
  // 模型以为没读完，于是一直翻页。
  const same = forwardNodes(18).map((row) => ({ ...row, sender: '阿三' }))
  const digest = digestForward(same, { maxChars: 600 })
  assert.equal(digest.nodes, 18)
  assert.match(digest.text, /共 18 条消息/)
  assert.ok(digest.truncated > 0)
})

await check('转发翻页：不传参数也要接着上一页往下走', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tools-forward-'))
  const tools = createTools({ ...deps, runtime: { config: {}, dir }, dir })
  const ctx = { event: { conversation: 'group:f1' }, forwardAll: forwardNodes(18) }
  const first = tools.call('read_forward_more', {}, ctx)
  const second = tools.call('read_forward_more', {}, ctx)
  assert.match(String(first.text), /第1条/)
  assert.ok(second.data.from > first.data.from, '第二次必须换到新一页，不能原地重读')
  assert.doesNotMatch(String(second.text).split('\n')[1] || '', /第1条：/, '第二页不该从第 1 条开始')
  assert.equal(first.data.done, false)
})

await check('转发翻页：读到末尾再说「读完了」，不把最后一条当新内容反复返回', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tools-forward-end-'))
  const tools = createTools({ ...deps, runtime: { config: {}, dir }, dir })
  const ctx = { event: { conversation: 'group:f2' }, forwardAll: forwardNodes(6) }
  const first = tools.call('read_forward_more', {}, ctx)
  assert.equal(first.data.done, true, '6 条一次就读完了')
  const again = tools.call('read_forward_more', {}, ctx)
  assert.equal(again.data.done, true)
  assert.match(String(again.text), /读完/)
  assert.doesNotMatch(String(again.text), /第6条：/, '读完之后不能又吐一遍最后一条')
})

console.log(`\n${failed.length ? '✗' : '✓'} 工具用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
