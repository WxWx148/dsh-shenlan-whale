/**
 * 限流与时机用例。
 *
 * 这一层最容易出的错是「静默失效」：配置改了，但判断用的是默认值；
 * 或者时间窗算错，变成「永远放行」。所以每个分支都单独撞一次。
 */

import assert from 'node:assert/strict'
import { Guard } from '../decide/index.mjs'

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
const cfg = (over = {}) => ({
  guard: {
    replyQuotaPerHour: 60,
    perMinute: 15,
    firstDelayMs: 2000,
    minGapMs: 1200,
    mergeWindowMs: 2000,
    nightWindow: '23:00-07:00',
    ...over,
  },
})

await check('白天、没超限：放行', () => {
  const guard = new Guard({ config: cfg(), now: () => BASE })
  assert.equal(guard.check(BASE).ok, true)
})

await check('夜间静音：不开口，且原因是 night', () => {
  const guard = new Guard({ config: cfg(), now: () => BASE })
  const at = new Date(2026, 9, 29, 23, 30, 0).getTime()
  const result = guard.check(at)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'night')
})

await check('跨零点的夜间也算：凌晨 2 点仍静音', () => {
  const guard = new Guard({ config: cfg(), now: () => BASE })
  assert.equal(guard.quiet(new Date(2026, 9, 30, 2, 0, 0).getTime()), true)
  assert.equal(guard.quiet(new Date(2026, 9, 30, 8, 0, 0).getTime()), false)
})

await check('每分钟上限真的会拦：发满 3 条后第 4 条被拒', () => {
  const guard = new Guard({ config: cfg({ perMinute: 3 }), now: () => BASE })
  for (let i = 0; i < 3; i += 1) guard.note(BASE + i)
  const result = guard.check(BASE + 10)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'per_minute')
})

await check('一分钟之后解封（窗口是滑动的，不是永久计数）', () => {
  const guard = new Guard({ config: cfg({ perMinute: 3 }), now: () => BASE })
  for (let i = 0; i < 3; i += 1) guard.note(BASE + i)
  assert.equal(guard.check(BASE + 10).ok, false)
  assert.equal(guard.check(BASE + 61_000).ok, true)
})

await check('每小时上限独立于每分钟：每分钟没满，总量到了照样拦', () => {
  const guard = new Guard({ config: cfg({ perMinute: 100, replyQuotaPerHour: 5 }), now: () => BASE })
  for (let i = 0; i < 5; i += 1) guard.note(BASE + i * 20_000)
  const result = guard.check(BASE + 110_000)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'per_hour')
})

await check('上限填 0 = 不限制（0 不该被当成「一条都不许」）', () => {
  const guard = new Guard({ config: cfg({ perMinute: 0, replyQuotaPerHour: 0 }), now: () => BASE })
  for (let i = 0; i < 50; i += 1) guard.note(BASE + i)
  assert.equal(guard.check(BASE + 100).ok, true)
})

await check('夜间窗口留空 = 不静音（不是「整天静音」）', () => {
  const guard = new Guard({ config: cfg({ nightWindow: '' }), now: () => BASE })
  assert.equal(guard.quiet(new Date(2026, 9, 29, 2, 0, 0).getTime()), false)
})

await check('首条延迟生效，但有 8 秒上限', () => {
  const guard = new Guard({ config: cfg({ firstDelayMs: 2000, minGapMs: 0 }), now: () => BASE })
  assert.equal(guard.delay(BASE), 2000)

  const slow = new Guard({ config: cfg({ firstDelayMs: 60_000, minGapMs: 0 }), now: () => BASE })
  assert.equal(slow.delay(BASE), 8000, '再久就不像打字，像掉线')
})

await check('刚发过一条：要等够最小间隔，不能贴脸刷', () => {
  const guard = new Guard({ config: cfg({ firstDelayMs: 0, minGapMs: 1200 }), now: () => BASE })
  guard.note(BASE)
  assert.equal(guard.delay(BASE + 200), 1000)
  assert.equal(guard.delay(BASE + 2000), 0)
})

