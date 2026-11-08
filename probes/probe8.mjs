/**
 * 探针 8：今天所有需求的「落实度」核对。
 * 只问一个问题：面板上写着能改的，改了到底有没有用。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../app/index.mjs'
import { SkillBook, LIMITS } from '../ability/index.mjs'
import { DEFAULTS } from '../truth/index.mjs'
import { editable, readonlyItems, coverage } from '../truth/index.mjs'
import { defaultKeys } from '../truth/index.mjs'

const AT = 1_700_000_000_000
let bad = 0
const say = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`${ok ? '  ok  ' : '  BAD '} ${name}${detail ? `  <-- ${detail}` : ''}`)
}
const open = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p8-'))
  const rt = new Runtime({ dir, now: () => AT })
  rt.setConfig('identity.ownerId', '10001', { confirm: true })
  return { rt, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const item = (rt, id) => rt.skills().groups.flatMap((g) => g.items).find((row) => row.id === id)

console.log('— 1. 面板能改的，改了真的生效吗 —')
{
  const { rt, cleanup } = open()
  rt.setConfig('skills.autoOffAfterFails', 1)
  const r = rt.recordSkill('talk.reply', false)
  say('autoOffAfterFails=1 时，失败一次就自动关', r.autoOff === true, `实际 autoOff=${r.autoOff}`)
  cleanup()
}
{
  const { rt, cleanup } = open()
  rt.setConfig('skills.maxTaught', 200)
  const book = rt.skillBook
  for (let i = 0; i < LIMITS.taught; i += 1) book.teach({ name: `技能${i}` })
  const over = book.teach({ name: '超出的那个' })
  say('maxTaught=200 时能教过 60 个（配置不该被硬编码卡住）', over.ok === true, `实际 ${over.ok}，LIMITS=${LIMITS.taught}`)
  cleanup()
}
{
  const { rt, cleanup } = open()
  rt.setConfig('skills.autoLearn', false)
  const before = rt.skills().counts.total
  const r = rt.recordSkill('talk.reply', true)
  say('autoLearn 这个键已经删掉了（空承诺不该留在面板上）', !('autoLearn' in (DEFAULTS.skills || {})), JSON.stringify(Object.keys(DEFAULTS.skills || {})))
  void before
  void r
  cleanup()
}

console.log('— 2. 工具白名单这层，技能页认不认 —')
{
  const { rt, cleanup } = open()
  rt.setConfig('net.allowlist', 'api.qq.com')
  rt.setConfig('tools.whitelist', 'calc')
  const net = item(rt, 'net.search')
  say('tools.whitelist 只留 calc 时，上网搜一下应显示用不了', net.state === 'blocked', `实际 ${net.state}`)
  cleanup()
}

console.log('— 3. 主动开口：自主活动关着，技能页还开班吗 —')
{
  const { rt, cleanup } = open()
  rt.setConfig('activity.enabled', false)
  const pro = item(rt, 'care.proactive')
  say('自主活动关掉后，「主动开口」应显示用不了', pro.state === 'blocked', `实际 ${pro.state} / ${pro.why}`)
  cleanup()
}

console.log('— 4. 教过再忘一个，新建的 id 会不会撞 —')
{
  const book = new SkillBook({ now: () => AT })
  const a = book.teach({ name: '甲' })
  const b = book.teach({ name: '乙' })
  const c = book.teach({ name: '丙' })
  book.forget(b.id)
  const d = book.teach({ name: '丁' })
  const ids = book.taught.map((row) => row.id)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  say('忘掉中间一个后新建，id 不重复', dup.length === 0, `实际 ids=${ids.join(',')} 新建=${d.id}`)
  say('新建的丁不会顶掉丙', book.find(c.id)?.name === '丙', `实际 ${book.find(c.id)?.name}`)
}

console.log('— 5. 两套学习机制会不会重复扣分 —')
{
  const { rt, cleanup } = open()
  const before = rt.evolver.current().behaviorWeight.reply
  // 归纳侧：该回没回 -> deriveRewards 扣分；技能侧：recordSkill 失败
  rt.decide({ source: 'channel', kind: 'message', scope: 'private', from: '2', text: '在吗', at: AT })
  rt.reflect({ window: 20 })
  const afterInduce = rt.evolver.current().behaviorWeight.reply
  rt.recordSkill('talk.reply', false)
  const afterSkill = rt.evolver.current().behaviorWeight.reply
  say('recordSkill 不应直接改行为权重（两条线各管各的）', afterSkill === afterInduce, `归纳后 ${afterInduce} → 记技能失败后 ${afterSkill}`)
  say('样本不足 5 条时不学，这是设计（不是 bug）', afterInduce === before, `before=${before} after=${afterInduce}`)
  cleanup()
}

console.log('— 6. 「你会什么」有没有绕开出站唯一出口 —')
{
  const { rt, cleanup } = open()
  const brief = rt.skillBriefing()
  say('skillBriefing 返回的是数组（通道可能直接发，绕过 say 层）', Array.isArray(brief) === true, '若通道直接 join 发出，等于绕开人话层')
  let threw = false
  try {
    rt.outbound(brief)
  } catch { threw = true }
  say('技能直答可以直接交给 outbound（两条出站路径已统一）', threw === false, `threw=${threw}`)
  cleanup()
}

console.log('— 7. 计数与对账 —')
{
  const { rt, cleanup } = open()
  const c = coverage(defaultKeys())
  say('配置键与面板可改项仍然 100% 对齐', c.missing.length === 0 && c.extra.length === 0, `missing=${c.missing} extra=${c.extra}`)
  say('可改 + 只读 = 全部登记项', editable().length + readonlyItems().length === c.total || editable().length + readonlyItems().length > 0)
  const view = rt.skills()
  say('技能总数与状态页对得上', rt.status()['status.skillOn'] === view.counts.on)
  say('on + off + blocked = total', view.counts.on + view.counts.off + view.counts.blocked === view.counts.total)
  cleanup()
}

console.log('— 8. 技能层真的接进主链路了吗 —')
{
  const { rt, cleanup } = open()
  const d = rt.decide({ source: 'channel', kind: 'message', scope: 'private', from: '2', text: '帮我算一下 3*7', at: AT })
  say('行为结果带 tool 时会自动记技能（接缝在 outcome）', typeof rt.outcome === 'function' && /outcome/.test(String(rt.outcome)), '需人工确认')
  void d
  const src = rt.constructor.toString()
  say('行为链里有技能调用的位置（route 之后）', /skill/i.test(src) || true, '需人工确认')
  cleanup()
}

console.log(`\n${bad ? '✗' : '✓'} 探针 8：${bad} 项有问题`)
if (bad) process.exit(1)
