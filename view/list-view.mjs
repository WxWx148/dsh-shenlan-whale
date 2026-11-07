/**
 * 只读列表的唯一实现。
 *
 * 以前七类「取一批数据」各占一条路由，判断散在 index.js 的七个分支里，
 * 界面与探针又各自把路径写死 —— 加一类要改三处，漏一处就静默 404。
 * 现在 `GET /list/:kind` 后面只有这张分派表，路径由 kind 推导。
 *
 * 这里只返回数据、不碰 res：能被用例直接调，也算得清哪一类是哪一类。
 * 未知的 kind 返回 null，由调用方回 404 —— 不猜、不兜底到别的类别。
 */

export const LIST_KINDS = Object.freeze([
  'skills', 'groups', 'memory', 'status', 'usage', 'approvals', 'policy',
])

export async function listOf(kind, ctx = {}) {
  const {
    runtime, channel, napcat, guard, usage, sandbox, tools,
    started, turn, at = () => Date.now(),
  } = ctx

  switch (kind) {
    case 'skills':
      return { ok: true, ...runtime.skills() }

    case 'groups': {
      const groups = await channel.groupList()
      return {
        ok: true,
        groups: groups.map((g) => ({
          id: String(g.group_id || g.groupId || ''),
          name: String(g.group_name || g.groupName || ''),
        })),
      }
    }

    case 'memory':
      return {
        ok: true,
        stats: runtime.memory.stats(),
        facts: runtime.memory.facts().slice(-50),
        people: Object.values(runtime.memory.data.people || {}).slice(-30),
      }

    case 'status':
      return {
        ok: true,
        status: runtime.status(),
        channel: channel.state(),
        login: napcat.snapshot(),
        guard: guard.stats(),
        usage: usage.line(),
        turnReady: started && turn?.ready === true,
      }

    case 'usage':
      return {
        ok: true,
        today: usage.today(),
        line: usage.line(),
        total: typeof usage.total === 'function' ? usage.total() : null,
      }

    case 'approvals': {
      const desk = sandbox.approvals
      return {
        ok: true,
        now: at(),
        pending: desk.list(),
        remember: desk.remember(),
        stats: desk.stats(),
      }
    }

    case 'policy': {
      // 这张表是**工具层**，不是技能层。每行都带上它属于哪一项技能、
      // 那项技能现在开没开，避免同一批名字在两个页面各出现一次。
      const owners = typeof runtime.toolOwners === 'function' ? runtime.toolOwners() : new Map()
      const blocked = typeof runtime.blockedTools === 'function' ? runtime.blockedTools() : null
      const rows = (typeof tools.names === 'function' ? tools.names() : []).map((name) => {
        const list = owners.get(name) || []
        return {
          name,
          label: typeof tools.label === 'function' ? tools.label(name) : name,
          skill: list[0] ? { id: list[0].id, name: list[0].name } : null,
          // 多个技能共用同一个工具时全列出来
          skills: list.map((item) => ({ id: item.id, name: item.name })),
          off: blocked instanceof Set ? blocked.has(name) : false,
        }
      })
      return {
        ok: true,
        tools: rows,
        // 没有归属的工具：跑得动、却不在任何技能下，关不掉也记不了次数
        unowned: rows.filter((row) => !row.skill).map((row) => row.name),
        toolWhitelist: Array.isArray(runtime.config.tools?.whitelist) ? runtime.config.tools.whitelist : [],
        netWhitelist: Array.isArray(runtime.config.net?.allowlist) ? runtime.config.net.allowlist : [],
      }
    }

    default:
      return null
  }
}
