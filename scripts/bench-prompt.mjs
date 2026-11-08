/**
 * scripts/bench-prompt.mjs — 量一下提示词到底有多大。
 *
 * 只看两件事：**字符数** 和 **前缀里有多少能命中缓存**。
 * token 数用「中文 0.62 / 其他 0.28」估，不追求和某家 tokenizer 完全一致 ——
 * 它只用于前后对比，不用于账单。
 *
 * 用法：node scripts/bench-prompt.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrompt, toolResultDigest } from '../turn/index.mjs'
import { createTools } from '../ability/index.mjs'
import { capabilityBrief } from '../truth/index.mjs'
import { styleGuide } from '../voice/index.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DATA = path.join(homedir(), '.dsh', 'shenlan-whale')

const config = {
  persona: { name: '深蓝', verbosity: 'normal', maxParts: 3 },
  identity: { ownerName: '老大' },
  memory: { enabled: true },
  sandbox: { codeMode: 'write' },
  tools: { whitelist: [] },
}
const runtime = {
  config,
  registerTools() {},
  blockedTools() { return new Set() },
  log() {},
}
const tools = createTools({ runtime })
const names = tools.names()
const soulFile = path.join(DATA, 'persona.md')
const soul = existsSync(soulFile) ? readFileSync(soulFile, 'utf8') : '名字：深蓝鲸\n\n## 一、底色\n忠诚，认实力不认嘴皮子。'
const recent = Array.from({ length: 6 }, (_, i) => ({
  from: i % 2 ? 'self' : 'peer',
  name: i % 2 ? '深蓝' : '光',
  text: i % 2 ? '嗯，我在看。' : '你帮我看看这个插件为什么这么大',
  at: Date.now() - (6 - i) * 60_000,
}))
const memory = {
  summary: '主人最近在折腾插件体积与 token 花费，希望不牺牲能力。',
  network: [{ text: '主人提过想把部署副本压到 1.5 MB 以内。' }, { text: '上次聊到上下文缓存按前缀命中。' }],
  facts: [{ text: '主人喜欢喝咖啡，不加糖。' }, { text: '主人在写一个 QQ 人格体插件。' }],
  related: [{ text: '上个月提过一次要清理备份目录。' }],
  self: [{ text: '我说话短，不爱解释。' }],
  person: { name: '光', impression: '一个爱折腾技术的人', notes: ['经常熬夜', '养猫'] },
  group: { label: '深蓝鲸内测群', topics: ['插件体积', 'token 费用'] },
}
const event = { from: '10001', payload: { senderName: '光', text: '在吗' }, tags: [] }

const estimate = (text) => Math.round([...text].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 0.62 : 0.28), 0))
const line = (label, text) => `${label.padEnd(22)} chars=${String([...text].length).padStart(6)}  ~tokens=${String(estimate(text)).padStart(5)}`

function compose(chat, text = '在吗') {
  return buildPrompt({
    event: { ...event, payload: { ...event.payload, text } },
    persona: { ...config.persona, ownerName: config.identity.ownerName },
    soul,
    styleGuide: styleGuide({ channel: 'private', maxParts: 3, verbosity: 'normal' }),
    recent,
    memory,
    toolLine: tools.prompt({ mode: chat ? 'chat' : 'full' }),
    capabilityLine: capabilityBrief({ config, toolNames: names, withTools: false }),
    allowFace: true,
    at: Date.now(),
  })
}

const chatPrompt = compose(true)
const fullPrompt = compose(false, '帮我查一下明天天气')
console.log('提示词预算（当前实现）')
console.log(line('闲聊（在吗）', chatPrompt))
console.log(line('动作（查天气）', fullPrompt))
console.log(line('工具清单·闲聊', tools.prompt({ mode: 'chat' })))
console.log(line('工具清单·全表', tools.prompt()))
console.log(line('能力说明·紧凑', capabilityBrief({ config, toolNames: names, withTools: false })))

// 静态前缀 = 到第一段动态内容（记忆）之前。缓存按前缀命中，这个数越大越省。
const staticEnd = chatPrompt.indexOf('你记得的旧摘要：')
console.log(line('闲聊静态前缀', chatPrompt.slice(0, staticEnd < 0 ? chatPrompt.length : staticEnd)))
console.log(`静态前缀占比：${((staticEnd / chatPrompt.length) * 100).toFixed(0)}%`)

const big = '工具返回的一段正文。'.repeat(200)
const results = Array.from({ length: 4 }, (_, i) => ({
  call: { name: 'code_read', raw: `{"path":"lib/x${i}.mjs"}` },
  called: { ok: true, text: big, data: { path: `lib/x${i}.mjs`, lines: 60 } },
}))
const oldDigest = results.map(({ call, called }, i) => `${i + 1}. ${call.name}(${call.raw}) → ${JSON.stringify(called).slice(0, 1800)}`).join('\n')
const newDigest = toolResultDigest(results)
console.log(line('工具回灌·旧写法', oldDigest))
console.log(line('工具回灌·现在', newDigest))
console.log(`工具回灌下降：${((1 - newDigest.length / oldDigest.length) * 100).toFixed(1)}%`)
