/**
 * decide/speech.mjs — 出口闸门：这件事能不能说出口。
 *
 * 为什么单独一件：`voice/` 管的是「话说出来像不像人」（成形、分条、语气、节奏），
 * 是**表达**；这里管的是「该不该说、说得够不够清楚」，是**判断**。
 * 以前 `guardPlan` 长在 `voice/say.mjs` 里，于是 `ability/sandbox.mjs` 为了
 * 执行前先要一句人话，不得不 import `voice/` —— 能力层去问表达层「我能不能跑」，
 * 方向是反的（R5 就是抓这条边）。
 *
 * 现在它在 decide/：沙箱问的是判断，decide 回答判断；
 * `voice/` 不再需要知道「执行前要有计划」这回事。
 *
 * 判断逻辑一行未改（0.45.x 起的文案与边界都保留），只是换了归属 ——
 * 换归属的价值在于依赖图：`ability → voice` 这条边消失了。
 */

/**
 * 计划闸门：在沙箱里跑之前必须先说人话。
 * 返回 {ok, plan} 或 {ok:false, reason}，由调用方决定回什么。
 *
 * 规则只有三条，但每条都对应一次线上事故：
 *   1. 空计划 —— 模型直接调 exec_sandbox 不解释，用户看到一段代码弹出来；
 *   2. 超过 5 步 —— 那不叫计划，叫把思考过程倒出来；
 *   3. 单步超 60 字 —— 一步一句短话才看得懂，长了就是在写代码注释。
 */
export function guardPlan(plan) {
  const list = Array.isArray(plan)
    ? plan.map((s) => String(s || '').trim()).filter(Boolean)
    : String(plan || '').trim()
      ? [String(plan).trim()]
      : []
  if (!list.length) {
    return { ok: false, reason: '先写清楚要做什么（一两句人话），再执行。' }
  }
  if (list.length > 5) {
    return { ok: false, reason: '计划最多 5 步，说重点。' }
  }
  if (list.some((s) => s.length > 60)) {
    return { ok: false, reason: '每一步用一句短话说，别超过 60 个字。' }
  }
  return { ok: true, plan: list }
}
