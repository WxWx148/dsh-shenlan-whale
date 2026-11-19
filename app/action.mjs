/**
 * 写操作的唯一实现：`POST /action { op, args }`。
 *
 * 二十一条「动词写在路径里」的路由（/memory/edit-group、/skill/amend、
 * /memory/forget-self …）以前各读一次 body、各写一遍判空，判断散在 index.js
 * 里。现在 op 就是动作名，args 就是原来那份 body，实现集中在这一张表里。
 *
 * 两条纪律：
 * - **只搬不改**。每个分支的判断与参数原样保留（例如 /memory/forget 同时认
 *   target 和 text、/skill 只认 `on === true`），改动行为不属这次收敛的范围。
 * - **未知的 op 返回 null**，调用方回 404。不猜、不兜底到「最接近」的动作 ——
 *   写操作猜错一次，改的就是用户的真实数据。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { failure, failureFrom } from './failure.mjs'

export const ACTION_OPS = Object.freeze([
  'memory.remember', 'memory.editSelf', 'memory.forgetSelf', 'memory.rememberSelf',
  'memory.edit', 'memory.editPerson', 'memory.editGroup',
  'memory.forget', 'memory.forgetPerson', 'memory.forgetGroup',
  'reminder.cancel', 'reminder.update',
  'approval.decide', 'approval.forget',
  'chat.reset', 'qq.send', 'qzone.post',
  'skill.forget', 'skill.amend', 'skill.teach', 'skill.set',
  'config.reload',
])

/** 把原分支的读参规则原样留在这里，省得每个 op 重复一遍。 */
const str = (value) => String(value ?? '')
const optStr = (value) => (value === undefined ? undefined : String(value))