// 这一条是对真实事故的回归：config.json 里曾躺着 0.3（把「秒」的数值当毫秒存），
// 于是看到消息 0.3 毫秒就回 —— 既像机器人，又是风控最敏感的行为特征。
// 节奏层是最后一道闸：就算配置脏了，也绝不能退成秒回。
await check('节奏时长被写成「秒的数值」时：按秒解释，不许退化成秒回', () => {
  const dirty = new Guard({ config: cfg({ firstDelayMs: 0.3, minGapMs: 0.3, mergeWindowMs: 0.3 }), now: () => BASE })
  assert.equal(dirty.delay(BASE), 300, '0.3 应解释为 0.3 秒 = 300 毫秒，而不是 0.3 毫秒')
})

await check('正常的毫秒值不会被误伤（2.5 秒仍是 2.5 秒）', () => {
  const guard = new Guard({ config: cfg({ firstDelayMs: 2500, minGapMs: 1800 }), now: () => BASE })
  assert.equal(guard.delay(BASE), 2500)
})

await check('0 = 明确「不等」，不该被当成脏值拉长', () => {
  const guard = new Guard({ config: cfg({ firstDelayMs: 0, minGapMs: 0 }), now: () => BASE })
  assert.equal(guard.delay(BASE), 0)
})

await check('一分钟发得太密：延迟被拉长（把曲线摊平）', () => {
  const guard = new Guard({ config: cfg({ firstDelayMs: 0, minGapMs: 0 }), now: () => BASE })
  for (let i = 0; i < 8; i += 1) guard.note(BASE + i * 100)
  const wait = guard.delay(BASE + 900)
  assert.ok(wait > 0, '积压时应当多等一会儿')
  assert.ok(wait <= 8000)
})

await check('配置热改能生效（面板改完不用重启）', () => {
  const guard = new Guard({ config: cfg({ perMinute: 15 }), now: () => BASE })
  guard.note(BASE)
  assert.equal(guard.check(BASE + 100).ok, true)
  guard.configure(cfg({ perMinute: 1 }))
  assert.equal(guard.check(BASE + 200).ok, false, '改成 1 之后，已发的那条就顶满了')
})

await check('临时静音：非主人被挡，主人照常，解除后恢复', () => {
  const guard = new Guard({ config: { ...cfg(), identity: { ownerId: '10001' } }, now: () => BASE })
  guard.mute(30, BASE)
  const blocked = guard.check(BASE + 60_000)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.why, 'muted')
  assert.match(blocked.text, /安静中/)
  assert.equal(guard.check(BASE + 60_000, { event: { from: '10001' } }).ok, true, '主人不受临时静音影响')
  guard.unmute()
  assert.equal(guard.check(BASE + 120_000).ok, true)
})

