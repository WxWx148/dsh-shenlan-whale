import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'whale-memory-'))
const { WhaleMemory } = await import('../lib/memory.mjs')
const { buildPrompt } = await import('../lib/turn.mjs')
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
  memory.rememberPerson('2239929077', { name: '大哥' })
  memory.rememberPerson('2239929077', { note: '喜欢简短回复' })
  memory.rememberPerson('2239929077', { note: '喜欢简短回复' })
  const person = memory.person('2239929077')
  assert.equal(person.name, '大哥')
  assert.equal(person.notes.length, 1)
})

await check('prompt carries facts and person', () => {
  memory.rememberFact('我在上海')
  const prompt = buildPrompt({
    event: { from: '2239929077', payload: { text: '你好', senderName: '大哥' } },
    persona: { name: '深蓝鲸' },
    memory: memory.digest({ forUser: '2239929077', query: '上海' }),
  })
  assert.match(prompt, /上海/)
  assert.match(prompt, /大哥/)
  assert.match(prompt, /深蓝鲸/)
})

console.log('OK whale memory: ' + passed)

import { memoryCommand } from '../lib/memory.mjs'
const cmd = memoryCommand('记住，我在上海', memory)
assert.match(cmd.text, /记住了/)
assert.match(memoryCommand('你记得什么', memory).text, /上海/)
assert.match(memoryCommand('忘掉上海', memory).text, /忘了/)
console.log('OK memory command: 3')
