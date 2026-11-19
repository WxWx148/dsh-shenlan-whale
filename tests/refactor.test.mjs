/**
 * 重构验收用例 —— 把「对比结论 / 改版范围 / 体验优化 / 同类项合并 / 预期效果」
 * 里的可验收判据钉住。全部离线，不发网络、不开协议端。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../app/index.mjs'
import { SelfCheckBook } from '../mind/index.mjs'
import { capabilityBrief, CAPABILITY_RULE, SELF_CHECK_RULE, PROGRESS_WORDS } from '../truth/index.mjs'
import { matchIntent, skipWebSearch } from '../decide/index.mjs'
import { digestForward } from '../ability/index.mjs'
import { DEBUG_ITEMS, runDebug } from '../view/index.mjs'
import { NAV_SECTIONS, REGIONS, DETAIL_KIND_LIST } from '../truth/index.mjs'
import { panelView, detailView } from '../view/index.mjs'
import { OneBotChannel } from '../channel/index.mjs'
import { Guard } from '../decide/index.mjs'
import { Usage } from '../facts/index.mjs'
import { Turn } from '../turn/index.mjs'
import { createTools } from '../ability/index.mjs'
import { KIND, SCOPE, SOURCE } from '../facts/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push({ name, err })
    console.log(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readSource = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const fresh = () => new Runtime({ dir: mkdtempSync(path.join(tmpdir(), 'sl-refactor-')) })
const toolNames = ['code_list', 'code_read', 'code_search', 'group_recap', 'who_said', 'my_memory', 'my_status', 'audit_self']

console.log('\n重构验收')

// ── 自查复盘闭环（参考实现「鱼」的做法）──────────────────────────
await check('结构快照不遗漏子目录：父模块里每个 .mjs 都在快照里', () => {
  const snap = JSON.parse(readSource('lib/structure.generated.json'))
  /** 递归列出目录下的代码文件（相对仓库根），派生规则与生成器一致 */
  const walk = (dir) => {
    const out = []
    for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
      const rel = `${dir}/${name}`
      const st = statSync(path.join(ROOT, rel))
      if (st.isDirectory()) out.push(...walk(rel))
      else if (/\.(mjs|js)$/.test(name)) out.push(rel)
    }
    return out
  }
  for (const parent of snap.parents) {
    const onDisk = walk(parent.dir)
    const inSnap = parent.files.map((one) => one.path)
    assert.deepEqual(
      onDisk.filter((one) => !inSnap.includes(one)),
      [],
      `${parent.dir}/ 里有文件没进快照（生成器扫不到子目录？）：${onDisk.filter((one) => !inSnap.includes(one)).join('、')}`,
    )
    assert.deepEqual(
      inSnap.filter((one) => !onDisk.includes(one)),
      [],
      `${parent.dir}/ 快照里有磁盘上没有的文件（改过名没重生成？）`,
    )
  }
})

await check('自查意图：截图里的三句原话都能落到正确的任务上', () => {
  assert.equal(matchIntent('你查一查你代码这部分的问题，给我说结论', toolNames).kind, 'self_check')
  assert.equal(matchIntent('那刚刚那个群的聊天记录你知道里面是什么了嘛', toolNames).kind, 'capability')
  assert.equal(matchIntent('？我要修正你', toolNames).kind, 'correction')
  assert.equal(matchIntent('？你怎么又不说话了是没查完嘛', toolNames).kind, 'progress_query')
  assert.equal(matchIntent('今天天气不错', toolNames), null)
})

await check('自指说法不再被送去联网搜索（白名单空时那等于静默失败）', () => {
  assert.equal(skipWebSearch('你查一下你代码这部分的问题'), true)
  assert.equal(skipWebSearch('查一下你自己的实现'), true)
  assert.equal(skipWebSearch('搜一下最新的新闻'), false)
})

await check('诊断类意图会临时多给几轮工具，且规则要求四段式结论', () => {
  const one = matchIntent('查一查你代码这部分的问题，给我说结论', toolNames)
  assert.ok(one.minRounds >= 4)
  assert.match(one.rule, /现象/)
  assert.match(one.rule, /依据/)
  assert.match(one.rule, /结论/)
  assert.equal(SELF_CHECK_RULE.includes('第 N 轮工具调用'), false)
  assert.match(SELF_CHECK_RULE, /不要出现/, '规则里要明令禁止把过程写进结论')
})

await check('能力事实分三层，且明令禁止把「没看到」说成「不可能」', () => {
  const brief = capabilityBrief({ config: {}, toolNames })
  assert.match(brief, /这场对话/)
  assert.match(brief, /一直记得的/)
  assert.match(brief, /可以现在查的/)
  assert.match(brief, /group_recap/, '跨会话查法要真的列出来')
  assert.match(CAPABILITY_RULE, /不许把/)
  assert.match(CAPABILITY_RULE, /并真的调用/)
})

