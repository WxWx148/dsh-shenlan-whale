/**
 * 回合用例 —— 一条消息进来，一句话出去。
 *
 * 这份测的是「接起来对不对」，不是「每个函数对不对」：
 * 分条、限流、记账、落盘、出站，五件事必须在同一次调用里都发生。
 * 生成器是假的（不联网、不调模型），所以这条链可以在没有宿主的环境里完整验证。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../app/index.mjs'
import { Guard } from '../decide/index.mjs'
import { Usage } from '../facts/index.mjs'
import { Turn, buildPrompt, parseToolCalls, splitReply, stripToolMarks } from '../turn/index.mjs'
import { AttentionDesk } from '../decide/index.mjs'
import { TypingDesk } from '../voice/index.mjs'
import { KIND, SCOPE, SOURCE } from '../facts/index.mjs'

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

const BASE = new Date(2026, 9, 29, 14, 0, 0).getTime()
const OWNER = '10001'
const dirs = []

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), 'turn-'))
  dirs.push(dir)
  const runtime = new Runtime({ dir, now: () => BASE })
  runtime.setConfig('identity.ownerId', OWNER, { confirm: true })
  // 这一套验的是单条回合的发送/记账；连发合并由 burst.test.mjs 单独验。
  runtime.setConfig('guard.mergeWindowMs', 0, { confirm: false })
  const guard = new Guard({ config: runtime.config, now: () => BASE })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, now: () => BASE })
  const sent = []
  const channel = {
    say: async (scope, target, text) => {
      sent.push({ scope, target, text })
      return { message_id: sent.length }
    },
  }
  return { runtime, guard, usage, channel, sent, dir }
}

/** 造一个回合。runner 默认说一句「嗯，知道了」 */
function makeTurn(ctx, over = {}) {
  const turn = new Turn({
    runtime: ctx.runtime,
    guard: ctx.guard,
    usage: ctx.usage,
    channel: ctx.channel,
    runner: async () => ({ text: '嗯，知道了', usage: { input: 1000, output: 200 } }),
    sleep: async () => {},
    now: () => BASE,
    // 连发合并的窗口在这里**立刻结算**：
    // 真实运行时要等 1.5 秒（等对方说完），用例里真等会让整个套件慢十几倍，
    // 而且断言时快时慢。合并本身的行为由 tests/burst.test.mjs 单独验证
    // （那里能精确控制「什么时候算说完」）。
    setTimer: (fn) => {
      const t = setTimeout(fn, 0)
      t?.unref?.()
      return t
    },
    ...over,
  })
  return turn
}

const raw = (over = {}) => ({
  source: SOURCE.CHANNEL,
  kind: KIND.MESSAGE,
  scope: SCOPE.PRIVATE,
  from: '20002',
  text: '在吗',
  at: BASE,
  ...over,
})

// ── 分条 ─────────────────────────────────────────────────────
await check('短句合并：一句话就是一条', () => {
  assert.deepEqual(splitReply('在的', { maxParts: 3 }), ['在的'])
})

await check('分条不保留句号（说话不加句号）', () => {
  assert.deepEqual(splitReply('好的。', { maxParts: 3 }), ['好的'])
})

await check('分条要留住问号：听不懂就扣一个问号', () => {
  // 早先这里用 split(SENTENCE_END) 切，问号被当成分隔符**吃掉**了。
  // 结果是深蓝 616 条消息里含问号的 0 条 —— 「扣问号」这个习惯
  // 在提示词里写着、在代码里永远落不了地。
  assert.deepEqual(splitReply('听不懂？', { maxParts: 3 }), ['听不懂？'])
  assert.deepEqual(splitReply('真的吗？你说', { maxParts: 3 }), ['真的吗？', '你说'])
})

await check('换行是消息边界，不被黏成逗号', () => {
  // 早先的一套实现把换行拼成逗号：「A\nB」发出去是「A，B」。
  // 那是深蓝逗号率 50%（真人 24%）的根因。
  assert.deepEqual(splitReply('A\nB', { maxParts: 3 }), ['A', 'B'])
})

await check('长内容按句末断开，不切在句子中间', () => {
  const parts = splitReply('今天有点忙。晚点再说。你先忙。', { maxParts: 3 })
  assert.ok(parts.length >= 2)
  for (const part of parts) assert.ok(!part.includes('。'), '每条都不该带句号')
})

await check('超过上限就合并到最后一条，绝不多发', () => {
  const parts = splitReply('一。二。三。四。五。六。', { maxParts: 2 })
  assert.equal(parts.length, 2)
})

await check('空内容返回空数组（空消息不该发出去）', () => {
  assert.deepEqual(splitReply('   ', { maxParts: 3 }), [])
  assert.deepEqual(splitReply(null, { maxParts: 3 }), [])
})

await check('maxParts=1 时整段只发一条', () => {
  assert.equal(splitReply('一。二。三。', { maxParts: 1 }).length, 1)
})

