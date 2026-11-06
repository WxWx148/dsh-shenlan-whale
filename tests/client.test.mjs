/**
 * 浏览器侧的离线冒烟用例。
 *
 * lib/client.js 是一份要在宿主前端跑的包，平时只能靠「装上去点一下」验证。
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

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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
    if (node === null || node === undefined || node === false || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((child, i) => call(child, `${path}.${i}`)); return }
    if (typeof node.type === 'function') {
      const prev = currentPath
      currentPath = path
      row().hook = 0
      let out
      try { out = node.type({ ...node.props, children: node.children }) } finally { currentPath = prev }
      call(out, `${path}/${node.type.name || 'anon'}`)
      return
    }
    ;(node.children || []).forEach((child, i) => call(child, `${path}.${i}`))
  }

  return { React, call, instances, effects: () => [...instances.values()].flatMap((r) => r.effects) }
}

/** 深渲染一次：跑 6 轮「渲染 → 执行 effect → 有状态变化就再来一轮」 */
async function deepRender(Component, live) {
  for (let round = 0; round < 6; round += 1) {
    live.call(live.React.createElement(Component, {}), 'root')
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
  return live
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

await check('首屏能渲染：根节点是 slj-root，左栏有十个分区导航', () => {
  const { Panel } = boot()
  const tree = Panel()
  assert.equal(tree.props.className, 'slj-root')
  const nav = find(tree, (node) => node.props && node.props.className === 'slj-navList')
  assert.ok(nav, '找不到导航容器')
  assert.equal(nav.children.length, 10)
  const labels = nav.children.map((row) => row.children[1].children[0])
  assert.deepEqual(labels, ['概览', 'QQ 连接', '对话', '记忆', '技能', '学习', '花费', '过程', '规则', '设置'])
})

await check('默认展开：左栏按 248 走，轨道标记为 false', () => {
  const { Panel } = boot()
  const tree = Panel()
  assert.equal(tree.props['data-slj-rail'], 'false')
  const aside = find(tree, (node) => node.props && node.props.className === 'slj-nav')
  assert.equal(aside.props.style.width, '248px')
})

await check('记住上次收起：下次打开直接是 56 的轨道', () => {
  const { Panel } = boot({ stored: { region: 'skills', collapsed: true, width: 0 } })
  const tree = Panel()
  assert.equal(tree.props['data-slj-rail'], 'true')
  const aside = find(tree, (node) => node.props && node.props.className === 'slj-nav')
  // 收起态不写内联宽度，交给样式表统一成轨道宽 —— 两处各写一次必然对不上
  assert.equal(aside.props.style.width, undefined)
})

await check('记住上次分区：存的是「技能」就直接落在技能页（也兼容老的 section 键）', () => {
  for (const stored of [
    { region: 'skills', collapsed: false, width: 0 },
    { section: 'skills', collapsed: false, width: 0 },
  ]) {
    const { Panel } = boot({ stored })
    const tree = Panel()
    const title = find(tree, (node) => node.props && node.props.className === 'slj-title')
    assert.equal(title.children[0], '技能')
    const nav = find(tree, (node) => node.props && node.props.className === 'slj-navList')
    const current = nav.children.filter((row) => row.props['aria-current'] === 'page')
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

await check('带数据深渲：记忆/技能/审计/规则这些详情页都不许抛异常（回归：undoBar 白屏）', async () => {
  // 0.31.0 的线上事故：`undoBar` 定义在 TalkSplit 里，却被 Panel 的详情区引用。
  // 只渲最外层看不出来，用户一点「记忆」整块面板就白屏。
  const panel = {
    ok: true,
    at: 1,
    layout: { expanded: 248, collapsed: 56, min: 200, max: 320, autoCollapseAt: 720, compactAt: 480 },
    nav: [
      { id: 'overview', label: '概览', hint: '', icon: 'pulse' },
      { id: 'memory', label: '记忆', hint: '', icon: 'brain' },
      { id: 'skills', label: '技能', hint: '', icon: 'spark' },
      { id: 'process', label: '过程', hint: '', icon: 'layers' },
      { id: 'rules', label: '规则', hint: '', icon: 'shield' },
    ],
    regions: {
      overview: { modules: [] },
      memory: { modules: [{ detail: 'memory.facts', label: '事实', desc: '' }] },
      skills: { modules: [{ detail: 'skills.all', label: '全部技能', desc: '' }] },
      process: { modules: [{ detail: 'process.audit', label: '审计日志', desc: '' }] },
      rules: { modules: [
        { detail: 'rules.all', label: '全部规则', desc: '', section: '总表' },
        { detail: 'rules.gaps', label: '还没接上', desc: '', section: '缺口' },
      ] },
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
        row({ id: 'typing.duration', title: '打字时长按字数算', desc: '一条消息的等待按字数算', meta: 'lib/typing.mjs · typingDelayMs()', group: '节奏与注意力', badge: 'guard 下限 2 秒' }),
        row({ id: 'route.order', title: '判定顺序不许调', desc: '@ → 叫名字 → 注意力窗口', meta: 'lib/behavior.mjs · route()', group: '回合与路由' }),
      ],
      hasMore: false,
      note: '规则正文只在 lib/rules.mjs 维护',
    },
    'rules.gaps': {
      kind: 'rows',
      title: '还没接上',
      subtitle: '已知缺口',
      rows: [row({ id: 'gap.burst', title: '连发合并还没接', desc: '只打标签', meta: 'lib/event.mjs · 下一步', badge: '还没接上', tone: 'warn' })],
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
  for (const region of ['overview', 'memory', 'skills', 'process', 'rules']) {
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
