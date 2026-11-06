import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { cleanReply, createHostRunner, resolveModel, sessionIdOf, workspaceOf } = await import('../lib/host.mjs')

let passed = 0
async function check(name, fn) {
  try { await fn(); passed += 1 } catch (e) { console.error('✗ ' + name); throw e }
}

function fakeCtx(chunks, selection = { provider: 'deepseek', model: 'deepseek-chat' }) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'llm') return { stream(options) { calls.push(options); return (async function* () { for (const c of chunks) yield c })() } }
        if (name === 'agentDefaultModel') return { currentSelection: () => selection }
        return null
      },
    },
  }
}

await check('模型：跟随当前选择并拼接文本/usage', async () => {
  const { ctx, calls } = fakeCtx([
    { type: 'text-delta', text: '你' },
    { type: 'text-delta', text: '好' },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
    { type: 'finish', kind: 'stop' },
  ])
  const runner = await createHostRunner({ ctx })
  assert.equal(typeof runner, 'function')
  const result = await runner('在吗', { conversation: 'private:1' })
  assert.equal(result.text, '你好')
  assert.deepEqual(result.usage, { input: 12, output: 3 })
  assert.equal(calls[0].provider, 'deepseek')
  assert.equal(calls[0].model, 'deepseek-chat')
  assert.match(calls[0].system, /深蓝鲸/)
})

await check('模型：面板 provider/model 优先', async () => {
  const { ctx, calls } = fakeCtx([{ type: 'text-delta', text: 'ok' }, { type: 'finish', kind: 'stop' }])
  const runner = await createHostRunner({ ctx, config: { modelProvider: 'p', model: 'm' } })
  await runner('x')
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].model, 'm')
})

await check('模型：没有 llm 服务返回 null，不炸插件', async () => {
  const runner = await createHostRunner({ ctx: { get: () => null } })
  assert.equal(runner, null)
})

await check('模型：finish error 变成可读错误', async () => {
  const { ctx } = fakeCtx([{ type: 'finish', kind: 'error', failure: { code: 'AUTH', message: 'key 不对' } }])
  const runner = await createHostRunner({ ctx })
  await assert.rejects(() => runner('x'), /key 不对/)
})

await check('reasoning/thinking 分片不进正文', async () => {
  const { ctx } = fakeCtx([
    { type: 'reasoning-delta', text: '分析不能发' },
    { type: 'text-delta', text: '好' },
    { type: 'finish', kind: 'stop' },
  ])
  const runner = await createHostRunner({ ctx })
  assert.equal((await runner('x')).text, '好')
})

await check('括号思考不进入正文', () => {
  assert.equal(cleanReply('（想了想）\n（再说一句）你好呀'), '你好呀')
  assert.equal(cleanReply('（只剩思考）'), '')
})

await check('sessionId 稳定且区分会话', () => {
  assert.equal(sessionIdOf('a'), sessionIdOf('a'))
  assert.notEqual(sessionIdOf('a'), sessionIdOf('b'))
})

await check('工作区路径指向沙箱真的会建的那个目录（不是没人建的空路径）', async () => {
  const { Sandbox } = await import('../lib/sandbox.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'host-ws-'))
  const sandbox = new Sandbox({ dir, runtime: { dir, config: { sandbox: {} }, log: () => {} }, sourceRoot: '' })
  // 以前这里返回 <dir>/workspace，而全仓没有任何一行 mkdir 过它 ——
  // 于是「工作目录」永远是不存在的目录，读它只会得到「只能读工作目录里的文件」。
  assert.equal(workspaceOf(dir), sandbox.workspace, '两处说的工作区必须是同一个')
  assert.equal(existsSync(workspaceOf(dir)), true, '沙箱建好之后，这个路径必须真的在')
  rmSync(dir, { recursive: true, force: true })
})

console.log('✓ 模型直连用例全部通过：' + passed + ' 项')
