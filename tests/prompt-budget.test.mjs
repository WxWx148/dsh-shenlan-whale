/**
 * 提示词预算用例。
 *
 * 这几条钉的不是「文案好不好」，而是三件会悄悄变贵的事：
 *   1. 静态块必须排在动态块前面（缓存按前缀命中，顺序错了钱就白花）；
 *   2. 同一句话不能因为落在记忆的两层里就写两遍；
 *   3. 闲聊档只列常用工具，动作类消息仍然拿全表 —— 省 token 不能省掉能力。
 */

import assert from 'node:assert/strict'
import { buildPrompt, needsFullTools, toolResultDigest } from '../turn/index.mjs'
import { createTools } from '../ability/index.mjs'
import { capabilityBrief } from '../truth/index.mjs'

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

const memory = {
  summary: '主人最近在折腾插件体积与 token 花费。',
  network: [{ text: '同一句记忆' }, { text: '联想出来的另一件事' }],
  facts: [{ text: '同一句记忆' }, { text: '主人喜欢喝咖啡' }],
  related: [{ text: '同一句记忆' }],
  self: [{ text: '我说话短' }],
  person: { name: '光', impression: '爱折腾技术', notes: ['经常熬夜'] },
  group: { label: '内测群', topics: ['插件体积'] },
}

await check('闲聊与动作分档：问候走闲聊，动手的话走全表', () => {
  assert.equal(needsFullTools('在吗'), false)
  assert.equal(needsFullTools('哈哈'), false)
  assert.equal(needsFullTools('晚安'), false)
  assert.equal(needsFullTools('帮我查一下明天天气'), true)
  assert.equal(needsFullTools('画一只猫'), true)
  assert.equal(needsFullTools('看看你的代码为什么这么大'), true)
  assert.equal(needsFullTools(''), false)
})

await check('闲聊档少列一半工具，但常用工具一个不少；动作档仍是全表', () => {
  const tools = createTools()
  const all = tools.names()
  const full = tools.prompt()
  const chat = tools.prompt({ mode: 'chat' })
  assert.ok(chat.length < full.length * 0.6, `闲聊档应该明显更短：${chat.length} vs ${full.length}`)
  for (const name of all) assert.ok(full.includes(name), `全表漏了 ${name}`)
  for (const name of ['time', 'calc', 'recall', 'remember_fact', 'send_sticker', 'my_capabilities']) {
    assert.ok(chat.includes(name), `闲聊档漏了常用工具 ${name}`)
  }
  assert.match(full, /code_read/)
  assert.doesNotMatch(chat, /code_read/, '闲聊档不该列自查代码那一组')
})

await check('能力说明在提示词里不重复抄工具名（名字只在工具清单出现一次）', () => {
  const tools = createTools()
  const compact = capabilityBrief({ config: {}, toolNames: tools.names(), withTools: false })
  assert.match(compact, /别的群/)
  assert.match(compact, /自己的代码/)
  assert.doesNotMatch(compact, /group_recap|code_read|my_status|recall/)
  const full = capabilityBrief({ config: {}, toolNames: tools.names() })
  assert.match(full, /group_recap/)
})

await check('静态块排在动态块前面，当前这句话仍然在最后', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    memory,
    toolLine: '可用工具：recall。',
    capabilityLine: '关于你能看到什么：\n· 这场对话。',
    allowFace: true,
  })
  const toolAt = prompt.indexOf('可用工具：recall。')
  const faceAt = prompt.indexOf('[face:id]')
  const memoryAt = prompt.indexOf('你记得的事实：')
  const recentAt = prompt.indexOf('现在是 ')
  assert.ok(toolAt >= 0 && faceAt >= 0 && memoryAt >= 0, '静态块和动态块都要在')
  assert.ok(toolAt < memoryAt, '工具清单要在记忆之前')
  assert.ok(faceAt < memoryAt, '表情表要在记忆之前')
  assert.ok(memoryAt < recentAt, '记忆要在时间锚点之前')
  assert.ok(prompt.trimEnd().endsWith('老王（QQ 20002）说：在吗'), '当前这句话必须留在最后')
})

await check('同一句记忆落在两层里只写一遍', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    memory,
  })
  const hits = prompt.split('同一句记忆').length - 1
  assert.equal(hits, 1, `同一句记忆出现了 ${hits} 次`)
  assert.match(prompt, /主人喜欢喝咖啡/)
})

await check('工具结果回灌：只给正文，不把给界面看的 data 再抄一遍', () => {
  const out = toolResultDigest([{
    call: { name: 'code_read', raw: '{"path":"lib/x.mjs","start":1,"count":60}' },
    called: { ok: true, text: '第一行\n第二行', data: { path: 'lib/x.mjs', lines: 60, secret: '不该出现' } },
  }])
  assert.match(out, /第一行/)
  assert.match(out, /第二行/)
  assert.match(out, /path=lib\/x\.mjs/)
  assert.doesNotMatch(out, /不该出现/)
  assert.match(out, /^1\. code_read/)
})

await check('工具结果回灌有整段上限，失败也写清原因', () => {
  const text = '正'.repeat(2000)
  const results = Array.from({ length: 4 }, (_, i) => ({
    call: { name: 'web_fetch', raw: `{"url":"https://x/${i}"}` },
    called: { ok: true, text, data: { url: `https://x/${i}` } },
  }))
  const out = toolResultDigest(results)
  assert.ok(out.length <= 5700, `整段超上限：${out.length}`)
  const failed = toolResultDigest([{
    call: { name: 'web_search', raw: '{"query":"x"}' },
    called: { ok: false, code: 'net_denied', error: '联网白名单没放行' },
  }])
  assert.match(failed, /失败/)
  assert.match(failed, /net_denied/)
  assert.match(failed, /联网白名单没放行/)
})

await check('闲聊提示词比动作提示词短，但人格、记忆、当前这句话都在', () => {
  const base = {
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝', ownerName: '老大' },
    soul: '这是灵魂文件里的人格设定。'.repeat(20),
    styleGuide: '说话按聊天来，不按文章来：',
    memory,
    recent: [{ from: 'self', text: '刚在' }],
    capabilityLine: capabilityBrief({ config: {}, toolNames: ['recall'], withTools: false }),
    allowFace: true,
  }
  const tools = createTools()
  const chat = buildPrompt({ ...base, toolLine: tools.prompt({ mode: 'chat' }) })
  const full = buildPrompt({ ...base, toolLine: tools.prompt() })
  assert.ok(chat.length < full.length * 0.85, `闲聊档应短于动作档：${chat.length} vs ${full.length}`)
  assert.match(chat, /这是灵魂文件里的人格设定/)
  assert.match(chat, /主人喜欢喝咖啡/)
  assert.match(chat, /老王（QQ 20002）说：在吗/)
})

console.log(`\n${failed.length ? '✗' : '✓'} 提示词预算用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