// ── 主人与额度 ─────────────────────────────────────────────────
// 这一组是对一次真实事故的回归：跟机器人聊得密了一阵之后，它突然一条都不回，
// 通道在线、消息收得到、日志里躺着 `per_hour`，但人只看得见沉默 —— 只能靠重启绕过。
// 起因就是「每小时总量」这道闸没有给主人开豁免权。
await check('主人不受每小时总量限制：聊天再密也回得了话', () => {
  const config = { ...cfg({ perMinute: 100, replyQuotaPerHour: 3 }), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  for (let i = 0; i < 3; i += 1) guard.note(BASE + i * 20_000)
  const other = guard.check(BASE + 90_000, { event: { from: '20002' } })
  assert.equal(other.ok, false, '别人该被拦还得被拦')
  assert.equal(other.why, 'per_hour')
  const owner = guard.check(BASE + 90_000, { event: { from: '10001' } })
  assert.equal(owner.ok, true, '主人不能被自己的机器人拒之门外')
})

// 下限是 15，所以要用**高于下限**的配置才能验证「主人也会撞到分钟闸门」
await check('主人仍然受分钟闸门管：不是「主人就可以无限刷」', () => {
  const config = { ...cfg({ perMinute: 20, replyQuotaPerHour: 0 }), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  for (let i = 0; i < 20; i += 1) guard.note(BASE + i)
  const owner = guard.check(BASE + 30, { event: { from: '10001' } })
  assert.equal(owner.ok, false)
  assert.equal(owner.why, 'per_minute', '主人豁免的是「总量」，不是「频率」')
})

await check('主人的分钟额度有一个兜底下限：配置调到 1 也至少给 15 条', () => {
  const config = { ...cfg({ perMinute: 1, replyQuotaPerHour: 0 }), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  for (let i = 0; i < 14; i += 1) guard.note(BASE + i)
  assert.equal(guard.check(BASE + 20, { event: { from: '10001' } }).ok, true, '主人的下限是 15 条/分钟')
  guard.note(BASE + 30)
  assert.equal(guard.check(BASE + 40, { event: { from: '10001' } }).why, 'per_minute', '超过 15 条仍要拦')
})

await check('没有配主人 QQ 时，谁都不算主人（身份识别失败 = 收紧，不是放开）', () => {
  const guard = new Guard({ config: cfg({ perMinute: 100, replyQuotaPerHour: 2 }), now: () => BASE })
  for (let i = 0; i < 2; i += 1) guard.note(BASE + i * 20_000)
  assert.equal(guard.check(BASE + 90_000, { event: { from: '10001' } }).ok, false)
})

await check('夜间的主人豁免不受这一改动影响（本来就该回）', () => {
  const config = { ...cfg(), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  const night = new Date(2026, 9, 29, 23, 30, 0).getTime()
  assert.equal(guard.check(night, { event: { from: '20002' } }).why, 'night')
  assert.equal(guard.check(night, { event: { from: '10001' } }).ok, true)
})

await check('一句话拆成三条气泡，额度上只算一条回复；分钟闸也按会话算', () => {
  const config = { ...cfg({ perMinute: 3, replyQuotaPerHour: 100 }), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  const event = { scope: 'group', conversation: 'group:111', from: '20002', payload: { groupId: '111' } }
  // 一条回复拆成三条：只有第一条 count=1，后两条 count=0
  guard.note(BASE, { conversation: 'group:111' }, 1)
  guard.note(BASE + 100, { conversation: 'group:111' }, 0)
  guard.note(BASE + 200, { conversation: 'group:111' }, 0)
  assert.equal(guard.check(BASE + 300, { event }).ok, true, '三条气泡只该占一条额度')
  // 再回两条（各 1 条）才到 3 条上限
  guard.note(BASE + 400, { conversation: 'group:111' }, 1)
  guard.note(BASE + 500, { conversation: 'group:111' }, 1)
  assert.equal(guard.check(BASE + 600, { event }).why, 'per_minute')
  const otherGroup = { scope: 'group', conversation: 'group:222', from: '20003', payload: { groupId: '222' } }
  assert.equal(guard.check(BASE + 600, { event: otherGroup }).ok, true, '别的群不该被这个群的一分钟额度拖住')
})

await check('每小时额度按群算：一个群刷满了，不该让别的群跟着哑掉', () => {
  const config = { ...cfg({ perMinute: 100, replyQuotaPerHour: 3 }), identity: { ownerId: '10001' } }
  const guard = new Guard({ config, now: () => BASE })
  for (let i = 0; i < 3; i += 1) guard.note(BASE + i * 1000, { conversation: 'group:111' })
  for (let i = 0; i < 5; i += 1) guard.note(BASE + i * 1000, { conversation: 'group:222' })
  const hot = guard.check(BASE + 60_000, { event: { scope: 'group', conversation: 'group:111', from: '20002', payload: { groupId: '111' } } })
  assert.equal(hot.why, 'per_hour', '这个群自己刷满了，该拦')
  const cold = guard.check(BASE + 60_000, { event: { scope: 'group', conversation: 'group:333', from: '20003', payload: { groupId: '333' } } })
  assert.equal(cold.ok, true, '另一个群没说过话，不该被前面的群拖累')
})

await check('统计能说清「这一分钟说了几条、是不是静音」', () => {
  const guard = new Guard({ config: cfg(), now: () => BASE })
  guard.note(BASE - 1000)
  guard.note(BASE - 500)
  const stats = guard.stats(BASE)
  assert.equal(stats.lastMinute, 2)
  assert.equal(stats.quiet, false)
})

console.log(`\n${failed.length ? '✗' : '✓'} 限流用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
