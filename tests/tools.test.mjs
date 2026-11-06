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
import { calc, createTools } from '../lib/tools.mjs'
import { skillIdOfTool } from '../lib/skill.mjs'
import { isRefused } from '../lib/refusals.mjs'

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
  const tools = createTools()
  assert.deepEqual(tools.names(), [
    'time', 'calc', 'web_search', 'web_fetch', 'digest', 'exec_sandbox', 'self_tune', 'voice_to_text',
    'image_read', 'file_read', 'code_list', 'code_read', 'code_search', 'code_write', 'code_restore',
    'run_command', 'remind', 'set_reminder', 'memory_search', 'people_lookup', 'thread_summary',
    'send_sticker', 'list_stickers', 'save_sticker', 'send_face', 'at_person', 'read_forward_more',
    'recall', 'remember_fact', 'remember_self', 'revise_self', 'forget_self', 'remember_person',
    'my_memory', 'my_digest', 'my_status', 'person_dossier', 'group_recap', 'who_said',
    'my_activities', 'my_thoughts', 'my_capabilities', 'my_schedule', 'group_impressions',
    'note_want', 'my_wants', 'resolve_want', 'drop_want', 'view_avatar', 'draw_image', 'news_now', 'hot_news',
    'owner_commands', 'write_notebook', 'read_notebook', 'refuse_person',
  ])
  assert.equal(tools.has('calc'), true)
  assert.equal(tools.has('send_sticker'), true)
  assert.equal(tools.has('recall'), true)
})

await check('调没接上的工具：错误码是 not_wired，不是「参数错了」', () => {
  const tools = createTools()
  const result = tools.call('proactive', {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_wired')
  assert.match(result.error, /还没接上/)
})

await check('调 calc：走工具表也一样算得对', () => {
  const tools = createTools()
  const result = tools.call('calc', { expression: '6*7' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '42')
})

await check('建表时把「接上了」登记给运行时（技能页才敢说会用）', () => {
  const registered = []
  const tools = createTools({ runtime: { registerTools: (names) => registered.push(...names) } })
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
    const tools = createTools({ runtime: fakeRuntime(dir), channel })
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
    const tools = createTools({ runtime: fakeRuntime(dir), channel })
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

await check('收藏表情：从聊天图片落库，重复收藏不新增文件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const image = path.join(dir, 'in.png')
    writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))
    const tools = createTools({ runtime: fakeRuntime(dir), channel: { sendImage: async () => {} } })
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

await check('回忆：只在说过的原话里找，不编造', () => {
  const rows = [
    { at: 1, scope: 'group', group: '9', from: '42', sender: '老王', text: '上次说的那家店在城南' },
    { at: 2, scope: 'private', from: '42', sender: '老王', text: '今天吃什么' },
  ]
  const tools = createTools({ runtime: fakeRuntime('E:/tmp', rows) })
  const hit = tools.call('recall', { query: '那家店' })
  assert.equal(hit.ok, true)
  assert.match(hit.text, /城南/)
  assert.doesNotMatch(hit.text, /吃什么/)
})

await check('需求本：记一条、改状态、删掉，三步都能查', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const tools = createTools({ runtime: fakeRuntime(dir) })
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

await check('不想理某人：登记之后查得到，主人不会被登记', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-tool-'))
  try {
    const runtime = fakeRuntime(dir)
    runtime.config.identity = { ownerId: '10000' }
    const tools = createTools({ runtime })
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
  const tools = createTools()
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
  const tools = createTools({ runtime })
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
  const tools = createTools({ runtime })
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
    const tools = createTools({ runtime, channel: null, usage: null, dir })
    const names = tools.names()
    assert.ok(names.length >= 40, '工具表不该只剩几个')
    const orphans = names.filter((name) => !skillIdOfTool(name))
    assert.deepEqual(orphans, [], '这些工具没有归属技能：' + orphans.join('、'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${failed.length ? '✗' : '✓'} 工具用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
