/**
 * 打字台用例。
 *
 * 这一层怕的不是「等错了」，是**看起来在等、其实没等**：
 * 并发两条时互相插队（人看着像两个人在抢键盘）、指示器发完才亮、
 * 队列堆起来时还在一条条慢打。所以每个分支都拿可控的 sleep 撞一次。
 */

import assert from 'node:assert/strict'
import { TYPING, TypingDesk, partGapMs, typingDelayMs, typingOnlyMs } from '../voice/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}：${error?.message || error}`)
  }
}

/** 记录等待时长，但不真的等 */
function recorder() {
  const waits = []
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms)
    },
  }
}

await check('时间模型：字越多越久，且带上基础思考与抖动', () => {
  const short = typingDelayMs('在')
  const long = typingDelayMs('今天下午那件事我看了一下，问题不大，明天再细说')
  assert.ok(short < long, `短句应更快：${short} vs ${long}`)
  // 1.5s 基础 + 1 字 * 0.5s + 0.75s 抖动 = 2750ms
  assert.equal(short, 2750)
})

await check('时间模型：再长也封顶在 15 秒，不会让人等成掉线', () => {
  const huge = '啊'.repeat(2000)
  assert.equal(typingDelayMs(huge), TYPING.capSec * 1000)
})

await check('时间模型：空串也给下限，不会退化成秒回', () => {
  assert.equal(typingDelayMs(''), Math.round(1500 + 750))
  assert.ok(typingDelayMs('', { baseSec: 0, jitterMs: 0 }) >= TYPING.floorMs)
})

await check('分条间隔：自己拆的段比机器切的长', () => {
  assert.equal(partGapMs(0, { selfSplit: true }), TYPING.selfSplitGapMs[0])
  assert.equal(partGapMs(1, { selfSplit: true }), TYPING.selfSplitGapMs[1])
  assert.equal(partGapMs(0, { selfSplit: false }), TYPING.partGapMs[0])
  assert.equal(partGapMs(1, { selfSplit: false }), TYPING.partGapMs[1])
})

await check('单线程：两条并发时后一条排在前一条发完之后，中间不插队', async () => {
  const { sleep, waits } = recorder()
  const desk = new TypingDesk({ sleep, random: () => 0, log: () => {} })
  const order = []
  const say = (tag) => async (text) => {
    order.push(`${tag}${text}`)
  }
  await Promise.all([
    desk.typeOut({ parts: ['A1', 'A2'], say: say('A'), pace: () => 0 }),
    desk.typeOut({ parts: ['B1'], say: say('B'), pace: () => 0 }),
  ])
  assert.deepEqual(order, ['AA1', 'AA2', 'BB1'])
  // A 的第一条等一次；A1→A2 之间是「缝 + A2 自己的打字时间」两次；
  // B 自己再等一次
  assert.equal(waits.length, 4)
})

await check('「想」只发生一次：后续每条只算打字，不重新想一遍', async () => {
  // 这一条是连续发言的核心语义：
  //   一条回复分成三条发，是**同一个连续动作**。
  //   真人不会在发第二条之前重新想一遍 —— 他是想到一句发一句。
  //
  // 所以：第一条 = 想 + 打，后面每条 = 只算打。
  // 两头的错都犯过：
  //   · 早期：后面每条只给固定缝 → 长短一样快，不像人在打字；
  //   · 后来：后面每条也算完整时长 → 每条都重新想，三条各带 1.5 秒，
  //     总时长翻倍，对方以为卡死了。
  const text = '我先看看这个文件啊'
  const full = typingDelayMs(text, {})
  const only = typingOnlyMs(text, {})
  // 纯打字要比完整时长少一个「想」的底
  assert.ok(only < full, `纯打字该比完整时长短：only=${only} full=${full}`)
  assert.ok(
    Math.abs((full - only) - TYPING.thinkingBaseSec * 1000) < 5,
    '差额该正好是一个思考底',
  )
  // 但纯打字仍随字数增长 —— 这才是「在打字」的证据
  assert.ok(typingOnlyMs('字'.repeat(40), {}) > typingOnlyMs('字'.repeat(4), {}), '字数多就该打得更久')
})

