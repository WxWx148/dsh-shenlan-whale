/**
 * tests/skill.test.mjs — 技能簿：清单、鉴权、学会的证据。
 *
 * 这组测试盯的是「说会其实不会」这一类谎话：
 *   · 清单说会、依赖没开 —— 必须显示用不了并说清缺什么；
 *   · 说学会了、只是运气好 —— 必须靠次数与成功率卡住；
 *   · 教了就生效 —— 必须默认关着。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CATALOG,
  LIMITS,
  MASTERY,
  SKILL_GROUPS,
  SOURCE,
  STATE,
  SkillBook,
  bindWeights,
  brief,
  lineOf,
  masteryOf,
  allToolNames,
  looksBroken,
  promptLineOf,
  registerTools,
  resolveNeeds,
  stateOf,
  toolsAllowed,
} from '../ability/index.mjs'
import { DEFAULTS } from '../truth/index.mjs'

/**
 * 这一组用例测的是「执行器都接上之后」的判定逻辑，所以先把工具全部注册进来。
 * 没接上的世界不在这里测 —— 那是一个更重要的场景，单独有一节专门测它，
 * 而且用的是显式传空的 impl，不靠「忘了注册」这种偶然状态。
 */
registerTools(allToolNames())

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error.message}`)
  }
}

const AT = 1_700_000_000_000
const openBook = (data) => new SkillBook({ data, now: () => AT })

/** 一份「什么都开着」的配置，用来测「依赖够了就该能用」 */
function openConfig(over = {}) {
  return {
    ...DEFAULTS,
    channel: { ...DEFAULTS.channel, enabled: true },
    memory: { ...DEFAULTS.memory, enabled: true },
    net: { ...DEFAULTS.net, allowlist: ['api.qq.com'], quotaPerHour: 60 },
    sandbox: { ...DEFAULTS.sandbox, mode: 'free', dailyMax: 40 },
    ...over,
  }
}

console.log('技能簿用例')

// ── 1. 清单本身 ────────────────────────────────────────────────
await check('出厂清单每条都写得全，没有两条抢同一个 id', () => {
  const ids = new Set()
  for (const skill of CATALOG) {
    for (const field of ['id', 'name', 'what', 'group']) {
      assert.ok(String(skill[field] || '').trim(), `${skill.id || '(无 id)'} 缺 ${field}`)
    }
    assert.ok(!ids.has(skill.id), `id 重复：${skill.id}`)
    ids.add(skill.id)
    assert.ok(skill.source === undefined || skill.source === SOURCE.BUILTIN, '出厂技能不该自带 source')
  }
})

await check('每个技能都落在已登记的分组里，分组不会空着', () => {
  const groups = new Set(SKILL_GROUPS.map((g) => g.id))
  for (const skill of CATALOG) {
    assert.ok(groups.has(skill.group), `${skill.id} 的分组 ${skill.group} 没登记`)
  }
  for (const group of SKILL_GROUPS) {
    assert.ok(CATALOG.some((skill) => skill.group === group.id), `分组 ${group.id} 一个技能都没有，面板会出现空块`)
  }
})

await check('每个技能都有 tools 键 —— 否则进化权重对不上人', () => {
  for (const skill of CATALOG) {
    assert.ok(Array.isArray(skill.tools) && skill.tools.length > 0, `${skill.id} 没有 tools`)
    for (const tool of skill.tools) assert.ok(String(tool).trim(), `${skill.id} 的 tools 里有空名`)
  }
})

await check('needs 只用认得的权限名，写错等于永远拦不住', () => {
  const known = new Set(Object.keys(resolveNeeds({})))
  for (const skill of CATALOG) {
    for (const need of skill.needs || []) {
      assert.ok(known.has(need), `${skill.id} 依赖了不存在的权限 ${need}`)
    }
  }
})

// ── 2. 两个「留空」的方向正好相反 ──────────────────────────────
await check('联网白名单空着 = 全都不许；工具白名单空着 = 全部允许', () => {
  const empty = resolveNeeds({ channel: { enabled: true }, memory: { enabled: true }, net: { allowlist: [] }, sandbox: { mode: 'free', dailyMax: 40 } })
  assert.equal(empty.net, false, '白名单空着必须判成不能上网')
  assert.equal(empty.channel, true)
  const filled = resolveNeeds({ net: { allowlist: ['a.com'], quotaPerHour: 10 } })
  assert.equal(filled.net, true, '写了域名就该能上网')
})

await check('联网次数上限是 0 时也算不能上网（避免「允许但配额为零」的假开）', () => {
  assert.equal(resolveNeeds({ net: { allowlist: ['a.com'], quotaPerHour: 0 } }).net, false)
})

await check('沙箱档位 off 或每日 0 次，都判成不能用沙箱', () => {
  assert.equal(resolveNeeds({ sandbox: { mode: 'off', dailyMax: 40 } }).sandbox, false)
  assert.equal(resolveNeeds({ sandbox: { mode: 'free', dailyMax: 0 } }).sandbox, false)
  assert.equal(resolveNeeds({ sandbox: { mode: 'ask', dailyMax: 1 } }).sandbox, true)
})

// ── 3. 状态：会 ≠ 现在能用 ─────────────────────────────────────
await check('权限没开时，技能显示「用不了」并说清缺什么', () => {
  const skill = CATALOG.find((row) => row.id === 'net.search')
  const state = stateOf(skill, { config: DEFAULTS })
  assert.equal(state.state, STATE.BLOCKED)
  assert.match(state.why, /白名单/)
})

await check('权限都开着时出厂技能直接可用', () => {
  const skill = CATALOG.find((row) => row.id === 'net.search')
  assert.equal(stateOf(skill, { config: openConfig() }).state, STATE.ON)
})

await check('用户关掉的，就算权限够也是关着', () => {
  const skill = CATALOG.find((row) => row.id === 'talk.reply')
  const state = stateOf(skill, { config: openConfig(), states: { 'talk.reply': STATE.OFF } })
  assert.equal(state.state, STATE.OFF)
  assert.match(state.why, /关/)
})

await check('乱码名一律拦在门外：不存、不显示成正常技能', () => {
  // 线上真实事故：taught.1 的 name 存成了 "????"、what 存成了 "??"。
  // 损坏发生在到达服务端之前（终端码页转了一道），代码还原不了，只能别再收进来。
  assert.equal(looksBroken('????'), true)
  assert.equal(looksBroken('??'), true)
  assert.equal(looksBroken('？？'), true)
  assert.equal(looksBroken('帮助'), false)
  assert.equal(looksBroken('？'), false, '单个问号可能真是问句，不冤杀')

  const book = new SkillBook({ now: () => 1000 })
  const refused = book.teach({ name: '????', what: '??', group: 'do' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /问号/)
  assert.equal(book.list().filter((row) => row.source === SOURCE.TAUGHT).length, 0, '坏名字不许进技能簿')

  // 已经坏在盘上的老数据：显示成「用不了」，而不是一条看起来正常的技能
  const legacy = new SkillBook({ now: () => 1000, data: { seq: 1, taught: [{ id: 'taught.1', name: '????', what: '??', group: 'do', tools: ['taught.1'], risk: 'low' }] } })
  const broken = legacy.list().find((row) => row.id === 'taught.1')
  const state = stateOf(broken, { states: { 'taught.1': STATE.ON } })
  assert.equal(state.state, STATE.BLOCKED)
  assert.match(state.why, /乱码/)
})

await check('教进来的技能默认是关的 —— 一句话不该直接开出能力', () => {
  const book = openBook()
  const taught = book.teach({ name: '把长图切成九宫格', what: '收到长图自动切' })
  assert.ok(taught.ok)
  const view = book.view({ config: openConfig() })
  const item = view.groups.flatMap((g) => g.items).find((row) => row.id === taught.id)
  assert.equal(item.state, STATE.OFF, '教完必须还是关的')
  assert.match(item.what, /切/)
})

// ── 4. 学会的证据 ──────────────────────────────────────────────
await check('一次都没试过 = 没试过，不是「会」', () => {
  assert.equal(masteryOf(null).level, MASTERY.NEW)
  assert.equal(masteryOf({ uses: 0, ok: 0 }).level, MASTERY.NEW)
})

await check('试了两次都成，也还不能叫学会（运气与本事要分开）', () => {
  assert.equal(masteryOf({ uses: 2, ok: 2 }).level, MASTERY.TRYING)
})

await check('三次成两次 = 学会；三次只成一次 = 还在学', () => {
  assert.equal(masteryOf({ uses: 3, ok: 2 }).level, MASTERY.LEARNED)
  assert.equal(masteryOf({ uses: 3, ok: 1 }).level, MASTERY.TRYING)
})

await check('十次成八次才算很熟；十次成七次只是会', () => {
  assert.equal(masteryOf({ uses: 10, ok: 8 }).level, MASTERY.SOLID)
  assert.equal(masteryOf({ uses: 10, ok: 7 }).level, MASTERY.LEARNED)
})

await check('record 会累计次数，并给出人话结论', () => {
  const book = openBook()
  book.record('net.search', true)
  book.record('net.search', true)
  const third = book.record('net.search', true)
  assert.equal(third.mastery.level, MASTERY.LEARNED)
  assert.match(third.mastery.why, /3 次里成 3 次/)
  assert.equal(book.stats['net.search'].uses, 3)
})

await check('连续失败到阈值就自动关掉，不硬撑', () => {
  const book = openBook({ states: { 'net.search': STATE.ON } })
  book.record('net.search', false)
  book.record('net.search', false)
  const last = book.record('net.search', false)
  assert.equal(last.autoOff, true, '连续 3 次失败应自动关闭')
  assert.equal(book.states['net.search'], STATE.OFF)
  assert.match(last.why, /连续失败 3 次/)
})

await check('手动重新打开技能会清零旧失败串，不会下一次失败又自动关', () => {
  const book = openBook({ states: { 'net.search': STATE.OFF } })
  book.record('net.search', false)
  book.record('net.search', false)
  assert.equal(book.setState('net.search', STATE.ON).ok, true)
  assert.equal(book.failStreak['net.search'], 0, '手动打开要重新计数')
  assert.equal(book.record('net.search', false).autoOff, false, '不能拿旧失败串立刻关')
})

await check('重启不继承旧失败串：上次失败再多，重启后第一次失败也不自动关', () => {
  const book = openBook({ failStreak: { 'net.search': 99 } })
  assert.equal(book.record('net.search', false).autoOff, false)
  assert.equal(book.failStreak['net.search'], 1)
})

await check('中间成了一次，失败计数要清零（不是累计总数）', () => {
  const book = openBook({ states: { 'net.search': STATE.ON } })
  book.record('net.search', false)
  book.record('net.search', false)
  book.record('net.search', true)
  book.record('net.search', false)
  book.record('net.search', false)
  assert.equal(book.states['net.search'], STATE.ON, '不该被前两次的旧账拖下水')
})

// ── 5. 教与忘 ─────────────────────────────────────────────────
await check('同名教两次不会长出两条', () => {
  const book = openBook()
  const first = book.teach({ name: '读天气' })
  const second = book.teach({ name: '读天气' })
  assert.equal(second.duplicate, true)
  assert.equal(first.id, second.id)
  assert.equal(book.taught.length, 1)
})

await check('名字空着 / 太长都拒掉，并说清为什么', () => {
  const book = openBook()
  assert.equal(book.teach({ name: '  ' }).ok, false)
  const long = book.teach({ name: '一'.repeat(LIMITS.nameChars + 1) })
  assert.equal(long.ok, false)
  assert.match(long.error, /太长/)
})

await check('到上限就拒，不再长', () => {
  const book = openBook()
  for (let i = 0; i < LIMITS.taught; i += 1) assert.ok(book.teach({ name: `技能${i}` }).ok)
  const over = book.teach({ name: '再教一个' })
  assert.equal(over.ok, false)
  assert.match(over.error, /上限/)
})

await check('出厂技能忘不掉，只能关 —— 说忘了就是骗人', () => {
  const book = openBook()
  const result = book.forget('talk.reply')
  assert.equal(result.ok, false)
  assert.match(result.error, /忘不掉/)
})

await check('忘掉教过的会把开关和统计一起清干净，不留幽灵', () => {
  const book = openBook()
  const taught = book.teach({ name: '临时技能' })
  book.setState(taught.id, STATE.ON)
  book.record(taught.id, true)
  assert.ok(book.forget(taught.id).ok)
  assert.equal(book.states[taught.id], undefined)
  assert.equal(book.stats[taught.id], undefined)
  assert.equal(book.find(taught.id), null)
})

await check('打开高危技能要二次确认，普通技能不用', () => {
  const book = openBook()
  assert.equal(book.setState('do.code', STATE.ON).needConfirm, true)
  assert.equal(book.setState('do.code', STATE.ON, { confirm: true }).ok, true)
  assert.equal(book.setState('talk.reply', STATE.ON).ok, true)
})

await check('关技能不需要确认（关永远比开安全）', () => {
  const book = openBook()
  assert.equal(book.setState('do.code', STATE.OFF).ok, true)
})

// ── 6. 坏数据自愈 ─────────────────────────────────────────────
await check('手工改坏的开关值被丢掉，不是让整份技能表作废', () => {
  const book = openBook({ states: { 'talk.reply': 'maybe', 'net.search': STATE.OFF } })
  assert.equal(book.states['talk.reply'], undefined)
  assert.equal(book.states['net.search'], STATE.OFF)
})

await check('读回来的 taught 缺 id 的丢掉，不让脏行进清单', () => {
  const book = openBook({ taught: [{ id: 'taught.9', name: '好的' }, { name: '没 id 的' }] })
  assert.equal(book.taught.length, 1)
})

await check('重复 id 的只留第一条（否则第二条永远改不动）', () => {
  const book = openBook({
    taught: [
      { id: 'taught.1', name: '先来的' },
      { id: 'taught.1', name: '后来的' },
    ],
  })
  assert.equal(book.taught.length, 1)
  assert.equal(book.find('taught.1').name, '先来的', 'find 只能拿到一条，就让它是第一条')
})

await check('脏统计不会算出负数成功率', () => {
  const m = masteryOf({ uses: -5, ok: 99 })
  assert.equal(m.level, MASTERY.NEW, '负数次数当成没试过')
  const m2 = masteryOf({ uses: 4, ok: 99 })
  assert.ok(m2.rate >= 0 && m2.rate <= 1, `成功率应在 0~1，实际 ${m2.rate}`)
})

await check('技能名里的换行被压成空格（不然面板一整行会被挤歪）', () => {
  const book = openBook()
  const r = book.teach({ name: '第一行\n第二行', what: '说明\n也换行' })
  assert.ok(r.ok)
  assert.equal(r.skill.name, '第一行 第二行')
  assert.ok(!r.skill.what.includes('\n'))
})

// ── 7. 面板要的视图 ───────────────────────────────────────────
await check('视图把用不了的单独列出来，并带原因', () => {
  const book = openBook()
  const view = book.view({ config: DEFAULTS })
  assert.ok(view.blocked.length > 0)
  for (const item of view.blocked) assert.ok(item.why, `${item.id} 用不了却没写原因`)
})

await check('视图的分组只含有内容的，不出现空块', () => {
  const view = openBook().view({ config: openConfig() })
  for (const group of view.groups) assert.ok(group.items.length > 0)
})

await check('计数与清单一致：开 + 关 + 用不了 = 总数', () => {
  const view = openBook().view({ config: openConfig() })
  const { total, on, off, blocked } = view.counts
  assert.equal(on + off + blocked, total)
  assert.equal(total, CATALOG.length)
})

await check('一周内首胜的才算「最近学会」，旧的沉下去', () => {
  const book = new SkillBook({
    data: { stats: { 'net.search': { uses: 5, ok: 5, fail: 0, firstAt: AT - 1000, firstOkAt: AT - 1000 } } },
    now: () => AT + 10 * 24 * 3600 * 1000,
  })
  assert.equal(book.view({ config: openConfig(), at: AT + 10 * 24 * 3600 * 1000 }).learned.length, 0)
  assert.equal(book.learnedSince(AT - 5000).length, 1)
})

// ── 8. 权重归位 ──────────────────────────────────────────────
await check('权重按技能归位，面板上显示的是「上网搜一下」而不是 http_get', () => {
  const { rows, orphans } = bindWeights({ web_search: 1.4, exec_sandbox: 0.5 }, new SkillBook().list())
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, '上网搜一下')
  assert.equal(rows[0].trend, '更常用')
  assert.equal(rows[1].trend, '不太用')
  assert.equal(orphans.length, 0)
})

await check('对不上技能的权重单独列出来，不静默丢掉', () => {
  const { rows, orphans } = bindWeights({ mystery_tool: 1.2 }, new SkillBook().list())
  assert.equal(rows.length, 0)
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].tool, 'mystery_tool')
})

// ── 9. 落盘往返 ──────────────────────────────────────────────
await check('存下去再读回来，教过的、开关、次数一个不少', () => {
  const book = openBook()
  const taught = book.teach({ name: '记住车牌' })
  book.setState(taught.id, STATE.ON)
  book.record('talk.reply', true)
  book.record('talk.reply', false)
  const back = new SkillBook({ data: JSON.parse(JSON.stringify(book.toJSON())), now: () => AT })
  assert.equal(back.taught[0].name, '记住车牌')
  assert.equal(back.states[taught.id], STATE.ON)
  assert.equal(back.stats['talk.reply'].uses, 2)
  assert.equal(back.stats['talk.reply'].ok, 1)
})

// ── 12. 面板上的阈值真的生效（这组是上一版的 bug 复发点）────────
await check('autoOffAfterFails=1：失败一次就自动关', () => {
  const book = new SkillBook({ options: { autoOffAfterFails: 1 }, now: () => AT })
  const r = book.record('talk.reply', false)
  assert.equal(r.autoOff, true, '面板写 1，就该 1 次就关')
})

await check('autoOffAfterFails=0：永远不自动关（0 是合法值，不能被默认值吃掉）', () => {
  const book = new SkillBook({ options: { autoOffAfterFails: 0 }, now: () => AT })
  for (let i = 0; i < 6; i += 1) assert.equal(book.record('talk.reply', false).autoOff, false)
  assert.equal(book.states['talk.reply'], undefined)
})

await check('autoOffAfterFails 填 10：要失败 10 次才关', () => {
  const book = new SkillBook({ options: { autoOffAfterFails: 10 }, now: () => AT })
  for (let i = 0; i < 9; i += 1) assert.equal(book.record('talk.reply', false).autoOff, false)
  assert.equal(book.record('talk.reply', false).autoOff, true)
})

await check('maxTaught=200 时能教过默认的 60 个，不被硬编码卡住', () => {
  const book = new SkillBook({ options: { maxTaught: 200 }, now: () => AT })
  for (let i = 0; i < 70; i += 1) assert.ok(book.teach({ name: `技能${i}` }).ok, `第 ${i + 1} 个被拒了`)
  assert.equal(book.taught.length, 70)
})

await check('maxTaught 收小时也真的收小', () => {
  const book = new SkillBook({ options: { maxTaught: 2 }, now: () => AT })
  book.teach({ name: '甲' })
  book.teach({ name: '乙' })
  assert.equal(book.teach({ name: '丙' }).ok, false)
})

// ── 13. 两个闸门：权限类别 + 工具白名单，缺一不可 ──────────────
await check('工具白名单收紧后，技能显示用不了并指向具体工具名', () => {
  const skill = CATALOG.find((row) => row.id === 'net.search')
  const config = { ...openConfig(), tools: { whitelist: ['calc'] } }
  const state = stateOf(skill, { config })
  assert.equal(state.state, STATE.BLOCKED)
  assert.match(state.why, /web_search/, `要说清缺哪个工具，实际：${state.why}`)
})

await check('工具白名单留空 = 全部允许，不误伤', () => {
  const skill = CATALOG.find((row) => row.id === 'net.search')
  assert.equal(stateOf(skill, { config: openConfig() }).state, STATE.ON)
  assert.equal(toolsAllowed(skill, { tools: { whitelist: [] } }).ok, true)
})

await check('工具白名单里写上了，就能用', () => {
  const skill = CATALOG.find((row) => row.id === 'net.search')
  const config = { ...openConfig(), tools: { whitelist: ['web_search'] } }
  assert.equal(stateOf(skill, { config }).state, STATE.ON)
})

await check('自主活动关掉后，「主动开口」用不了（不能只在通道上把关）', () => {
  const skill = CATALOG.find((row) => row.id === 'care.proactive')
  const config = { ...openConfig(), activity: { ...DEFAULTS.activity, enabled: false } }
  const state = stateOf(skill, { config })
  assert.equal(state.state, STATE.BLOCKED)
  assert.match(state.why, /自主活动/)
})

// ── 14. id 唯一：忘掉中间一个不能导致撞车 ────────────────────
await check('忘掉中间一个再新建，id 不与还活着的撞车', () => {
  const book = openBook()
  const a = book.teach({ name: '甲' })
  const b = book.teach({ name: '乙' })
  const c = book.teach({ name: '丙' })
  book.forget(b.id)
  const d = book.teach({ name: '丁' })
  const ids = book.taught.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, `id 撞了：${ids.join(',')}`)
  assert.notEqual(d.id, c.id)
  assert.equal(book.find(c.id).name, '丙', '丙不能被丁顶掉')
  assert.equal(book.find(d.id).name, '丁')
  assert.ok(a.id)
})

await check('序号落盘：重启后继续往后编，不回头重号', () => {
  const first = openBook()
  first.teach({ name: '甲' })
  first.teach({ name: '乙' })
  first.forget('taught.1')
  const second = new SkillBook({ data: JSON.parse(JSON.stringify(first.toJSON())), now: () => AT })
  const next = second.teach({ name: '丙' })
  assert.equal(next.id, 'taught.3', `重启后应从 3 开始，实际 ${next.id}`)
})

// ── 15. 一句话总结不重算视图 ────────────────────────────────
await check('lineOf 直接用已算好的视图，取到的数字与视图一致', () => {
  const view = openBook().view({ config: openConfig() })
  const line = lineOf(view)
  assert.match(line, new RegExp(`会 ${view.counts.on} 项`))
})

// ── 11. 实现检查：一件事是「会」还是「还没接上」 ────────────────
// 这一节测的是「底线」：宁可让面板说什么都不会，也不要让它说会然后做不到。

const NOTHING = new Set()

await check('一项都没接时，出厂技能全部显示用不了，原因写「还没接上」', () => {
  const view = new SkillBook({ now: () => 1 }).view({ config: openConfig(), impl: NOTHING })
  assert.equal(view.counts.on, 0, '一个都不能算能用')
  assert.equal(view.counts.notWired, view.counts.total, '全部归到「还没接上」这一类')
  const one = view.groups.flatMap((g) => g.items)[0]
  assert.equal(one.state, STATE.BLOCKED)
  assert.match(one.why, /还没接上/)
  assert.equal(one.wired, false)
})

await check('「还没接上」排在权限前面：别让人先去开一堆开关再发现没用', () => {
  // 配置里通道、白名单、沙箱全都没开。若先报权限，用户会去开开关；
  // 开完仍然不能用，因为他改不了的那一层才是原因。
  const skill = CATALOG.find((row) => row.id === 'net.search')
  const state = stateOf(skill, { config: DEFAULTS, impl: NOTHING })
  assert.equal(state.state, STATE.BLOCKED)
  assert.match(state.why, /还没接上/, '应先说没接上，而不是白名单为空')
})

await check('接上之后，同一份清单立刻变成能用（判定是现场算的，不是写死的）', () => {
  const skill = CATALOG.find((row) => row.id === 'talk.reply')
  assert.equal(stateOf(skill, { config: openConfig(), impl: NOTHING }).state, STATE.BLOCKED)
  const wired = stateOf(skill, { config: openConfig(), impl: new Set(allToolNames()) })
  assert.equal(wired.state, STATE.ON)
  assert.equal(wired.wired, true)
})

await check('用户自己关掉的仍是「关掉了」，不被「还没接上」盖住', () => {
  // 他/她明确关过的东西，不该因为底层没接上就改口成别的理由 ——
  // 那会让人以为自己没关成功。
  const state = stateOf(CATALOG[0], { config: openConfig(), states: { [CATALOG[0].id]: STATE.OFF }, impl: NOTHING })
  assert.equal(state.state, STATE.OFF)
  assert.match(state.why, /你关掉了/)
})

await check('清单里每个工具名都能被列出来（否则实现永远对不上）', () => {
  const names = allToolNames()
  assert.ok(names.length > 0)
  for (const skill of CATALOG) {
    for (const tool of skill.tools || []) {
      assert.ok(names.includes(tool), `${skill.id} 的 ${tool} 没进汇总`)
    }
  }
})

await check('教出来的技能不被实现检查误伤（虚拟工具名不算依赖）', () => {
  const book = new SkillBook({ now: () => 1 })
  const taught = book.teach({ name: '记住车牌号' })
  assert.ok(taught.ok)
  const view = book.view({ config: openConfig(), impl: NOTHING })
  const row = view.groups.flatMap((g) => g.items).find((item) => item.id === taught.id)
  assert.equal(row.wired, true, '自己 id 当工具名只是权重键，不该算「没接上」')
  assert.equal(row.state, STATE.OFF, '教完仍然是关着的')
})

await check('一项都用不了时，「你会什么」直接说清，不用报表口吻', () => {
  const view = new SkillBook({ now: () => 1 }).view({ config: openConfig(), impl: NOTHING })
  const lines = brief(view)
  assert.ok(lines.length <= 2, '这种时候不该刷出五行')
  assert.ok(!lines.join('').includes('会 0 项'), '不要说「会 0 项」')
  assert.match(lines[0], /都还用不了/)
  assert.match(lines[0], /底层还没接上/)
})

await check('用不了的原因分开说：都没接上和对半开，措辞不同', () => {
  const allWired = new SkillBook({ now: () => 1 }).view({ config: openConfig(), impl: new Set(allToolNames()) })
  assert.match(lineOf(allWired), /会 \d+ 项/)

  const none = new SkillBook({ now: () => 1 }).view({ config: openConfig(), impl: NOTHING })
  assert.match(lineOf(none), /还没接上/, '一项都没接时要直说')
  assert.ok(!lineOf(none).includes('权限'), '别把等更新说成缺权限')
})

// ── 10. 一句话总结 ───────────────────────────────────────────
await check('总结能说清「会几项、练熟几项、几项用不了」', () => {
  const line = openBook().line({ config: openConfig() })
  assert.match(line, /会 \d+ 项/)
  const blockedOnly = openBook().line({ config: DEFAULTS })
  assert.match(blockedOnly, /用不了/)
})

// ── 11. 「你会什么」的直答 ────────────────────────────────────
await check('问「你会什么」收到的回答不超过 5 行', () => {
  const lines = brief(openBook().view({ config: openConfig() }))
  assert.ok(lines.length >= 2)
  assert.ok(lines.length <= 5, `实际 ${lines.length} 行，读的人会划走`)
})

await check('回答里不塞长清单：每组最多 4 个名字', () => {
  const lines = brief(openBook().view({ config: openConfig() }))
  for (const line of lines.slice(1)) {
    const names = line.split('：')[1]
    if (!names) continue
    assert.ok(names.split('、').length <= 4, `这一行名字太多：${line}`)
  }
})

await check('分组装不下时如实说「还有几类」，不假装全说了', () => {
  const lines = brief(openBook().view({ config: openConfig() }))
  const last = lines.at(-1)
  assert.match(last, /还有 \d+ 类|想看全部/)
})

await check('权限不够时，回答里要提一句「用不了」，而不是装作都会', () => {
  const lines = brief(openBook().view({ config: DEFAULTS }))
  assert.ok(lines.some((line) => /用不了/.test(line)), `实际：${lines.join(' / ')}`)
})

await check('什么都没登记时给一句人话，不是空白', () => {
  const lines = brief({ counts: { total: 0 }, groups: [] })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /刚起步/)
})

const dirs = []
void dirs
void mkdtempSync
void rmSync
void path
void os

await check('改名：修一条教坏的，id 不变、开关和成功率都留着', () => {
  // 线上真实场景：教的时候名字在输入框里变成了 "????"，唯一的出路曾经是「忘掉重教」。
  // 重教会换一个新 id，用过几次、成功率全部归零 —— 改一个错字不该这么贵。
  const book = new SkillBook({ now: () => 1000 })
  const taught = book.teach({ name: '临时叫法', what: '临时说明' })
  assert.equal(taught.ok, true)
  book.setState(taught.id, STATE.ON)
  book.record(taught.id, true)
  book.record(taught.id, true)
  const before = book.stats[taught.id]
  assert.equal(before.uses, 2)

  const fixed = book.amend(taught.id, { name: '上网查新闻', what: '问到了就去搜，回来只说结论' })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.changed, true)
  assert.equal(fixed.before.name, '临时叫法')
  assert.equal(book.find(taught.id).name, '上网查新闻')
  assert.equal(book.find(taught.id).what, '问到了就去搜，回来只说结论')
  assert.equal(book.states[taught.id], STATE.ON, '开关不许被改名带走')
  assert.equal(book.stats[taught.id].uses, 2, '履历不许清零')
  assert.equal(book.list().filter((row) => row.source === SOURCE.TAUGHT).length, 1, '不许改出一条新的')
})

await check('改名：出厂技能改不了；重名要拒绝；乱码名能被覆盖，但新名字不能还是乱码', () => {
  const book = new SkillBook({ now: () => 1000 })
  assert.equal(book.amend('do.calc', { name: '算账' }).ok, false, '出厂技能在代码里，改了也会变回去')

  const a = book.teach({ name: '甲技能' })
  const b = book.teach({ name: '乙技能' })
  const dup = book.amend(b.id, { name: '甲技能' })
  assert.equal(dup.ok, false, '两条同名会让面板出现两个一样的，改哪条都改不对')
  assert.match(dup.error, /已经有一条/)

  // 盘上的坏数据：先把名字写成问号（模拟旧版本留下的），再用 amend 覆盖掉
  const legacy = new SkillBook({ now: () => 1000, data: { seq: 1, taught: [{ id: 'taught.1', name: '????', what: '??', group: 'do', tools: ['taught.1'], risk: 'low', steps: [] }] } })
  assert.equal(stateOf(legacy.find('taught.1'), { states: { 'taught.1': STATE.ON } }).state, STATE.BLOCKED)
  assert.equal(legacy.amend('taught.1', { name: '????' }).ok, false, '换成一个还是问号的名字没有意义')
  const ok = legacy.amend('taught.1', { name: '自定义一课', what: '主人教的一课' })
  assert.equal(ok.ok, true)
  assert.equal(stateOf(legacy.find('taught.1'), { states: { 'taught.1': STATE.ON } }).state, STATE.ON, '改好之后就能开了')
})

await check('改名：空名字拦住，什么都没改时明说没改', () => {
  const book = new SkillBook({ now: () => 1000 })
  const taught = book.teach({ name: '占位', what: '占位说明' })
  assert.equal(book.amend(taught.id, { name: '   ' }).ok, false)
  const same = book.amend(taught.id, { name: '占位', what: '占位说明' })
  assert.equal(same.ok, true)
  assert.equal(same.changed, false, '原样提交不该写盘、不该记一条审计')
})

await check('教出来的技能进了提示词：打开的才进，关着的不进', () => {
  const book = new SkillBook({ now: () => AT })
  const taught = book.teach({ name: '每天早上问好', what: '早上八点主动问一句早安' })
  assert.equal(taught.ok, true)

  const viewOn = () => book.view({ config: DEFAULTS, at: AT, impl: new Set() })
  // 刚教完是关着的 —— 最小权限，不能进提示词
  assert.equal(promptLineOf(viewOn()), '', '关着的技能不该进提示词')

  book.setState(taught.id, STATE.ON)
  const line = promptLineOf(viewOn())
  assert.ok(line.includes('每天早上问好'), '打开后要出现在提示词里')
  assert.ok(line.includes('早上八点主动问一句早安'), '说明要原样交给模型')
  assert.ok(line.startsWith('主人教过你这几件事'), '要有一句说明这是什么')

  // 出厂技能不进这段：它们的行为由工具承载，工具名已经在「可用工具」那一行里
  const builtinOnly = promptLineOf(book.view({ config: DEFAULTS, at: AT, impl: new Set() }))
  assert.ok(!builtinOnly.includes('说'), '出厂技能不该挤进这段')
})

await check('教出来的技能关掉后立刻从提示词里消失', () => {
  const book = new SkillBook({ now: () => AT })
  const taught = book.teach({ name: '临时技能', what: '临时说明' })
  book.setState(taught.id, STATE.ON)
  assert.ok(promptLineOf(book.view({ config: DEFAULTS, at: AT, impl: new Set() })).includes('临时技能'))
  book.setState(taught.id, STATE.OFF)
  assert.equal(promptLineOf(book.view({ config: DEFAULTS, at: AT, impl: new Set() })), '', '关掉就该立刻不见')
})

console.log(`\n${failed.length ? '✗' : '✓'} 技能簿用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
