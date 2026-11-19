// layers-guard: ignore —— 这份文件必须写出 send_private_msg 才能断言动作名对不对
/**
 * 通道用例。
 *
 * 通道层最怕「格式翻译错了但不报错」：程序照跑，只是他/她不回话。
 * 所以这里拿真实 OneBot 事件的形状喂 toRaw，逐字段断言；
 * 再用一个假 socket 走一遍收与发，确认 echo 能对上、自己说的话会被丢掉。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OneBotChannel, friendlySendError, toRaw } from '../channel/index.mjs'
import { KIND, SCOPE } from '../facts/index.mjs'

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

const SELF = '10000'
const T0 = new Date(2026, 9, 29, 14, 0, 0).getTime() / 1000

const groupMsg = (over = {}) => ({
  post_type: 'message',
  message_type: 'group',
  time: T0,
  self_id: Number(SELF),
  message_id: 123,
  group_id: 555,
  user_id: 20001,
  sender: { card: '老王', nickname: '老王' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

await check('群消息：范围、发件人、文本都对得上', () => {
  const raw = toRaw(groupMsg(), { selfId: SELF })
  assert.equal(raw.scope, SCOPE.GROUP)
  assert.equal(raw.kind, KIND.MESSAGE)
  assert.equal(raw.from, '20001')
  assert.equal(raw.text, '在吗')
  assert.equal(raw.payload.groupId, '555')
  assert.equal(raw.at, T0 * 1000)
})

await check('@我：认出 atMe，但不把 @ 文本当成正文', () => {
  const raw = toRaw(groupMsg({ message: [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 帮我看看' } },
  ] }), { selfId: SELF })
  assert.equal(raw.atMe, true)
  assert.equal(raw.atAll, false)
  assert.equal(raw.text, '帮我看看')
})

await check('@全体：不算 @我（这两个必须分开，否则等于每次都被叫到）', () => {
  const raw = toRaw(groupMsg({ message: [
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: '通知一下' } },
  ] }), { selfId: SELF })
  assert.equal(raw.atAll, true)
  assert.equal(raw.atMe, false)
})

await check('自己发的消息必须丢掉（否则会自己回自己）', () => {
  const raw = toRaw(groupMsg({ user_id: Number(SELF) }), { selfId: SELF })
  assert.equal(raw, null)
})

await check('只发图没文字：类型是 image，并标了 hasImage', () => {
  const raw = toRaw(groupMsg({ message: [{ type: 'image', data: { file: 'a.jpg' } }] }), { selfId: SELF })
  assert.equal(raw.kind, KIND.IMAGE)
  assert.equal(raw.hasImage, true)
  assert.equal(raw.text, '')
})

await check('纯 @ 没有正文也要记下来（被叫到却当没发生最糟）', () => {
  const raw = toRaw(groupMsg({ message: [{ type: 'at', data: { qq: SELF } }] }), { selfId: SELF })
  assert.ok(raw, '不该被丢掉')
  assert.equal(raw.atMe, true)
  assert.equal(raw.text, '')
})

await check('只引用、不打字也要记下来，并带上引用摘要', () => {
  const raw = toRaw(groupMsg({ message: [{ type: 'reply', data: { id: '70001', content: '被引用的原话' } }] }), { selfId: SELF })
  assert.ok(raw, '只引用的消息不能整条丢')
  assert.equal(raw.payload.replyId, '70001')
  assert.equal(raw.payload.replySummary, '被引用的原话')
  assert.equal(raw.kind, KIND.MESSAGE)
})

await check('字符串模式的 CQ 码也认（NapCat 两种格式都会发）', () => {
  const raw = toRaw(groupMsg({ message: `[CQ:at,qq=${SELF}] 你好[CQ:image,file=b.png]` }), { selfId: SELF })
  assert.equal(raw.atMe, true)
  assert.equal(raw.hasImage, true)
  assert.equal(raw.text, '你好')
})

await check('私聊：范围是 private，没有群号', () => {
  const raw = toRaw({
    post_type: 'message', message_type: 'private', time: T0, user_id: 20002,
    message: [{ type: 'text', data: { text: '悄悄话' } }],
  }, { selfId: SELF })
  assert.equal(raw.scope, SCOPE.PRIVATE)
  assert.equal(raw.payload.groupId, '')
})

await check('心跳进流程，但不是消息（不该触发回话）', () => {
  const raw = toRaw({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: T0, status: { online: true } }, { selfId: SELF })
  assert.equal(raw.kind, KIND.HEARTBEAT)
})

await check('不认识的类型、脏包一律返回 null（不抛异常）', () => {
  assert.equal(toRaw(null), null)
  assert.equal(toRaw({ post_type: 'notice' }), null)
  assert.equal(toRaw({ post_type: 'request' }), null)
  assert.equal(toRaw({ post_type: 'message', message: [] }), null)
})

await check('戳一戳与入群申请不再被丢掉：翻成通知，带齐后面要用的字段', () => {
  // 以前这两类事件在这里就被 return null 吞了，系统里查不到任何痕迹。
  const poke = toRaw({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 20002, time: 1 })
  assert.equal(poke.kind, KIND.NOTICE)
  assert.equal(poke.payload.notice, 'poke')
  assert.equal(poke.payload.subType, 'poke')
  assert.equal(poke.payload.pokeMe, true, '空 target 也按戳自己处理')
  assert.equal(poke.from, '20002')

  const ask = toRaw({ post_type: 'request', flag: 'f-1', sub_type: 'group', group_id: 30001, user_id: 20002, comment: '拉你进群', time: 1 })
  assert.equal(ask.kind, KIND.NOTICE)
  assert.equal(ask.scope, SCOPE.GROUP)
  assert.equal(ask.payload.request.flag, 'f-1')
  assert.equal(ask.payload.request.comment, '拉你进群')

  // 好友申请走私聊范围：判错范围会让它把陌生人当成群友
  const friend = toRaw({ post_type: 'request', flag: 'f-2', sub_type: 'friend', user_id: 20003, time: 1 })
  assert.equal(friend.scope, SCOPE.PRIVATE)
})

/** 假 socket：能记录发出去的帧，也能模拟服务端推消息 */
function fakeSocket() {
  const listeners = {}
  const sent = []
  return {
    listeners,
    sent,
    addEventListener(type, fn) {
      listeners[type] = fn
    },
    send(data) {
      sent.push(JSON.parse(data))
    },
    close() {
      listeners.close?.({})
    },
    emit(type, payload) {
      listeners[type]?.({ data: JSON.stringify(payload) })
    },
    open() {
      listeners.open?.({})
    },
  }
}

