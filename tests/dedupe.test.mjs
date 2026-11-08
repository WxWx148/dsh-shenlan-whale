/**
 * tests/dedupe.test.mjs — 出口去重
 *
 * 这个模块最要紧的不是「拦住了多少」，而是**「有没有误伤」**。
 * 一个把正常回答静默吞掉的去重，比没有去重更糟 ——
 * 主人的体感是「它坏了」，不是「它复读了」。
 *
 * 所以这里的断言大半是在钉住「**该放行的必须放行**」。
 */

import assert from 'node:assert/strict'
import { DUP_TEXT_MS, Dedupe, normalize, sameUtterance } from '../decide/index.mjs'

const check = async (name, fn) => {
  try {
    await fn()
    console.log('✓ ' + name)
  } catch (error) {
    console.log('✗ ' + name)
    console.log('  ' + String(error?.message || error).split('\n').slice(0, 4).join('\n  '))
    process.exitCode = 1
  }
}

// ── 归一化 ───────────────────────────────────────────────────
await check('归一化：空白与标点差异不算内容差异', () => {
  assert.equal(normalize('  你好  世界 '), '你好世界')
  assert.equal(normalize('我看看啊，马上'), '我看看啊马上')
  assert.equal(normalize('a\n\nb'), 'ab')
})

// ── 同一句话的判定 ───────────────────────────────────────────
await check('同一句话：完全一样才算', () => {
  assert.equal(sameUtterance('我看看啊', '我看看啊'), true)
  assert.equal(sameUtterance('我看看啊', '我看看'), false)
})

await check('同一句话：包含关系且长度接近才算', () => {
  // 「我先去查一下」 vs 「我先去查一下马上好」 —— 差两个字，是同一句话在长
  assert.equal(sameUtterance('我先去查一下', '我先去查一下马上好'), true)
  // 「我看看」 vs 「我看看这个文件的第三个bug在哪」 —— 差太多，是两句
  assert.equal(sameUtterance('我看看', '我看看这个文件的第三个bug在哪'), false)
})

await check('同一句话：太短的包含不算', () => {
  // 短句包含是巧合，不是复读
  assert.equal(sameUtterance('好的', '好的我知道了'), false)
})

// ── 消息级去重 ───────────────────────────────────────────────
await check('消息级：同一条消息不回两遍', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteMessage('group:1', 'm1')
  assert.equal(d.checkMessage('group:1', 'm1').duplicate, true, '同一条消息第二次回要被拦')
})

await check('消息级：不同消息都要回（主人再问一遍）', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteMessage('group:1', 'm1')
  assert.equal(d.checkMessage('group:1', 'm2').duplicate, false, '新消息必须能回')
})

await check('消息级：窗口过了就放行', () => {
  let at = 1000
  const d = new Dedupe({ now: () => at })
  d.noteMessage('group:1', 'm1')
  at += 301_000
  assert.equal(d.checkMessage('group:1', 'm1').duplicate, false, '过了五分钟就该能再回')
})

// ── 内容级去重：按时间邻近，不按内容相等 ─────────────────────
await check('内容级：紧接着说同一句要拦（真复读）', () => {
  let at = 1000
  const d = new Dedupe({ now: () => at })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  at += 2000
  assert.equal(d.checkText('group:1', '我看看啊这个文件', 'round-A').duplicate, true, '2 秒内说同一句是复读')
})

await check('内容级：隔久了说同一句要放行（人再说了）', () => {
  let at = 1000
  const d = new Dedupe({ now: () => at })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  at += DUP_TEXT_MS + 1000
  const hit = d.checkText('group:1', '我看看啊这个文件', 'round-A')
  assert.equal(hit.duplicate, false, '隔久了说同一句是正常对话，不能拦')
})

await check('内容级：跨轮一律放行（主人再问一遍必须能再答）', () => {
  let at = 1000
  const d = new Dedupe({ now: () => at })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  at += 1000
  const hit = d.checkText('group:1', '我看看啊这个文件', 'round-B')
  assert.equal(hit.duplicate, false, '跨轮的重复不是复读')
})

await check('内容级：不给轮次标识就放行（宁可漏拦不能误伤）', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  assert.equal(d.checkText('group:1', '我看看啊这个文件').duplicate, false, '没给 key 等于关掉内容去重')
  assert.equal(d.checkText('group:1', '我看看啊这个文件', '').duplicate, false, '空 key 同样放行')
})

await check('内容级：太短的话不拦（「嗯」「好」重复是正常对话）', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteText('group:1', '嗯', 'round-A')
  assert.equal(d.checkText('group:1', '嗯', 'round-A').duplicate, false, '短句重复不算复读')
})

await check('内容级：不带轮次标识时 noteText 也不记账', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteText('group:1', '我看看啊这个文件', '')
  assert.equal(d.texts.size, 0, '没给 key 就不该留下记录')
})

await check('内容级：不同会话互不影响', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  assert.equal(d.checkText('group:2', '我看看啊这个文件', 'round-A').duplicate, false, '别的群说同一句不算复读')
})

// ── 统计 ─────────────────────────────────────────────────────
await check('统计：拦下的次数能被面板看见', () => {
  const d = new Dedupe({ now: () => 1000 })
  d.noteText('group:1', '我看看啊这个文件', 'round-A')
  d.checkText('group:1', '我看看啊这个文件', 'round-A')
  d.markSkipped()
  const stats = d.stats()
  assert.equal(stats.skipped, 1, '拦了一次就要记一次')
  assert.ok(stats.trackedTexts >= 1, '面板要看得到在跟踪多少条')
})

// ── 内存不涨 ─────────────────────────────────────────────────
await check('内存：记太多时会淘汰最老的', () => {
  const d = new Dedupe({ now: () => 1000 })
  for (let i = 0; i < 600; i += 1) {
    d.noteText('group:1', '这是第' + i + '条不一样的测试内容', 'round-' + i)
  }
  assert.ok(d.texts.size <= 400, '表不能无限长，实际 ' + d.texts.size)
})
