/**
 * view/debug.mjs — 「数据与调试」的唯一清单与执行器。
 *
 * 后端早就有 reload / 状态 / 用量 / 技能 / 视觉自检这些能力，界面却一个入口都没有；
 * 用户在设置里改完一个值，只能切到 QQ 发条消息碰运气，才能知道有没有生效。
 * 这里把它们收成一份清单：选一份数据 → 跑一次 → 当场看结果。
 *
 * 清单与执行都在这一个文件里：加一项不会漏掉界面卡片，也不会漏掉后端分支。
 */
import { loadConfig } from '../base/core.mjs'
import { digestForward } from '../ability/index.mjs'
import { activityUsageView } from '../life/index.mjs'
import { netStatus, checkNet } from '../ability/index.mjs'

/** 顺序即界面顺序。label/desc 都是人话，不出现内部字段名 */
export const DEBUG_ITEMS = Object.freeze([
  { id: 'config', label: '设置有没有生效', desc: '核对界面上的值与实际在用的是不是同一份' },
  { id: 'net', label: '联网开关试一次', desc: '当场验证白名单与次数有没有真的拦住联网' },
  { id: 'memory', label: '记过的东西', desc: '核对记了多少、能不能找出来' },
  { id: 'usage', label: '账本与用量', desc: '核对今天用了多少 token、花了多少钱' },
  { id: 'activity', label: '自主活动用量', desc: '核对它自己那段时间花了多少 token，不依赖思维链' },
  { id: 'skills', label: '能做的事', desc: '核对哪些能用、哪些还不行' },
  { id: 'channel', label: 'QQ 连接', desc: '核对现在连没连上、登录到哪一步' },
  { id: 'forward', label: '转发记录', desc: '核对最近一段转发能不能完整读出来' },
  { id: 'selfcheck', label: '自查结论', desc: '核对最近一次复盘有没有结论、处理了没' },
])

const row = (label, value, tone = 'idle') => ({ label, value: String(value ?? '—'), tone })

function safe(fn, fallback) {
  try { return fn() } catch (error) { return fallback === undefined ? String(error?.message || error) : fallback }
}

/** 找最近一条带转发的消息，用来真的试读一次 */
async function forwardProbe(runtime, channel) {
  const events = safe(() => runtime?.events?.read?.({ limit: 200, maxScan: 2000, filter: (r) => !!r?.payload?.forwardId })?.rows || [], [])
  const latest = events[0]
  if (!latest?.payload?.forwardId) {
    return { ok: true, rows: [row('最近一段转发', '还没有转发记录')], note: '等群里发过一段合并转发，这里就能直接核对解析结果。' }
  }
  if (!channel || typeof channel.getForward !== 'function') {
    return { ok: false, rows: [row('读取', '通道没接上')], note: '通道没连上时读不到转发内容。' }
  }
  const nodes = await channel.getForward(latest.payload.forwardId, 200)
  const digest = digestForward(nodes, { maxChars: 3000, total: Number(nodes.forwardTotal) || nodes.length, truncated: nodes.forwardTruncated === true })
  return {
    ok: true,
    rows: [
      row('协议端给的条数', Number(nodes.forwardTotal) || nodes.length),
      row('这次读到', nodes.length),
      row('有正文的条数', nodes.filter((n) => String(n.text || '').trim()).length),
      row('整理后字数', digest.text.length),
    ],
    note: nodes.length && nodes.some((n) => String(n.text || '').trim())
      ? '读到了正文；模型回答时用的就是这份整理结果。'
      : '这次没读到正文。可能是协议端只给了元信息，或这条转发里全是非文本内容 —— 提示词里会明说「没读到」，不会凭空编。',
  }
}

/**
 * 跑一次核对。
 * @returns {Promise<{ok:boolean,title:string,rows:Array,note:string}>}
 */