await check('连上之后状态是 online；断开是 offline', () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', selfId: SELF } },
    open: () => socket,
  })
  channel.start()
  socket.open()
  assert.equal(channel.state(), 'online')
  channel.stop()
  assert.equal(channel.state(), 'off')
})

await check('掉线重连不再刷「还没连上」：状态只在 offline 上待着', async () => {
  // 真实日志里 22377 条审计（93%）都是通道状态，全是 offline ↔ unknown 反复跳：
  // 每次退避重连都先报 unknown 再报 offline。这条钉住「重连只报 offline」。
  const states = []
  const runtime = { markChannel: (state) => states.push(state) }
  let socket = null
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } },
    runtime,
    open: () => {
      socket = fakeSocket()
      return socket
    },
  })
  channel.start()
  socket.open()
  assert.equal(channel.state(), 'online')
  assert.deepEqual(states, ['unknown', 'online'], '首次连接：先说正在连，再说在线')
  socket.listeners.close?.({})
  assert.equal(channel.state(), 'offline')
  assert.deepEqual(states, ['unknown', 'online', 'offline'])
  // 等第一次退避重连（1s）跑完：重连期间不该再冒出一个 unknown
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.deepEqual(states, ['unknown', 'online', 'offline'], '重连又把状态刷回「还没连上」了')
  channel.stop()
})

