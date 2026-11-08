/**
 * 浏览器侧的离线冒烟用例。
 *
 * lib/client.panel.js 是一份要在宿主前端跑的包，平时只能靠「装上去点一下」验证。
 * 这里用一个极小的假宿主把它跑起来，专门抓三类问题：
 *   1. 包装形状写错（不是 window.__ModuleLoader__.load）→ 整份代码根本不会执行；
 *   2. 两个槽位没成对注册 → 点了入口但主面板是空的；
 *   3. 首屏渲染就抛异常 → 一进面板就白屏。
 *
 * 特别注意第 3 条：假 React 的 useEffect 不执行，所以 fetch 不会真的发，
 * `data` 会一直是 null —— 这恰好能抓「首屏数据没到就崩」的回归。
 *
 * 它不测样式好不好看，也不测真实交互 —— 那要在真浏览器里看。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.panel.js', import.meta.url), 'utf8')

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

/** 极简 React 替身：只实现 client.js 用到的那几个钩子 */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/**
 * 在假宿主里加载并装配一次。
 * @param {{stored?: object|null}} options 预置的 localStorage 内容
 */
function boot(options = {}) {
  const created = []
  const document = {
    head: {
      appendChild(tag) {
        created.push(tag)
      },
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: '' }
    },
    querySelector() {
      return created.length ? created[0] : null
    },
  }
  const storage = {
    value: options.stored === undefined || options.stored === null ? null : JSON.stringify(options.stored),
  }
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load(options) {
        loaded = options
      },
    },
    localStorage: {
      getItem: () => storage.value,
      setItem: () => {},
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    // 真浏览器一定有这两个。缺了它们，组件里"监听窗口大小"这类逻辑会直接抛，
    // 而抛在 effect 里就整块白屏 —— 桩要比被测代码更老实，不能只提供用得上的那几个。
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
  }
  const context = {
    window,
    document,
    console,
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ ok: true }) })),
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(SOURCE, context)

  const captured = loaded
  assert.ok(captured, '没有调用 window.__ModuleLoader__.load')

  const React = options.react || makeReact()
  const api = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('require 了没预期的包：' + name)
  })

  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) {
        assert.equal(typeof callback, 'function', name + ' 的 inject 回调必须是函数')
        callback()
      },
      register(options, Component) {
        registrations.push({ name: options.name, options, Component })
        return () => {}
      },
    },
  }
  api.apply(ctx)
  return { api, registrations, Panel: registrations[0] && registrations[0].Component, created, React }
}

/** 在元素树里按条件找节点 */
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return null
}

/**
 * 深渲染：把组件树整棵走一遍，包括子组件。
 *
 * 为什么普通用例不够：`boot().Panel()` 只执行**最外层**组件，子组件只是
 * element 对象，根本不会被调用。0.31.0 就是这么翻车的 ——
 * `undoBar` 写进了 TalkSplit 的作用域，却被 Panel 的详情区引用，
 * 一点「记忆」就 ReferenceError，整块面板白屏；而外层渲染一点问题都没有。
 * 这里补上「子组件也真的执行一次 + 带数据重渲染」，把这类错误挡在发布前。
 */
function makeLiveReact() {
  const instances = new Map()
  let currentPath = null
  let dirty = false
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const row = () => {
    if (!instances.has(currentPath)) instances.set(currentPath, { state: [], hook: 0, effects: [], memo: [] })
    return instances.get(currentPath)
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState(init) {
      const r = row()
      const i = r.hook++
      if (!(i in r.state)) r.state[i] = typeof init === 'function' ? init() : init
      return [r.state[i], (value) => {
        const next = typeof value === 'function' ? value(r.state[i]) : value
        if (Object.is(next, r.state[i])) return
        r.state[i] = next
        dirty = true
      }]
    },
    useRef(init) {
      const r = row()
      const i = r.hook++
      if (!(i in r.state)) r.state[i] = { current: init }
      return r.state[i]
    },
    useEffect(fn, deps) {
      const r = row()
      const i = r.hook++
      const prev = r.effects[i]
      if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) r.effects[i] = { fn, deps, pending: true }
    },
    useCallback(fn, deps) {
      const r = row()
      const i = r.hook++
      if (r.memo[i] && sameDeps(r.memo[i].deps, deps)) return r.memo[i].fn
      r.memo[i] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const r = row()
      const i = r.hook++
      if (r.memo[i] && sameDeps(r.memo[i].deps, deps)) return r.memo[i].value
      const value = fn()
      r.memo[i] = { deps, value }
      return value
    },
  }

  const call = (node, path) => {
    if (node === null || node === undefined || node === false || typeof node !== 'object') return node
    if (Array.isArray(node)) { node.forEach((child, i) => call(child, `${path}.${i}`)); return node }
    if (typeof node.type === 'function') {
      const prev = currentPath
      currentPath = path
      row().hook = 0
      let out
      try { out = node.type({ ...node.props, children: node.children }) } finally { currentPath = prev }
      call(out, `${path}/${node.type.name || 'anon'}`)
      return out
    }
    ;(node.children || []).forEach((child, i) => call(child, `${path}.${i}`))
    return node
  }

  return { React, call, instances, effects: () => [...instances.values()].flatMap((r) => r.effects) }
}

