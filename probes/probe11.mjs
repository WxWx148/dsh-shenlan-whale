/**
 * 联调探针 11：不起 DSH，把插件装进一个假宿主，验证面板与新增路由真的能跑通。
 *
 * 单元测试各测各的函数，只有装进假宿主才能确认「路由层接对了没有」。
 * 这里刻意用最苛刻的环境：宿主不给生成器、QQ 也没连上 —— 这两条降级路径
 * 一旦没接对，真机上表现就是「点独立对话白屏」「在 QQ 界面发消息没反应」。
 * 通过标准：所有请求都返回结构化 JSON，且没有把异常/空转塞进 notices。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { REGIONS } from '../lib/taxonomy.mjs'
import { readonlyItems } from '../lib/panel.mjs'
import { saveImageBytes } from '../lib/media.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-probe11-'))
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channel: { enabled: false } }), 'utf8')
process.env.SHENLAN_DATA_DIR = dir

const { apply } = await import('../index.js')

let handler = null
const effects = []
const ctx = {
  logger: { info() {}, error() {} },
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
}
apply(ctx)

// wire() 是异步的（要 await 生成器），让出一次事件循环，别在半初始化状态下断言
await new Promise((resolve) => setImmediate(resolve))

/**
 * 只取原始响应：图片路由回的是字节，不能当 JSON 解。
 * 其余路由都回 JSON，所以这里单独开一个，不去改 call 的返回形状。
 */
function callRaw(pathname, method = 'GET') {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        if (headers) this.headers = headers
      },
      end(raw) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw === undefined ? '' : raw)),
        })
      },
    }
    const req = { method, url: pathname, on() {} }
    handler(req, res)
  })
}

function call(pathname, method = 'GET', body) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(raw) {
        resolve({ status: this.status, body: JSON.parse(raw) })
      },
    }
    const req = {
      method,
      url: pathname,
      on(event, cb) {
        if (event === 'end') {
          if (body !== undefined) {
            this._data?.(JSON.stringify(body))
            cb()
          } else cb()
        }
        if (event === 'data') this._data = cb
        if (event === 'error') this._error = cb
      },
    }
    handler(req, res)
  })
}

const failures = []
function ok(cond, label, detail) {
  if (cond) {
    console.log('  ok   ' + label + (detail ? '  <-- ' + detail : ''))
  } else {
    failures.push(label)
    console.log('  FAIL ' + label + (detail ? '  <-- ' + detail : ''))
  }
}

console.log('— 1. 面板骨架 —')
const panel = await call('/api/shenlan/panel')
ok(panel.status === 200 && panel.body.ok === true, 'GET /panel 返回 200 且 ok', `status=${panel.status}`)
ok(Array.isArray(panel.body.notices) && panel.body.notices.length === 0, '没有分区算崩（notices 为空）', JSON.stringify(panel.body.notices))
const navIds = (panel.body.nav || []).map((item) => item.id)
// 顺序以 lib/taxonomy.mjs 为唯一来源 —— 探针不再写死一份清单，
// 否则「代码改了、探针还是老的」会像上次那样把红的说成绿的。
ok(JSON.stringify(navIds) === JSON.stringify(REGIONS.map((one) => one.id)), '分区顺序与 taxonomy.REGIONS 一致', navIds.join('/'))
const regionIds = Object.keys(panel.body.regions || {})
ok(
  regionIds.length === REGIONS.length && regionIds.every((id) => Array.isArray(panel.body.regions[id].modules) && panel.body.regions[id].modules.length > 0),
  `${REGIONS.length} 个区域都带模块数组`,
  regionIds.join('/'),
)
const settingsModules = (panel.body.regions.settings?.modules || []).map((one) => one.detail)
ok(settingsModules.includes('settings.channel'), '设置页不再漏掉「QQ 连接」', settingsModules.join('/'))

console.log('— 2. 详情：每个入口点得开、且说真话 —')
const local = await call('/api/shenlan/detail?id=talk.local')
ok(local.body.kind === 'chat' && local.body.chat && local.body.chat.canSend === false, '独立对话：没给生成器时只读并说明原因', local.body.chat?.disabledReason)
const audit = await call('/api/shenlan/detail?id=process.audit')
ok(audit.body.kind === 'rows' && Array.isArray(audit.body.rows), '审计日志：空账本也返回列表结构')
const sandbox = await call('/api/shenlan/detail?id=process.sandbox')
ok(sandbox.body.kind === 'cards' && /执行器/.test(sandbox.body.notice || '') && !/还没写/.test(sandbox.body.notice || ''), '沙箱：报执行器真实状态，不再说「还没写」', sandbox.body.notice)
const skills = await call('/api/shenlan/detail?id=skills.all')
ok(skills.body.kind === 'rows' && Array.isArray(skills.body.rows), '技能清单：点得开')
// 线上踩过：教进来的名字存成 "????"，面板上就是一张谁也认不出的卡。
// 这类条目不该混在正常清单里当没事人 —— 要么改好，要么明确标成乱码。
const brokenRows = (skills.body.rows || []).filter((row) => /^[?\uFFFD？]{2,}$/.test(String((row.skill && row.skill.name) || '')))
ok(brokenRows.length === 0, '技能清单：没有被编码坏成问号的条目', brokenRows.map((row) => row.id).join('、') || '干净')
const allStatus = await call('/api/shenlan/detail?id=status.all')
ok(
  allStatus.body.kind === 'cards' && (allStatus.body.cards || []).length === readonlyItems().length,
  '状态全表：登记的每一项都有一张牌',
  `${(allStatus.body.cards || []).length} / ${readonlyItems().length}`,
)