await check('发一条私聊：动作名、参数、echo 都对', async () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } },
    open: () => socket,
  })
  channel.start()
  socket.open()
  const promise = channel.say('private', '20002', '嗯')
  await Promise.resolve()
  assert.equal(socket.sent[0].action, 'send_private_msg')
  assert.equal(socket.sent[0].params.user_id, 20002, '号码按数字发，OneBot 接口要的是 number')
  assert.equal(socket.sent[0].params.message, '嗯')
  socket.emit('message', { echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { message_id: 1 } })
  const data = await promise
  assert.equal(data.message_id, 1)
})

await check('发群消息走 send_group_msg（scope 决定接口）', async () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } },
    open: () => socket,
  })
  channel.start()
  socket.open()
  channel.say('group', '555', '好').catch(() => {})
  await Promise.resolve()
  assert.equal(socket.sent[0].action, 'send_group_msg')
  assert.equal(socket.sent[0].params.group_id, 555)
})

await check('群聊引用回复：replyTo 会变成 reply 段，放在正文前', async () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } },
    open: () => socket,
  })
  channel.start()
  socket.open()
  const promise = channel.say('group', '555', '同意，两码事', { replyTo: '123456' })
  await Promise.resolve()
  const message = socket.sent[0].params.message
  assert.ok(Array.isArray(message), '带引用时必须发消息段数组')
  assert.deepEqual(message[0], { type: 'reply', data: { id: '123456' } })
  assert.equal(message[1].type, 'text')
  assert.equal(message[1].data.text, '同意，两码事')
  socket.emit('message', { echo: socket.sent[0].echo, status: 'ok', retcode: 0, data: { message_id: 2 } })
  await promise
})

await check('通道返回失败：promise 要 reject，不能静默当成功', async () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } },
    open: () => socket,
  })
  channel.start()
  socket.open()
  const promise = channel.say('private', '20002', '在')
  await Promise.resolve()
  socket.emit('message', { echo: socket.sent[0].echo, status: 'failed', retcode: 100, wording: '风控' })
  await assert.rejects(promise, /风控/)
})

await check('收到消息事件会交给 onRaw；自己发的不交', () => {
  const socket = fakeSocket()
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', selfId: SELF } },
    open: () => socket,
  })
  const got = []
  channel.onRaw = (raw) => got.push(raw)
  channel.start()
  socket.open()
  socket.emit('message', groupMsg())
  socket.emit('message', groupMsg({ user_id: Number(SELF) }))
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '在吗')
})

await check('引用原文：get_msg 返回字符串 CQ 码也认得', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x' } } })
  channel.sendRaw = async () => ({ message: '[CQ:reply,id=1]被引用的原话[CQ:image,file=x.jpg]', sender: { card: '老李' } })
  const got = await channel.getMessage('1')
  assert.equal(got.ok, true)
  assert.equal(got.text, '被引用的原话')
  assert.equal(got.images.length, 1)
  assert.equal(got.sender, '老李')
})

await check('引用图：get_msg 取不到时从本会话历史补回图片', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x' } } })
  channel.sendRaw = async (action) => {
    if (action === 'get_msg') throw new Error('等通道回应超时')
    if (action === 'get_group_msg_history') {
      return {
        messages: [{
          message_id: 7336284,
          time: Math.floor(T0 / 1000),
          user_id: 400000002,
          sender: { card: '饕餮龙弑' },
          message: [{ type: 'image', data: { file: 'quote.jpg', url: 'https://example.com/quote.jpg' } }],
        }],
      }
    }
    throw new Error('unknown action ' + action)
  }
  const got = await channel.getMessage('7336284', { conversation: 'group:300000001' })
  assert.equal(got.ok, true)
  assert.equal(got.source, 'history')
  assert.equal(got.images.length, 1)
  assert.equal(got.images[0].file, 'quote.jpg')
  assert.equal(got.sender, '饕餮龙弑')
})

