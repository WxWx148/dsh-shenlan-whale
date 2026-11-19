import assert from 'node:assert/strict'
import { ACTION_OPS, runAction } from '../app/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name) }
  catch (error) { failed.push(name); console.error('  ✗ ' + name + '：' + (error && error.message)) }
}

const calls = []
const rec = (name, result = { ok: true }) => (...args) => {
  calls.push({ name, args })
  return result
}

const ctx = {
  runtime: {
    memory: {
      rememberFact: rec('memory.rememberFact'),
      updateSelf: rec('memory.updateSelf'),
      forgetSelf: rec('memory.forgetSelf'),
      rememberSelf: rec('memory.rememberSelf'),
      updateFact: rec('memory.updateFact'),
      updatePerson: rec('memory.updatePerson'),
      updateGroup: rec('memory.updateGroup'),
      forgetFact: rec('memory.forgetFact'),
      forgetPerson: rec('memory.forgetPerson'),
      forgetGroup: rec('memory.forgetGroup'),
    },
    reminders: { cancel: rec('reminders.cancel'), update: rec('reminders.update') },
    forgetSkill: rec('runtime.forgetSkill'),
    amendSkill: rec('runtime.amendSkill'),
    teachSkill: rec('runtime.teachSkill'),
    setSkill: rec('runtime.setSkill'),
    outbound: () => 'SENT',
    noteSelfMessage: rec('runtime.noteSelfMessage'),
    log: rec('runtime.log'),
    reloadConfig: () => ({ ok: true, effects: Promise.resolve([{ login: 'L' }, { message: 'M' }]) }),
  },
  sandbox: {
    approvals: { decide: rec('approvals.decide'), forget: rec('approvals.forget') },
  },
  chat: { reset: rec('chat.reset') },
  channel: {
    state: () => 'online',
    groupList: async () => [{ group_id: 2002 }],
    say: rec('channel.say'),
  },
  guard: { note: rec('guard.note') },
  card: (row) => ({ kind: 'card', row }),
  peerOf: () => ({ scope: 'private', id: '1001' }),
  at: () => 1234,
}

/** op → 期望落到哪个方法、参数是什么。参数映射写错，这里当场红。 */
const cases = [
  { op: 'memory.remember', args: { text: '事实' }, name: 'memory.rememberFact', with: ['事实', { source: 'panel' }] },
  { op: 'memory.editSelf', args: { old: '旧', text: '新' }, name: 'memory.updateSelf', with: ['旧', '新'] },
  { op: 'memory.forgetSelf', args: { text: '一条' }, name: 'memory.forgetSelf', with: ['一条'] },
  { op: 'memory.rememberSelf', args: { text: '一条' }, name: 'memory.rememberSelf', with: ['一条'] },
  { op: 'memory.edit', args: { old: '旧', text: '新' }, name: 'memory.updateFact', with: ['旧', '新'] },
  { op: 'memory.editPerson', args: { uin: '1001', name: '甲', note: 'n', impression: 'i' }, name: 'memory.updatePerson', with: ['1001', { name: '甲', note: 'n', impression: 'i' }] },
  { op: 'memory.editGroup', args: { groupId: '2002', label: '群', topic: '题' }, name: 'memory.updateGroup', with: ['2002', { label: '群', topic: '题' }] },
  { op: 'memory.forget', args: { target: '要删的' }, name: 'memory.forgetFact', with: ['要删的'] },
  { op: 'memory.forgetPerson', args: { uin: '1001' }, name: 'memory.forgetPerson', with: ['1001'] },
  { op: 'memory.forgetGroup', args: { groupId: '2002' }, name: 'memory.forgetGroup', with: ['2002'] },
  { op: 'reminder.cancel', args: { id: 'r1' }, name: 'reminders.cancel', with: ['r1'] },
  { op: 'reminder.update', args: { id: 'r1', text: '提醒', at: 99 }, name: 'reminders.update', with: ['r1', { text: '提醒', at: 99 }] },
  { op: 'approval.decide', args: { id: 'a1', allow: true, remember: 1, reason: 'ok' }, name: 'approvals.decide', with: ['a1', { allow: true, remember: false, reason: 'ok' }] },
  { op: 'approval.forget', args: {}, name: 'approvals.forget', with: [] },
  { op: 'chat.reset', args: {}, name: 'chat.reset', with: [] },
  { op: 'skill.forget', args: { id: 's1' }, name: 'runtime.forgetSkill', with: ['s1'] },
  { op: 'skill.amend', args: { id: 's1', name: '新名' }, name: 'runtime.amendSkill', with: ['s1', { name: '新名', what: undefined, group: undefined }, { actor: 'panel' }] },
  { op: 'skill.teach', args: { name: '技能', what: '做件事' }, name: 'runtime.teachSkill', with: [{ name: '技能', what: '做件事', group: 'do', risk: 'low' }] },
  { op: 'skill.set', args: { id: 's1', on: true, confirm: false }, name: 'runtime.setSkill', with: ['s1', 'on', { confirm: false, actor: 'panel' }] },
]

