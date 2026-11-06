/**
 * lib/ticker.mjs — 定时器的重入闸。
 *
 * 为什么需要它：`setInterval(async () => { ... await 模型 ... }, 60_000)` 不保证
 * 「上一次跑完才跑下一次」。间隔到点就再进一次，**不等上一次返回**。
 * 于是同一段活会同时有两份在跑：
 *
 *   · 主动开口：两边都读到「上次开口是两小时前」，于是各发一条 —— perDay 的上限
 *     只在状态文件里生效，两份都在写之前读，谁的限额都没拦住谁；
 *   · 自主活动 / 掉线自学：两路同时联网抓同一个话题，token 双倍，活动日志写两遍；
 *   · 每日简报：两份同时看到「今天还没发」，于是同一天发两遍。
 *
 * 这些活里最慢的一步是模型调用，30 秒到两分钟都正常，而间隔往往就是 60 秒 ——
 * 撞车不是理论风险，是常态。
 *
 * 所以规矩只有一条：**同一个名字，同一时刻只允许一份在跑**。到点时如果上一份还没回来，
 * 这一次直接跳过（跳过不记日志、不排队、不补跑 —— 补跑等于把撞车换成堆压）。
 * 跳过是安全的：下一分钟还会到点，状态没被写坏才是最要紧的。
 *
 * 独立成文件而不是塞在 index.js 里：这样它能被单独测（见 tests/hardening.test.mjs）。
 * 放进入口就没法测了 —— 入口一 import 就起一堆真定时器。
 */

/**
 * 建一个闸。
 *
 * @param {object} [options]
 * @param {(error: unknown, name: string) => void} [options.onError]
 *        兜底：任务自己没接住的异常在这里落地。有它才不会变成 unhandledRejection
 *        （那会让进程直接退出，一个后台任务炸掉整个插件）。
 * @param {() => number} [options.now]
 * @returns {{ every: Function, once: Function, busy: Function, inFlight: () => string[], stop: Function, stopped: Function }}
 */
export function createTicker(options = {}) {
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const running = new Set()
  const timers = new Set()
  const skips = new Map()
  let stopped = false

  /**
   * 跑一次，跑完才放开。
   *
   * 返回值说明：`skipped: true` 不是错误，是「上一份还在跑」这一条事实本身 ——
   * 调用方要能区分「没跑」和「跑了但失败」，否则面板上两种完全不同的情况会长得一样。
   */
  async function once(name, fn) {
    const key = String(name || '')
    if (!key) return { ok: false, skipped: true, reason: 'no_name' }
    if (running.has(key)) {
      skips.set(key, (skips.get(key) || 0) + 1)
      return { ok: false, skipped: true, reason: 'in_flight' }
    }
    running.add(key)
    try {
      return { ok: true, skipped: false, value: await fn() }
    } catch (error) {
      // 任务自己的 try/catch 优先（它知道该说人话说什么）。走到这里说明漏了，
      // 交给 onError 兜住：宁可记一条日志，也不要让进程因为一次后台失败退出。
      onError(error, key)
      return { ok: false, skipped: false, error }
    } finally {
      running.delete(key)
    }
  }

  /**
   * 起一个带闸的定时器。
   *
   * `unref()` 是必须的：这些定时器不该把宿主进程按住不让退出 ——
   * 用户关掉应用，后台任务还攥着事件循环，任务管理器里就会挂着一个关不掉的进程。
   */
  function every(intervalMs, name, fn, opts = {}) {
    const ms = Math.max(200, Number(intervalMs) || 0)
    const key = String(name || '')
    const run = () => {
      if (stopped || (opts.enabled && opts.enabled() === false)) return
      once(key, fn)
    }
    const timer = setInterval(run, ms)
    timer.unref?.()
    timers.add(timer)
    return timer
  }

  /** 停掉全部定时器：插件卸载时要还回去，不能留在宿主的进程里继续跑 */
  function stop() {
    stopped = true
    for (const timer of timers) {
      try { clearInterval(timer) } catch {}
    }
    timers.clear()
  }

  return {
    every,
    once,
    busy: (name) => running.has(String(name || '')),
    inFlight: () => [...running],
    /** 累计被跳过多少次。只在排查「为什么这个点没跑」时有用，不进面板 */
    skips: (name) => skips.get(String(name || '')) || 0,
    stop,
    stopped: () => stopped,
    now,
  }
}