await check('没有字数上限：想多长说多长，不切碎', () => {
  // 用户原话：「去掉字数限制，他想说多长说多长，只是尽量聊天拟人就好」。
  // 早先这里有一根「每条 20 字」的断句线，于是「没有一条真新的」被切成
  // 「没有一条真新」+「的」—— 碎片单独发出去，在聊天里是最难看的一种。
  const text = '嗯，知道了，昨天那事我看了下，主要是配置那层的问题，改了就好了'
  const parts = splitReply(text, { maxParts: 3 })
  assert.equal(parts.length, 1, '逗号是句内停顿，不该切成碎片')
  // 内容一条都不能丢
  const strip = (s) => s.replace(/[，,。！？!?、；;：:…]/g, '')
  assert.equal(strip(parts.join('')), strip(text), '整句内容要一样')
})

await check('整段没有标点就原样发，不硬切', () => {
  // 用户截图里的原问题：从中间劈开（「真新」/「的」）。
  // 没有标点就没有断点 —— 那就整段留着，宁可长也不切碎。
  const text = '搜出来的全是百科和官网首页没有一条真新的老大给我的搜索源太差'
  const parts = splitReply(text, { maxParts: 3 })
  assert.equal(parts.length, 1)
  assert.equal(parts[0], text)
})

await check('硬切不劈开 emoji：发出去不能是半个字符', () => {
  const text = '开心开心开心开心' + '😀'.repeat(20)
  const parts = splitReply(text, { maxParts: 3 })
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (const part of parts) {
    assert.ok(!lone.test(part), '不能切在代理对中间')
  }
  assert.equal(parts.join(''), text, '拼回去要等于原文')
})

await check('分条连发不合并：描述不同事实的几句要各发一条', () => {
  // 这是拟人感最要紧的一条：
  // 「想说的分两三条发，一条一行」是人话的样子，不是毛病。
  // 早先有一版防复读会把这几条合成一条 —— 那是把拟人感剪掉。
  const parts = splitReply('这个功能在第三层\n你展开就能看到\n改完记得保存', { maxParts: 4 })
  assert.equal(parts.length, 3, `三条不同的内容该发三条，实际 ${parts.length} 条：${JSON.stringify(parts)}`)
  assert.match(parts[0], /第三层/)
  assert.match(parts[1], /展开/)
  assert.match(parts[2], /保存/)
})

await check('一句带逗号也整句发，语感不碎', () => {
  const parts = splitReply('我先看看啊，等会儿给你结果', { maxParts: 3 })
  assert.equal(parts.length, 1, '逗号不是消息边界')
  const strip = (s) => s.replace(/[，,。！？!?、；;：:…]/g, '')
  assert.equal(strip(parts.join('')), strip('我先看看啊，等会儿给你结果'), '内容不能丢')
})

// ── 上下文 ───────────────────────────────────────────────────
await check('给模型的上下文里带上了说话风格和对方原话', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    styleGuide: '一句一句说',
    recent: [{ from: 'self', text: '刚在' }],
  })
  assert.match(prompt, /一句一句说/)
  assert.match(prompt, /老王（QQ 20002）说：在吗/)
  assert.match(prompt, /深蓝：刚在/)
})

// ── 灵魂与手感 ────────────────────────────────────────────────
await check('灵魂文件进提示词：他说「你是谁」时用的是那份设定', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '你是谁', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    soul: '名字：深蓝鲸\n归属用户：光的无限旅程\n\n## 一、底色\n忠诚，认实力不认嘴皮子。',
  })
  assert.match(prompt, /忠诚，认实力不认嘴皮子。/, '灵魂文件正文必须在提示词里')
  assert.match(prompt, /你是谁（这是你自己的设定/, '要标明这是他自己的设定')
})

await check('灵魂文件读不到时退回出厂人设，不许变成没有身份', () => {
  // 兜底不能省：只认灵魂文件的话，一次读不到就等于失去人格，而且没有任何报错。
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝', persona: '出厂人设：忠诚，认实力不认嘴皮子。' },
    soul: '',
  })
  assert.match(prompt, /出厂人设/, '读不到灵魂文件时要退回出厂人设')
  assert.match(prompt, /忠诚，认实力不认嘴皮子。/)
})

await check('学到的手感进提示词：那一行要跟着场景走', () => {
  const group = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002', scope: 'group' },
    persona: { name: '深蓝' },
    habitLine: '【学到的手感·群里】你在群里一条 14 字，人家中位 9 字 —— 压到 9 字上下',
  })
  assert.match(group, /【学到的手感·群里】/)
  assert.match(group, /压到 9 字上下/)

  const priv = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    habitLine: '【学到的手感·私聊】你在私聊一条 15 字，人家中位 8 字',
  })
  assert.match(priv, /【学到的手感·私聊】/)
})