await check('纯打字：封顶比整体小（不能一条长消息拖满 15 秒）', () => {
  const huge = typingOnlyMs('字'.repeat(200), {})
  assert.ok(huge <= TYPING.typingOnlyCapSec * 1000, '纯打字的封顶要生效')
  assert.ok(huge < TYPING.capSec * 1000, '纯打字的封顶要比整体小')
  assert.ok(huge >= TYPING.typingOnlyFloorMs, '纯打字也有下限，不能是 0')
})

await check('纯打字：数值必须是有限的（NaN 会让等待静默失效）', () => {
  for (const t of ['', '在', '我先看看这个文件啊', '字'.repeat(100)]) {
    const v = typingOnlyMs(t, {})
    assert.ok(Number.isFinite(v), `打字时间不能是 NaN：${JSON.stringify(t)} → ${v}`)
    assert.ok(v > 0, '打字时间必须大于 0')
  }
})

await check('指示器：先亮再等，不是发完才亮', async () => {
  const events = []
  const desk = new TypingDesk({
    channel: { inputStatus: async () => events.push('typing') },
    sleep: async () => events.push('sleep'),
    random: () => 0,
    log: () => {},
  })
  await desk.typeOut({ parts: ['嗯'], scope: 'group', target: 1, say: async () => events.push('say'), pace: () => 0 })
  assert.deepEqual(events, ['typing', 'sleep', 'say'])
})

await check('指示器：协议端不支持时静默，回复照样发出去', async () => {
  const desk = new TypingDesk({
    channel: { inputStatus: async () => { throw new Error('接口不存在') } },
    sleep: async () => {},
    random: () => 0,
    log: () => {},
  })
  const sent = []
  const result = await desk.typeOut({ parts: ['在'], say: async (t) => sent.push(t), pace: () => 0 })
  assert.equal(result.ok, true)
  assert.deepEqual(sent, ['在'])
})

await check('队列满了：不再人为拖时间，但仍然串行发出去', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const desk = new TypingDesk({ sleep: async () => gate, random: () => 0, log: () => {} })
  const done = []
  const tasks = []
  for (let i = 0; i < 6; i += 1) {
    tasks.push(desk.typeOut({ parts: [`m${i}`], say: async (t) => done.push(t), pace: () => 1000 }))
  }
  // 前 5 条各自在等自己的 sleep，第 6 条进队时看到 waiting=5
  assert.equal(desk.waiting, 6)
  release()
  const results = await Promise.all(tasks)
  assert.equal(desk.overloads, 1)
  assert.equal(results[5].overloaded, true)
  assert.equal(results[5].waitedMs, 0)
  assert.deepEqual(done, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
})