await check('动作清单就是全部实现，一个不多一个不少', () => {
  assert.equal(ACTION_OPS.length, 22)
  assert.equal(new Set(ACTION_OPS).size, 22, 'op 不能重名')
  const covered = new Set([...cases.map((one) => one.op), 'qq.send', 'qzone.post', 'config.reload'])
  assert.deepEqual([...ACTION_OPS].sort(), [...covered].sort())
})

await check('未知 op 返回 null：写操作绝不猜「最接近」的那个', async () => {
  assert.equal(await runAction('nope', {}, ctx), null)
  assert.equal(await runAction('', {}, ctx), null)
})

for (const one of cases) {
  await check(`${one.op} → ${one.name}，参数原样`, async () => {
    calls.length = 0
    const result = await runAction(one.op, one.args, ctx)
    assert.ok(result, `${one.op} 没返回结果`)
    assert.equal(calls.length, 1, `${one.op} 调了 ${calls.length} 次`)
    assert.equal(calls[0].name, one.name)
    assert.deepEqual(calls[0].args, one.with)
  })
}

await check('memory.forget 兼容 text / target 两种历史字段', async () => {
  calls.length = 0
  await runAction('memory.forget', { text: '旧字段' }, ctx)
  assert.deepEqual(calls[0].args, ['旧字段'])
  calls.length = 0
  await runAction('memory.forget', { target: 'T', text: 'X' }, ctx)
  assert.deepEqual(calls[0].args, ['T'], 'target 优先')
})

await check('skill.set 只认 on === true，字符串 false 不当开', async () => {
  calls.length = 0
  await runAction('skill.set', { id: 's1', on: 'true' }, ctx)
  assert.equal(calls[0].args[1], 'off')
})

await check('qq.send 走同一套出站链，并把发送记进日志', async () => {
  calls.length = 0
  const result = await runAction('qq.send', { conversation: 'private:1001', text: '  你好  ' }, ctx)
  assert.deepEqual(result, { ok: true, text: 'SENT' })
  const say = calls.find((one) => one.name === 'channel.say')
  assert.deepEqual(say.args, ['private', '1001', 'SENT'])
  assert.equal(calls.find((one) => one.name === 'guard.note').args[0], 1234)
  assert.equal(calls.find((one) => one.name === 'runtime.log').args[0], 'panel_send')
})

await check('qq.send 的三个空值/离线保护一个都不能少', async () => {
  assert.equal((await runAction('qq.send', { text: 'x' }, ctx)).ok, false)
  assert.equal((await runAction('qq.send', { conversation: 'private:1001', text: '   ' }, ctx)).ok, false)
  const offline = { ...ctx, channel: { ...ctx.channel, state: () => 'offline' } }
  assert.equal((await runAction('qq.send', { conversation: 'private:1001', text: 'x' }, offline)).ok, false)
})

await check('config.reload 把异步副作用并进响应', async () => {
  const result = await runAction('config.reload', {}, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.login, 'L')
  assert.match(result.message, /M/)
})

await check('chat 没接上时 reset 说人话，不抛异常', async () => {
  const result = await runAction('chat.reset', {}, { ...ctx, chat: null })
  assert.equal(result.ok, false)
  assert.match(result.error, /还没有对话/)
})

console.log(`\n${failed.length ? '✗' : '✓'} 统一写入口用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