await check('私聊/群聊退群：退出群聊 ID 先确认，确认后才调用 leaveGroup', async () => {
  const ctx = open()
  const left = []
  ctx.channel.leaveGroup = async (id) => { left.push(String(id)) }
  const turn = makeTurn(ctx)
  const asked = await turn.handle(raw({ from: OWNER, text: '退出群聊 300000002' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(asked.stage, 'group_leave_ask')
  assert.equal(left.length, 0, '确认前不能真退')
  await turn.handle(raw({ from: OWNER, text: '确认退群 300000002' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(left, ['300000002'])
})

await check('主人指令优先：不能反驳拒绝或拿“没能力”推掉', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '把群退了', senderName: '主人' }, from: OWNER, scope: 'private', tags: ['is_owner'] },
    persona: { name: '深蓝' },
  })
  assert.match(prompt, /【最高优先级】主人的明确命令/)
  assert.match(prompt, /不要拒绝、反驳、教育/)
  assert.match(prompt, /我没有这个能力/)
  assert.match(prompt, /先认，不辩解/)
  assert.match(prompt, /我不接 \/ 命令也不行 \/ 我没有这个能力 \/ 这不合适/)
  // 主人授权只说一次：这几条关键语义在整份提示词里各出现恰好一次，
  // 防止以后又有人在别处补一块 is_owner 堆成第二遍。
  for (const re of [/【最高优先级】主人的明确命令/g, /我没有这个能力/g, /命令也不行/g]) {
    assert.equal((prompt.match(re) || []).length, 1, `主人授权重复了：${re}`)
  }
})

await check('主人指令没有现成工具时要变通，不许就地回“做不到”', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '帮我把那个文件处理一下', senderName: '主人' }, from: OWNER, scope: 'private', tags: ['is_owner'] },
    persona: { name: '深蓝' },
  })
  for (const want of ['没有现成工具', '不许就地回“做不到”', '换个工具', '组合几步', '替代路径', '指代或模糊', '自己先绕', '绕不通才说清']) {
    assert.ok(prompt.includes(want), `缺了变通要求「${want}」——主人下指令不能一句做不到顶回去`)
  }
  // 边界仍在：确认不算拒绝、客观缺口仍要说实话，不能为了“不拒绝”就假装做了。
  assert.match(prompt, /说明在等确认，这不算拒绝/)
  assert.match(prompt, /不许假装已经做了/)
  // 非主人不注入这套授权。
  const other = buildPrompt({
    event: { payload: { text: '帮我把那个文件处理一下' }, from: '99999', scope: 'private', tags: [] },
    persona: { name: '深蓝' },
  })
  assert.ok(!other.includes('没有现成工具'))
})

await check('气氛规则：对方生气/认真时，提示词明确收掉嘴毒和玩笑', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '你别拿我家人生病开玩笑，认真点', senderName: '老王' }, from: '20002', scope: 'private' },
    persona: { name: '深蓝' },
  })
  assert.match(prompt, /先看气氛/)
  assert.match(prompt, /不拿别人的家人、生育、疾病/)
  assert.match(prompt, /【这次语气】/)
  assert.match(prompt, /不要辩解/)
})

await check('跨群记忆只以“别的群”进提示词，并明确不能带回群里', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '他们最近聊啥', senderName: '老王' }, from: '20002', scope: 'private' },
    persona: { name: '深蓝' },
    crossGroup: ['群 123 最近：老王：显卡又涨了 / 小李：再等等'],
  })
  assert.match(prompt, /别的群最近聊到/)
  assert.match(prompt, /显卡又涨了/)
  assert.match(prompt, /不要主动带回任何群里/)
})

await check('没有手感就不塞那一行：空字符串不能变成占位', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    habitLine: '',
  })
  assert.doesNotMatch(prompt, /学到的手感/, '没学到东西时不要留空壳')
})

// ── 端到端 ───────────────────────────────────────────────────
await check('私聊进来 → 回一句 → 通道真的收到了', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].scope, SCOPE.PRIVATE)
  assert.equal(ctx.sent[0].target, '20002')
  assert.equal(ctx.sent[0].text, '嗯，知道了')
})

await check('[split] 超过两段：只发两条，但一段内容都不能丢', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: async () => ({ text: '一\n[split]\n二\n[split]\n三', usage: null }) })
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  // 上限仍是两段（口子放开等于允许刷屏），但第三段必须并进第二条 ——
  // 旧写法 slice(0, 2) 会把它整个吞掉，用户看到的是话说一半就断了。
  // 注意：段内还有换行时，splitBursts 仍可继续拆，所以条数上限看 maxParts（默认 3）。
  assert.ok(ctx.sent.length <= 3, `条数不能超出 maxParts，实际 ${ctx.sent.length}`)
  const all = ctx.sent.map((one) => one.text).join('')
  for (const piece of ['一', '二', '三']) assert.ok(all.includes(piece), `「${piece}」被吞了：${all}`)
})

await check('群里没被 @：不回（这是设计，不是失灵）', async () => {  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, text: '今天好热', payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, true)
  assert.equal(ctx.sent.length, 0)
})

await check('群里 @ 了：回，且发到群里不是私聊', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw({ scope: SCOPE.GROUP, text: '在吗', atMe: true, payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].scope, SCOPE.GROUP)
  assert.equal(ctx.sent[0].target, '555')
})