await check('自查结论账本：同一问题不重复提，标完成状态可查', () => {
  const book = new SelfCheckBook({ dir: mkdtempSync(path.join(tmpdir(), 'sl-check-')) })
  const first = book.propose({ title: '转发读不完', body: '现象：只拿到条数和时间。依据：onebot.getForward。' })
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, false)
  const again = book.propose({ title: '转发读不完', body: '现象：只拿到条数和时间。依据：onebot.getForward。' })
  assert.equal(again.duplicate, true)
  assert.equal(book.summary().pending, 1)
  assert.equal(book.markDone(first.id, 'done', '已修').ok, true)
  assert.equal(book.summary().pending, 0)
  assert.equal(book.summary().done, 1)
  assert.equal(book.list()[0].status, 'done')
})

await check('Runtime 挂上了自查账本与进度状态，进度会过期', () => {
  const runtime = fresh()
  assert.ok(runtime.selfCheck)
  assert.equal(runtime.progressText(), '')
  runtime.setProgress(PROGRESS_WORDS.checking, 'private:10001')
  assert.equal(runtime.progressText(), '正在核对数据')
  runtime.clearProgress('private:10001')
  assert.equal(runtime.progressText(), '')
  runtime.setProgress('正在翻聊天记录', 'private:10001')
  assert.equal(runtime.progressText(Number(runtime.now()) + 61_000), '', '超过一分钟不该一直挂着')
})

// ── 转发数据契约 ────────────────────────────────────────────────
await check('转发节点：纯图片 / @ / 卡片 / 嵌套转发不再被整条丢掉', async () => {
  const fake = {
    async sendRaw() {
      return {
        messages: [
          { sender: { nickname: '阿三' }, time: 1700000000, content: [{ type: 'image', data: { file: 'a' } }] },
          { sender: { nickname: '小四' }, time: 1700000060, content: [{ type: 'at', data: { qq: '10001', name: '阿土' } }, { type: 'text', data: { text: '你看这个' } }] },
          { sender: { nickname: 'ce' }, time: 1700000120, content: [{ type: 'json', data: { data: '{}' } }] },
          { sender: { nickname: '阿五' }, time: 1700000180, content: [{ type: 'forward', data: { id: 'x' } }] },
        ],
      }
    },
  }
  const rows = await OneBotChannel.prototype.getForward.call(fake, 'fw-1', 200)
  assert.equal(rows.length, 4, '一条都不许因为「没有正文」被过滤掉')
  assert.match(rows[0].text, /图片/)
  assert.equal(rows[0].imageItems.length, 1, '转发里的图片本体要带出来，不能只剩一个 [图片]')
  assert.equal(rows[0].imageItems[0].file, 'a')
  assert.match(rows[1].text, /@阿土/)
  assert.match(rows[2].text, /卡片/)
  assert.match(rows[3].text, /嵌套转发/)
  assert.equal(rows.forwardTotal, 4)
  assert.equal(rows.forwardTruncated, false)
})

await check('CQ 字符串形式的 content 也能读出正文，不是只剩条数和时间', async () => {
  const fake = { async sendRaw() { return { messages: [{ sender: { nickname: '阿三' }, time: 1700000000, content: '补偿怎么算[CQ:face,id=1]按 N+1' }] } } }
  const rows = await OneBotChannel.prototype.getForward.call(fake, 'fw-2', 200)
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /补偿怎么算/)
  assert.match(rows[0].text, /表情/)
  assert.match(rows[0].text, /按 N\+1/)
})

await check('转发头部报真实总数，并说明这次只展开了多少', () => {
  const nodes = Array.from({ length: 18 }, (_, i) => ({ sender: '阿三', text: `第${i + 1}条内容`, time: 1700000000 + i * 60 }))
  const digest = digestForward(nodes.slice(0, 5), { maxChars: 3000, total: 18, truncated: false })
  assert.match(digest.text, /共 18 条/)
  assert.match(digest.text, /这次先展开 5 条/)
  assert.equal(digest.nodes, 18)
})

// ── 界面：内部状态零暴露（token 保留）────────────────────────────
await check('主界面文案：轮数 / 权重版本 / 执行器 / 配置键名 / 暂不生效 全部零命中', () => {
  // 只扫「用户看得见的那一行」：注释里解释实现的不算界面暴露。
  const visible = (text) => text.split('\n')
    .filter((line) => /(label|desc|hint|note|subtitle|badge|title|empty)\s*:/.test(line))
    .join('\n')
  const view = visible(readSource('view/panel-view.mjs'))
  const panel = visible(readSource('truth/panel.mjs'))
  const banned = [/第 \$\{[^}]*\} 轮/, /权重版本/, /轮数上限/, /执行器/, /配置项 group\./, /暂不生效/, /每一轮它是怎么想的/]
  for (const re of banned) {
    assert.equal(re.test(view), false, `界面文案里不该出现 ${re}`)
    assert.equal(re.test(panel), false, `配置清单里不该出现 ${re}`)
  }
})

