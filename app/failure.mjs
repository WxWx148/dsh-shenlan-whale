/**
 * app/failure.mjs — 接口错误体的唯一定义。
 *
 * 形状（**error 永远是字符串**）：
 *
 *   { ok:false, error:'空消息不发', code:'EMPTY_TEXT',
 *     hint:'在输入框写点内容再发送', field:'text', retry:false }
 *
 * 为什么不是架构文档里画的 `error:{code,message,hint,field}` 嵌套对象：
 * 界面有 30+ 处把 `result.error` 当字符串直接显示，改成对象的代价是同时改对
 * 30 处，漏一处的表现是「[object Object]」——不报错、不崩溃，只是那句话没了。
 * 当时宿主认证正被限流，没有真机窗口可以逐屏核对，所以选了「并列字段」：
 * 机器该有的 code / hint / field 一个不少，人读的那句人话原地不动。
 * 两者信息量相同，差别只在error是不是对象；这条取舍由 R15 钉住。
 *
 * hint 的规矩：**指向一个真实存在的入口**（哪个页面、哪个输入框、哪一步操作），
 * 不写「请重试」「稍后再试」这种正确的废话。确实没有可操作入口的（消息已被
 * 撤回），就如实说「没有可操作入口」，不许编一个按钮出来。
 */

/** 错误码表。新增出口先在这里登记，守卫会检查每个码都有中文说明与有效 hint。 */
export const FAILURES = Object.freeze({
  UNKNOWN_ROUTE: {
    message: '没有这个接口',
    hint: '界面版本可能落后于宿主：重启 DeepSeek Harness 重新加载前端',
    retry: false,
  },
  UNKNOWN_LIST: {
    message: '没有这一类列表',
    hint: '界面版本可能落后于宿主：重启 DeepSeek Harness 重新加载前端',
    field: 'kind', retry: false,
  },
  UNKNOWN_OP: {
    message: '没有这个操作',
    hint: '界面版本可能落后于宿主：重启 DeepSeek Harness 重新加载前端',
    field: 'op', retry: false,
  },
  UNKNOWN_ASSET: {
    message: '没有这个资源',
    hint: '可用资源只有二维码与落盘图片；界面版本落后时重启 DeepSeek Harness',
    field: 'name', retry: false,
  },
  INTERNAL: {
    message: '宿主这边出错了',
    hint: '「诊断」页看运行日志里 [whale] 开头的那一段',
    retry: true,
  },
  MISSING_ID: {
    message: '没说要看哪一条（缺 id）',
    hint: '从消息列表点「查看原文」，不要手工拼地址',
    field: 'id', retry: false,
  },
  MESSAGE_OFFLINE: {
    message: '本地记录里没有这条，通道又不在线，暂时查不到原文',
    hint: '「连接」页把通道恢复在线后再点一次「查看原文」',
    retry: true,
  },
  MESSAGE_GONE: {
    message: '协议端也查不到这条了（可能已过期或被撤回）',
    hint: '没有可操作入口：这条原文已经取不回来了',
    retry: false,
  },
  CHAT_UNAVAILABLE: {
    message: '生成能力还没接上：宿主没把模型给我',
    hint: '「设置」页 →「模型」组，选好 modelProvider 与 model',
    retry: false,
  },
  CONFIG_FAILED: {
    message: '这项没改成',
    hint: '「设置」页检查这一项的值与取值范围，再单独保存一次',
    field: 'key', retry: true,
  },
  CHAT_NOT_READY: {
    message: '还没有对话',
    hint: '「对话」页先发一句话，再回来点「清空」',
    retry: false,
  },
  MISSING_CONVERSATION: {
    message: '不知道发给谁',
    hint: '从「对话」页选一个会话再发送，不要手工拼 conversation',
    field: 'conversation', retry: false,
  },
  EMPTY_TEXT: {
    message: '空消息不发',
    hint: '在输入框里写点内容再点「发送」',
    field: 'text', retry: false,
  },
  CHANNEL_OFFLINE: {
    message: '通道不在线，发不出去',
    hint: '「连接」页看通道状态；掉线时先恢复 NapCat 再发',
    retry: true,
  },
  GROUP_NOT_JOINED: {
    message: '这个群号不在机器人加入的群列表里',
    hint: '「连接」页刷新群列表，或从一条新的群聊会话发起',
    field: 'conversation', retry: false,
  },
  SEND_FAILED: {
    message: '消息没发出去',
    hint: '「连接」页确认通道在线；仍失败就到「诊断」页看日志',
    retry: true,
  },
  BUSINESS_FAILED: {
    message: '这一步没成功',
    hint: '看返回的具体原因；配置类去「设置」页，运行类去「诊断」页',
    retry: true,
  },
})

/**
 * 给「业务模块自己返回的 ok:false」补齐结构化字段。
 *
 * 这些结果（setConfig / chat.send / reminders.update …）由几十个模块各自构造，
 * 逐个改过去既超范围又容易漏。它们在 HTTP 边界汇合，所以在这里补一次：
 * **保留原有全部字段**（含 error 原文、items、checks 等业务数据），只加
 * code / hint / retry 三个结构化字段。已有 code 的不动 —— 显式错误体优先。
 *
 * 注意不会误伤 `/vision/selftest` 这类「ok:false 但没有 error 字段」的自检结果：
 * 它是数据不是错误，界面要逐条显示 checks。
 */
export function normalizeFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (value.ok !== false || typeof value.error !== 'string' || value.code) return value
  const spec = FAILURES.BUSINESS_FAILED
  return { ...value, code: 'BUSINESS_FAILED', hint: spec.hint, retry: !!spec.retry }
}

/** 全部错误码，守卫与用例共用一份清单。 */
export const FAILURE_CODES = Object.freeze(Object.keys(FAILURES))

/**
 * 构造一个错误体。
 *
 * @param {string} code   FAILURES 里登记过的码；未知码不猜，统一降级到 INTERNAL
 * @param {{message?:string, detail?:string, field?:string, retry?:boolean, [k:string]:unknown}} [extra]
 *   detail 用来带上「哪一类 / 哪个 op」这种具体值，会拼在中文说明后面。
 */
export function failure(code, extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(FAILURES, code)
  const spec = FAILURES[known ? code : 'INTERNAL']
  const detail = String(extra.detail ?? '').trim()
  const message = String(extra.message ?? (spec.message + (detail ? '：' + detail : '')))
  const out = {
    ok: false,
    error: message,
    code: known ? code : 'INTERNAL',
    hint: spec.hint,
    retry: extra.retry === undefined ? !!spec.retry : !!extra.retry,
  }
  const field = extra.field === undefined ? spec.field : extra.field
  if (field) out.field = String(field)
  // 未知码不能悄悄吞掉：把原码留下来，日志里能看出是哪一处没登记。
  if (!known) out.unknownCode = String(code || '')
  // 允许调用方附带上下文（例如批量保存里是哪一项失败了）。
  for (const [key, value] of Object.entries(extra)) {
    if (['message', 'detail', 'field', 'retry'].includes(key)) continue
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 异常对象 → 错误体。保留原始报错文字，别让它变成一句笼统的「出错了」。 */
export function failureFrom(error, code = 'INTERNAL', extra = {}) {
  return failure(code, {
    ...extra,
    message: String(error?.message || error || FAILURES.INTERNAL.message),
  })
}
