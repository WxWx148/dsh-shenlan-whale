/**
 * 面板刷新的事件源。
 *
 * 以前前端每 5 秒拉一次完整 /panel 载荷，绝大多数请求拿回来的东西和上次
 * 一模一样 —— 载荷里有一堆要读文件、算统计的字段，只为确认「没变」。
 * 这里把「有没有变」的判断挪到宿主：每秒算一次**低成本状态摘要**，变了才
 * 给订阅者推一句 invalidate，前端收到再拉一次。
 *
 * 边界：摘要不是 /panel 的替代品，只是「该重拉了」的信号。它必须便宜，
 * 任何一项算不出来都不能让整条链断掉；覆盖不到的字段由前端的低频兜底
 * 轮询补上，绝不出现「改了但永远不刷新」。
 */

/** 一处状态摘要。每项单独兜底：某个对象还没装配好时整条链不能崩。 */
export function eventKeyOf({ runtime, sandbox, channel, napcat } = {}) {
  const part = (fn) => {
    try { return String(fn() ?? '') } catch { return '?' }
  }
  const pending = part(() =>
    (sandbox?.approvals?.list?.() || []).map((one) => (one && one.id) || '').join(','),
  )
  const channelState = part(() => {
    const state = channel?.state?.() || {}
    return [state.online, state.connected, state.state].filter((v) => v !== undefined).join(':')
  })
  const login = part(() => {
    const state = napcat?.snapshot?.() || {}
    return [state.status, state.state].filter((v) => v !== undefined).join(':')
  })
  return [
    part(() => Number(runtime?.configRevision) || 0),
    part(() => runtime?.progressText?.(Date.now()) || ''),
    pending,
    channelState,
    login,
  ].join('|')
}

/**
 * 一条广播通道。没有订阅者时不跑定时器，最后一个订阅者走了就清掉 ——
 * 面板关着还每秒算一次摘要，等于把省下来的轮询又加回去了。
 *
 * 定时器与时钟都从外面注入，测试可以手动 tick，不用真的等一秒。
 */
export function createEventHub({
  keyOf,
  interval = 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  at = () => Date.now(),
} = {}) {
  if (typeof keyOf !== 'function') throw new Error('createEventHub 需要 keyOf')
  const sinks = new Set()
  let lastKey = null
  let timer = null

  const broadcast = (payload) => {
    for (const fn of sinks) {
      try { fn(payload) } catch { /* 一个订阅者写坏了不能拖垮其他窗口 */ }
    }
  }

  const tick = () => {
    let key
    try { key = keyOf() } catch { return }
    if (lastKey === null) lastKey = key // 首帧只建基线，不推 invalidate
    const changed = key !== lastKey
    lastKey = key
    broadcast({ type: changed ? 'invalidate' : 'ping', at: at() })
  }

  return {
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      sinks.add(fn)
      if (lastKey === null) {
        try { lastKey = keyOf() } catch { /* 首帧算不出来就等下一拍 */ }
      }
      if (!timer) timer = setIntervalFn(tick, interval)
      return () => {
        sinks.delete(fn)
        if (!sinks.size && timer) {
          clearIntervalFn(timer)
          timer = null
          lastKey = null
        }
      }
    },
    tick,
    get size() { return sinks.size },
  }
}