console.log('— 3. 两个对话界面的接口 —')
const chatGet = await call('/api/shenlan/chat')
ok(chatGet.status === 200 && Array.isArray(chatGet.body.rows), 'GET /chat 返回历史数组')
const chatPost = await call('/api/shenlan/chat', 'POST', { text: '在吗' })
ok(chatPost.status === 200 && typeof chatPost.body.ok === 'boolean', 'POST /chat 有结构化回执（不因无生成器抛 500）', JSON.stringify(chatPost.body).slice(0, 80))
const qqSend = await call('/api/shenlan/qq/send', 'POST', { conversation: 'private:1001', text: '你好' })
ok(qqSend.status === 200 && qqSend.body.ok === false, 'QQ 未连时发消息被拒且说清原因', qqSend.body.error)
const qqEmpty = await call('/api/shenlan/qq/send', 'POST', { conversation: 'private:1001', text: '   ' })
ok(qqEmpty.body.ok === false, '空消息不发出去')

console.log('— 3.4 日志口径与记忆改写 —')
const auditWide = await call('/api/shenlan/detail?id=process.audit&level=debug')
ok(auditWide.body.filter && auditWide.body.filter.level === 'debug', '审计：页面上按级别筛能压过设置里的默认', auditWide.body.filter?.level)
const auditStrict = await call('/api/shenlan/detail?id=process.audit&level=error')
ok(/一条没删/.test(auditStrict.body.subtitle || ''), '审计：筛掉内容时明说「磁盘上一条没删」', auditStrict.body.subtitle)
const selfAdd = await call('/api/shenlan/memory/remember-self', 'POST', { text: '探针写的一条自我记忆' })
ok(selfAdd.body.ok === true, '记忆：自我记忆能写（撤销要用这条路）', selfAdd.body.error)
const selfDel = await call('/api/shenlan/memory/forget-self', 'POST', { text: '探针写的一条自我记忆' })
ok(selfDel.body.ok === true, '记忆：写进去的能删掉，不留垃圾', selfDel.body.error)

console.log('— 3.5 引用原文与群名 —')
const msgNoId = await call('/api/shenlan/message')
ok(msgNoId.status === 200 && msgNoId.body.ok === false && /id/.test(msgNoId.body.error || ''), 'GET /message 缺 id 时说清缺什么', msgNoId.body.error)
const msgGone = await call('/api/shenlan/message?conversation=group:2002&id=m-404')
ok(msgGone.status === 200 && msgGone.body.ok === false && /查不到|不在线/.test(msgGone.body.error || ''), 'GET /message 查不到时不假装成功', msgGone.body.error)
const qqDetail = await call('/api/shenlan/detail?id=qq:group:2002')
ok(qqDetail.body.kind === 'chat' && /群/.test(qqDetail.body.title || ''), '群会话详情：没有群名时退回群号，标题不空着', qqDetail.body.title)

console.log('— 3.6 工具与技能的归属 —')
const policy = await call('/api/shenlan/policy')
const toolRows = policy.body.tools || []
ok(toolRows.length >= 40, 'GET /policy 给出工具表', String(toolRows.length))
ok(toolRows.every((row) => row.name && row.skill), '每个工具都写着它属于哪一项技能', (policy.body.unowned || []).join('、'))
ok((policy.body.unowned || []).length === 0, '没有「跑得动却没人管」的工具', (policy.body.unowned || []).join('、'))

console.log('— 3.7 图片本体路由 —')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const stored = saveImageBytes(dir, png)
ok(stored.ok, '图片按内容落盘', stored.name)
const got = await callRaw('/api/shenlan/media/' + stored.name)
ok(got.status === 200, 'GET /media/<名字> 能取回图片', String(got.status))
ok(String(got.headers['content-type'] || '') === 'image/png', '内容类型是 image/png', String(got.headers['content-type'] || ''))
ok(Buffer.isBuffer(got.body) && got.body.equals(png), '回来的字节和存进去的一致', String(got.body.length))
const escaped = await callRaw('/api/shenlan/media/' + encodeURIComponent('../config.json'))
ok(escaped.status === 404, '想用 ../ 读配置被拒', String(escaped.status))

console.log('— 3.8 配置重载（改了磁盘不用重启）—')
const reloadRes = await call('/api/shenlan/config/reload', 'POST', {})
ok(reloadRes.status === 200, 'POST /config/reload 返回 200', String(reloadRes.status))
ok(reloadRes.body?.ok === true, '重载成功', JSON.stringify(reloadRes.body || {}).slice(0, 140))
// 重载出来的值必须是毫秒级的：秒回是风控最敏感的行为特征
const guardPage = await call('/api/shenlan/detail?id=settings.guard')
const firstDelay = (guardPage.body?.form?.items || []).find((i) => i.key === 'guard.firstDelayMs')
ok(Number(firstDelay?.value) >= 300, `首条延迟是毫秒级（${firstDelay?.value}ms）`, String(firstDelay?.value))
ok(Number(firstDelay?.scale) === 1000, '换算比例一起下发了，前端才知道按秒显示')

console.log('— 4. 基础路由与兜底 —')
const status = await call('/api/shenlan/status')
ok(status.status === 200 && typeof status.body.status === 'object', 'GET /status 返回状态对象')
const unknown = await call('/api/shenlan/nope')
ok(unknown.status === 404, '未知路由返回 404')

// 收尾：把假宿主起的 effect 停掉，别泄漏定时器/句柄
for (const dispose of effects) {
  try {
    if (typeof dispose === 'function') dispose()
  } catch {
    // 探针收尾失败不算功能问题
  }
}

console.log(`\n${failures.length ? '✗' : '✓'} 探针 11：${failures.length} 项有问题`)
if (failures.length) {
  for (const one of failures) console.error('   - ' + one)
  process.exit(1)
}