export async function runDebug(kind, ctx = {}) {
  const { runtime, channel, usage, napcat } = ctx
  const item = DEBUG_ITEMS.find((one) => one.id === String(kind || ''))
  if (!item) return { ok: false, title: '没这一项', rows: [], note: '不认识的核对项目。' }

  if (kind === 'config') {
    const disk = safe(() => loadConfig(runtime?.dir || '').config, null)
    const same = disk ? JSON.stringify(disk) === JSON.stringify(runtime?.config || {}) : false
    const net = safe(() => netStatus(), null)
    const activity = safe(() => activityUsageView(runtime), null)
    const tools = Array.isArray(runtime?.config?.tools?.whitelist) ? runtime.config.tools.whitelist : []
    return {
      ok: true,
      title: item.label,
      rows: [
        row('内存里正在用的', same ? '与磁盘一致' : '与磁盘不一致'),
        row('配置改动次数', Number(runtime?.configRevision) || 0),
        row('需要重启', runtime?.dirtyRestart ? '是' : '否'),
        // 下面三行看的不是「保存的值」，而是真正拦请求的那个闸：
        // 值一致不等于开关接上了，得看执行处是不是同一个数。
        row('联网白名单（执行中）', net ? (net.allowlist.length ? net.allowlist.join('、') : '空的 · 联网停用') : '—'),
        row('每小时次数（执行中）', net ? `${net.quotaPerHour} 次 · 本小时已用 ${net.used} 次` : '—'),
        row('工具白名单（执行中）', tools.length ? `${tools.length} 项放行` : '留空 · 全部允许'),
        row('自主活动独立账本', activity ? `${activity.calls} 次 · ${activity.tokens} token` : '—'),
      ],
      note: same
        ? '界面上改过的值已经在用了；下面几行是各开关实际执行处读到的值，改完回来再跑一次就能对比。'
        : '磁盘与内存不一致：可能是外部手改过配置。点「重新读取设置」即可不重启地对齐。',
    }
  }

  if (kind === 'net') {
    const before = netStatus()
    // 只过闸、不真的发搜索请求：白名单与次数是不是真的生效，这一步就能验证。
    // 放行时会占一次配额，所以把「试之前 / 试之后」都摆出来，用户看得见代价。
    const probe = checkNet('https://cn.bing.com/search?q=probe')
    const after = netStatus()
    return {
      ok: true,
      title: item.label,
      rows: [
        row('白名单', before.allowlist.length ? before.allowlist.join('、') : '空的 · 全部不许'),
        row('每小时次数', before.quotaPerHour),
        row('试之前已用', `${before.used} 次`),
        row('刚才这一下', probe.ok ? '放行了' : probe.error, probe.ok ? 'ok' : 'warn'),
        row('试之后已用', `${after.used} 次`),
      ],
      note: '这一步只核对开关有没有接上，不真的发搜索请求；放行时会占一次联网次数。改完白名单或次数再跑一次，结果应当立刻变。',
    }
  }

  if (kind === 'memory') {
    const digest = safe(() => runtime?.memory?.digest?.({ query: '' }) || {}, {})
    const stats = safe(() => runtime?.memory?.stats?.() || {}, {})
    return {
      ok: true,
      title: item.label,
      rows: [
        row('记着的事实', Array.isArray(digest.facts) ? digest.facts.length : (stats.facts ?? 0)),
        row('认识的人', stats.people ?? 0),
        row('记住的群', stats.groups ?? 0),
        row('长期记忆', runtime?.config?.memory?.enabled === false ? '关着' : '开着'),
      ],
      note: '改了「最多记多少条」之类的设置后，回来再跑一次就能看到有没有生效。',
    }
  }

  if (kind === 'usage') {
    const status = safe(() => runtime?.status?.() || {}, {})
    const today = safe(() => usage?.today?.() || {}, {})
    const fallbackTokens = Number.isFinite(Number(today.input)) && Number.isFinite(Number(today.output))
      ? Number(today.input) + Number(today.output)
      : 0
    return {
      ok: true,
      title: item.label,
      rows: [
        row('今日 token', status['status.todayTokens'] ?? fallbackTokens),
        row('今日花费', status['status.todayCost'] ?? '—'),
        row('调用次数', today.calls ?? 0),
        row('预算', status['status.budget'] ?? '没设上限'),
      ],
      note: '改完单价或预算，这里会立刻按新值算，不用去 QQ 试。',
    }
  }

  if (kind === 'activity') {
    const view = safe(() => activityUsageView(runtime), null)
    if (!view) return { ok: false, title: item.label, rows: [], note: '自主活动账本还没接上。' }
    const byKind = view.byKind.filter((one) => one.calls).map((one) =>
      row(one.label, `${one.calls} 次 · ${one.tokens} token${one.untracked ? ` · ${one.untracked} 次没拿到数字` : ''}`),
    )
    return {
      ok: true,
      title: item.label,
      rows: [
        row('今天用了', `${view.tokens} token`),
        row('推理次数', view.calls),
        row('约合', `¥${view.cost.toFixed(3)}`),
        row('没拿到数字', view.untracked),
        ...byKind,
      ],
      note: '这本账按「每一次自主推理」记，主动开口、群里插话、没生成文字的反思都在内；思维链只是副本，不在思维链里也能看到消耗。',
    }
  }

  if (kind === 'skills') {
    const counts = safe(() => runtime?.skills?.()?.counts || {}, {})
    return {
      ok: true,
      title: item.label,
      rows: [
        row('能用', counts.on ?? 0),
        row('用不了', counts.blocked ?? 0),
        row('还没接上', counts.notWired ?? 0),
      ],
      note: '改了白名单或档位之后，这里的数字会跟着变；没变就说明那一项没真正生效。',
    }
  }

  if (kind === 'channel') {
    const state = safe(() => channel?.state?.() || '不知道', '不知道')
    const login = safe(() => napcat?.snapshot?.() || {}, {})
    return {
      ok: true,
      title: item.label,
      rows: [
        row('通道', state),
        row('登录', login.online === true ? '在线' : (login.hint || '还没连上')),
        row('开关', runtime?.config?.channel?.enabled === false ? '关着' : '开着'),
      ],
      note: '这里显示的是当前这一刻的情形；改完连接设置会立刻重连。',
    }
  }

  if (kind === 'forward') return { ...(await forwardProbe(runtime, channel)), title: item.label }

  if (kind === 'selfcheck') {
    const state = safe(() => runtime?.selfCheck?.summary?.() || null, null)
    return {
      ok: true,
      title: item.label,
      rows: [
        row('结论总数', state?.total ?? 0),
        row('还没处理', state?.pending ?? 0),
        row('已处理', state?.done ?? 0),
        row('最近一份', state?.latest?.title || '还没有'),
      ],
      note: state?.pending
        ? '还有待处理的结论：主人处理完要标记一下，否则同一个问题会被反复提出。'
        : '目前没有待处理的结论。',
    }
  }

  return { ok: false, title: item.label, rows: [], note: '这一项还没接上。' }
}