await check('发失败：如实返回失败与已发条数，不装作全发完', async () => {
  const desk = new TypingDesk({ sleep: async () => {}, random: () => 0, log: () => {} })
  let n = 0
  const result = await desk.typeOut({
    parts: ['一', '二'],
    pace: () => 0,
    say: async () => {
      n += 1
      if (n === 2) throw new Error('通道断了')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.lines, 1)
  assert.match(result.error, /通道断了/)
})

await check('空内容：一条都不发，也不白等', async () => {
  const { sleep, waits } = recorder()
  const desk = new TypingDesk({ sleep, random: () => 0, log: () => {} })
  const result = await desk.typeOut({ parts: ['', '   '], say: async () => assert.fail('不该发') })
  assert.equal(result.ok, true)
  assert.equal(result.lines, 0)
  assert.equal(waits.length, 0)
})

await check('下限：guard 要等更久时听 guard 的，而不是被打字时间压过去', async () => {
  const { sleep, waits } = recorder()
  const desk = new TypingDesk({ sleep, random: () => 0, log: () => {} })
  await desk.typeOut({ parts: ['嗯'], say: async () => {}, pace: () => 9000 })
  assert.equal(waits[0], 9000)
})

await check('节奏统计：发了几条、最近等了多久，能报出来', async () => {
  const desk = new TypingDesk({ sleep: async () => {}, random: () => 0, log: () => {} })
  await desk.typeOut({ parts: ['一', '二'], say: async () => {}, pace: () => 0 })
  const stats = desk.stats()
  assert.equal(stats.typed, 2)
  assert.equal(stats.waiting, 0)
  assert.ok(stats.lastWaitMs > 0)
})

await check('已等过的时间不再等一遍：生成用了 4 秒，打字就少等 4 秒', async () => {
  const rec = recorder()
  const text = '今天下午那件事我看了一下'
  // Desk 的抖动取中值 0.75s（random=0.5），用例按同一口径算
  const full = typingDelayMs(text, { jitterMs: 750 })
  const desk = new TypingDesk({ sleep: rec.sleep, random: () => 0.5, log: () => {} })
  await desk.typeOut({ parts: [text], say: async () => {}, pace: () => 0, elapsedMs: 4000 })
  assert.equal(rec.waits[0], Math.max(0, full - 4000), '应该扣掉已经花掉的时间')
  assert.ok(desk.stats().savedMs >= 4000, '省掉多少要能报出来')
})

await check('提前亮过指示器：不再亮第二次（会闪），并且按亮起时刻扣时间', async () => {
  let lit = 0
  const rec = recorder()
  let clock = 1_000_000
  const desk = new TypingDesk({
    channel: { inputStatus: async () => { lit += 1 } },
    sleep: rec.sleep,
    random: () => 0.5,
    now: () => clock,
    log: () => {},
  })
  await desk.early('private', '20002', 'private:20002')
  assert.equal(lit, 1, '提前亮一次')
  clock += 5000
  await desk.typeOut({ key: 'private:20002', parts: ['今天下午那件事'], target: '20002', scope: 'private', say: async () => {}, pace: () => 0 })
  assert.equal(lit, 1, '同一条回复只亮一次')
  const full = typingDelayMs('今天下午那件事', { jitterMs: 750 })
  assert.equal(rec.waits[0], Math.max(0, full - 5000))
})

await check('有人排队时让路：单条最多打 4 秒，不把队尾压住', async () => {
  const rec = recorder()
  const desk = new TypingDesk({ sleep: rec.sleep, random: () => 1, log: () => {} })
  // 先进队的那条不受限；后面排着人的那条要被限时
  const first = desk.typeOut({ parts: ['啊'.repeat(100)], say: async () => {}, pace: () => 0 })
  const second = desk.typeOut({ parts: ['啊'.repeat(200)], say: async () => {}, pace: () => 0 })
  await Promise.all([first, second])
  assert.equal(rec.waits.length, 2)
  assert.ok(rec.waits[0] > TYPING.crowdedCapSec * 1000, '先来的照常慢慢打')
  assert.ok(rec.waits[1] <= TYPING.crowdedCapSec * 1000, `有人在等的那条该限到 ${TYPING.crowdedCapSec}s：${rec.waits[1]}`)
})

await check('上一条炸了也要放行：队不能永久卡死', async () => {
  const desk = new TypingDesk({ sleep: async () => {}, random: () => 0, log: () => {} })
  // 直接撬开队尾：模拟「上一段 Promise 被 reject」
  let broke = () => {}
  desk.tail = new Promise((_, reject) => { broke = reject })
  const task = desk.typeOut({ parts: ['嗯'], say: async () => {}, pace: () => 0 })
  broke(new Error('上一段炸了'))
  const result = await task
  assert.equal(result.ok, true, '后面这条必须照发')
  assert.equal(desk.waiting, 0)
})

console.log('')
if (failed.length) {
  console.log(`✗ 打字台用例：${failed.length} 项失败（通过 ${passed} 项）`)
  for (const item of failed) console.log(`  - ${item.name}：${item.error?.stack || item.error}`)
  process.exit(1)
}
console.log(`✓ 打字台用例：${passed} 项通过`)