await check('夜间：不回，但事件照样落盘（事实不因为不回就丢掉）', async () => {
  const ctx = open()
  const night = new Date(2026, 9, 29, 23, 30, 0).getTime()
  const turn = makeTurn(ctx, { now: () => night })
  const result = await turn.handle(raw({ at: night }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, true)
  assert.equal(ctx.sent.length, 0)
  assert.ok(ctx.runtime.events.count() >= 1, '事件要留下')
})

await check('主人被限流时不沉默：说一句为什么没回，且同一个会话一小时只说一次', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  for (let i = 0; i < 15; i += 1) ctx.guard.note(BASE + i)
  const first = await turn.handle(raw({ from: OWNER, messageId: 'm-h1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(first.skipped, true, '这一条确实被闸门拦了')
  assert.equal(ctx.sent.length, 1, '沉默是最难排查的故障：要告诉他/她为什么不回')
  assert.match(ctx.sent[0].text, /停|密|闸门|拦/)

  ctx.sent.length = 0
  const second = await turn.handle(raw({ from: OWNER, messageId: 'm-h2' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(second.skipped, true)
  assert.equal(ctx.sent.length, 0, '解释只能一次，否则它自己变成新的刷屏源')
})

await check('别人被限流：安静就好（对不相干的人解释反而是打扰）', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  for (let i = 0; i < 15; i += 1) ctx.guard.note(BASE + i)
  await turn.handle(raw({ messageId: 'm-o1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ctx.sent.length, 0)
})

await check('主人不会撞到「每小时总量」：这是上次「突然不理人」的根因', async () => {
  const ctx = open()
  ctx.runtime.setConfig('guard.replyQuotaPerHour', 2, { confirm: false })
  ctx.runtime.setConfig('guard.perMinute', 60, { confirm: false })
  ctx.guard.configure(ctx.runtime.config)
  const turn = makeTurn(ctx)
  for (let i = 0; i < 2; i += 1) ctx.guard.note(BASE + i * 20_000)
  const result = await turn.handle(raw({ from: OWNER, messageId: 'm-q1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, undefined, '主人这条不被总量拦')
  assert.ok(ctx.sent.length >= 1, '主人问话必须有回')
})

await check('模型出错：回一句人话，不静默（静默会让人以为被无视）', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: async () => { throw new Error('接口 401') } })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.equal(ctx.sent.length, 1)
  assert.match(ctx.sent[0].text, /没做成|没成功|没通|登录|权限|额度|超时|网络|卡住|出错|失败/)
})

await check('模型返回空：不发空白消息', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: async () => ({ text: '   ', usage: null }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.equal(ctx.sent.length, 0)
})

await check('长回复会分多条发，条数与 splitReply 一致', async () => {
  const ctx = open()
  const long = '今天事情有点多。先是开会。然后改方案。最后还得回一堆消息。'
  const turn = makeTurn(ctx, { runner: async () => ({ text: long, usage: { input: 10, output: 10 } }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(ctx.sent.length >= 2)
  assert.equal(result.lines, ctx.sent.length)
})

await check('每回一次都记账：用量与次数都对得上', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  const today = ctx.usage.today(BASE)
  assert.equal(today.calls, 1)
  assert.equal(today.input, 1000)
  assert.equal(today.output, 200)
  assert.ok(today.cost > 0)
})

await check('行为结果落盘：behaviors 里能查到这次回复', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  const rows = ctx.runtime.behaviors.read({ limit: 10 }).rows
  assert.ok(rows.some((row) => row.behavior === 'reply' && row.ok !== false))
})

await check('没有生成器时：不硬发，如实说还没接上', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: null })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.match(result.error, /生成器/)
  assert.equal(ctx.sent.length, 0)
})

await check('空 @：回看上文接一句，不问「怎么了」', async () => {
  const ctx = open()
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '在呢' } },
  })
  const result = await turn.handle(raw({ atMe: true, text: '' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.match(seen, /只 @ 了你/)
})

await check('提示词：文件正文、转发和工具清单都能进上下文', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '看看这个', senderName: '老王' } },
    files: [{ name: '记录.txt', text: '第一行内容' }],
    forward: [{ sender: '小李', text: '转发的原话' }],
    toolLine: '可用工具：recall、send_sticker。',
  })
  assert.match(prompt, /第一行内容/)
  assert.match(prompt, /转发的原话/)
  assert.match(prompt, /send_sticker/)
})