export async function runAction(op, args = {}, ctx = {}) {
  const {
    runtime, sandbox, chat, channel, guard,
    card, peerOf, at = () => Date.now(),
  } = ctx
  const memory = runtime?.memory
  const approvals = sandbox?.approvals

  switch (op) {
    case 'memory.remember':
      return memory.rememberFact(str(args.text), { source: 'panel' })

    case 'memory.editSelf':
      return memory.updateSelf(str(args.old), str(args.text))

    case 'memory.forgetSelf':
      return memory.forgetSelf(str(args.text))

    // 撤销用：删错了再把这条写回去。没有这个入口，面板上的「删除」就是单向门。
    case 'memory.rememberSelf':
      return memory.rememberSelf(str(args.text))

    case 'memory.edit':
      return memory.updateFact(str(args.old), str(args.text))

    case 'memory.editPerson':
      return memory.updatePerson(str(args.uin), {
        name: args.name, note: args.note, impression: args.impression,
      })

    case 'memory.editGroup':
      return memory.updateGroup(str(args.groupId), { label: args.label, topic: args.topic })

    case 'memory.forget':
      // 面板历史上传 text，另一处传 target；只认一个就会删错东西。
      return memory.forgetFact(str(args.target ?? args.text ?? ''))

    case 'memory.forgetPerson':
      return memory.forgetPerson(str(args.uin))

    case 'memory.forgetGroup':
      return memory.forgetGroup(str(args.groupId))

    case 'reminder.cancel':
      return runtime.reminders.cancel(str(args.id))

    case 'reminder.update':
      return runtime.reminders.update(str(args.id), { text: args.text, at: args.at })

    case 'approval.decide':
      return approvals.decide(str(args.id), {
        allow: args.allow === true,
        remember: args.remember === true,
        reason: str(args.reason),
      })

    case 'approval.forget':
      return approvals.forget()

    case 'chat.reset':
      return chat ? chat.reset() : failure('CHAT_NOT_READY')

    case 'qq.send': {
      const conversation = str(args.conversation)
      const text = str(args.text).trim()
      if (!conversation) return failure('MISSING_CONVERSATION')
      if (!text) return failure('EMPTY_TEXT')
      const state = channel.state()
      if (state !== 'online') return failure('CHANNEL_OFFLINE', { message: `通道现在是「${state}」，发不出去` })
      const peer = peerOf(conversation)
      const scope = peer.scope === 'group' ? 'group' : 'private'
      if (scope === 'group') {
        const groups = await channel.groupList()
        if (groups.length && !groups.some((group) => String(group.group_id || group.groupId || '') === String(peer.id))) {
          return failure('GROUP_NOT_JOINED')
        }
      }
      try {
        // 出站必须过 runtime.outbound（截断、防空、脱敏），面板不该有第二套发送逻辑。
        const payload = runtime.outbound(card({ line: text }), 'qq')
        await channel.say(scope, peer.id, payload)
        guard.note(at(), { scope, target: peer.id, conversation })
        runtime.noteSelfMessage({ conversation, scope, text: payload, at: at() })
        runtime.log('panel_send', { conversation, scope, chars: payload.length, actor: 'panel' })
        return { ok: true, text: payload }
      } catch (error) {
        return failureFrom(error, 'SEND_FAILED')
      }
    }

    case 'qzone.post': {
      const text = str(args.content).trim()
      if (!text) return failure('EMPTY_TEXT')
      if (runtime?.config?.qzone?.enabled !== true) return failure('QZONE_DISABLED')
      if (!channel || typeof channel.sendQzone !== 'function') return failure('QZONE_NOT_WIRED')
      if (channel.state() !== 'online') return failure('CHANNEL_OFFLINE')
      const limit = Math.max(0, Number(runtime.config.qzone.dailyLimit ?? 2) || 0)
      const file = `${runtime.dir}/qzone-state.json`
      const day = new Date(at()).toDateString()
      let state = { day: '', count: 0 }
      try {
        state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }
      } catch {}
      if (state.day !== day) state = { day, count: 0 }
      if (limit <= 0 || state.count >= limit) return failure('QZONE_LIMIT', { message: `今天已经发过 ${state.count} 条` })
      try {
        await channel.sendQzone(text.slice(0, 300), Number(args.ugcRight ?? 1) || 1)
        writeFileSync(file, JSON.stringify({ day, count: state.count + 1 }) + '\n', 'utf8')
        runtime.log('qzone_post', { chars: text.length, actor: 'panel' })
        return { ok: true, text: '说说发出去了：' + text.slice(0, 80) }
      } catch (error) {
        return failureFrom(error, 'QZONE_SEND_FAILED')
      }
    }

    case 'skill.forget':
      return runtime.forgetSkill(str(args.id))

    // 改一条教过的技能：名字/说明/分组。id 不变，开关与成功率都留着。
    case 'skill.amend':
      return runtime.amendSkill(str(args.id), {
        name: optStr(args.name),
        what: optStr(args.what),
        group: optStr(args.group),
      }, { actor: 'panel' })

    case 'skill.teach':
      return runtime.teachSkill({
        name: str(args.name),
        what: str(args.what),
        group: str(args.group || 'do'),
        risk: str(args.risk || 'low'),
      })

    case 'skill.set':
      // 只认 `on === true`：让前端传布尔会在「传了 'false' 字符串」时翻车，
      // 那种错表现为「点了没反应」，最难查。
      return runtime.setSkill(str(args.id), args.on === true ? 'on' : 'off', {
        confirm: args.confirm === true, actor: 'panel',
      })

    case 'config.reload': {
      // config.json 被外面改过之后，内存里这份还是旧的。重新按磁盘装配，
      // 组件同步与副作用由 runtime 的统一订阅者做完，这里只把异步结果并进响应。
      const result = runtime.reloadConfig()
      for (const effect of await result.effects) {
        if (effect.login) result.login = effect.login
        if (effect.message) result.message = String(result.message || '重新读好了') + '；' + effect.message
      }
      return result
    }

    default:
      return null
  }
}