/** 深渲染一次：跑 6 轮「渲染 → 执行 effect → 有状态变化就再来一轮」 */
async function deepRender(Component, live) {
  let tree = null
  for (let round = 0; round < 6; round += 1) {
    tree = live.call(live.React.createElement(Component, {}), 'root')
    let ran = 0
    for (const effect of live.effects()) {
      if (effect && effect.pending) {
        effect.pending = false
        effect.fn()
        ran += 1
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!ran) break
  }
  // 交出最后一轮的树：调用方要能检查"数据到了之后画成什么样"，
  // 而不是只能检查"没抛异常"。
  return tree
}

console.log('\n浏览器侧外壳')

await check('包装形状正确：模块能被宿主的加载器接住，并导出 apply/inject', () => {
  const { api } = boot()
  assert.equal(typeof api.apply, 'function')
  assert.deepEqual([...api.inject], ['slots'])
})

await check('两个槽位成对注册，且用的是同一个面板 id', () => {
  const { registrations } = boot()
  assert.equal(registrations.length, 2, '应当只注册主面板与左栏入口')
  const main = registrations.find((row) => row.name === 'main')
  const entry = registrations.find((row) => row.name === 'sidebar.panellist')
  assert.ok(main, '没注册 main 面板')
  assert.ok(entry, '没注册左栏入口')
  assert.equal(main.options.key, 'shenlan')
  assert.equal(entry.options.id, 'shenlan')
  assert.equal(entry.options.label(), '深蓝鲸')
  assert.ok(Number.isFinite(entry.options.order), '入口要有排序值，否则会飘到列表最前')
})

await check('首屏数据还没到也不白屏（回归：曾直接读 data.notices 抛异常）', () => {
  // 假 React 的 useEffect 不跑 → fetch 不发 → data 恒为 null。
  // 这一条守住「第一帧就能画出来」，而不是等数据到了才敢渲染。
  let tree = null
  assert.doesNotThrow(() => {
    tree = boot().Panel()
  })
  assert.equal(tree.props.className, 'slj-root')
  const empty = find(tree, (node) => node.props && node.props.className === 'slj-empty')
  assert.ok(empty, '数据未到时应有一句占位提示，而不是空白')
  assert.match(String(empty.children[0]), /正在读/)
})

await check('首屏能渲染：根节点是 slj-root；数据没到画骨架，不假装有导航', () => {
  const { Panel } = boot()
  const tree = Panel()
  assert.equal(tree.props.className, 'slj-root')
  const nav = find(tree, (node) => node.props && node.props.className === 'slj-navList')
  assert.ok(nav, '找不到导航容器')
  // 以前这里会渲染一份浏览器自带的十个页面清单。那份清单在页面合并后就成了
  // "点进去是空白的第七页"，而代码看起来一切正常。现在第一帧只有灰条。
  assert.equal(nav.children.length, 5)
  for (const row of nav.children) assert.equal(row.props.className, 'slj-skelRow')
})

await check('首屏不写死几何：宽度交给样式表，数据到了再切内联', () => {
  const { Panel } = boot()
  const tree = Panel()
  assert.equal(tree.props['data-slj-rail'], 'false')
  const aside = find(tree, (node) => node.props && node.props.className === 'slj-nav')
  // 0 表示"还不知道"。写 248 就等于在浏览器里又存了一份几何。
  assert.equal(aside.props.style.width, undefined)
  // 还没量到现场（container = 0）时不许给自己写宽度：
  // 写了就是拿一个假数字去盖住宿主的真实布局。
  assert.equal(tree.props.style, undefined, '首屏不该有内联宽度')
  assert.equal(tree.props['data-slj-clipped'], 'false', '没量到之前不能声称自己被裁')
})

await check('记住上次分区：旧页面 id 经下发的别名翻译后落在合并后的页上', async () => {
  const panel = {
    ok: true,
    layout: { expanded: 248, collapsed: 56, min: 200, max: 320, autoCollapseAt: 720, compactAt: 480 },
    // 宿主下发的别名表（来自 blueprint）。浏览器不许自己抄一份。
    aliases: { skills: 'ability', memory: 'mind', usage: 'overview' },
    nav: [
      { id: 'overview', label: '总览', hint: '', icon: 'pulse' },
      { id: 'mind', label: '心智', hint: '', icon: 'spark' },
      { id: 'ability', label: '能力', hint: '', icon: 'grid' },
    ],
    navSections: [],
    regions: {
      overview: { modules: [] },
      mind: { modules: [] },
      ability: { modules: [] },
    },
    notices: [],
    head: {},
    sections: {},
  }
  const fetch = async () => ({ ok: true, json: async () => panel })
  for (const [stored, expect] of [['skills', '能力'], ['memory', '心智'], ['usage', '总览']]) {
    const live = makeLiveReact()
    const built = boot({ react: live.React, fetch, stored: { region: stored, collapsed: false, width: 0 } })
    const tree = await deepRender(built.Panel, live)
    const title = find(tree, (node) => node.props && node.props.className === 'slj-title')
    assert.equal(title.children[0], expect, `${stored} 应当落在「${expect}」`)
    const nav = find(tree, (node) => node.props && node.props.className === 'slj-navList')
    const current = nav.children.filter((row) => row.props && row.props['aria-current'] === 'page')
    assert.equal(current.length, 1, '同时只能有一个「当前页」')
  }
})

await check('样式只注入一次：热重载/重进面板不会叠第二份', () => {
  const { created } = boot()
  assert.equal(created.length, 1)
  assert.equal(created[0].dataset.pluginCss, 'dsh-shenlan-whale/panel.css')
})

await check('拖宽手柄始终在树里（收起态由样式表隐藏，位置不丢）', () => {
  const open = boot()
  const closed = boot({ stored: { region: '', collapsed: true, width: 0 } })
  assert.ok(find(open.Panel(), (node) => node.props && node.props.className === 'slj-grip'))
  assert.ok(find(closed.Panel(), (node) => node.props && node.props.className === 'slj-grip'))
})

await check('带数据深渲：心智/能力/诊断这些详情页都不许抛异常（回归：undoBar 白屏）', async () => {
  // 0.31.0 的线上事故：`undoBar` 定义在 TalkSplit 里，却被 Panel 的详情区引用。
  // 只渲最外层看不出来，用户一点「记忆」整块面板就白屏。
  const panel = {
    ok: true,
    at: 1,
    layout: { expanded: 248, collapsed: 56, min: 200, max: 320, autoCollapseAt: 720, compactAt: 480 },
    // 页面合并后的真实形状：记忆与学习同属「心智」，技能与规则同属「能力」
    aliases: { memory: 'mind', skills: 'ability', rules: 'ability' },
    nav: [
      { id: 'overview', label: '总览', hint: '', icon: 'pulse' },
      { id: 'mind', label: '心智', hint: '', icon: 'spark' },
      { id: 'ability', label: '能力', hint: '', icon: 'grid' },
      { id: 'process', label: '诊断', hint: '', icon: 'layers' },
    ],
    regions: {
      overview: { modules: [] },
      mind: { modules: [{ detail: 'memory.facts', label: '事实', desc: '' }] },
      ability: { modules: [
        { detail: 'skills.all', label: '全部技能', desc: '' },
        { detail: 'rules.all', label: '全部规则', desc: '', section: '总表' },
        { detail: 'rules.gaps', label: '还没接上', desc: '', section: '缺口' },
      ] },
      process: { modules: [{ detail: 'process.audit', label: '审计日志', desc: '' }] },
    },
    notices: [],
    head: {},
    sections: {},
    groups: [],
    tools: [],
    toolWhitelist: [],
    netWhitelist: [],
  }
  const row = (extra) => ({ id: extra.id, title: extra.title || 'x', meta: '', desc: '', ...extra })
  const details = {
    'memory.facts': {
      kind: 'rows',
      title: '事实',
      subtitle: '事实 1 · 人物 0 · 群 0 · 自我 0。删除要点两下，删完还能撤销',
      rows: [row({ id: 'fact-F1', title: '我在重庆', meta: '事实 · 记得于 3 小时前', actions: [{ action: 'edit-fact', actionLabel: '改' }, { action: 'forget-fact', actionLabel: '删' }], value: '我在重庆', undo: { type: 'fact', text: '我在重庆' } })],
      hasMore: false,
    },
    'skills.all': {
      kind: 'rows',
      title: '全部技能',
      subtitle: '',
      rows: [row({ id: 'taught.1', title: '动手 · 自定义一课', skill: { id: 'taught.1', name: '自定义一课', what: '主人教的', state: 'on', toggleable: true, wired: true }, actions: [{ action: 'edit-skill', actionLabel: '改名' }, { action: 'forget-skill', actionLabel: '忘掉' }] })],
      hasMore: false,
    },
    'process.audit': {
      kind: 'rows',
      title: '审计日志',
      subtitle: '只看「常规信息」 · 全部类型。磁盘上的审计一条没删，这里只是不显示',
      rows: [row({ id: 'au1', title: '改设置', meta: '刚刚 · 常规信息 · config', desc: '改成 3' })],
      filter: { level: 'info', kinds: [], noise: true, levels: [{ id: 'error', label: '只看错误' }, { id: 'warn', label: '错误与警告' }], dirty: false },
      hasMore: false,
    },
    'rules.all': {
      kind: 'rows',
      title: '全部规则',
      subtitle: '此刻仍然生效的硬约束',
      search: true,
      rows: [
        row({ id: 'typing.duration', title: '打字时长按字数算', desc: '一条消息的等待按字数算', meta: 'voice/typing.mjs · typingDelayMs()', group: '节奏与注意力', badge: 'guard 下限 2 秒' }),
        row({ id: 'route.order', title: '判定顺序不许调', desc: '@ → 叫名字 → 注意力窗口', meta: 'decide/behavior.mjs · route()', group: '回合与路由' }),
      ],
      hasMore: false,
      note: '规则正文只在 lib/rules.mjs 维护',
    },
    'rules.gaps': {
      kind: 'rows',
      title: '还没接上',
      subtitle: '已知缺口',
      rows: [row({ id: 'gap.burst', title: '连发合并还没接', desc: '只打标签', meta: 'facts/event.mjs · 下一步', badge: '还没接上', tone: 'warn' })],
      hasMore: false,
    },
  }
  const fetch = async (url) => {
    const text = String(url)
    const body = text.includes('/detail')
      ? details[new URL('http://x' + text.slice(text.indexOf('/detail') + 7)).searchParams.get('id')] || { kind: 'rows', title: '空', rows: [] }
      : panel
    return { ok: true, json: async () => body }
  }

  // 逐个分区切换：区域决定详情区渲染哪一类行（记忆的叫法、技能的开关键、审计的胶囊）
  // 旧 id（memory/skills/rules）也一起跑：老书签必须还能打开，靠的是下发别名。
  for (const region of ['overview', 'mind', 'ability', 'process', 'memory', 'skills', 'rules']) {
    const live = makeLiveReact()
    const built = boot({ react: live.React, fetch, stored: { region, collapsed: false, width: 248 } })
    assert.ok(built.Panel, '面板没注册')
    try {
      await deepRender(built.Panel, live)
    } catch (error) {
      assert.fail(`${region} 分区渲染抛异常：${error && error.message}`)
    }
  }
})

await check('沙箱确认弹窗：两个按钮、倒计时、记住选择、拒绝理由都在', () => {
  // 这一条是源码级的：假 React 不跑 useEffect，弹窗只在有挂起请求时出现，
  // 用渲染去测它等于什么都没测。这里只保「零件没被删掉、文案没丢」。
  for (const needle of ['slj-askMask', 'slj-askBarFill', '确认执行', '取消并拒绝', '记住我的选择', '拒绝理由', '项目：', '目的：']) {
    assert.ok(SOURCE.includes(needle), '弹窗缺了：' + needle)
  }
  assert.ok(!/window\.confirm\(/.test(SOURCE), '确认弹窗不许用原生 confirm：桌面壳里会被禁用，而且会把整页卡住')
})

console.log(`\n${failed.length ? '✗' : '✓'} 浏览器侧外壳用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