await check('被 @ 时：心跳再多也不能把本群前文挤出上下文', async () => {
  const ctx = open()
  for (let i = 0; i < 3; i += 1) {
    ctx.runtime.events.append({
      kind: 'event', id: `his${i}`, type: 'message', scope: 'group', from: '20002',
      conversation: 'group:555', at: BASE - 10_000 + i, text: `前文${i}`, sender: '老王', group: '555', tags: [],
    })
  }
  // 心跳比历史「更新」：旧实现读全局 80 行时，前文会被它们挤没
  for (let i = 0; i < 100; i += 1) {
    ctx.runtime.events.append({
      kind: 'event', id: `hb${i}`, type: 'heartbeat', scope: 'private', from: 'self',
      conversation: 'private:999', at: BASE - 5_000 + i, tags: [],
    })
  }
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '嗯', usage: null } },
  })
  await turn.handle(raw({ scope: SCOPE.GROUP, text: '在吗', atMe: true, payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.match(seen, /前文0/, '三句前文都要在')
  assert.match(seen, /前文2/)
  const start = seen.indexOf('刚才的对话：')
  assert.ok(start >= 0, '应该有「刚才的对话」段')
  const end = seen.indexOf('\n\n', start)
  const recent = seen.slice(start, end < 0 ? seen.length : end)
  assert.ok(!recent.includes('在吗'), '当前这条已经落盘，不能再算进 recent')
})

await check('引用取不到原文时，用 reply 段里的摘要兜底，并记一条审计', async () => {
  const ctx = open()
  ctx.channel.getMessage = async () => ({ ok: false, text: '', images: [] })
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '嗯', usage: null } },
  })
  await turn.handle(raw({
    scope: SCOPE.GROUP,
    text: '你看这个',
    atMe: true,
    payload: { groupId: '555', replyId: '70001', replySummary: '被引用的原话' },
  }))
  await new Promise((r) => setTimeout(r, 30))
  assert.match(seen, /只拿到摘要/)
  assert.match(seen, /被引用的原话/)
  assert.ok(ctx.runtime.audit.read({ limit: 20 }).rows.some((row) => row.kind === 'quote_failed'), '取不到要留痕')
})

