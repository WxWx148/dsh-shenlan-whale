/**
 * tests/log.test.mjs — 审计与终端两份日志的关系、以及「怎么筛」。
 *
 * 这里盯的是三件事：
 *   1. 严重度是**算出来**的，不是每条手写的 —— 否则同一种错会出现两种级别；
 *   2. 级别只影响「看不看得到」，不影响「记不记得下来」；
 *   3. 三个过滤条件（级别 / 类型 / 噪音）是「与」，不是「或」。
 */

import assert from 'node:assert/strict'
import {
  LEVELS,
  LEVEL_IDS,
  LEVEL_LABELS,
  NOISE_KINDS,
  auditFilter,
  auditVisible,
  isNoise,
  kindsPass,
  labelOf,
  levelPass,
  severityOf,
  tracePass,
} from '../base/log.mjs'

const passed = []
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed.push(name)
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log(`    ${error.message}`)
  }
}

await check('严重度是按名字规则算出来的：拒了是 warn、崩了是 error、不认识的是 info', () => {
  assert.equal(severityOf('turn_failed'), 'error')
  assert.equal(severityOf('config_save_failed'), 'error')
  assert.equal(severityOf('config_reject'), 'warn')
  assert.equal(severityOf('skill_teach_reject'), 'warn')
  assert.equal(severityOf('tool_batch_truncated'), 'warn')
  assert.equal(severityOf('config'), 'info')
  assert.equal(severityOf('skill_state'), 'info')
  // 以后新加的类型没登记规则时，必须是 info（显示），不能是 debug（藏起来）
  assert.equal(severityOf('some_brand_new_kind'), 'info')
  assert.equal(severityOf(''), 'info')
})

await check('级别门槛：error 最严、debug 最松；每个档位都有中文名', () => {
  assert.equal(levelPass('error', 'error'), true)
  assert.equal(levelPass('error', 'warn'), false)
  assert.equal(levelPass('warn', 'warn'), true)
  assert.equal(levelPass('warn', 'info'), false)
  assert.equal(levelPass('info', 'info'), true)
  assert.equal(levelPass('debug', 'debug'), true)
  assert.equal(levelPass('不认识的档位', 'info'), true, '档位坏了要退回默认 info，不能把日志全关掉')
  for (const id of LEVEL_IDS) {
    assert.ok(LEVEL_LABELS[id], `${id} 没有中文名`)
    assert.equal(typeof LEVELS[id], 'number')
  }
})

await check('类型白名单：留空=全部放行（和 net.allowlist 空值语义相反）', () => {
  assert.equal(kindsPass([], 'config'), true)
  assert.equal(kindsPass(['config'], 'config'), true)
  assert.equal(kindsPass(['config'], 'skill_state'), false)
  // 通配：以后类型多了不可能一个个列
  assert.equal(kindsPass(['skill_*'], 'skill_teach'), true)
  assert.equal(kindsPass(['skill_*'], 'config'), false)
  assert.equal(kindsPass(['  '], 'config'), true, '空白项当没写')
})

await check('噪音：通道状态与心跳算噪音，配置改动不算', () => {
  for (const kind of NOISE_KINDS) assert.equal(isNoise(kind), true, `${kind} 应该是噪音`)
  assert.equal(isNoise('config'), false)
  assert.equal(isNoise('skill_state'), false)
})

await check('三个条件是「与」：级别够、类型在名单里、噪音没被折叠，缺一不可', () => {
  const filter = { level: 'warn', kinds: [], noise: true }
  assert.equal(auditVisible({ kind: 'config_reject' }, filter), true, 'warn 级、非噪音 → 显示')
  assert.equal(auditVisible({ kind: 'config' }, filter), false, 'info 级低于门槛 → 不显示')
  assert.equal(auditVisible({ kind: 'channel_state' }, filter), false, '噪音默认折叠')

  const withNoise = { ...filter, level: 'debug', noise: false }
  assert.equal(auditVisible({ kind: 'channel_state' }, withNoise), true, '关掉折叠就要全列出来')

  const byKind = { level: 'debug', kinds: ['channel_state'], noise: true }
  assert.equal(auditVisible({ kind: 'channel_state' }, byKind), true, '显式点名要看噪音类型，就该给')

  const onlyConfig = { level: 'debug', kinds: ['config'], noise: true }
  assert.equal(auditVisible({ kind: 'config_reject' }, onlyConfig), false, '类型不在名单里 → 不显示')
})

await check('配置读成过滤条件：坏值退回默认，不把审计页变成空白', () => {
  const fallback = auditFilter({})
  assert.deepEqual(fallback, { level: 'info', kinds: [], noise: true })

  const custom = auditFilter({ log: { auditLevel: 'error', auditKinds: ['config_reject'], auditNoise: false } })
  assert.equal(custom.level, 'error')
  assert.deepEqual(custom.kinds, ['config_reject'])
  assert.equal(custom.noise, false)

  const broken = auditFilter({ log: { auditLevel: '瞎写的', auditKinds: 'not-an-array' } })
  assert.equal(broken.level, 'info', '档位不认识就退回 info')
  assert.deepEqual(broken.kinds, [], '类型表坏了就当没填')
})

await check('终端开关只看 log.level，和审计口径互不影响', () => {
  assert.equal(tracePass({ log: { level: 'info' } }, 'info'), true)
  assert.equal(tracePass({ log: { level: 'info' } }, 'debug'), false)
  assert.equal(tracePass({ log: { level: 'debug' } }, 'debug'), true)
  assert.equal(tracePass({}, 'info'), true, '没配就当 info')
  // 审计口径调严，不该影响终端（反过来也一样）
  assert.equal(tracePass({ log: { auditLevel: 'error' } }, 'info'), true)
})

await check('类型有中文名：常见类型都认得，没登记的退回原名', () => {
  assert.equal(labelOf('config'), '改设置')
  assert.equal(labelOf('turn_failed'), '一轮对话失败')
  assert.equal(labelOf('skill_amend_reject'), '改技能名被拒')
  assert.equal(labelOf('mystery_kind'), 'mystery_kind')
  assert.equal(labelOf(''), '记录')
})

console.log(`\n${failed.length ? '✗' : '✓'} 日志口径用例：${passed.length} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
