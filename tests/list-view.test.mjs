import assert from 'node:assert/strict'
import { LIST_KINDS, listOf } from '../view/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name) }
  catch (error) { failed.push(name); console.error('  ✗ ' + name + '：' + (error && error.message)) }
}

const ctx = {
  runtime: {
    skills: () => ({ builtin: 3, learned: 1 }),
    memory: {
      stats: () => ({ facts: 2 }),
      facts: () => ['甲', '乙'],
      data: { people: { p1: { name: '甲' } } },
    },
    status: () => ({ uptime: 1 }),
    toolOwners: () => new Map([['send_face', [{ id: 's1', name: '发图' }]]]),
    blockedTools: () => new Set(['send_face']),
    config: { tools: { whitelist: ['send_face'] }, net: { allowlist: ['a.com'] } },
  },
  channel: {
    groupList: async () => [{ group_id: 123, group_name: '群一' }],
    state: () => ({ online: true }),
  },
  napcat: { snapshot: () => ({ status: 'online' }) },
  guard: { stats: () => ({ night: false }) },
  usage: { today: () => ({ cost: 1 }), line: () => '今天 1.00 元', total: () => 9 },
  sandbox: {
    approvals: {
      list: () => [{ id: 'a1' }],
      remember: () => [],
      stats: () => ({ allow: 1 }),
    },
  },
  tools: { names: () => ['send_face', 'orphan'], label: (name) => '标签:' + name },
  started: true,
  turn: { ready: true },
  at: () => 1234,
}

await check('七类清单就是全部实现：每一类都取得到数据', async () => {
  assert.equal(LIST_KINDS.length, 7)
  for (const kind of LIST_KINDS) {
    const one = await listOf(kind, ctx)
    assert.ok(one, `${kind} 没有实现`)
    assert.equal(one.ok, true, `${kind} 没带 ok`)
  }
})

await check('未知 kind 返回 null，不猜也不兜底到别的类别', async () => {
  assert.equal(await listOf('nope', ctx), null)
  assert.equal(await listOf('', ctx), null)
})

await check('groups：协议端字段名两种都认，映射成 id/name', async () => {
  const one = await listOf('groups', ctx)
  assert.deepEqual(one.groups, [{ id: '123', name: '群一' }])
})

await check('status：把六个来源并成一份，turnReady 跟着 started', async () => {
  const one = await listOf('status', ctx)
  assert.equal(one.channel.online, true)
  assert.equal(one.login.status, 'online')
  assert.equal(one.turnReady, true)
  assert.equal((await listOf('status', { ...ctx, started: false })).turnReady, false)
})

await check('approvals：时间戳可注入，待确认项原样透传', async () => {
  const one = await listOf('approvals', ctx)
  assert.equal(one.now, 1234)
  assert.deepEqual(one.pending, [{ id: 'a1' }])
})

await check('policy：共用工具列全归属、被关的标 off、无归属单列', async () => {
  const one = await listOf('policy', ctx)
  const face = one.tools.find((row) => row.name === 'send_face')
  assert.equal(face.skill.id, 's1')
  assert.equal(face.skills.length, 1)
  assert.equal(face.off, true)
  assert.deepEqual(one.unowned, ['orphan'])
  assert.deepEqual(one.toolWhitelist, ['send_face'])
  assert.deepEqual(one.netWhitelist, ['a.com'])
})

await check('memory：事实与人物各自截断，不把整库甩给前端', async () => {
  const one = await listOf('memory', ctx)
  assert.deepEqual(one.facts, ['甲', '乙'])
  assert.equal(one.people.length, 1)
})

console.log(`\n${failed.length ? '✗' : '✓'} 统一列表用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