await check('加群请求：同意/拒绝都走 set_group_add_request，flag 原样带回去', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x' } } })
  const seen = []
  channel.sendRaw = async (action, params) => { seen.push({ action, params }); return {} }
  await channel.setGroupRequest('flag-abc', true, 'invite')
  await channel.setGroupRequest('flag-def', false, 'add')
  assert.deepEqual(seen, [
    { action: 'set_group_add_request', params: { flag: 'flag-abc', sub_type: 'invite', approve: true } },
    { action: 'set_group_add_request', params: { flag: 'flag-def', sub_type: 'add', approve: false } },
  ])
})

await check('语音转文字走 QQ 原生 fetch_ptt_text，message_id 必须是数字', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x' } } })
  let seen = null
  channel.sendRaw = async (action, params) => {
    seen = { action, params }
    return { text: '能识别出我说了什么吗？' }
  }
  const got = await channel.getVoiceText('715166282')
  assert.deepEqual(seen, { action: 'fetch_ptt_text', params: { message_id: 715166282 } })
  assert.equal(got.ok, true)
  assert.equal(got.text, '能识别出我说了什么吗？')
})

await check('历史消息：群消息拉回来并归一化，自己的发言剔掉', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x', selfId: SELF } } })
  channel.selfId = SELF
  channel.sendRaw = async (action) => {
    if (action === 'get_group_msg_history') {
      return {
        messages: [
          { message_id: 11, time: T0, user_id: 20001, sender: { card: '老王' }, message: [{ type: 'text', data: { text: '补一句' } }] },
          { message_id: 12, time: T0 + 1, user_id: Number(SELF), sender: {}, message: [{ type: 'text', data: { text: '自己' } }] },
        ],
      }
    }
    throw new Error('unknown action ' + action)
  }
  const list = await channel.getHistory('group:555', { count: 10 })
  assert.equal(list.length, 1)
  assert.equal(list[0].messageId, '11')
  assert.equal(list[0].text, '补一句')
  assert.equal(list[0].groupId, '555')
})

await check('重连回调带出空档：第一次 since=0，断线再连带上掉线时间', () => {
  const socket = fakeSocket()
  let clock = 1_000
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://x', selfId: SELF } },
    open: () => socket,
    now: () => clock,
  })
  const seen = []
  channel.onReconnect = (info) => seen.push(info)
  channel.start()
  socket.open()
  clock = 5_000
  socket.close()
  clock = 9_000
  // 真实世界里重连会建一条新 socket，这里用同一个假对象模拟；
  // 但必须先把退避定时器摘掉再补一脚 —— 通道现在会拒绝「对着已经关掉的 socket 重放 open」。
  clearTimeout(channel.retryTimer)
  channel.retryTimer = null
  channel.ensureRetrying()
  socket.open()
  assert.equal(seen.length, 2)
  assert.equal(seen[0].first, true)
  assert.equal(seen[0].since, 0)
  assert.equal(seen[1].first, false)
  assert.equal(seen[1].since, 5_000)
  assert.equal(seen[1].ms, 4_000)
  channel.stop()
})

await check('没填地址：启动失败但给得出原因，不是静默不动', () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: '' } } })
  const result = channel.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /地址/)
})

await check('没连上就发：明确拒绝，不排队假装成功', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: false, wsUrl: 'ws://x' } } })
  // 0.33.0 起这句话翻成了人话（原文「还没连上通道」只说现象，不说去哪处理），
  // 但语义没变：直接拒绝，不假装成功、不排队。
  await assert.rejects(channel.say('private', '1', '在'), /QQ 连接|连接断了/)
})

await check('等回执超时：消息进 outbox，重连后补发，不是直接丢', async () => {
  const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://x' } } })
  channel.stopped = false
  channel.sendRaw = async () => { throw new Error('等通道回应超时') }
  channel.state = () => 'offline'
  const result = await channel.say('group', '555', '刚才想太久了，没接上')
  assert.equal(result.ok, true)
  assert.equal(result.queued, true)
  assert.equal(channel.outbox.length, 1)
  assert.equal(channel.outbox[0].params.group_id, 555)
})