await check('技术名词 token 按用户要求保留', () => {
  const view = readSource('view/panel-view.mjs')
  assert.match(view, /今日 token/)
  assert.match(view, /累计 token/)
  assert.match(view, /每百万 token/)
})

await check('进度与追问深度不再作为可调旋钮暴露，但底层键仍在', () => {
  const view = readSource('view/panel-view.mjs')
  assert.match(view, /HIDDEN_SETTING_KEYS/)
  assert.match(view, /tools\.maxRounds/)
  assert.match(view, /正在核对数据|slj-progress/) // 前端状态条由 client.js 渲染
  const panel = readSource('truth/panel.mjs')
  assert.match(panel, /num\('tools\.maxRounds'/)
  assert.match(panel, /num\('tools\.maxPerRound'/)
})

await check('真实回合：主人让查代码时，能力事实与结论规则进了提示词，且没被送去联网', async () => {
  const base = new Date(2026, 10, 6, 15, 50, 0).getTime()
  const dir = mkdtempSync(path.join(tmpdir(), 'sl-turn-'))
  const runtime = new Runtime({ dir, now: () => base })
  runtime.setConfig('identity.ownerId', '10001', { confirm: true })
  runtime.setConfig('guard.mergeWindowMs', 0, { confirm: false })
  const guard = new Guard({ config: runtime.config, now: () => base })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, now: () => base })
  const channel = { say: async () => ({ message_id: 1 }), sendImage: async () => ({}), getForward: async () => [] }
  const tools = createTools({ runtime, channel, usage, dir })
  const prompts = []
  const turn = new Turn({
    runtime, guard, usage, channel, tools,
    runner: async (prompt) => {
      prompts.push(prompt)
      return { text: '现象：转发读不完。依据：onebot.getForward。结论：段类型被丢。建议：补映射。', usage: { input: 100, output: 20 } }
    },
    sleep: async () => {},
    now: () => base,
  })
  const result = await turn.handle({
    source: SOURCE.CHANNEL, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE,
    from: '10001', text: '你查一查你代码这部分的问题，给我说结论', at: base,
    conversation: 'private:10001', payload: { text: '你查一查你代码这部分的问题，给我说结论' },
  })
  assert.equal(result.ok, true)
  assert.ok(prompts.length >= 1, '至少问过一次模型')
  assert.match(prompts[0], /可以现在查的/, '能力三层要真的进提示词')
  assert.match(prompts[0], /【现象】/, '自查四段式规则要真的进提示词')
  assert.equal(prompts[0].includes('刚查到的网上资料'), false, '自指说法不该被送去搜网页')
  assert.equal(runtime.progressText(base), '', '回合结束后进度状态要撤掉')
})

// ── 同类项合并与调试台 ─────────────────────────────────────────
await check('十个区域收敛到四段，且每个区域只归一段、没有漏掉', () => {
  assert.equal(NAV_SECTIONS.length, 4)
  const seen = NAV_SECTIONS.flatMap((one) => one.regions)
  assert.equal(new Set(seen).size, seen.length, '有区域被归到两段')
  assert.deepEqual(new Set(seen), new Set(REGIONS.map((one) => one.id)))
  const page = panelView({})
  assert.equal(page.navSections.length, 4)
  assert.ok('progress' in page)
})

await check('数据与调试：清单、详情、执行器三处一致，每项都能跑出结果', async () => {
  assert.ok(DETAIL_KIND_LIST.includes('debug'))
  const detail = detailView({ id: 'process.debug' })
  assert.equal(detail.kind, 'debug')
  assert.deepEqual(detail.items.map((one) => one.id), DEBUG_ITEMS.map((one) => one.id))
  const runtime = fresh()
  for (const item of DEBUG_ITEMS) {
    const result = await runDebug(item.id, { runtime, channel: null, usage: null, napcat: null })
    assert.equal(result.ok, true, `${item.id} 跑不起来`)
    assert.ok(Array.isArray(result.rows) && result.rows.length > 0, `${item.id} 没有可看的结果`)
  }
})

await check('界面真的接上了后端核对与重新读取两个入口', () => {
  const client = readSource('lib/client.panel.js')
  assert.match(client, /\/debug\/run/)
  // 重新读取设置已随其余写操作收进 POST /action，路径字面量不再出现在前端；
  // 入口本身还在，查 op 名字更准（R13 会保证这个 op 在动作清单里）。
  assert.match(client, /action\('config\.reload'/)
  assert.match(client, /运行一次/)
  assert.match(client, /重新读取设置/)
})

if (failed.length) {
  console.log(`\n✗ 重构验收：${failed.length} 项失败`)
  for (const { name, err } of failed) console.log(`  · ${name}: ${err?.message ?? err}`)
  process.exit(1)
}
console.log(`\n✓ 重构验收：${passed} 项通过`)
