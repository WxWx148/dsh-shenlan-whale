/**
 * 提醒的离线用例：只测「什么时候响、响什么、会不会重复响」。
 *
 * 线上真出过的事故：模型写 {"time":"2026-11-08 09:00","content":"改毛病"}，
 * 工具只认 minutes/text → 时间落成默认 5 分钟、内容丢成「时间到了」。
 * 这里把「绝对时间 / 别名 / 重复」三件事钉住。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Reminders, describeAt, parseReminder, parseWhen } from '../life/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message || error}`)
  }
}

const NOW = new Date(2026, 10, 7, 9, 22, 0).getTime() // 2026-11-07 09:22 本地

console.log('\n提醒')

await check('绝对时间：明天早上 9 点、明早 9 点、今晚 8 点半', () => {
  const a = parseWhen('明天早上9点', NOW)
  assert.equal(a.ok, true)
  assert.equal(new Date(a.at).getHours(), 9)
  assert.equal(new Date(a.at).getDate(), 8)

  const b = parseWhen('明早9点', NOW)
  assert.equal(b.ok, true)
  assert.equal(new Date(b.at).getDate(), 8)

  const c = parseWhen('今晚8点半', NOW)
  assert.equal(c.ok, true)
  assert.equal(new Date(c.at).getHours(), 20)
  assert.equal(new Date(c.at).getMinutes(), 30)
})

await check('绝对时间：日期 + 时刻 / 只有时刻（过了就顺延明天）', () => {
  const a = parseWhen('2026-11-08 09:00', NOW)
  assert.equal(a.ok, true)
  assert.equal(new Date(a.at).getDate(), 8)

  const b = parseWhen('11月8日 9点', NOW)
  assert.equal(b.ok, true)
  assert.equal(new Date(b.at).getDate(), 8)

  const c = parseWhen('9点', NOW) // 今天 9 点已过 → 明天
  assert.equal(c.ok, true)
  assert.equal(new Date(c.at).getDate(), 8)
})

await check('相对时间：5 分钟后 / 半小时后 / 3 天后', () => {
  assert.equal(parseWhen('5分钟后', NOW).at, NOW + 5 * 60_000)
  assert.equal(parseWhen('半小时后', NOW).at, NOW + 30 * 60_000)
  assert.equal(parseWhen('3天后', NOW).at, NOW + 3 * 86_400_000)
})

await check('过去的时间和不认识的时间都必须报错，不许悄悄改成 5 分钟', () => {
  assert.equal(parseWhen('2026-11-06 09:00', NOW).ok, false)
  assert.equal(parseWhen('随便什么时候', NOW).ok, false)
  assert.match(parseWhen('', NOW).error, /没说什么时候/)
})

await check('聊天原话：抽出时间与内容，且不把「明天 9 点开会」误当提醒', () => {
  const a = parseReminder('5分钟后提醒我喝水', NOW)
  assert.equal(a.text, '喝水')
  assert.equal(a.at, NOW + 5 * 60_000)

  const b = parseReminder('提醒我明天早上9点改毛病', NOW)
  assert.equal(b.text, '改毛病')
  assert.equal(new Date(b.at).getDate(), 8)

  const c = parseReminder('明天早上9点提醒我改毛病', NOW)
  assert.equal(c.text, '改毛病')

  assert.equal(parseReminder('明天9点开会', NOW), null)
})

await check('去重：同一个人、同一分钟、同样内容只留一条', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-remind-'))
  try {
    const reminders = new Reminders({ dir, now: () => NOW })
    const at = NOW + 60 * 60_000
    const first = reminders.add({ at, text: '改毛病', to: '10001' })
    const second = reminders.add({ at: at + 5_000, text: '改毛病。', to: '10001' })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.duplicated, true)
    assert.equal(reminders.list().length, 1)

    // 不同内容、不同时间仍然各留一条
    reminders.add({ at, text: '喝水', to: '10001' })
    reminders.add({ at: at + 2 * 60_000, text: '改毛病', to: '10001' })
    assert.equal(reminders.list().length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('到点、标记已发、取消都还是老行为', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-remind-'))
  try {
    let now = NOW
    const reminders = new Reminders({ dir, now: () => now })
    const item = reminders.add({ at: NOW + 10_000, text: '喝水', to: '10001' }).item
    assert.equal(reminders.due(NOW).length, 0)
    now = NOW + 11_000
    assert.equal(reminders.due(now).length, 1)
    assert.equal(reminders.markSent(item.id).ok, true)
    assert.equal(reminders.due(now).length, 0)
    assert.equal(reminders.cancel(item.id).ok, false) // 已发完的不能再取消
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('describeAt 说人话：今天 / 明天 / 具体日期', () => {
  assert.equal(describeAt(NOW + 60_000, NOW), '今天 09:23')
  assert.equal(describeAt(new Date(2026, 10, 8, 9, 0).getTime(), NOW), '明天 09:00')
  assert.equal(describeAt(new Date(2026, 10, 10, 9, 0).getTime(), NOW), '11-10 09:00')
})

console.log(`\n${failed.length ? '✗' : '✓'} 提醒用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