await check('群名缓存：问过一次就记住，并落盘（下次启动不必先给你看群号）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-groups-'))
  try {
    const runtime = { dir, markChannel: () => {} }
    const channel = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } }, runtime })
    channel.sendRaw = async (action) => (action === 'get_group_list' ? [{ group_id: 2002, group_name: '观鸟小分队' }] : [])
    assert.equal(channel.groupNameOf('2002'), '', '还没问过就是空的，不能编')
    const list = await channel.groupList()
    assert.equal(list.length, 1)
    assert.equal(channel.groupNameOf('2002'), '观鸟小分队')
    assert.ok(existsSync(path.join(dir, 'groups.json')), '要落盘，否则重启后面板又只剩群号')

    // 新实例（相当于重启）能直接把名字读出来
    const again = new OneBotChannel({ config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001' } }, runtime })
    assert.equal(again.groupNameOf('2002'), '观鸟小分队')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('群名刷新：不在线就不发请求，只吃缓存', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-groups2-'))
  try {
    const channel = new OneBotChannel({ config: { channel: { enabled: false, wsUrl: 'ws://127.0.0.1:3001' } }, runtime: { dir, markChannel: () => {} } })
    let asked = 0
    channel.sendRaw = async () => { asked += 1; return [] }
    const off = await channel.refreshGroups({ force: true })
    assert.equal(off.ok, false)
    assert.equal(asked, 0, '通道关着还去问协议端，只会白等 8 秒')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('发送失败翻译：QQ 内核拒绝，要说清该动账号还是动群设置', () => {
  // 用户截图里那条就是这一类：NTEvent / sendMsg / {"result":100651}。
  // 原样贴给人只会得到「发送失败：事件检查器失败：……」—— 既看不出是账号问题，也不知道下一步做什么。
  const nt = friendlySendError(new Error('事件检查器失败：NTEvent 服务和方法：NodeIKernelMsgService/sendMsg 监听器名称：NodeIKernelMsgListener/onMsgInfoListUpdate 事件返回值：{"result":100651}'))
  assert.match(nt, /QQ 内核/, '要说清是 QQ 那一层拒的')
  assert.match(nt, /100651/, '码要留着，查资料要用')
  assert.match(nt, /手机 QQ/, '必须给一个能自己做的最小验证')
  assert.match(nt, /aq\.qq\.com/, '账号级限制要给解限入口')
  assert.equal(/NodeIKernelMsgService/.test(nt), false, '别把原始英文再甩回来')

  assert.match(friendlySendError(new Error('还没连上通道')), /QQ 连接/, '链路层要说去哪看')
  assert.match(friendlySendError(new Error('你已被禁言')), /禁言/)
  assert.match(friendlySendError(new Error('对方把你拉黑了')), /拉黑/)
  assert.match(friendlySendError(new Error('something odd happened')), /something odd/, '不认识的错要保留原文，别瞎猜')
})

await check('发送失败留痕：审计里有 send_failed、result 码和目标', async () => {
  // 面板上那条红字一闪就没了。事后要回答「什么时候开始不行、是所有群还是某一个」只能靠审计。
  const socket = fakeSocket()
  const logs = []
  const channel = new OneBotChannel({
    config: { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', selfId: SELF } },
    runtime: { log: (kind, detail) => logs.push({ kind, detail }), markChannel: () => {} },
    open: () => socket,
  })
  channel.start()
  socket.open()

  const sending = channel.say(SCOPE.PRIVATE, '20002', '在吗')
  const frame = socket.sent[socket.sent.length - 1]
  socket.emit('message', {
    status: 'failed',
    retcode: 1200,
    echo: frame.echo,
    wording: '事件检查器失败：NTEvent 服务和方法：NodeIKernelMsgService/sendMsg 监听器名称：NodeIKernelMsgListener/onMsgInfoListUpdate 事件返回值：{"result":100651}',
  })
  await assert.rejects(sending, /QQ 内核/)

  const row = logs.find((item) => item.kind === 'send_failed')
  assert.ok(row, '发送失败必须留一条审计')
  assert.equal(row.detail.code, '100651')
  assert.equal(row.detail.target, '20002')
  assert.equal(row.detail.action, 'say')
  channel.stop()
})

console.log(`\n${failed.length ? '✗' : '✓'} 通道用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
