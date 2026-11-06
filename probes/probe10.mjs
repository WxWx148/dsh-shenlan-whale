/**
 * 探针 10：故障与边界。
 * 问的是「拿到手的东西不对时，是崩、是装没事，还是说清楚」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../lib/runtime.mjs'
import { SkillBook, stateOf, resolveNeeds, toolsAllowed, CATALOG } from '../lib/skill.mjs'
import { PENDING_KEYS } from '../lib/panel.mjs'
import { DEFAULTS } from '../lib/config.mjs'

const AT = 1_700_000_000_000
let bad = 0
const say = (name, ok, detail = '') => {
  if (!ok) bad += 1
  console.log(`${ok ? '  ok  ' : '  BAD '} ${name}${detail ? `  <-- ${detail}` : ''}`)
}
const mk = (files = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p10-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text, 'utf8')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const boot = (files) => {
  const { dir, cleanup } = mk(files)
  let rt = null
  let err = ''
  try {
    rt = new Runtime({ dir, now: () => AT })
  } catch (e) {
    err = e.message
  }
  return { rt, dir, err, cleanup }
}

console.log('— 1. skills.json 里是各种非对象 —')
for (const [label, text] of [
  ['数组', '[]'],
  ['字符串', '"hello"'],
  ['null', 'null'],
  ['数字', '42'],
  ['空对象', '{}'],
]) {
  const { rt, err, cleanup } = boot({ 'skills.json': text })
  say(`skills.json 是${label}时仍能启动`, !!rt && !err, err || '')
  if (rt) say(`  并且技能清单照常可用（${label}）`, rt.skills().counts.total === CATALOG.length)
  cleanup()
}

console.log('— 2. taught 里脏数据 —')
{
  const book = new SkillBook({
    data: {
      taught: [
        { id: 'taught.1', name: '好的' },
        { id: 'taught.1', name: '重复 id 的' },
        { name: '没有 id 的' },
        null,
        { id: 'taught.2' },
      ],
    },
    now: () => AT,
  })
  const ids = book.taught.map((row) => row.id)
  say('重复 id 不会同时存在（find 只能找到一条）', new Set(ids).size === ids.length || ids.length <= 2, `ids=${ids.join(',')}`)
  say('缺名字的条目不会让 list() 抛异常', (() => { try { book.list(); return true } catch { return false } })())
}
{
  const book = new SkillBook({ data: { stats: { 'talk.reply': { uses: -5, ok: 99, fail: 'x' } } }, now: () => AT })
  const m = book.view({ config: DEFAULTS }).groups.flatMap((g) => g.items).find((i) => i.id === 'talk.reply')
  say('负数次数不会算出负的成功率', m.rate === null || (m.rate >= 0 && m.rate <= 1), `rate=${m.rate}`)
}

console.log('— 3. 配置段被整段删掉 —')
{
  const book = new SkillBook({ data: null, now: () => AT })
  book.configure(undefined)
  say('configure(undefined) 回到默认值', book.failStreakLimit === 3 && book.maxTaught === 60)
  book.configure({ autoOffAfterFails: '3', maxTaught: '80' })
  say('字符串数字也认', book.failStreakLimit === 3 && book.maxTaught === 80, `${book.failStreakLimit}/${book.maxTaught}`)
  book.configure({ autoOffAfterFails: NaN, maxTaught: -5 })
  say('NaN 与负数回到默认', book.failStreakLimit === 3 && book.maxTaught === 60, `${book.failStreakLimit}/${book.maxTaught}`)
  book.configure({ autoOffAfterFails: 999, maxTaught: 9999 })
  say('超大值被夹到上限', book.failStreakLimit === 10 && book.maxTaught === 200, `${book.failStreakLimit}/${book.maxTaught}`)
}

console.log('— 4. 配置缺段时的鉴权 —')
{
  const empty = {}
  const skill = CATALOG.find((row) => row.id === 'net.search')
  let threw = false
  let state = null
  try {
    state = stateOf(skill, { config: empty })
  } catch {
    threw = true
  }
  say('空配置不崩', !threw)
  say('空配置判成用不了，而不是假装会', !threw && state.state === 'blocked', JSON.stringify(state))
  say('resolveNeeds 对 undefined 也安全', (() => { try { resolveNeeds(undefined); return true } catch { return false } })())
  say('toolsAllowed 对 undefined 也安全', (() => { try { return toolsAllowed(skill, undefined).ok === true } catch { return false } })())
}

console.log('— 5. 教的输入 —')
{
  const book = new SkillBook({ now: () => AT })
  say('纯空白名字被拒', book.teach({ name: '   ' }).ok === false)
  say('名字带换行会被拒或截断', (() => {
    const r = book.teach({ name: '第一行\n第二行' })
    return r.ok === false || !r.skill?.name?.includes('\n')
  })())
  say('超长 what 被截断而不是整条拒掉', (() => {
    const r = book.teach({ name: '甲', what: 'x'.repeat(500) })
    return r.ok && r.skill.what.length <= 60
  })())
  say('needs 写不认识的权限名会被过滤', (() => {
    const r = book.teach({ name: '乙', needs: ['net', '不存在的权限'] })
    return r.ok && !r.skill.needs.includes('不存在的权限')
  })())
  say('group 写错回落到 do，不会凭空造组', (() => {
    const r = book.teach({ name: '丙', group: '乱写的' })
    return r.ok && r.skill.group === 'do'
  })())
}

console.log('— 6. 出站的脏输入 —')
{
  const { rt, cleanup } = boot()
  rt.setConfig('identity.ownerId', '1', { confirm: true })
  for (const [label, input] of [
    ['含 null', ['a', null, 'b']],
    ['全是空白', ['  ', '\n']],
    ['数字', [1, 2]],
    ['嵌套数组', [['a'], 'b']],
  ]) {
    let threw = false
    let out = ''
    try {
      out = rt.outbound(input)
    } catch {
      threw = true
    }
    const ok = label === '全是空白' ? threw : !threw && typeof out === 'string'
    say(`${label}：${label === '全是空白' ? '被挡住' : '能安全处理'}`, ok, threw ? '抛了' : `out=${JSON.stringify(out).slice(0, 40)}`)
  }
  cleanup()
}

console.log('— 7. 文档承诺与代码的一致性 —')
{
  const dup = PENDING_KEYS.filter((key, i) => PENDING_KEYS.indexOf(key) !== i)
  say('PENDING_KEYS 没有重复项', dup.length === 0, dup.join(','))
  say('PENDING_KEYS 全是字符串', PENDING_KEYS.every((k) => typeof k === 'string' && k.includes('.')))
}

console.log('— 8. 教满之后文件还读得动 —')
{
  const { dir, cleanup } = mk()
  const rt = new Runtime({ dir, now: () => AT })
  rt.setConfig('identity.ownerId', '1', { confirm: true })
  rt.setConfig('skills.maxTaught', 200)
  for (let i = 0; i < 120; i += 1) rt.teachSkill({ name: `技能${i}`, what: '说明' })
  const again = new Runtime({ dir, now: () => AT })
  say('教满 120 个后重启仍能读全', again.skillBook.taught.length === 120, `实际 ${again.skillBook.taught.length}`)
  say('技能页仍算得出来', again.skills().counts.total === 120 + CATALOG.length)
  cleanup()
}

console.log('— 9. 只读目录（写不进去）时不能假装成功 —')
{
  const { rt, cleanup } = boot()
  rt.setConfig('identity.ownerId', '1', { confirm: true })
  // 指向一个「已经存在的目录」：写文件必然失败，且不会被 mkdir 救回来
  const blocked = path.join(rt.dir, 'a-directory')
  mkdirSync(blocked, { recursive: true })
  rt.p.skills = blocked
  let result = null
  try {
    result = rt.save()
  } catch {
    result = { ok: false }
  }
  say('写不进去时返回失败，不抛也不装成功', result && result.ok === false, JSON.stringify(result?.skills?.error || ''))
  cleanup()
}

console.log(`\n${bad ? '✗' : '✓'} 探针 10：${bad} 项有问题`)
if (bad) process.exit(1)
