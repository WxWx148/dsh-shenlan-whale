/**
 * 自主活动用例 —— 只记真的发生过的事。
 *
 * 这里不测「模型想得好不好」，只测一条硬约束：
 *   写进活动日志的标题、正文、链接必须来自真的抓到的页面；
 *   查不到就写「没找到」，绝不许出现「我做了什么」的编造。
 */

import assert from 'node:assert/strict'
import { runActivityStep } from '../life/index.mjs'

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

function fakeRuntime() {
  const activities = []
  const cot = []
  const notes = []
  return {
    activities: { read: () => ({ rows: [] }) },
    activityRows: activities,
    cot,
    notes,
    logActivity(record) { activities.push(record) },
    logCot(record) { cot.push(record) },
    memory: { rememberSelf(text) { notes.push(text) } },
  }
}

const isReflectPrompt = (prompt) => String(prompt).includes('你刚真的查到了这段')

await check('自主活动：日志只写抓到的原文与来源，不写进思维链', async () => {
  const runtime = fakeRuntime()
  let cotAtSearch = -1
  const search = async () => {
    cotAtSearch = runtime.cot.length
    return [{ title: '候鸟迁徙', url: 'https://example.com/bird', snippet: '春天候鸟北迁' }]
  }
  const read = async () => ({ ok: true, text: '候鸟按季节迁徙，沿途停歇觅食。' })
  const runner = async (prompt) => (isReflectPrompt(prompt)
    ? { text: '原来它们靠地磁导航。', reasoning: '刚查到这段' }
    : { text: '查一下 候鸟迁徙', reasoning: '想看看鸟' })

  const step = await runActivityStep({
    runtime,
    runner,
    search,
    read,
    config: { group: { interests: ['观鸟'] } },
    now: 1000,
  })

  assert.equal(step.ok, true)
  assert.equal(step.found, true)
  assert.equal(cotAtSearch, 0, '自主活动不写思维链')
  assert.equal(runtime.cot.length, 0, '反思和搜索都不进思维链')
  assert.equal(runtime.notes.length, 0, '自主活动不写自我认知')

  const rows = runtime.activityRows
  const searchRow = rows.find((row) => row.kind === 'search')
  assert.ok(searchRow, '要有一条 search 记录')
  assert.match(searchRow.text, /候鸟迁徙/)
  assert.match(searchRow.text, /沿途停歇/)
  assert.match(searchRow.text, /https:\/\/example\.com\/bird/)
  assert.ok(!searchRow.text.includes('想看看鸟'), '模型的话不许混进「查到了什么」')
  assert.ok(!rows.some((row) => row.kind === 'act'), '编造的 act 记录必须消失')
})

await check('查不到：如实记「没找到」，不编反思', async () => {
  const runtime = fakeRuntime()
  const runner = async () => ({ text: '冷门话题', reasoning: '随便看看' })
  const step = await runActivityStep({
    runtime,
    runner,
    search: async () => [],
    read: async () => ({ ok: false }),
    config: {},
    now: 2000,
  })
  assert.equal(step.ok, true)
  assert.equal(step.found, false)
  assert.equal(runtime.activityRows.length, 1)
  assert.equal(runtime.activityRows[0].kind, 'search')
  assert.match(runtime.activityRows[0].text, /没有找到结果/)
})

await check('页面读失败时退回搜索摘要，不编正文', async () => {
  const runtime = fakeRuntime()
  const runner = async (prompt) => (isReflectPrompt(prompt)
    ? { text: '记住了。' }
    : { text: '硬核硬件', reasoning: '想看看' })
  const step = await runActivityStep({
    runtime,
    runner,
    search: async () => [{ title: '新显卡', url: 'https://example.com/gpu', snippet: '这一代功耗更低' }],
    read: async () => ({ ok: false, error: '超时' }),
    config: {},
    now: 3000,
  })
  assert.equal(step.found, true)
  const searchRow = runtime.activityRows.find((row) => row.kind === 'search')
  assert.match(searchRow.text, /这一代功耗更低/)
  assert.ok(!searchRow.text.includes('超时'))
})

await check('搜索词会去掉口语前缀，空搜索词不落假记录', async () => {
  const runtime = fakeRuntime()
  const seen = []
  const step = await runActivityStep({
    runtime,
    runner: async () => ({ text: '帮我搜一下  显卡评测' }),
    search: async (query) => { seen.push(query); return [] },
    read: async () => ({ ok: false }),
    config: {},
  })
  assert.equal(step.query, '显卡评测')
  assert.deepEqual(seen, ['显卡评测'])
})

const empty = await runActivityStep({ runtime: fakeRuntime(), runner: async () => ({ text: '   ' }) })
assert.equal(empty.ok, false, '没有搜索词时不该记一条空活动')

console.log(`\n${failed.length ? '✗' : '✓'} 自主活动用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