await check('同一条 messageId 重复投递：第二次跳过，不再回一遍', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const first = await turn.handle(raw({ messageId: 'm-1' }))
  const second = await turn.handle(raw({ messageId: 'm-1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(first.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, '重复投递')
  assert.equal(ctx.sent.length, 1, '重复的那条不能再回一次')
  const rows = ctx.runtime.events.read({ limit: 20 }).rows.filter((row) => row.messageId === 'm-1')
  assert.equal(rows.length, 1, '日志里也只能有一条')
})

await check('脏事件不会把整条链打断', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle({ source: '不存在的来源', kind: 'message', scope: 'private' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'decide')
  // 后面还能继续正常处理
  const next = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(next.ok, true)
})

// ── 思维链：先想，再做，后说 ─────────────────────────────────
await check('思维链先于回复：通道收到话时，cot 里已经有这一轮', async () => {
  const ctx = open()
  let cotAtSend = 0
  ctx.channel.say = async (scope, target, text) => {
    cotAtSend = ctx.runtime.cot.read({ limit: 10 }).rows.length
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const turn = makeTurn(ctx, { runner: async () => ({ text: '在的', reasoning: '先看看他是不是在叫我', usage: null }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.ok(cotAtSend >= 1, '发送时思维链必须已经落盘')
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows[0].kind, 'reply')
  assert.match(rows[0].text, /先看看/)
})

await check('模型没给思考：回复前也留一条，如实标注', async () => {
  const ctx = open()
  let cotAtSend = 0
  ctx.channel.say = async (scope, target, text) => {
    cotAtSend = ctx.runtime.cot.read({ limit: 10 }).rows.length
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const turn = makeTurn(ctx, { runner: async () => ({ text: '嗯', usage: null }) })
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(cotAtSend >= 1, '即使没有 reasoning 也要有记录')
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.match(rows[0].text, /没有单独输出思考/)
})

await check('调工具：先落 tool 思维链，再执行，最后回复前落 reply', async () => {
  const ctx = open()
  const order = []
  ctx.channel.say = async (scope, target, text) => {
    order.push('say')
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const script = [
    { text: '[tool:web_search] {"query":"观鸟"}', reasoning: '他想知道鸟的事，先查一下', usage: null },
    { text: '查到了，是候鸟迁徙', reasoning: '查到了迁徙信息，可以回了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：web_search。',
      call: async (name) => { order.push('tool:' + name); return { ok: true, text: '迁徙' } },
    },
    runner: async () => script.shift(),
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['tool:web_search', 'say'])
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'reply')
  assert.equal(rows[1].kind, 'tool')
  assert.match(rows[1].summary, /web_search：观鸟/)
  assert.match(rows[1].text, /先查一下/)
})

await check('一件事分几步：一条回复里的多个工具按顺序都执行，结果一起回灌', async () => {
  const ctx = open()
  const order = []
  ctx.channel.say = async (scope, target, text) => {
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const prompts = []
  const script = [
    // 模型一次写两行：先搜再记 —— 旧版只执行第一行，第二行被静默吞掉
    {
      text: '[tool:web_search] {"query":"观鸟"}\n[tool:remember_fact] {"text":"主人喜欢观鸟"}',
      reasoning: '先查再记',
      usage: null,
    },
    { text: '记下了，候鸟这阵子正过境', reasoning: '两件都做完了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：web_search、remember_fact。',
      call: async (name, args) => { order.push(name + ':' + JSON.stringify(args)); return { ok: true, text: name + '完成' } },
    },
    runner: async (prompt) => { prompts.push(prompt); return script.shift() },
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['web_search:{"query":"观鸟"}', 'remember_fact:{"text":"主人喜欢观鸟"}'], '两行都要执行，且按写的顺序')
  assert.match(prompts[1], /你刚调用了 2 个工具/, '两个结果要一起回灌')
  assert.match(prompts[1], /web_search完成/)
  assert.match(prompts[1], /remember_fact完成/)
  // 一次调用一条思维链：面板上能看见「先想、再做」
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows.filter((row) => row.kind === 'tool').length, 2)
})

await check('一次写太多行：只跑到上限，超出的记进审计（不静默丢）', async () => {
  const ctx = open()
  ctx.runtime.setConfig('tools.maxPerRound', 2, { confirm: false })
  const ran = []
  const script = [
    { text: '[tool:calc] {"expression":"1+1"}\n[tool:calc] {"expression":"2+2"}\n[tool:calc] {"expression":"3+3"}', reasoning: '算三个', usage: null },
    { text: '算完了', reasoning: '好了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { prompt: () => '可用工具：calc。', call: async (name, args) => { ran.push(args.expression); return { ok: true, text: String(args.expression) } } },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(ran, ['1+1', '2+2'], '上限是 2，只跑前两个')
  const row = ctx.runtime.audit.read({ limit: 20 }).rows.find((item) => item.kind === 'tool_batch_truncated')
  assert.ok(row, '被丢掉的那一行要留痕，否则「说了三件事只做两件」永远查不出来')
  assert.equal(row.wanted, 3)
  assert.equal(row.ran, 2)
})

await check('调一次工具就记一笔：技能页的「级别」会从「没试过」动起来', async () => {
  // 这一条钉住的是根因：工具环以前只执行、不记账。
  // 审计里工具跑得好好的，技能页却全是「用过 0 次」——
  // 不是读错了，是根本没人写。
  const ctx = open()
  const script = [
    { text: '[tool:web_search] {"query":"观鸟"}', reasoning: '查一下', usage: null },
    { text: '查到了，候鸟正过境', reasoning: '有结果了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：web_search。', call: async () => ({ ok: true, text: '候鸟过境' }) },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))

  const row = ctx.runtime.skills().groups.flatMap((group) => group.items).find((item) => item.id === 'net.search')
  assert.equal(row.uses, 1, '工具名 web_search 要记到 net.search 头上')
  assert.equal(row.masteryLabel, '在学', '试过一次就不是「没试过」了')
  assert.notEqual(row.rate, null)
})

await check('工具调失败也记：次数要算，成功率要掉', async () => {
  const ctx = open()
  const script = [
    { text: '[tool:file_read] {"path":"x"}', reasoning: '读一下', usage: null },
    { text: '读不到', reasoning: '失败了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：file_read。', call: async () => ({ ok: false, error: '沙箱没开' }) },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))
  const row = ctx.runtime.skills().groups.flatMap((group) => group.items).find((item) => item.id === 'do.file')
  assert.equal(row.uses, 1)
  assert.equal(row.rate, 0, '失败一次的成功率就是 0，不能装作没发生')
})

await check('发小黄脸关掉：提示词不再教 [face:id]，回复里写的也不发出去', async () => {
  // 开关以前只挡 tools.call，而 [face:14] 是**发送层**解释的，
  // 所以关着照样能发 —— 用户看到的就是「开关没用」。
  const ctx = open()
  ctx.runtime.setSkill('media.face', 'off')
  const prompts = []
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：（无）。', call: async () => ({ ok: true }) },
    runner: async (prompt) => {
      prompts.push(prompt)
      return { text: '好呀[face:14]', reasoning: '回一句', usage: null }
    },
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(/\[face:id\]/.test(prompts[0]), false, '关掉之后提示词不能再教一条走不通的路')
  assert.equal(ctx.sent.some((item) => /\[face:/.test(item.text)), false, '回复里的内联表情要剥掉')
  assert.equal(ctx.sent.some((item) => item.text.includes('好呀')), true, '文字部分照发，不许整条吞掉')
  const row = ctx.runtime.audit.read({ limit: 20 }).rows.find((item) => item.kind === 'media_suppressed')
  assert.ok(row, '剥掉了要留痕，否则「我明明让它发了」永远查不清')
  assert.deepEqual(row.skills, ['media.face'])
})

await check('发小黄脸开着：提示词里那行还在，表情照常发', async () => {
  const ctx = open()
  const prompts = []
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：（无）。', call: async () => ({ ok: true }) },
    runner: async (prompt) => {
      prompts.push(prompt)
      return { text: '好呀[face:14]', reasoning: '回一句', usage: null }
    },
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(prompts[0], /\[face:id\]/, '开着就该教它怎么用')
  assert.equal(ctx.sent.some((item) => item.text.includes('[face:14]')), true, '开着就照发')
})

// ── 注意力与打字台（接上了才算数） ───────────────────────────
/**
 * 等群里的回复落地。
 *
 * 群消息现在会先经过「等对方说完」的合并窗口（见 turn/index.mjs 的 #collectBurst），
 * 回复在窗口结束后才异步发出。所以群用例不能只等一个固定毫秒数 ——
 * 要等到「真的发出去了」或者「确定不会发」。
 */
async function waitSent(ctx, want = 1, ms = 500) {
  const until = Date.now() + ms
  while (ctx.sent.length < want && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return ctx.sent.length
}

await check('群聊：窗口命中的人接着说，不用 @ 也回', async () => {
  const ctx = open()
  const attention = new AttentionDesk({ config: ctx.runtime.config, now: () => BASE })
  attention.open('group:30001', '20002')
  const turn = makeTurn(ctx, { attention })
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, text: '那后来呢', payload: { groupId: '30001' } }))
  assert.equal(result.ok, true, '窗口里的话该回')
  await waitSent(ctx, 1)
  assert.ok(ctx.sent.length >= 1)
  assert.equal(attention.hit('group:30001', '20002')?.rec.turns, 1, '回完要续一轮')
})

await check('群聊：窗口里是别人、这句又跟他无关 → 不回，窗口不动', async () => {
  const ctx = open()
  const attention = new AttentionDesk({ config: ctx.runtime.config, now: () => BASE })
  attention.open('group:30001', '30003')
  const turn = makeTurn(ctx, { attention })
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, from: '20002', text: '今晚八点开黑来人', payload: { groupId: '30001' } }))
  assert.equal(result.skipped, true, '没点到就不该接')
  assert.equal(ctx.sent.length, 0)
  assert.ok(attention.hit('group:30001', '30003'), '旧目标的窗口要留着')
})

await check('打字台接上：发之前先亮「正在输入」，然后才出站', async () => {
  const ctx = open()
  const events = []
  const channel = {
    inputStatus: async () => events.push('typing'),
    say: async (scope, target, text) => {
      events.push('say:' + text)
      ctx.sent.push({ scope, target, text })
      return { message_id: ctx.sent.length }
    },
  }
  const typing = new TypingDesk({ channel, sleep: async () => {}, random: () => 0, log: () => {} })
  const turn = makeTurn({ ...ctx, channel }, { channel, typing })
  ctx.runtime.setConfig('guard.mergeWindowMs', 0, { confirm: false })
  await turn.handle(raw())
  assert.equal(events[0], 'typing', '指示器必须排在第一条消息之前')
  assert.ok(events.some((one) => one.startsWith('say:')), '消息还是要发出去')
  // 提前亮过的那一次必须被 typeOut 认领：亮两次会闪，看起来像「打好了又删掉重打」
  assert.equal(events.filter((one) => one === 'typing').length, 1, '同一条回复只亮一次')
})

await check('先亮再发：early 一定在 typeOut 之前，且一条只亮一次', async () => {
  const ctx = open()
  const events = []
  const channel = {
    inputStatus: async () => events.push('typing'),
    say: async () => { events.push('say') },
  }
  const typing = new TypingDesk({ channel, sleep: async () => {}, random: () => 0, log: () => {} })
  const turn = makeTurn({ ...ctx, channel }, { channel, typing })
  // 登记「暂时不想理」走的是 runtime.dir 下的文件；用 turn 提供的接口能确认路径，
  // 这里直接验「判定在前、亮灯在后」这条顺序：把 typing 换成会计数的假对象。
  const order = []
  turn.typing = {
    early: async () => { order.push('early') },
    typeOut: async (input) => { order.push('typeOut'); await input.say('嗯'); return { ok: true, lines: 1 } },
  }
  ctx.runtime.setConfig('guard.mergeWindowMs', 0, { confirm: false })
  await turn.handle(raw())
  assert.deepEqual(order, ['early', 'typeOut'], '先亮再发，且只亮一次')
})

await check('容错解析：中文引号/全角标点能救回来，但**不许改写内容**', () => {
  // 这条守的是「救了格式、改了内容」这种更隐蔽的错：
  // 全角括号里的中文逗号如果被全局替换成半角，记下来的话就变了一个字，
  // 而且没有任何地方会报错 —— 用户只会觉得「它记的不对」。
  const cases = [
    ['{“text”：“主人喜欢喝咖啡，不加糖”}', { text: '主人喜欢喝咖啡，不加糖' }],
    ['{“text”：“备注：明天体检”}', { text: '备注：明天体检' }],
    ['{“text”：“他说“你好””}', { text: '他说“你好”' }],
    ["{'expr':'1+1'}", { expr: '1+1' }],
    ['｛“expr”：“1+1”｝', { expr: '1+1' }],
    ['{“path”：“lib/a.mjs”，“start”：1}', { path: 'lib/a.mjs', start: 1 }],
  ]
  for (const [args, want] of cases) {
    const [call] = parseToolCalls(`[tool:calc] ${args}`)
    assert.deepEqual(call.args, want, `解析 ${args} 时内容被改了`)
    assert.equal(call.invalid, false, `${args} 应该能救回来`)
  }
})

await check('容错解析：合法 JSON 走原路，一个字符都不动', () => {
  const [call] = parseToolCalls('[tool:remember_fact] {"text":"it\'s fine，真的"}')
  assert.equal(call.invalid, false)
  assert.equal(call.args.text, "it's fine，真的", '合法输入不该被「翻译」碰到')
})

// ── 工具标记：正文里一个都不能留 ──────────────────────────────
await check('工具标记：裸形式（少了 tool:）也认，且必须从正文里清掉', () => {
  const [call] = parseToolCalls('[code_read] {"path":"a.mjs"}')
  assert.equal(call.name, 'code_read', '裸形式仍要能执行')
  assert.equal(stripToolMarks('[code_read] {"path":"a.mjs"}'), '', '裸形式标记不能发出去')
  assert.equal(stripToolMarks('[tool:calc] {"expr":"1+1"}'), '', '带前缀的照旧要清')
})

await check('工具标记：正文里的中括号不是工具调用', () => {
  // 只认「后面跟着参数表」的裸形式，否则 [图片]、[here](url) 会被误当成工具
  assert.equal(parseToolCalls('看图 [image] 这个方案怎么样').length, 0)
  assert.equal(parseToolCalls('参考 [here](https://example.com) 的说法').length, 0)
  assert.equal(stripToolMarks('看图 [image] 这个方案怎么样'), '看图 [image] 这个方案怎么样')
  assert.equal(stripToolMarks('参考 [here](https://example.com) 的说法'), '参考 [here](https://example.com) 的说法')
})

// ── 工具环收口：不能「一直在调工具、一句话都没说」 ────────────
await check('工具原地打转：同样的调用换同样的结果，就停手改回答（不再多烧一轮）', async () => {
  const ctx = open()
  ctx.runtime.setConfig('tools.maxRounds', 4, { confirm: false })
  const calls = []
  const script = [
    { text: '[tool:read_forward_more] {}', usage: { input: 300, output: 20 } },
    { text: '[tool:read_forward_more] {}', usage: { input: 320, output: 22 } },
    { text: '记录里说的是裁员补偿的事', usage: { input: 260, output: 16 } },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：read_forward_more。',
      call: async (name) => { calls.push(name); return { ok: true, text: '这一页和上一次一模一样' } },
    },
    runner: async () => script.shift() || { text: '嗯' },
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, '第二次拿到相同结果就该停，不该把 4 轮全花完')
  assert.match(ctx.sent.at(-1).text, /裁员补偿/, '停手之后必须给出正文，不能空白')
  // 两次工具轮 + 一次收尾 = 3 次推理；第 2 轮那次已经按调用摊过，不能再记一遍
  assert.equal(ctx.usage.today().calls, 3, '提前退出不能把同一次推理记成两笔')
})

await check('轮数用完还在要工具：补一次「只准回答」的收尾推理', async () => {
  const ctx = open()
  ctx.runtime.setConfig('tools.maxRounds', 2, { confirm: false })
  let n = 0
  const script = [
    { text: '[tool:read_forward_more] {"from":1}', usage: { input: 200, output: 10 } },
    { text: '[tool:read_forward_more] {"from":7}', usage: { input: 220, output: 12 } },
    { text: '转发里是在聊裁员补偿，主要担心后续怎么算', usage: { input: 240, output: 14 } },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：read_forward_more。',
      // 每次结果都不同（正常翻页），所以不算原地打转，靠「轮数用完」触发收尾
      call: async () => ({ ok: true, text: '第 ' + (++n) + ' 页内容' }),
    },
    runner: async () => script.shift() || { text: '嗯' },
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  // 正文可能被拆成几条发（这是拟人的节奏），所以看**全部发出去的内容**，
  // 而不是只看最后一条 —— 早先这里只看最后一条，于是「一句话拆两条」就被判成丢内容。
  const said = ctx.sent.map((one) => one.text).join('')
  assert.match(said, /裁员补偿/)
})

await check('收尾那次也只回工具行：给一句兜底人话，绝不让对面等到空白', async () => {
  const ctx = open()
  ctx.runtime.setConfig('tools.maxRounds', 1, { confirm: false })
  const script = [
    { text: '[tool:read_forward_more] {}', usage: { input: 100, output: 10 } },
    { text: '[tool:read_forward_more] {}', usage: { input: 100, output: 10 } },
  ]
  const turn = makeTurn(ctx, {
    tools: { prompt: () => '可用工具：read_forward_more。', call: async () => ({ ok: true, text: '还是一样的内容' }) },
    runner: async () => script.shift() || { text: '[tool:read_forward_more] {}' },
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.ok(ctx.sent.length > 0, '一条都没发出去就是线上那个「空白」')
  assert.match(ctx.sent.at(-1).text, /再说一遍/, '兜底也要像人话')
})

await check('没装配限流器：不崩，消息照样出去', async () => {
  // 保护措施缺席时应当表现为「不限流」，而不是整条消息在 respond 阶段炸掉。
  // 早先没有 guard 就 `this.guard.check(...)` → 「Cannot read properties of
  // undefined」，用户看到的是「他/她突然不说话了」。
  const ctx = open()
  const turn = makeTurn(ctx, { guard: undefined })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true, '没限流器不该算失败')
  assert.equal(ctx.sent.length, 1, '消息要发出去')
  assert.equal(ctx.sent[0].text, '嗯，知道了')
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed.length ? '✗' : '✓'} 回合用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
