/**
 * 探针 9：时序与状态。
 * 问的是「同一个东西被反复动过之后，还是不是同一个东西」。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../lib/runtime.mjs'
import { SkillBook } from '../lib/skill.mjs'

const AT = 1_700_000_000_000
let bad = 0
const say = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`${ok ? '  ok  ' : '  BAD '} ${name}${detail ? `  <-- ${detail}` : ''}`)
}
const mk = (at = AT) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p9-'))
  const rt = new Runtime({ dir, now: () => at })
  rt.setConfig('identity.ownerId', '10001', { confirm: true })
  return { rt, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const item = (rt, id) => rt.skills().groups.flatMap((g) => g.items).find((row) => row.id === id)

console.log('— 1. 开关改完重启，还是那个状态吗 —')
{
  const { rt, dir, cleanup } = mk()
  rt.setSkill('talk.split', 'off')
  rt.setSkill('net.search', 'on')
  const again = new Runtime({ dir, now: () => AT })
  say('关掉的仍然关着', item(again, 'talk.split').state === 'off')
  say('打开过的仍然开着（前提是权限够）', item(again, 'net.search').state !== 'off', `实际 ${item(again, 'net.search').state} / ${item(again, 'net.search').why}`)
  cleanup()
}

console.log('— 2. 教满、忘一个、再教：还能教吗，编号对不对 —')
{
  const { rt, cleanup } = mk()
  rt.setConfig('skills.maxTaught', 2)
  const a = rt.teachSkill({ name: '甲' })
  const b = rt.teachSkill({ name: '乙' })
  const blocked = rt.teachSkill({ name: '丙' })
  say('到上限时拒绝并说清楚', blocked.ok === false && /上限/.test(blocked.error), JSON.stringify(blocked.error))
  rt.forgetSkill(a.id)
  const c = rt.teachSkill({ name: '丙' })
  say('忘掉一个之后又能教了', c.ok === true, JSON.stringify(c.error))
  say('新编号不与活着的撞车', c.id !== b.id, `b=${b.id} c=${c.id}`)
  cleanup()
}

console.log('— 3. 忘掉再教同名：旧账会不会跟着回来 —')
{
  const { rt, cleanup } = mk()
  const first = rt.teachSkill({ name: '读天气' })
  rt.setSkill(first.id, 'on')
  rt.recordSkill(first.id, true)
  rt.recordSkill(first.id, true)
  rt.forgetSkill(first.id)
  const second = rt.teachSkill({ name: '读天气' })
  say('同名重教得到的是新条目', second.id !== first.id, `${first.id} -> ${second.id}`)
  say('新条目不带旧的成功记录', !rt.skillBook.stats[second.id], JSON.stringify(rt.skillBook.stats[second.id] || null))
  say('新条目默认还是关着的', item(rt, second.id).state === 'off')
  cleanup()
}

console.log('— 4. 连续改同一个配置，技能簿跟不跟得上 —')
{
  const { rt, cleanup } = mk()
  for (const n of [1, 2, 0, 5]) {
    rt.setConfig('skills.autoOffAfterFails', n)
    if (rt.skillBook.failStreakLimit !== n) say(`改成 ${n} 后没跟上`, false, `实际 ${rt.skillBook.failStreakLimit}`)
  }
  say('连续改四次都跟上了', rt.skillBook.failStreakLimit === 5)
  cleanup()
}

console.log('— 5. 两个进程同时跑同一个目录（模拟面板与 QQ 同时开）—')
{
  const { rt, dir, cleanup } = mk()
  rt.teachSkill({ name: '甲' })
  const other = new Runtime({ dir, now: () => AT })
  other.teachSkill({ name: '乙' })
  other.save()
  const after = new Runtime({ dir, now: () => AT })
  const names = after.skillBook.taught.map((row) => row.name).sort()
  say('后写的不会把先写的悄悄抹掉（或者至少能被发现）', names.length === 2, `实际 ${JSON.stringify(names)}`)
  void rt
  cleanup()
}

console.log('— 6. 同一秒里连记十次，顺序与计数 —')
{
  const { rt, cleanup } = mk()
  for (let i = 0; i < 10; i += 1) rt.recordSkill('talk.reply', i % 2 === 0)
  const row = rt.skillBook.stats['talk.reply']
  say('十次都记上了', row.uses === 10, `实际 ${row.uses}`)
  say('成功五次', row.ok === 5, `实际 ${row.ok}`)
  say('失败五次', row.fail === 5, `实际 ${row.fail}`)
  say('五次成一败交替，不算自动关（连败没到阈值）', rt.skillBook.states['talk.reply'] !== 'off')
  cleanup()
}

console.log('— 7. 状态页与技能页在同一时刻给的数字一致 —')
{
  const { rt, cleanup } = mk()
  const a = rt.status()['status.skillOn']
  const b = rt.skills().counts.on
  const c = rt.status()['status.skillOn']
  say('连算三次都一样', a === b && b === c, `${a}/${b}/${c}`)
  cleanup()
}

console.log('— 8. 时间倒退（系统时钟被改回去）—')
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p9t-'))
  const forward = new Runtime({ dir, now: () => AT + 86_400_000 })
  forward.teachSkill({ name: '甲' })
  const back = new Runtime({ dir, now: () => AT })
  say('时钟倒退后仍能读起教过的技能', back.skillBook.taught.length === 1)
  say('时钟倒退不抛异常', true)
  rmSync(dir, { recursive: true, force: true })
}

console.log('— 9. 落盘文件可以被人工检查（用户要能看懂）—')
{
  const { rt, dir, cleanup } = mk()
  rt.teachSkill({ name: '记住车牌号', what: '看到车牌记下来' })
  rt.recordSkill('talk.reply', true)
  const text = readFileSync(path.join(dir, 'skills.json'), 'utf8')
  say('skills.json 是给人看得懂的 JSON', text.includes('记住车牌号') && text.includes('"uses"'))
  say('里面没有把整个配置抄一遍（只存技能相关）', !text.includes('wsUrl'))
  writeFileSync(path.join(dir, 'keep.txt'), 'x')
  cleanup()
}
{
  const book = new SkillBook({ now: () => AT })
  say('SkillBook 单独用也不会崩', book.list().length > 0)
}

console.log(`\n${bad ? '✗' : '✓'} 探针 9：${bad} 项有问题`)
if (bad) process.exit(1)
