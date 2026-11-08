import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'whale-memory-'))
const { WhaleMemory } = await import('../mind/index.mjs')
const { buildPrompt } = await import('../turn/index.mjs')
const memory = new WhaleMemory({ dir })
let passed = 0
async function check(name, fn) { try { await fn(); passed += 1 } catch (e) { console.error('FAIL ' + name); throw e } }

await check('facts: write, dedupe, forget', () => {
  assert.equal(memory.rememberFact('我在上海').ok, true)
  assert.equal(memory.rememberFact('我在上海').duplicated, true)
  assert.equal(memory.stats().facts, 1)
  assert.equal(memory.forgetFact('上海').ok, true)
  assert.equal(memory.stats().facts, 0)
})

// 空键曾经会把整本事实清空：任何字符串都 includes('')，一条都没匹配上就等于全删。
// 面板漏传字段（发 text、服务端读 target）就是现实中的触发路径。
await check('forgetFact 空目标：不删，也不假装删了', () => {
  memory.rememberFact('第一条事实')
  memory.rememberFact('第二条事实')
  const before = memory.stats().facts
  for (const empty of ['', '   ', null, undefined]) {
    const result = memory.forgetFact(empty)
    assert.equal(result.ok, false, `空目标 ${JSON.stringify(empty)} 不该成功`)
    assert.equal(memory.stats().facts, before, '空目标把事实删掉了')
  }
  // 只有标点也算空：normalize 会把标点洗掉
  assert.equal(memory.forgetFact('，。').ok, false, '全是标点等于没说忘哪条')
  assert.equal(memory.stats().facts, before)
})

await check('people: name and notes dedupe', () => {
  memory.rememberPerson('200000001', { name: '大哥' })
  memory.rememberPerson('200000001', { note: '喜欢简短回复' })
  memory.rememberPerson('200000001', { note: '喜欢简短回复' })
  const person = memory.person('200000001')
  assert.equal(person.name, '大哥')
  assert.equal(person.notes.length, 1)
})

await check('prompt carries facts and person', () => {
  memory.rememberFact('我在上海')
  const prompt = buildPrompt({
    event: { from: '200000001', payload: { text: '你好', senderName: '大哥' } },
    persona: { name: '深蓝鲸' },
    memory: memory.digest({ forUser: '200000001', query: '上海' }),
  })
  assert.match(prompt, /上海/)
  assert.match(prompt, /大哥/)
  assert.match(prompt, /深蓝鲸/)
})

console.log('OK whale memory: ' + passed)

import { memoryCommand } from '../mind/index.mjs'
const cmd = memoryCommand('记住，我在上海', memory)
assert.match(cmd.text, /记住了/)
assert.match(memoryCommand('你记得什么', memory).text, /上海/)
assert.match(memoryCommand('忘掉上海', memory).text, /忘了/)
console.log('OK memory command: 3')

// ── 改口：旧事实要让位，但不能误伤 ───────────────────────────────
// 这一段守的是「同一件事说反话」。它有两个真实的失败方式，都必须钉住：
//   1. 抓不到 —— 「爱吃辣 → 不爱吃辣」这种最常见的改口，因为否定式包含肯定式
//      （不爱吃 ⊃ 爱吃），早先的写法被自己的排除条件判死，一条都识别不出来；
//   2. 抓过头 —— 「爱猫」和「爱狗」是两件事，把其中一条标成过期就是删了用户真说过的话。
import { readFileSync, rmSync } from 'node:fs'
const { WhaleMemory: Mem2 } = await import('../mind/index.mjs')

function freshMemory(options = {}) {
  const d = mkdtempSync(join(tmpdir(), 'whale-contradict-'))
  return { memory: new Mem2({ dir: d, now: () => Date.now(), ...options }), dir: d }
}

await check('改口：说反话时旧事实退场（不再两条并存）', () => {
  const cases = [
    ['主人爱吃辣', '主人不爱吃辣'],
    ['主人爱猫', '主人恨猫'],
    ['主人习惯早起', '主人不习惯早起'],
    ['主人有两只猫', '主人没有两只猫'],
    ['主人喜欢喝咖啡，不加糖', '主人不喜欢喝咖啡了'],
    ['主人喜欢猫', '主人讨厌猫'],
  ]
  for (const [oldText, newText] of cases) {
    const { memory: m, dir } = freshMemory()
    m.rememberFact(oldText)
    m.rememberFact(newText)
    const superseded = m.facts().filter((f) => f.supersededAt)
    assert.equal(superseded.length, 1, `「${oldText}」→「${newText}」应当只让旧的那条退场`)
    assert.equal(superseded[0].text, oldText, '退场的必须是被改口的那条')
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('改口：换了话题、或只是重复，都不许把旧事实标成过期', () => {
  const cases = [
    ['主人是设计师', '主人不会做饭'], // 同一态度词族，不同的事
    ['主人爱吃辣', '主人不爱吃甜'], // 真改口，但不是同一道菜
    ['主人喜欢猫', '主人讨厌狗'],
    ['今天下雨了', '今天不下雨了'], // 没表态的词，不该猜到
    ['主人喜欢吃苹果', '主人喜欢吃苹果'], // 完全重复：算重复，不算改口
  ]
  for (const [oldText, newText] of cases) {
    const { memory: m, dir } = freshMemory()
    m.rememberFact(oldText)
    m.rememberFact(newText)
    assert.equal(m.facts().filter((f) => f.supersededAt).length, 0, `「${oldText}」+「${newText}」不该判成改口`)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── hits 落盘节流 ────────────────────────────────────────────────
// digest() 每条消息都跑一次，而它会给被选中的事实 +1 hits。
// 早先是每次 digest 都整份重写 memory.json（2000 条时约 300 KB），聊十句写十遍。
// 现在窗口内攒着，close() 补一次。这里钉的是「攒着」和「补写」这两件事。
await check('hits 节流：窗口内不反复写盘，退出前补写一次', () => {
  const { memory: m, dir } = freshMemory({ hitsSaveEveryMs: 60_000 })
  m.rememberFact('主人喜欢喝咖啡')
  m.rememberFact('主人养了一只猫')
  const hitsOnDisk = () => JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
    .facts.find((f) => f.text === '主人喜欢喝咖啡').hits

  m.digest({ query: '咖啡' }) // 第一次会写盘（上一次写盘是 0）
  const first = hitsOnDisk()
  m.digest({ query: '咖啡' }) // 窗口内：内存里加一，磁盘不动
  m.digest({ query: '咖啡' })
  assert.equal(hitsOnDisk(), first, '窗口内不该反复写盘')

  m.close() // 退出前补写
  assert.ok(hitsOnDisk() > first, 'close 要把攒着的 hits 写下去')
  rmSync(dir, { recursive: true, force: true })
})

console.log('OK 记忆健壮性: 改口 2（正例 6 组 / 反例 5 组）+ 落盘节流 1')
