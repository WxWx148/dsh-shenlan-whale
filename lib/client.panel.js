/**
 * lib/client.panel.js — 浏览器那一半：把「深蓝鲸」挂进 DSH 的左侧，并画出整个控制台。
 *
 * 这个文件不是普通模块，它在浏览器里由宿主的模块加载器执行，所以形状是固定的：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 里面能 require 的只有宿主已经加载过的共享包 —— 这里只用了 react，
 * 图标是内联 SVG，样式是内联 <style>，不引任何第三方库：少一个依赖就少一处装不上。
 *
 * 页面结构（区域 → 模块 → 详情）：
 *   左栏十个区域 → 区域页是一格格模块卡（可按 section 分段）→ 点卡片进详情，详情顶部有返回。
 *   这条「点得进去」的路必须由数据驱动：模块卡上的 detail id 就是详情请求的 id，
 *   所以后端加了模块却没写详情时，界面会明确说「没有这个页面」，而不是点下去没反应。
 *
 * 什么**不**在这里做：
 *   · 不算业务判断。「能用了没有」「第几版权重」「谁在跟谁聊」全部由宿主算好
 *     （view/panel-view.mjs），这里只把字段摆到屏幕上。前端一旦开始算数，
 *     就会长出第二套口径，最后两边说的不一样。
 *   · 不碰全局。不改 body、不写全局 CSS、不带 !important。
 *     所有类名以 slj- 开头，只有一个 <style data-plugin-css> 标签。
 */
window.__ModuleLoader__.load({
  id: 'dsh-shenlan-whale',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    /** 面板 id：左栏入口与主面板槽位必须用同一个，否则点了会「选中但没内容」 */
    const PANEL_ID = 'shenlan'
    /** 宿主路由前缀，与 index.js 的 ROUTE_PREFIX 一致 */
    const API = '/api/shenlan'
    /** 面板事件流。用它替掉每 5 秒一次的整包轮询；断线时自动降级，见 SSE 那段 */
    const ES_URL = API + '/events'
    /** 界面偏好（当前区域 / 是否收起 / 宽度）。换机器不同步，这是本机外观 */
    // 本地偏好（当前分区 / 是否收起 / 宽度）。
    //
    // v3：页面从 10 并到 6，布局也从"单栏替换"改成"宽屏三栏 / 窄屏两段"。
    // 旧偏好里的 region 能靠别名翻译，但 collapsed / width 这套组合在新布局下
    // 没有对应的意义（比如上次收起了侧栏，重开就只剩图标，而"为什么要展开"没人知道）。
    // 一次性回落到默认值，比留着半套失效的偏好强。
    const STORE_KEY = 'slj.panel.v3'

    /**
     * 这里以前有两份兜底：一份十个页面的清单（FALLBACK_NAV），一份侧栏几何
     * （FALLBACK_LAYOUT），理由都是"第一帧别空着/别闪"。
     *
     * 代价是：页面从 10 并成 6 之后，这两份没人改就成了"界面上的第七个页面" ——
     * 点进去是空的，而代码里看起来一切正常。两处数字对不上也不会有任何报错。
     *
     * 现在第一帧交给**骨架**（几行灰条）和 CSS 里的默认宽度：
     * 页面清单只有 taxonomy.REGIONS 一份，几何只有 panel-view.SIDEBAR 一份，
     * 都由 /panel 下发。浏览器里不再有第二份。
     */

    // ── 样式 ────────────────────────────────────────────────────
    // 全部走宿主的主题 token（--dsw-*），所以浅色/深色、换皮肤都跟着变。
    const CSS = [
      '.slj-root{display:flex;height:100%;min-height:0;box-sizing:border-box;overflow:hidden;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);',
      'font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px}',
      '.slj-root *{box-sizing:border-box}',

      // 侧边栏：宽度只由 --slj-nav-w 决定，展开/收起只是换这个值
      '.slj-nav{--slj-nav-w:248px;flex:0 0 auto;width:var(--slj-nav-w);height:100%;display:flex;flex-direction:column;',
      'padding:10px 10px 8px;border-right:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));overflow:hidden}',
      '.slj-root[data-slj-rail="true"] .slj-nav{--slj-nav-w:56px;padding:10px 10px 8px}',
      '.slj-root[data-slj-compact="true"] .slj-nav{--slj-nav-w:56px}',

      '.slj-brand{display:flex;align-items:center;gap:8px;height:36px;padding:0 6px;margin-bottom:10px;flex:none;overflow:hidden}',
      '.slj-mark{flex:none;width:24px;height:24px;border-radius:var(--dsw-radius-sm);display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font-size:13px;font-weight:600}',
      '.slj-brandText{min-width:0;display:flex;flex-direction:column;line-height:16px}',
      '.slj-brandName{font-size:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap}',
      '.slj-brandSub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.slj-build{flex:none;margin:-4px 10px 8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);font-size:11.5px;line-height:16px;',
      'border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-state-warn-label);cursor:default}',
      '.slj-build[data-tone="bad"]{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.slj-root[data-slj-rail="true"] .slj-build,.slj-root[data-slj-compact="true"] .slj-build{display:none}',
      '.slj-ver{flex:none;margin:-6px 6px 8px;font-size:10.5px;font-family:var(--dsw-font-family-mono,monospace);color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
      '.slj-root[data-slj-rail="true"] .slj-ver,.slj-root[data-slj-compact="true"] .slj-ver{display:none}',

      // 列表可滚、底部固定：条目多起来时（比如加了分组标题），如果列表不滚，
      // 它会把底部的状态点与「展开侧边栏」挤出可视区 —— 收起之后就再也点不回去。
      '.slj-navList{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}',
      '.slj-navList::-webkit-scrollbar{width:6px}',
      '.slj-navList::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:3px}',
      // 第一帧的占位灰条。它不假装自己是导航（没有文字、没有图标），
      // 只是让左栏不空 —— 空侧栏会让人以为插件没装上。
      '.slj-skelRow{height:34px;margin:2px 6px;border-radius:var(--dsw-radius-md);',
      'background:linear-gradient(90deg,var(--dsw-alias-interactive-bg-hover) 25%,transparent 37%);',
      'background-size:400% 100%;animation:sljSkel 1.4s ease infinite}',
      '@keyframes sljSkel{0%{background-position:100% 50%}100%{background-position:0 50%}}',
      '.slj-navRow{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 8px;margin:0;',
      'border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
      'font:inherit;text-align:left;cursor:pointer;overflow:hidden}',
      '.slj-navRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-navRow[aria-current="page"]{background:var(--dsw-alias-interactive-bg-hover);font-weight:500}',
      // 侧栏按四段收敛：段标题只做分组，不占一个可点的入口
      '.slj-navSection{padding:10px 10px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
      '.slj-progress{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.slj-progressDot{width:6px;height:6px;border-radius:3px;flex:none;background:var(--dsw-alias-state-business-primary)}',
      '.slj-debugOut{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:20px}',
      '.slj-debugOutRow{display:flex;justify-content:space-between;gap:12px}',
      '.slj-navRow:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.slj-navGlyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}',
      '.slj-navRow[aria-current="page"] .slj-navGlyph{color:var(--dsw-alias-label-primary)}',
      '.slj-navLabel{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}',
      '.slj-navBadge{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:11px;line-height:18px;text-align:center;',
      // 角标用「深底浅字」：明暗两套主题里都是最高对比，不需要再挑颜色
      'background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-inverted)}',
      '.slj-root[data-slj-rail="true"] .slj-navRow,.slj-root[data-slj-compact="true"] .slj-navRow{justify-content:center;width:36px;height:36px;padding:0;margin:0 auto}',
      '.slj-root[data-slj-rail="true"] .slj-navLabel,.slj-root[data-slj-compact="true"] .slj-navLabel,',
      '.slj-root[data-slj-rail="true"] .slj-brandText,.slj-root[data-slj-compact="true"] .slj-brandText,',
      '.slj-root[data-slj-rail="true"] .slj-navBadge,.slj-root[data-slj-compact="true"] .slj-navBadge{display:none}',
      '.slj-root[data-slj-rail="true"] .slj-brand,.slj-root[data-slj-compact="true"] .slj-brand{justify-content:center;padding:0}',

      '.slj-navFoot{padding-top:8px;flex:none;display:flex;flex-direction:column;gap:6px}',
      '.slj-state{display:flex;align-items:center;gap:6px;padding:0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden}',
      '.slj-dot{width:6px;height:6px;border-radius:3px;flex:none;background:var(--dsw-alias-state-idle-primary)}',
      '.slj-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}',
      '.slj-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}',
      '.slj-dot[data-tone="bad"]{background:var(--dsw-alias-state-error-primary)}',
      // 轨道态只剩一个点：文字留着会被 36px 的栏裁掉半截，看着像坏了
      '.slj-root[data-slj-rail="true"] .slj-state,.slj-root[data-slj-compact="true"] .slj-state{justify-content:center;padding:0}',
      '.slj-root[data-slj-rail="true"] .slj-stateText,.slj-root[data-slj-compact="true"] .slj-stateText{display:none}',
      '.slj-root[data-slj-rail="true"] .slj-navFoot,.slj-root[data-slj-compact="true"] .slj-navFoot{align-items:center}',

      '.slj-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;padding:0;',
      'border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.slj-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-iconBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',

      '.slj-grip{flex:0 0 6px;width:6px;cursor:col-resize;background:transparent}',
      '.slj-grip:hover{background:var(--dsw-alias-border-l2)}',
      '.slj-root[data-slj-rail="true"] .slj-grip,.slj-root[data-slj-compact="true"] .slj-grip{display:none}',

      // 正文
      '.slj-body{flex:1;min-width:0;min-height:0;overflow:hidden;overflow-x:hidden}',
      '.slj-inner{height:100%;max-width:1120px;margin:0 auto;padding:22px clamp(16px,3vw,32px) 20px;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.slj-content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:10px}',
      // 内容区的宽度约束。浏览器里最常见的一种"右边被切掉"，
      // 起因不是某个元素写死了宽度，而是 flex 子项的 min-width 默认是 auto：
      // 里面有一个不肯换行的短行（键名、单位、长单词），整列就被撑到超出容器，
      // 而外层 overflow:hidden 把多出来的部分直接剪掉，连横向滚动条都不给。
      '.slj-content>*{min-width:0;max-width:100%}',
      '.slj-content>*{min-height:0}',
      '.slj-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;justify-content:space-between;margin-bottom:6px}',
      '.slj-headMain{min-width:0}',
      '.slj-crumb{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}',
      '.slj-back{border:none;background:transparent;padding:0;color:var(--dsw-alias-link);cursor:pointer;font:inherit;font-size:12px}',
      '.slj-back:hover{text-decoration:underline}',
      '.slj-title{margin:0;font-size:20px;line-height:26px;font-weight:600;letter-spacing:.01em}',
      '.slj-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.slj-rule{height:1px;background:var(--dsw-alias-border-l2);margin:14px 0 18px}',

      // 模块卡：区域页的主体。整块可点，hover 有反馈，键盘也能选中
      '.slj-mods{display:flex;flex-direction:column;gap:1px}',
      // 分组标题只在小标题有意义时出现；没有 section 的区域不会多出一层空行
      '.slj-modSection{margin-bottom:12px}',
      '.slj-modSection:last-child{margin-bottom:0}',
      '.slj-modSectionHead{margin:0 0 8px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
      '.slj-rowGroup{margin:14px 0 8px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}',
      '.slj-rowGroup:first-child{margin-top:0}',
      '.slj-split{display:flex;gap:12px;min-height:0;flex:1 1 0;align-items:stretch}',
      '.slj-splitSide{flex:0 0 240px;min-width:180px;max-width:300px;display:flex;flex-direction:column;gap:1px;overflow:auto;padding-right:6px}',
      '.slj-split[data-slj-wide="true"] .slj-splitSide{flex:0 0 272px;max-width:320px}',
      '.slj-splitMain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:auto}',
      // 窄屏版左栏：不再是一条 240 的窄条，而是整页宽的一列（对话页用）
      '.slj-splitSideFull{flex:1 1 auto;max-width:none;min-width:0;padding-right:0}',
      // 窄屏对话页：一屏一件事 —— 列表占满，或对话占满，靠返回键来回。
      // 两条都必须 min-height:0，否则内部滚动区会把整页顶高，
      // 输入框被推到窗口外面（这就是"窄的时候发不出消息"的真正原因）。
      '.slj-talkList{display:flex;flex-direction:column;min-height:0;height:100%;overflow:auto;gap:6px}',
      '.slj-talkPage{display:flex;flex-direction:column;min-height:0;flex:1 1 0}',
      '.slj-talkPage .slj-splitMain{flex:1 1 0}',
      // 聊天页自己管滚动（消息区滚、输入框常驻），外层就别再滚一遍 ——
      // 两层滚动叠在一起时，滚轮到底了输入框还没出现，看起来像"发不出去"。
      //
      // 更根本的是高度链：content 本来是「可滚动的 flex 列」，里面的 flex 子项
      // 在这种容器里拿不到确定高度，flex:1 会一层层退化成内容高度，整条消息流
      // 就把输入框推到屏幕外。改成「content 当定位上下文 + 聊天页 absolute
      // inset:0」之后，高度只有一个来源，不再靠祖先链一层层传。
      '.slj-content:has(.slj-chatWrap){display:block;position:relative;overflow:hidden;gap:0}',
      // 聊天页只该让「窄屏单页」走纵向；宽屏的 .slj-split 必须是左右分栏。
      // 以前两条选择器共用 flex-direction:column，宽屏一打开会话就被上下堆叠：
      // 会话列表只剩很矮一截，聊天区跑到下面（截图里的错位）。
      '.slj-content:has(.slj-chatWrap)>.slj-talkPage{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0}',
      '.slj-content:has(.slj-chatWrap)>.slj-split{position:absolute;inset:0;display:flex;flex-direction:row;min-height:0}',
      '.slj-content:has(.slj-chatWrap) .slj-splitMain{flex:1 1 0;min-height:0;overflow:hidden}',
      '.slj-content:has(.slj-chatWrap) .slj-chatWrap{flex:1 1 0;min-height:0;display:flex;flex-direction:column}',
      '.slj-content:has(.slj-chatWrap) .slj-thread{flex:1 1 auto;min-height:0;overflow-y:auto}',
      // 左栏是「目录」，不是「卡片」：13 项各描一圈边，视线就被切成 13 个盒子。
      // 去掉边框、只留 hover 底色；选中项用左侧竖条标出，不靠换边框颜色。
      '.slj-splitRow{display:flex;flex-direction:column;gap:1px;width:100%;padding:8px 10px;text-align:left;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.slj-splitRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-splitRow[aria-current="true"]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}',
      '.slj-splitRow b{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.slj-splitRow small{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.slj-root[data-slj-compact="true"] .slj-modDesc{display:none}',
      // 列表行，不是卡片：一张卡占 240px 宽 × 78px 高，一屏只放得下 12 个；
      // 一行 40px 能放 20 个，而且「标题 / 一句说明 / 状态」三件事的视线是一条直线。
      // 卡片墙只适合「数量少、每个都要看见图」的场合，这里不属于。
      '.slj-mod{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;text-align:left;',
      'border:none;border-radius:var(--dsw-radius-md);background:transparent;',
      'color:inherit;font:inherit;cursor:pointer}',
      '.slj-mod:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-mod:active{background:var(--dsw-alias-interactive-bg-pressed,var(--dsw-alias-interactive-bg-hover))}',
      '.slj-mod:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.slj-modGlyph{flex:none;width:24px;height:24px;border-radius:var(--dsw-radius-sm);display:flex;align-items:center;justify-content:center;',
      'color:var(--dsw-alias-label-secondary)}',
      '.slj-modMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}',
      '.slj-modTitle{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500}',
      '.slj-modDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.slj-modArrow{flex:none;color:var(--dsw-alias-label-tertiary);align-self:center}',

      '.slj-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-bottom:16px}',
      '.slj-root[data-slj-compact="true"] .slj-tiles{grid-template-columns:1fr}',
      '.slj-tile{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-settings-card-fill);border:.5px solid var(--dsw-alias-settings-card-stroke)}',
      '.slj-tileLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.slj-tileValue{font-size:18px;line-height:24px;font-weight:600;word-break:break-word}',
      '.slj-tileHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.slj-tile[data-tone="ok"] .slj-tileValue{color:var(--dsw-alias-state-success-primary)}',
      '.slj-tile[data-tone="warn"] .slj-tileValue{color:var(--dsw-alias-state-warn-primary)}',
      '.slj-tile[data-tone="bad"] .slj-tileValue{color:var(--dsw-alias-state-error-primary)}',

      '.slj-group{margin:14px 0 22px}',
      '.slj-groupHead{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
      '.slj-groupLabel{font-size:14px;font-weight:600}',
      '.slj-groupDesc{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.slj-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:8px 0 0}',
      // 审计页的过滤胶囊：一行放得下四个档位，选中态用底色而不是加粗（加粗会让行高跳）
      '.slj-chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}',
      '.slj-chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:999px;',
      'padding:3px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.slj-chip[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.slj-chip:disabled{opacity:.5;cursor:default}',

      // 设置页顶部的搜索条：123 项平铺时，「记得有这么一个开关但不知道在哪组」是常态
      '.slj-formBar{display:flex;align-items:center;gap:8px;position:sticky;top:0;z-index:2;',
      'padding:6px 0 8px;background:var(--dsw-alias-bg-base)}',
      '.slj-formBar .slj-input{flex:1;min-width:0}',

      // 吸底保存条：只有存在草稿才出现。不常驻，就不用解释"这个灰按钮是干嘛的"
      '.slj-dirtyBar{position:sticky;bottom:-2px;z-index:3;display:flex;align-items:center;gap:8px;',
      'margin-top:12px;padding:10px 12px;border-radius:var(--dsw-radius-md);',
      'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 -6px 16px -8px rgba(0,0,0,.28)}',
      '.slj-dirtyText{flex:1;font-size:13px;color:var(--dsw-alias-label-secondary)}',

      // 只读项折叠：27 行不能动的东西混在可改项里，会让人以为"这里也能改，只是没找到开关"
      '.slj-roGroup{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.slj-roToggle{display:flex;align-items:center;gap:4px;width:100%;padding:6px 4px;border:none;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}',
      '.slj-roToggle:hover{color:var(--dsw-alias-label-primary)}',
      '.slj-roCaret{font-size:10px;line-height:1}',

      '.slj-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md);',
      'min-width:0;max-width:100%;',
      'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);margin-bottom:8px}',
      '.slj-row[data-open="true"]{cursor:pointer}',
      '.slj-row[data-open="true"]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.slj-rowTitle{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;font-weight:500}',
      // 生效时机常态用小字：123 行都套角标会把标题栏铺成一片色块，
      // 反而没人看得见真正要动手的「重启后生效」。
      '.slj-effect{font-size:11px;font-weight:400;letter-spacing:.01em;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.slj-rowText{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.slj-rowSide{flex:none;display:flex;align-items:center;gap:8px}',
      '.slj-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',

      '.slj-chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--dsw-radius-xs);',
      'font-size:11px;line-height:20px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.slj-chip[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.slj-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-label)}',
      '.slj-chip[data-tone="bad"]{color:var(--dsw-alias-state-error-primary)}',

      '.slj-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);',
      'border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.slj-btn:hover{background:var(--dsw-alias-button-floating-hover)}',
      '.slj-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.slj-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
      '.slj-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',

      '.slj-switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:none;border-radius:10px;cursor:pointer;',
      'background:var(--dsw-alias-state-idle-primary);transition:background .15s var(--ds-ease-in-out,ease)}',
      '.slj-switch[data-on="true"]{background:var(--dsw-alias-state-success-primary)}',
      '.slj-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:var(--dsw-alias-switch-thumb,#fff);',
      'transition:transform .15s var(--ds-ease-in-out,ease)}',
      '.slj-switch[data-on="true"] .slj-knob{transform:translateX(14px)}',
      '.slj-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

      '.slj-input,.slj-select,.slj-area{width:100%;min-width:0;max-width:100%;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);',
      'border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px}',
      '.slj-area{height:auto;min-height:64px;padding:6px 8px;line-height:18px;resize:vertical}',
      '.slj-input:focus-visible,.slj-select:focus-visible,.slj-area:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.slj-field{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0;max-width:100%}',
      '.slj-field[data-wide="true"]{align-items:stretch;flex-direction:column}',
      '.slj-field[data-wide="true"] .slj-btn{align-self:flex-start}',

      '.slj-banner{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;margin-bottom:14px;border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-interactive-bg-hover);border-left:3px solid var(--dsw-alias-state-warn-primary);',
      'color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}',
      '.slj-banner[data-tone="bad"]{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',

      '.slj-empty{padding:28px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}',

      // 聊天窗口
      // 结构：chatWrap（撑满高度，flex 列）→ thread（自己滚）/ composer（常驻底部）。
      //
      // 以前 composer 用 position:sticky;bottom:0，但它的包含块（这一整页的消息流）
      // 比可视区高，所以它"贴"的是消息流的底部，不是屏幕的底部 ——
      // 结果是输入框被推到几屏之外，看起来像"这一页根本没法说话"。
      // 高度一律用 flex 摊开，不用 height:100%：
      // 百分比高度要穿过「flex 容器 → flex:1 → 子项」这条链才成立，
      // 中间哪一层的高度算不出来，整条链就退化成 auto ——
      // 表现就是输入框被推到消息流底部，几屏之外，看着像"这页没法说话"。
      '.slj-chatWrap{position:relative;display:flex;flex-direction:column;min-height:0;flex:1 1 0}',
      // 底部留一条输入栏的高度：消息滚到底时，最后一条才不会被输入栏压住。
      '.slj-thread{display:flex;flex-direction:column;gap:8px;margin:4px 0 10px;padding-bottom:112px;flex:1 1 auto;min-height:0;overflow-y:auto}',
      '.slj-threadEmpty{flex:1 1 auto;min-height:0}',
      '.slj-msg{display:flex;max-width:100%}',
      '.slj-msg[data-self="true"]{justify-content:flex-end}',
      // 聊天「不要气泡」：仿 QQ 的简洁消息流，不画圆角背景块。
      // 身份靠三样东西区分 —— 对方靠左/自己靠右、上方名字、文字颜色；
      // 读起来像在聊天，而不是在看一堆卡片。
      '.slj-bubble{max-width:100%;padding:1px 2px;font-size:14px;line-height:22px;',
      'white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.slj-msg[data-self="true"] .slj-bubble{color:var(--dsw-alias-state-business-primary)}',
      // 引用：像 QQ 那样在正文上方留一小块「原话」，不能只显示一个 replyId
      '.slj-quote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'border-left:2px solid var(--dsw-alias-label-tertiary);padding-left:6px;margin:0 0 3px;',
      'white-space:pre-wrap;word-break:break-word;opacity:.85}',
      '.slj-msg[data-self="true"] .slj-quote{text-align:left}',
      // 引用默认只露两行，想看完整原话点一下 —— 但不能只给摘要就算完
      '.slj-quoteText{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.slj-quote[data-open="true"] .slj-quoteText{display:block;-webkit-line-clamp:unset;overflow:visible}',
      '.slj-quoteBtn{border:none;background:transparent;padding:0 0 0 4px;font:inherit;font-size:12px;',
      'color:var(--dsw-alias-link);cursor:pointer}',
      '.slj-quoteBtn[disabled]{opacity:.5;cursor:default}',
      '.slj-who{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}',
      '.slj-msg[data-self="true"] .slj-who{text-align:right}',
      // 输入栏贴在聊天区底部，不吃 flex 高度链：
      // 上面任何一层算不出确定高度时，普通流里的输入栏就会被消息流顶到屏幕外，
      // 而 absolute + 实底 + z-index 保证它始终在聊天区的可视底部、盖在消息之上。
      '.slj-composer{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;flex-direction:column;gap:6px;',
      'padding:10px 0 4px;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l2)}',
      '.slj-composerRow{display:flex;gap:8px;align-items:flex-end}',
      '.slj-composer .slj-area{min-height:56px}',
      '.slj-loadmore{align-self:center}',

      '.slj-toast{position:sticky;bottom:12px;margin:16px auto 0;max-width:560px;padding:8px 12px;border-radius:var(--dsw-radius-md);',
      'font-size:12px;line-height:18px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);',
      'box-shadow:var(--dsw-elevation-soft,0 4px 16px rgba(0,0,0,.12))}',
      '.slj-toast[data-tone="bad"]{background:var(--dsw-alias-state-error-primary);color:#fff}',
      '.slj-toast[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary,#b26a00);color:#fff}',

      // ── 沙箱确认弹窗 ──────────────────────────────────────────
      // 盖住整页而不是只盖内容区：这个确认的对象是「执行器要动手」，
      // 它比面板里任何一页都重要，用户不该在它下面继续点别的。
      '.slj-askMask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;',
      'padding:20px;background:rgba(10,16,30,.34)}',
      '.slj-ask{width:min(580px,100%);max-height:calc(100vh - 56px);overflow:auto;border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);',
      'box-shadow:0 18px 48px rgba(0,0,0,.22);padding:16px 18px 14px}',
      '.slj-askHead{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
      '.slj-askGlyph{flex:none;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-state-warn-primary,#b26a00);color:#fff}',
      '.slj-askTitle{font-size:15px;font-weight:600;line-height:22px}',
      '.slj-askSub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.slj-askTimer{flex:none;margin-left:auto;font-family:var(--dsw-font-family-mono,monospace);font-size:13px;',
      'font-weight:600;color:var(--dsw-alias-state-warn-primary,#b26a00)}',
      '.slj-askBar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:2px 0 12px}',
      '.slj-askBarFill{height:100%;background:var(--dsw-alias-state-warn-primary,#b26a00);transition:width .25s linear}',
      '.slj-askPlan{margin:0 0 10px;padding-left:18px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.slj-askCode{margin:0 0 12px;padding:10px 12px;max-height:220px;overflow:auto;border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2);',
      'font-family:var(--dsw-font-family-mono,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}',
      '.slj-askFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.slj-askFoot .slj-grow{flex:1 1 auto}',
      '.slj-askCheck{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.slj-btn[data-variant="danger"]{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}',
      '.slj-askHint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:8px}',

      '@media (prefers-reduced-motion:reduce){.slj-nav,.slj-switch,.slj-knob{transition:none}}',
    ].join('')

    /**
     * 样式注入：一次生命周期内只做一次，但**内容变了要替换**。
     *
     * 这里原来写的是「标签已存在就直接 return」，注释还写着"热重载时换掉旧标签" ——
     * 代码和注释说的不是一回事。后果很具体：插件重载、宿主重启之后，
     * document.head 里那份旧 CSS 还在，新样式永远进不来，
     * 于是"改了代码、重启了、界面一点没变"。
     *
     * 现在按内容判断：同一份 CSS 不动；换了内容就改写现有标签（不叠第二份）。
     */
    let injectedCss = ''
    function injectStyle() {
      if (typeof document === 'undefined') return
      if (injectedCss === CSS) return
      const tagId = 'dsh-shenlan-whale/panel.css'
      const selector = 'style[data-plugin-css="' + tagId + '"]'
      const existing = document.querySelector(selector)
      if (existing) {
        existing.textContent = CSS
      } else {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-shenlan-whale'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      injectedCss = CSS
    }

    // ── 小工具 ──────────────────────────────────────────────────

    /** 读本机外观偏好。localStorage 在隐私模式会抛异常，读不到就当没存过 */
    function readStore() {
      const fallback = { region: '', collapsed: false, width: 0 }
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return fallback
        const value = JSON.parse(raw)
        return {
          region: typeof value.region === 'string' ? value.region : '',
          collapsed: value.collapsed === true,
          width: Number(value.width) > 0 ? Number(value.width) : 0,
        }
      } catch {
        return fallback
      }
    }

    function writeStore(value) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
      } catch {
        // 存不了就算了：这只是外观，不该因为它把页面弄崩
      }
    }

    /** 统一的取数口。HTTP 200 也可能是业务失败，所以 ok 也要看 */
    // 配置修订号：任何响应都带。它变了说明配置被改动过 —— 可能就是这次保存，
    // 也可能是另一个面板窗口、QQ 里一句「说话短一点」、工具改配置、
    // 或有人直接改了 config.json 点了重载。以前界面只能靠 5 秒轮询重拉主数据，
    // 已经点开的详情页永远停在旧值，除非手动切走再切回来。
    // 现在由它统一驱动刷新：主数据、当前详情、所有关联区块一起跟上。
    let seenRevision = null
    let onRevisionChange = null
    // 并发保存计数：区分「这次变化是我自己发起的」和「别处改的」。
    // 自己保存时只清掉刚提交那一项的草稿；别处改配置时，手里按旧值填的
    // 所有草稿都必须作废，否则一提交就把别人刚改的值覆盖回去。
    let localConfigWrites = 0

    /**
     * 前端自己的版本标记。
     *
     * 用途只有一个：让**后端**能回答「页面里跑的是哪一版前端」。
     * 之前排查「改了没变化」时，没有任何办法确认这一点 —— 界面不变，
     * 既可能是副本旧、也可能是宿主缓存旧，只能靠猜。现在每次拉面板都带上它，
     * 命令行 curl 一下就知道前端有没有换成新的。
     *
     * 取值用样式表长度：改样式（最常见的改动）必然会变，不用手工维护版本号。
     */
    const CLIENT_REV = 'css' + String(CSS.length)

    /**
     * 统一错误体在前端的唯一处理点。
     *
     * 宿主给的是 { ok:false, error:'中文人话', code, hint, field, retry }。
     * error **保持字符串**（界面 30+ 处直接把它显示出来），hint 指出「去哪改」。
     * 在这里把 hint 拼进那句话，所有调用点不用改就能看到完整提示；
     * code / hint / field / retry 原样留着，将来按码分支不用再改数据层。
     */
    function readableError(body, fallback) {
      const message = String((body && body.error) || fallback || '没成功')
      const hint = body && typeof body.hint === 'string' ? body.hint : ''
      if (!hint || message.includes(hint)) return message
      return message + ' · ' + hint
    }

    async function api(path, init) {
      const res = await fetch(API + path, {
        ...init,
        // charset 写全：JSON 本来就该是 UTF-8，但少写一次就多一次「中文变问号」的机会
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
      let body = null
      try {
        body = await res.json()
      } catch {
        throw new Error('宿主没有返回 JSON，可能路由没挂上')
      }
      // 200 但 ok:false 的业务错误（发消息、改记忆…）也在这里归一：
      // 各处 say(result.error) 拿到的已经带上「去哪改」，不会只剩一句「没改成」。
      if (body && body.ok === false && typeof body.error === 'string') {
        body.error = readableError(body)
      }
      if (!res.ok) throw new Error(readableError(body, '宿主返回 ' + res.status))
      const revision = body && typeof body.revision === 'number' ? body.revision : null
      // 第一次只记下基线，不触发刷新（首帧本来就在拉数据）。
      // 之后只要和上次见到的不同就通知一次，连续多次改配置会各自触发，
      // 不会因为合并而漏掉中间状态。
      if (revision !== null && seenRevision !== null && revision !== seenRevision && onRevisionChange) onRevisionChange()
      if (revision !== null) seenRevision = revision
      return body || {}
    }

    /** 写操作统一入口：op 是动作名，args 是原来那份 body。 */
    async function action(op, args) {
      return api('/action', { method: 'POST', body: JSON.stringify({ op, args }) })
    }

    function clampWidth(value, min, max) {
      const n = Math.round(Number(value) || 0)
      if (!Number.isFinite(n) || n <= 0) return 0
      return Math.min(max, Math.max(min, n))
    }

    // ── 图标 ────────────────────────────────────────────────────
    // 内联 SVG，不引图标库：少一个包就少一处「装不上」。
    const ICON_PATHS = {
      pulse: ['M3 12h4l2.4-7 3.6 14 2.4-7H21'],
      chat: ['M4 5.5h16v10H9l-5 4z', 'M8 9h8', 'M8 12.5h5'],
      grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
      spark: ['M12 3.5l2.3 5.9 5.9 2.3-5.9 2.3L12 20l-2.3-6-5.9-2.3 5.9-2.3z'],
      coin: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M9.4 9.6h5.2', 'M9.4 14.4h5.2', 'M12 7.8v8.4'],
      plug: ['M9 3v5.5', 'M15 3v5.5', 'M6 8.5h12v2.2a6 6 0 0 1-12 0z', 'M12 16.7V21'],
      layers: ['M12 3.5l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 16.5l8 4 8-4'],
      sliders: ['M4 7h8', 'M17 7h3', 'M4 17h3', 'M12 17h8', 'M15 5.5v3', 'M9 15.5v3'],
      chevronLeft: ['M14.5 6l-6 6 6 6'],
      chevronRight: ['M9.5 6l6 6-6 6'],
      arrowRight: ['M6 12h11', 'M13 7l5 5-5 5'],
      refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4h-4'],
      fish: ['M4 12c3.2-4.4 8.2-5.6 12-3.2 1.6 1 2.6 2.4 3.2 3.2-.6.8-1.6 2.2-3.2 3.2-3.8 2.4-8.8 1.2-12-3.2z', 'M15.6 9.8h.01'],
      shield: ['M12 3.2l7 2.8v5.1c0 4.3-2.9 7.8-7 9.7-4.1-1.9-7-5.4-7-9.7V6z', 'M9 12l2 2 4-4.2'],
    }

    function Icon({ name, size }) {
      const paths = ICON_PATHS[name] || ICON_PATHS.pulse
      const px = size || 18
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    // ── 原子组件 ────────────────────────────────────────────────

    function Tile({ tile }) {
      return h(
        'div',
        { className: 'slj-tile', 'data-tone': tile.tone || 'idle' },
        h('div', { className: 'slj-tileLabel' }, tile.label),
        h('div', { className: 'slj-tileValue' }, tile.value === '' || tile.value === undefined ? '—' : String(tile.value)),
        tile.hint ? h('div', { className: 'slj-tileHint' }, tile.hint) : null,
      )
    }

    function Chip({ tone, children }) {
      return h('span', { className: 'slj-chip', 'data-tone': tone || 'idle' }, children)
    }

    function Toast({ toast }) {
      if (!toast) return null
      return h('div', { className: 'slj-toast', 'data-tone': toast.tone || 'ok', role: 'status' }, toast.text)
    }

    function Banner({ tone, children }) {
      return h('div', { className: 'slj-banner', 'data-tone': tone || 'warn', role: 'alert' }, children)
    }

    /**
     * 沙箱确认弹窗。
     *
     * 三条由后端定、这里只负责显示的东西：
     *   · 剩几秒 —— 用服务端的 expiresAt 算，不用本机自己倒数（两边时钟不一样时会飘）；
     *   · 超时是不是拒绝 —— 是。倒计时走完这里会代填「超时未确认」再提交一次，
     *     服务端也有一道兜底，所以面板关掉也不会卡住一次执行；
     *   · 记住之后还弹不弹 —— 不弹。这个结论由后端存，这里只显示当前这一次。
     *
     * 为什么把「拒绝理由」一直露在外面而不是点「取消」才弹出来：
     * 想拒绝的人第一眼就能看见地方写，超时那一刻它也有内容可记。
     */
    function AskDialog({ ask, leftMs, reason, remember, busy, onReason, onRemember, onAllow, onDeny }) {
      if (!ask) return null
      const total = Math.max(1, Number(ask.totalMs) || 1)
      const left = Math.max(0, Number(leftMs) || 0)
      const percent = Math.max(0, Math.min(100, Math.round((left / total) * 100)))
      const seconds = Math.ceil(left / 1000)
      const expired = left <= 0
      return h(
        'div',
        { className: 'slj-askMask' },
        h(
          'div',
          {
            className: 'slj-ask',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'slj-ask-title',
          },
          h(
            'div',
            { className: 'slj-askHead' },
            h('span', { className: 'slj-askGlyph', 'aria-hidden': 'true' }, h(Icon, { name: 'shield', size: 16 })),
            h(
              'div',
              null,
              h('div', { className: 'slj-askTitle', id: 'slj-ask-title' }, '要在这台机器上跑一段代码'),
              // 项目和目的必须写在最上面：只写「要跑一段代码」的确认，
              // 点同意的人其实不知道自己同意了什么
              h(
                'div',
                { className: 'slj-askSub' },
                '项目：' + String(ask.project || '深蓝鲸') + '　目的：' + String(ask.purpose || ask.label || '跑一段代码'),
              ),
            ),
            h('span', { className: 'slj-askTimer' }, expired ? '已超时' : seconds + 's'),
          ),
          h('div', { className: 'slj-askBar' }, h('div', { className: 'slj-askBarFill', style: { width: percent + '%' } })),
          ask.plan && ask.plan.length
            ? h('ol', { className: 'slj-askPlan' }, ask.plan.map((step, index) => h('li', { key: index }, String(step))))
            : null,
          h('pre', { className: 'slj-askCode' }, String(ask.code || '') + (ask.truncated ? '\n…（后面还有，完整代码在执行记录里）' : '')),
          h('input', {
            className: 'slj-input',
            placeholder: '拒绝理由（可选，一句话；会写进日志）',
            value: reason,
            maxLength: 140,
            disabled: busy === ask.id,
            onChange: (event) => onReason(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onDeny()
            },
          }),
          h(
            'div',
            { className: 'slj-askFoot', style: { marginTop: 10 } },
            h(
              'label',
              { className: 'slj-askCheck' },
              h('input', {
                type: 'checkbox',
                checked: remember,
                disabled: busy === ask.id,
                onChange: (event) => onRemember(event.target.checked),
              }),
              '记住我的选择',
            ),
            h('span', { className: 'slj-grow' }),
            h(
              'button',
              { type: 'button', className: 'slj-btn', 'data-variant': 'danger', disabled: busy === ask.id, onClick: onDeny },
              busy === ask.id ? '处理中…' : '取消并拒绝',
            ),
            h(
              'button',
              { type: 'button', className: 'slj-btn', 'data-variant': 'primary', disabled: busy === ask.id, onClick: onAllow },
              '确认执行',
            ),
          ),
          h(
            'div',
            { className: 'slj-askHint' },
            '倒计时走完按拒绝处理（不会执行）；「记住我的选择」会一直生效，随时可在「过程 → 沙箱确认」里清掉。',
          ),
        ),
      )
    }

    /** 区域页的一张模块卡：整块可点，键盘也能进 */
    function ModuleCard({ module, onOpen }) {
      return h(
        'button',
        { type: 'button', className: 'slj-mod', onClick: () => onOpen(module.detail) },
        h('span', { className: 'slj-modGlyph' }, h(Icon, { name: module.icon || 'grid', size: 16 })),
        h(
          'span',
          { className: 'slj-modMain' },
          h(
            'span',
            { className: 'slj-modTitle' },
            h('span', null, module.label),
            module.badge ? h(Chip, { tone: module.tone }, module.badge) : null,
          ),
          module.desc ? h('span', { className: 'slj-modDesc', title: module.desc }, module.desc) : null,
        ),
        h('span', { className: 'slj-modArrow' }, h(Icon, { name: 'arrowRight', size: 16 })),
      )
    }

    /**
     * 把模块卡按 `section` 分成连续的小段。
     *
     * 十二张设置卡平铺像一堵墙；按「身份 / 表达 / 心智…」分段后，
     * 用户找的是「哪一类」而不是「第几张」。没有 section 的区域保持原样，
     * 不会平白多出一层空标题。
     */
    function moduleSections(modules) {
      const list = Array.isArray(modules) ? modules : []
      const groups = []
      for (const module of list) {
        const label = String(module.section || '')
        const last = groups[groups.length - 1]
        if (!last || last.label !== label) groups.push({ label, items: [module] })
        else last.items.push(module)
      }
      return groups
    }

    // ── 详情：四类渲染器 ────────────────────────────────────────

    function DetailCards({ detail }) {
      return h(
        'div',
        null,
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,
        h('div', { className: 'slj-tiles' }, (detail.cards || []).map((tile, index) => h(Tile, { key: index, tile }))),
        detail.note ? h('p', { className: 'slj-note' }, detail.note) : null,
      )
    }

    function TeachSkillForm({ onDone, notify }) {
      const [name, setName] = useState('')
      const [what, setWhat] = useState('')
      const [group, setGroup] = useState('do')
      const [busy, setBusy] = useState(false)
      const submit = async () => {
        const title = String(name || '').trim()
        if (!title) { notify('先给技能起个名字', 'bad'); return }
        setBusy(true)
        try {
          const result = await action('skill.teach', { name: title, what, group })
          if (result && result.ok) {
            notify(result.message || '技能已安装，默认是关着的')
            setName('')
            setWhat('')
            onDone()
          } else {
            notify((result && result.error) || '没装成', 'bad')
          }
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'slj-panel', style: { marginBottom: 10 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '安装技能'),
        h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 } }, '给深蓝鲸教一个新技能；安装后默认关闭，确认后再打开。'),
        h('div', { className: 'slj-field', 'data-wide': 'true' },
          h('input', { className: 'slj-input', placeholder: '技能名字，例如：每日一句', value: name, maxLength: 20, onChange: (e) => setName(e.target.value) }),
          h('input', { className: 'slj-input', placeholder: '它做什么（可选）', value: what, maxLength: 60, onChange: (e) => setWhat(e.target.value) }),
          h('select', { className: 'slj-input', value: group, onChange: (e) => setGroup(e.target.value) },
            [['talk', '说话'], ['know', '知道'], ['do', '动手'], ['net', '上网'], ['media', '看和听'], ['care', '照看']].map(([key, label]) => h('option', { key, value: key }, label)),
          ),
          h('button', { type: 'button', className: 'slj-btn', 'data-variant': 'primary', disabled: busy, onClick: submit }, busy ? '安装中…' : '安装技能'),
        ),
      )
    }

    function AddMemoryForm({ onDone, notify }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const submit = async () => {
        const value = String(text || '').trim()
        if (!value) return
        setBusy(true)
        try {
          const result = await action('memory.remember', { text: value })
          if (result && result.ok) {
            setText('')
            notify('记住了')
            onDone()
          } else {
            notify((result && result.error) || '没记住', 'bad')
          }
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { style: { display: 'flex', gap: 6, marginBottom: 10 } },
        h('input', { className: 'slj-input', placeholder: '手动记一条事实', value: text, onChange: (event) => setText(event.target.value) }),
        h('button', { type: 'button', className: 'slj-btn', disabled: busy || !text.trim(), onClick: submit }, busy ? '记着…' : '记住'),
      )
    }

    /**
     * 改一条记忆。
     *
     * 三处以前不顺手的地方：
     *   1. 标题只写「编辑」，改的是事实还是人物得自己回想；
     *   2. 输入框里是内容本身，看不出**原来是什么**，改了一半想撤回只能取消重来；
     *   3. 「保存」永远可点，于是「什么都没改也点一下」会写一次盘、记一条审计。
     */
    function MemoryEditForm({ row, onSave, onCancel }) {
      const isFact = row.action === 'edit-fact' || row.action === 'edit-self'
      const isPerson = row.action === 'edit-person'
      const [a, setA] = useState(isFact ? row.value || '' : row.title || '')
      const [b, setB] = useState('')
      const [c, setC] = useState('')
      const what = isFact ? (row.action === 'edit-self' ? '这条对自己的认识' : '这条事实') : isPerson ? '这个人' : '这个群'
      const firstLabel = isFact ? '内容' : isPerson ? '名字' : '群名'
      const secondLabel = isPerson ? '加一条备注（可空）' : '加一条群话题（可空）'
      const original = isFact ? String(row.value || '') : ''
      const next = String(a || '').trim()
      const dirty = next !== String(isFact ? original : row.title || '').trim() || String(b || '').trim() || String(c || '').trim()
      return h(
        'div',
        { className: 'slj-panel', style: { marginBottom: 10 } },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '改' + what),
        h('div', { className: 'slj-field', 'data-wide': 'true' },
          h('input', { className: 'slj-input', placeholder: firstLabel, value: a, autoFocus: true, onChange: (e) => setA(e.target.value) }),
          // 原值只在改动了之后才显示：没改的时候它就是框里的内容，重复一遍是噪音
          isFact && next && next !== original ? h('div', { className: 'slj-meta' }, '原来是：' + original) : null,
          !isFact && h('input', { className: 'slj-input', placeholder: secondLabel, value: b, onChange: (e) => setB(e.target.value) }),
          isPerson && h('input', { className: 'slj-input', placeholder: '印象（可空，例如：熟了、话少、爱开玩笑）', value: c, onChange: (e) => setC(e.target.value) }),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', className: 'slj-btn', onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'slj-btn',
                'data-variant': 'primary',
                disabled: !next || !dirty,
                onClick: () => onSave({ text: next, name: next, label: next, note: b, topic: b, impression: c }),
              },
              next && !dirty ? '还没改' : '保存',
            ),
          ),
        ),
      )
    }

    /**
     * 改一条教过的技能。
     *
     * 名字和说明分成两个框：以前只有一个「名字」，说明写错了永远改不掉。
     * 改的是同一条（id 不变），所以开关状态、用过几次、成功率都留着 ——
     * 这正是「忘掉重教」做不到的：它会换一个新 id，把履历清零。
     */
    function SkillEditForm({ row, onSave, onCancel }) {
      const [name, setName] = useState(String((row.skill && row.skill.name) || ''))
      const [what, setWhat] = useState(String((row.skill && row.skill.what) || ''))
      const broken = /^[?\uFFFD？]+$/.test(String(name || '').trim()) && String(name || '').trim().length > 1
      return h(
        'div',
        { className: 'slj-panel', style: { marginBottom: 10 } },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '改这条技能'),
        h(
          'div',
          { className: 'slj-field', 'data-wide': 'true' },
          h('input', { className: 'slj-input', placeholder: '名字（会显示在技能页和「你会什么」里）', value: name, onChange: (e) => setName(e.target.value) }),
          h('input', { className: 'slj-input', placeholder: '一句话说明它会做什么（可空）', value: what, onChange: (e) => setWhat(e.target.value) }),
          broken ? h('div', { className: 'slj-meta' }, '名字还是一串问号，换一个中文名再保存') : null,
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', className: 'slj-btn', onClick: onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'slj-btn',
                'data-variant': 'primary',
                disabled: broken || !String(name || '').trim(),
                onClick: () => onSave({ name: String(name || '').trim(), what: String(what || '').trim() }),
              },
              '保存',
            ),
          ),
        ),
      )
    }

    function VisionPanel({ detail }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = async () => {
        setBusy(true)
        try {
          const res = await fetch(detail.src)
          setData(await res.json())
        } catch (error) {
          setData({ ok: false, checks: [{ name: '请求失败', ok: false, detail: String((error && error.message) || error) }] })
        } finally {
          setBusy(false)
        }
      }
      useEffect(() => { load() }, [detail.src])
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
          h('b', null, data ? (data.ok ? '看图链路正常' : '看图链路有问题') : '正在自检…'),
          h('button', { type: 'button', className: 'slj-btn', disabled: busy, onClick: load }, busy ? '检查中…' : '重新自检'),
        ),
        h('div', { style: { maxHeight: '360px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' } },
          (data?.checks || []).map((row, index) => h('div', { key: index, style: { display: 'flex', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
            h('b', { style: { color: row.ok ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-error-primary)' } }, row.ok ? '✓' : '✗'),
            h('div', null, h('div', null, row.name), row.detail ? h('div', { className: 'slj-meta' }, row.detail) : null),
          )),
          !data ? h('div', { className: 'slj-empty' }, '正在检查…') : null,
        ),
        data?.sampleText ? h('p', { className: 'slj-note' }, '识别样例：' + data.sampleText) : null,
      )
    }

    function GroupPanel({ detail }) {
      const [groups, setGroups] = useState([])
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const load = async () => {
        setBusy(true)
        try {
          const res = await fetch(detail.src)
          const data = await res.json()
          setGroups(Array.isArray(data.groups) ? data.groups : [])
          setMsg('')
        } catch (error) {
          setMsg(String((error && error.message) || error))
        } finally {
          setBusy(false)
        }
      }
      useEffect(() => { load() }, [detail.src])
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          h('button', { type: 'button', className: 'slj-btn', disabled: busy, onClick: load }, busy ? '读取中…' : '刷新群列表'),
          h('span', { className: 'slj-meta' }, `共 ${groups.length} 个群`),
          msg ? h('span', { className: 'slj-meta' }, msg) : null,
        ),
        h('div', { style: { maxHeight: '360px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' } },
          groups.length ? groups.map((g) => h('div', { key: g.id, style: { display: 'flex', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
            h('b', { style: { minWidth: '96px', fontVariantNumeric: 'tabular-nums' } }, g.id),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.name || '未命名群'),
          )) : h('div', { className: 'slj-empty' }, detail.empty || '还没有群列表'),
        ),
      )
    }

    function QrPanel({ detail }) {
      const [login, setLogin] = useState(detail.login || null)
      const [ts, setTs] = useState(detail.qrAt || Date.now())
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const base = String(detail.src || '').split('?')[0]
      const online = login ? login.online === true : false
      const exists = login ? login.qr && login.qr.exists === true : detail.qrExists !== false
      const phaseLabel = online ? '已在线' : (login && login.phaseLabel) || detail.title || '扫码登录'
      const hint = online ? '已经登录好了，这张码只作记录' : (login && login.hint) || detail.subtitle || ''

      // 后端每轮轮询已经把阶段算好了，这里只负责取；有新的码就换图。
      // 不在前端判断「在线/过期」，判断只留一份在 channel/napcat.mjs。
      useEffect(() => {
        let alive = true
        let pulling = false
        const pull = async () => {
          if (pulling) return
          pulling = true
          try {
            const next = await api('/napcat/login')
            if (!alive || !next || !next.login) return
            setLogin(next.login)
            if (next.login.qr && next.login.qr.at) {
              setTs((prev) => (next.login.qr.at !== prev ? next.login.qr.at : prev))
            }
          } catch {
            // 查不到就保持上一屏，不把面板刷成空白
          } finally {
            pulling = false
          }
        }
        pull()
        const timer = window.setInterval(pull, 2500)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [])

      const act = async (action) => {
        setBusy(action)
        setMsg('')
        try {
          const result = await api('/napcat/login', { method: 'POST', body: JSON.stringify({ action }) })
          if (result && result.login) setLogin(result.login)
          if (result && result.login && result.login.qr && result.login.qr.at) setTs(result.login.qr.at)
          setMsg((result && (result.message || result.error)) || (result && result.ok !== false ? '已提交' : '没成功'))
        } catch (error) {
          setMsg(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }

      const button = (action, label) =>
        h('button', {
          type: 'button',
          className: 'slj-btn',
          disabled: !!busy,
          onClick: () => act(action),
        }, busy === action ? '处理中…' : label)

      return h('div', null,
        h('div', { style: { textAlign: 'center', marginBottom: 4 } },
          h('div', { style: { fontWeight: 600 } }, phaseLabel),
          hint ? h('div', { className: 'slj-meta', style: { marginTop: 2 } }, hint) : null,
        ),
        h('div', { style: { width: '260px', height: '260px', margin: '8px auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: exists ? '#fff' : 'transparent', border: exists ? 'none' : '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px', overflow: 'hidden', flex: 'none' } },
          exists
            ? h('img', { src: base + '?ts=' + ts, alt: detail.title || '二维码', style: { display: 'block', width: '100%', height: '100%', objectFit: 'contain' } })
            : h('span', { className: 'slj-meta', style: { textAlign: 'center', padding: '0 18px' } }, online ? '已在线，不用扫码' : '还没有二维码，点下面「扫码登录」'),
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 8, minHeight: '32px', flexWrap: 'wrap' } },
          online ? h('span', { className: 'slj-meta' }, 'QQ 已在线') : button('refresh', '刷新二维码'),
          online ? null : button('retry', login && login.mode === 'password' ? '再试密码' : '再试票据'),
          online ? null : button('qr', '改用扫码'),
        ),
        msg ? h('div', { className: 'slj-meta', style: { textAlign: 'center', marginBottom: 6 } }, msg) : null,
        detail.note ? h('p', { className: 'slj-note' }, detail.note) : null,
      )
    }

    /**
     * 审计页顶上的口径胶囊。
     *
     * 三个维度按「先粗后细」排：级别（多严重）→ 噪音（要不要看高频的）。
     * 类型白名单太碎，不放在胶囊里 —— 那是「设置 → 日志与排障」的事，
     * 页面上留一个入口反而更好用：点两下就筛完，不点就是默认。
     */
    function AuditFilterBar({ filter, onChange }) {
      const build = (next) => {
        const parts = ['level=' + encodeURIComponent(next.level)]
        const kinds = (next.kinds || []).join(',')
        if (kinds) parts.push('kind=' + encodeURIComponent(kinds))
        if (next.noise === false) parts.push('noise=0')
        return parts.join('&')
      }
      return h(
        'div',
        { className: 'slj-chips' },
        (filter.levels || []).map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'slj-chip',
              'data-on': filter.level === item.id ? 'true' : 'false',
              onClick: () => onChange(build({ ...filter, level: item.id })),
            },
            item.label,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'slj-chip',
            'data-on': filter.noise === false ? 'true' : 'false',
            onClick: () => onChange(build({ ...filter, noise: filter.noise !== false ? false : true })),
          },
          filter.noise === false ? '正在看噪音（点一下折叠）' : '连噪音一起看',
        ),
      )
    }

    function DetailRows({ detail, busy, onToggleSkill, onOpen, onMore, loadingMore, extra, onAction, onFilter }) {
      const [query, setQuery] = useState('')
      const [editing, setEditing] = useState(null)
      const editRef = useRef(null)
      // 编辑表单渲染在列表顶部；点下面第 20 行的「改」时，表单可能在滚动区外，
      // 用户会以为按钮没反应。打开表单后把它滚进视野，编辑才算真的可用。
      useEffect(() => {
        if (!editing) return
        const el = editRef.current
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [editing])
      // 「删除」要按两下：第一下只换成「再点一下」，四秒内不点就复原。
      // 之前的删除是一点就没，而记忆是删了就再也想不起来的东西。
      const [pendingForget, setPendingForget] = useState('')
      const trigger = (row, action) => {
        const kind = String(action.action || '')
        if (kind.startsWith('forget-') && pendingForget !== row.id) {
          setPendingForget(row.id)
          window.setTimeout(() => setPendingForget((cur) => (cur === row.id ? '' : cur)), 4000)
          return
        }
        setPendingForget('')
        if (kind.startsWith('edit-')) setEditing({ ...row, action: kind })
        else onAction && onAction({ ...row, action: kind })
      }
      const actionLabelOf = (row, action) =>
        pendingForget === row.id && String(action.action || '').startsWith('forget-') ? '再点一下' : action.actionLabel || '操作'
      const allRows = detail.rows || []
      const needle = String(query || '').trim()
      const rows = needle
        ? allRows.filter((row) => `${row.title || ''} ${row.desc || ''} ${row.meta || ''} ${row.group || ''}`.includes(needle))
        : allRows
      const isMemory = String(detail.id || '').startsWith('memory.')
      // 规则也要能搜：二十多条按链路排开，找「注意力」时不该靠眼睛从头扫。
      const isRules = String(detail.id || '').startsWith('rules.')
      const searchable = isMemory || isRules
      const search = searchable
        ? h('input', {
            className: 'slj-input',
            placeholder: isMemory ? '搜记忆：名字 / 群号 / 内容' : '搜规则：关键词 / 模块 / 位置',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            style: { marginBottom: '10px' },
          })
        : null
      if (!rows.length) {
        const emptyText = needle ? (isMemory ? '没有匹配的记忆' : '没有匹配的规则') : detail.empty || '还没有内容'
        return h('div', null, search, extra || null, h('div', { className: 'slj-empty' }, emptyText))
      }
      return h(
        'div',
        null,
        search,
        editing
          ? h('div', { ref: editRef },
              h(editing.action === 'edit-skill' ? SkillEditForm : MemoryEditForm, {
                row: editing,
                onCancel: () => setEditing(null),
                onSave: (values) => {
                  onAction && onAction({ ...editing, action: 'save-' + editing.action, values })
                  setEditing(null)
                },
              }),
            )
          : null,
        extra || null,
        detail.filter && onFilter ? h(AuditFilterBar, { filter: detail.filter, onChange: onFilter }) : null,
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,
        rows.map((row, index) => {
          const prev = index ? rows[index - 1] : null
          const head = row.group && (!prev || prev.group !== row.group) ? row.group : ''
          return h(
            react.Fragment,
            { key: row.id },
            head ? h('div', { className: 'slj-rowGroup' }, head) : null,
            h(
              'div',
              {
                className: 'slj-row',
              'data-open': row.open ? 'true' : 'false',
              onClick: row.open ? () => onOpen(row.open) : undefined,
            },
            h(
              'div',
              { className: 'slj-rowMain' },
              h(
                'div',
                { className: 'slj-rowTitle' },
                h('span', null, row.title),
                row.badge ? h(Chip, { tone: row.tone }, row.badge) : null,
              ),
              row.desc ? h('div', { className: 'slj-rowText' }, row.desc) : null,
              row.meta ? h('div', { className: 'slj-rowText' }, row.meta) : null,
            ),
            row.aside ? h('span', { className: 'slj-meta', style: { marginLeft: 'auto', flex: 'none' } }, row.aside) : null,
            row.skill
              ? h(
                  'div',
                  { className: 'slj-rowSide' },
                  row.skill.toggleable
                    ? h(
                        'button',
                        {
                          type: 'button',
                          role: 'switch',
                          className: 'slj-switch',
                          'data-on': row.skill.state === 'on' ? 'true' : 'false',
                          'aria-checked': row.skill.state === 'on',
                          'aria-label': (row.skill.state === 'on' ? '关掉 ' : '打开 ') + row.skill.name,
                          disabled: busy === row.skill.id,
                          onClick: (event) => {
                            event.stopPropagation()
                            onToggleSkill(row.skill)
                          },
                        },
                        h('span', { className: 'slj-knob' }),
                      )
                    : h('span', { className: 'slj-meta' }, row.skill.wired === false ? '等接底层' : '改不了'),
                  // 教过的技能还带「改名 / 忘掉」。
                  // 以前这里只能二选一：有开关就没按钮 —— 于是一条教坏了的技能
                  // 既开不了也改不了，只能去磁盘上动 JSON。开关在左、动词在右，各占各位。
                  row.actions && row.actions.length
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 4 } },
                        row.actions.map((action) =>
                          h(
                            'button',
                            {
                              key: action.action,
                              type: 'button',
                              className: 'slj-btn',
                              onClick: (event) => {
                                event.stopPropagation()
                                trigger(row, action)
                              },
                            },
                            actionLabelOf(row, action),
                          ),
                        ),
                      )
                    : null,
                )
              : row.actions && row.actions.length
                ? h(
                    'div',
                    { style: { display: 'flex', gap: 4 } },
                    row.actions.map((action) =>
                      h(
                        'button',
                        {
                          key: action.action,
                          type: 'button',
                          className: 'slj-btn',
                          onClick: (event) => {
                            event.stopPropagation()
                            trigger(row, action)
                          },
                        },
                        actionLabelOf(row, action),
                      ),
                    ),
                  )
                : row.action
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'slj-btn',
                        onClick: (event) => {
                          event.stopPropagation()
                          onAction && onAction(row)
                        },
                      },
                      row.actionLabel || '删除',
                    )
                  : row.open
                    ? h('span', { className: 'slj-meta' }, h(Icon, { name: 'chevronRight', size: 14 }))
                    : null,
              ),
            )
        }),
        detail.note ? h('p', { className: 'slj-note' }, detail.note) : null,
        detail.hasMore
          ? h(
              'div',
              { style: { textAlign: 'center', marginTop: '10px' } },
              h('button', { type: 'button', className: 'slj-btn', disabled: loadingMore, onClick: onMore }, loadingMore ? '正在读…' : '看更早的'),
            )
          : null,
      )
    }

    /**
     * 一条消息。
     *
     * 引用默认收起两行：聊天记录里经常「一句引用顶半屏」，全展开就没法看了。
     * 但**必须能看全**：
     *   · 本地日志里找得到原话 → 直接展开（不再发请求）；
     *   · 只拿到了 reply 段的摘要（原话不在读取窗口里，或协议端当初就没给）→「查看原文」，
     *     去问一次 /message：先翻本地事件流，翻不到再问协议端 get_msg。
     * 以前这里只截 120 字、没有出口，等于引用只能看到半句。
     */
    function ChatBubble({ row, conversation }) {
      const quote = row.reply || null
      const who = String((quote && quote.who) || '')
      const base = String((quote && quote.text) || row.replyText || '').trim()
      const [full, setFull] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const text = full !== null ? full : base
      const canExpand = text.length > 80
      const missing = row.replyFound === false && !!base
      const lookup = async () => {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          const result = await api('/message?conversation=' + encodeURIComponent(conversation || '') + '&id=' + encodeURIComponent(row.replyId || ''))
          if (result && result.ok && result.message) {
            const line = String(result.message.text || '').trim()
            if (line) { setFull(line); setOpen(true); return }
          }
          setNote((result && result.error) || '这条原文已经找不到了')
        } catch (err) {
          setNote(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'slj-msg', 'data-self': row.self ? 'true' : 'false' },
        h(
          'div',
          // fit-content 让包裹层宽度由内容明确决定，避免被 flex 压到极窄；
          // 76% 的上限相对 .slj-msg（宽度明确），不再形成百分比循环。
          { style: { width: 'fit-content', maxWidth: '76%' } },
          h('div', { className: 'slj-who' }, row.who || ''),
          base
            ? h(
                'div',
                { className: 'slj-quote', 'data-open': open ? 'true' : 'false' },
                h('div', { className: 'slj-quoteText' }, (who ? who + '：' : '') + text),
                canExpand
                  ? h('button', { type: 'button', className: 'slj-quoteBtn', onClick: () => setOpen((prev) => !prev) }, open ? '收起' : '展开')
                  : null,
                missing
                  ? h('button', { type: 'button', className: 'slj-quoteBtn', disabled: busy, onClick: lookup }, busy ? '正在找…' : '查看原文')
                  : null,
                note ? h('div', { className: 'slj-meta' }, note) : null,
              )
            : null,
          h('div', { className: 'slj-bubble' }, row.text || ''),
        ),
      )
    }

    function DetailChat({ detail, draft, onDraft, onSend, sending, onMore, loadingMore }) {
      const chat = detail.chat || {}
      const rows = chat.rows || []
      const disabled = !chat.canSend || sending
      const [autoScroll, setAutoScroll] = useState(() => {
        try { return window.localStorage.getItem('slj.autoscroll') !== '0' } catch { return true }
      })
      const threadRef = useRef(null)
      useEffect(() => {
        if (!autoScroll) return
        const el = threadRef.current
        if (el && el.lastElementChild) el.lastElementChild.scrollIntoView({ block: 'nearest' })
      }, [rows.length, chat.conversation, autoScroll])
      const toggleAutoScroll = () => {
        setAutoScroll((prev) => {
          const next = !prev
          try { window.localStorage.setItem('slj.autoscroll', next ? '1' : '0') } catch {}
          return next
        })
      }
      return h(
        'div',
        { className: 'slj-chatWrap' },
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 6, flex: 'none' } },
          h('button', { type: 'button', className: 'slj-btn', onClick: toggleAutoScroll }, autoScroll ? '自动滚动：开' : '自动滚动：关'),
        ),
        chat.hasMore
          ? h(
              'div',
              { style: { textAlign: 'center', marginBottom: '8px', flex: 'none' } },
              h('button', { type: 'button', className: 'slj-btn', disabled: loadingMore, onClick: onMore }, loadingMore ? '正在读…' : '看更早的消息'),
            )
          : null,
        rows.length
          ? h('div', { className: 'slj-thread', ref: threadRef }, rows.map((row) => h(ChatBubble, { key: row.id, row, conversation: chat.conversation })))
          : h('div', { className: 'slj-empty slj-threadEmpty' }, chat.source === 'qq' ? '这段会话还没有消息' : '说一句话试试'),
        h(
          'div',
          { className: 'slj-composer' },
          chat.canSend
            ? null
            : h('div', { style: { marginBottom: '6px' } }, h(Chip, { tone: 'warn' }, chat.disabledReason || '现在发不出去')),
          h(
            'div',
            { className: 'slj-composerRow' },
            h('textarea', {
              className: 'slj-area',
              value: draft,
              placeholder: chat.canSend ? '说点什么，Enter 发送，Shift+Enter 换行' : '现在发不出去',
              disabled,
              onChange: (event) => onDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onSend()
                }
              },
            }),
            h(
              'button',
              { type: 'button', className: 'slj-btn', 'data-variant': 'primary', disabled: disabled || !draft.trim(), onClick: onSend },
              sending ? '说着…' : '发送',
            ),
          ),
        ),
      )
    }

    // ── 设置项（表单）────────────────────────────────────────────

    function SaveButton({ item, value, onSave, busy }) {
      const raw = item.value === undefined || item.value === null ? '' : item.value
      const original = item.scale ? String((Number(raw) || 0) / Number(item.scale)) : String(raw)
      // 数字项清空后 Number('') 会变成 0，存下去就成了「每分钟 0 条」这种事故；
      // 敏感项留空是「不修改」，但也不能让空串把已配置的令牌/密码清掉。
      const blank = (item.kind === 'number' || item.secret) && String(value).trim() === ''
      const changed = String(value) !== original
      return h(
        'button',
        { type: 'button', className: 'slj-btn', disabled: !changed || blank || busy, onClick: () => onSave(item, value) },
        '保存',
      )
    }

    /** 档位下拉：显示中文，提交机器值。摆 free/ask/off 出去等于让人猜 */
    function EnumSelect({ item, value, onChange }) {
      const labels = item.optionLabels || null
      return h(
        'select',
        { className: 'slj-select', value: String(value), onChange: (event) => onChange(event.target.value) },
        (item.options || []).map((option) =>
          h('option', { key: option, value: option }, labels && labels[option] ? labels[option] : option),
        ),
      )
    }

    function NightWindowSlider({ item, onSave, busy }) {
      const parse = (text) => {
        const m = String(text || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
        return m ? [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])] : [23 * 60, 7 * 60]
      }
      const [start, setStart] = useState(() => parse(item.value)[0])
      const [end, setEnd] = useState(() => parse(item.value)[1])
      useEffect(() => {
        const parsed = parse(item.value)
        setStart(parsed[0])
        setEnd(parsed[1])
      }, [item.value])
      const clock = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      const text = `${clock(start)}-${clock(end)}`
      const invalid = start === end
      return h('div', { style: { width: '100%' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
          h('span', null, '开始 ' + clock(start)),
          h('span', null, '结束 ' + clock(end)),
        ),
        h('input', { type: 'range', min: 0, max: 1439, step: 15, value: start, style: { width: '100%' }, onChange: (e) => setStart(Number(e.target.value)) }),
        h('input', { type: 'range', min: 0, max: 1439, step: 15, value: end, style: { width: '100%' }, onChange: (e) => setEnd(Number(e.target.value)) }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { className: 'slj-meta' }, `夜间 ${text}`),
          h('button', { type: 'button', className: 'slj-btn', disabled: busy || invalid || text === String(item.value || ''), onClick: () => onSave(item, text) }, '保存'),
          invalid ? h('span', { className: 'slj-meta' }, '开始和结束不能一样') : null,
        ),
      )
    }

    function PercentSlider({ item, onSave, busy }) {
      const [value, setValue] = useState(Number(item.value) || 0)
      useEffect(() => { setValue(Number(item.value) || 0) }, [item.value])
      return h('div', { style: { width: '100%' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
          h('span', null, '接话概率'),
          h('b', null, value + '%'),
        ),
        h('input', { type: 'range', min: 0, max: 100, step: 5, value, style: { width: '100%' }, onChange: (e) => setValue(Number(e.target.value)) }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { className: 'slj-meta' }, value === 100 ? '每句都接' : value === 0 ? '从不主动接' : `约 ${value}% 的接话`),
          h('button', { type: 'button', className: 'slj-btn', disabled: busy || value === Number(item.value), onClick: () => onSave(item, value) }, '保存'),
        ),
      )
    }

    function SettingRow({ item, draft, busy, confirming, batch, dirty, locked = false, onDraft, onToggleBool, onSave, onConfirm, onCancel }) {
      if (item.key === 'group.followUpChance') return h(PercentSlider, { item, onSave, busy })
      if (item.key === 'guard.nightWindow') return h(NightWindowSlider, { item, onSave, busy })
      const readonly = item.readonly === true
      const raw = draft === undefined ? (item.value === undefined || item.value === null ? '' : item.value) : draft
      const value = item.scale ? (Number(raw) || 0) / Number(item.scale) : raw
      const unit = item.unit || ''
      let control = null

      if (readonly) {
        control = h('span', { className: 'slj-meta' }, String(item.value === '' ? '—' : item.value))
      } else if (item.kind === 'bool') {
        control = h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'slj-switch',
            'data-on': item.value === true ? 'true' : 'false',
            'aria-checked': item.value === true,
            'aria-label': item.label,
            disabled: busy,
            onClick: () => onToggleBool(item),
          },
          h('span', { className: 'slj-knob' }),
        )
      } else if (item.kind === 'enum') {
        control = h(
          'div',
          { className: 'slj-field' },
          h(EnumSelect, { item, value, onChange: (next) => onDraft(item.key, next) }),
          batch ? null : h(SaveButton, { item, value, onSave, busy }),
        )
      } else if (item.kind === 'number') {
        control = h(
          'div',
          { className: 'slj-field' },
          h('input', {
            className: 'slj-input',
            type: 'number',
            value: String(value),
            min: item.min === null ? undefined : item.min,
            max: item.max === null ? undefined : item.max,
            step: item.step === null ? undefined : item.step,
            onChange: (event) => onDraft(item.key, event.target.value),
          }),
          // 单位就摆在输入框边上。数字离开单位是没法核对对错的
          unit ? h('span', { className: 'slj-meta' }, unit) : null,
          batch ? null : h(SaveButton, { item, value, onSave, busy }),
        )
      } else if (item.kind === 'list' || item.multiline) {
        control = h(
          'div',
          { className: 'slj-field', 'data-wide': 'true' },
          h('textarea', {
            className: 'slj-area',
            value: Array.isArray(value) ? value.join('\n') : String(value),
            placeholder: item.placeholder || '',
            onChange: (event) => onDraft(item.key, event.target.value),
          }),
          batch ? null : h(SaveButton, { item, value, onSave, busy }),
        )
      } else {
        control = h(
          'div',
          { className: 'slj-field' },
          h('input', {
            className: 'slj-input',
            type: item.secret ? 'password' : 'text',
            value: String(value),
            placeholder: item.placeholder || '',
            maxLength: item.maxLen === null ? undefined : item.maxLen,
            disabled: locked || undefined,
            title: locked ? '默认跟随已开启；关闭开关后才能改' : undefined,
            onChange: (event) => onDraft(item.key, event.target.value),
          }),
          unit ? h('span', { className: 'slj-meta' }, unit) : null,
          batch ? null : h(SaveButton, { item, value, onSave, busy }),
        )
      }

      return h(
        'div',
        { className: 'slj-row' },
        h(
          'div',
          { className: 'slj-rowMain' },
          h(
            'div',
            { className: 'slj-rowTitle' },
            h('span', null, item.label),
            item.secretConfigured ? h(Chip, { tone: 'idle' }, '已配置') : null,
            // 生效徽标：只有「要重启」「改了也没用」需要动作，升级成醒目角标；
            // 「下一轮生效」「只读」是常态信息，一行小字就够。
            item.effect === 'restart' || item.effect === 'pending'
              ? h(Chip, { tone: 'warn' }, item.badge)
              : item.badge ? h('span', { className: 'slj-effect' }, item.badge) : null,
            item.needConfirm ? h(Chip, { tone: 'bad' }, '危险') : null,
            locked ? h(Chip, { tone: 'idle' }, '默认跟随中') : null,
            dirty ? h(Chip, { tone: 'warn' }, '未保存') : null,
          ),
          item.hint ? h('div', { className: 'slj-rowText' }, item.hint) : null,
          control,
          confirming
            ? h(
                'div',
                { className: 'slj-field' },
                h('span', { className: 'slj-rowText' }, '这项改坏了不好收拾，确定要改吗？'),
                h('button', { type: 'button', className: 'slj-btn', onClick: onCancel }, '取消'),
                h('button', { type: 'button', className: 'slj-btn', 'data-variant': 'primary', onClick: onConfirm }, '确定改'),
              )
            : null,
        ),
      )
    }

    /**
     * 数据与调试：把后端已有、界面原先没有入口的核对能力收在一处。
     * 选一项 → 跑一次 → 当场看结果，改完设置不必切到 QQ 发消息验证。
     */
    function DebugPanel({ detail, notify }) {
      const [results, setResults] = useState({})
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const items = Array.isArray(detail && detail.items) ? detail.items : []

      const run = async (kind) => {
        setBusy(kind)
        try {
          const next = await api('/debug/run', { method: 'POST', body: JSON.stringify({ kind }) })
          setResults((prev) => ({ ...prev, [kind]: next }))
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      const reread = async () => {
        setBusy('reload')
        try {
          const next = await action('config.reload', {})
          notify && notify((next && next.message) || '重新读好了')
          await run('config')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      return h(
        'div',
        null,
        detail.subtitle ? h('p', { className: 'slj-note' }, detail.subtitle) : null,
        items.map((item) => {
          const out = results[item.id]
          return h(
            'div',
            { key: item.id, className: 'slj-row' },
            h(
              'div',
              { className: 'slj-rowMain' },
              h('div', { className: 'slj-rowTitle' },
                h('span', null, item.label),
                h('button', {
                  type: 'button',
                  className: 'slj-btn',
                  disabled: busy === item.id,
                  onClick: () => run(item.id),
                }, busy === item.id ? '正在核对…' : '运行一次'),
              ),
              item.desc ? h('div', { className: 'slj-rowText' }, item.desc) : null,
              out
                ? h('div', { className: 'slj-debugOut' },
                    (out.rows || []).map((one, index) =>
                      h('div', { key: index, className: 'slj-debugOutRow' },
                        h('span', null, one.label),
                        h('b', null, one.value),
                      ),
                    ),
                    out.note ? h('div', { className: 'slj-rowText' }, out.note) : null,
                  )
                : null,
            ),
          )
        }),
        h('div', { className: 'slj-field' },
          h('button', { type: 'button', className: 'slj-btn', disabled: busy === 'reload', onClick: reread }, busy === 'reload' ? '正在读取…' : '重新读取设置'),
          h('span', { className: 'slj-rowText' }, '磁盘上的配置被外部改过时，点这里不用重启就能对齐。'),
        ),
        detail.note ? h('div', { className: 'slj-rowText' }, detail.note) : null,
        error ? h(Banner, { tone: 'bad' }, '核对没跑成：' + error) : null,
      )
    }

    function PolicyPanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [domain, setDomain] = useState('')
      const load = async () => {
        try {
          const next = await api('/list/policy')
          setData(next)
          setError('')
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }
      useEffect(() => { load() }, [])
      const save = async (key, value) => {
        setBusy(key)
        try {
          const result = await api('/config', { method: 'POST', body: JSON.stringify({ key, value }) })
          if (result && result.ok) await load()
        } finally {
          setBusy('')
        }
      }
      if (!data) {
        return h('div', null,
          h('div', { className: 'slj-empty' }, error ? '读不到工具表：' + error : '正在读工具表…'),
          error ? h('button', { type: 'button', className: 'slj-btn', onClick: load }, '重试') : null,
        )
      }
      const tools = (data.tools || []).map((item) => typeof item === 'string' ? { name: item, label: item } : item)
      const toolOn = (name) => !data.toolWhitelist.length || data.toolWhitelist.includes(name)
      const toolNames = tools.map((item) => item.name)
      const toggleTool = (name) => {
        let next
        if (!data.toolWhitelist.length) next = toolNames.filter((item) => item !== name)
        else if (data.toolWhitelist.includes(name)) next = data.toolWhitelist.filter((item) => item !== name)
        else next = [...data.toolWhitelist, name]
        if (next.length >= toolNames.length) next = []
        save('tools.whitelist', next)
      }
      const defaults = ['cn.bing.com', 'www.bing.com', 'api.deepseek.com', 'multimedia.nt.qq.com.cn', 'txz.qq.com']
      const domains = [...new Set([...defaults, ...(data.netWhitelist || [])])]
      const netOn = (name) => data.netWhitelist.includes(name)
      const toggleNet = (name) => {
        const next = netOn(name) ? data.netWhitelist.filter((item) => item !== name) : [...data.netWhitelist, name]
        save('net.allowlist', next)
      }
      const addDomain = () => {
        const value = String(domain || '').trim().toLowerCase()
        if (!value || data.netWhitelist.includes(value)) return
        save('net.allowlist', [...data.netWhitelist, value])
        setDomain('')
      }
      const section = (title, hint, rows, listStyle) => h('div', { style: { marginBottom: 14 } },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, title),
        h('div', { className: 'slj-meta', style: { marginBottom: 6 } }, hint),
        h('div', { style: { maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' } }, rows),
      )
      return h('div', null,
        section(
          '允许调用的工具',
          // 这一段以前只写「开关控制」，于是同一批中文名在技能页也出现一次（「发小黄脸」既是技能名，又是 send_face 的标签），
          // 看着就像技能跑进了工具列表。现在每行先写工具名、再写它归哪项技能，两个层级当场分开。
          '底层工具。每行后面写着它属于哪一项技能：技能页的开关管「它自己会不会用」，这里的开关管「允不允许调用」——两个都开才真能调。全部打开时保存为空，表示不限制',
          tools.map((tool) => h('div', { key: tool.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
            h('span', { style: { flex: 1 } },
              h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px' } }, tool.name),
              h('span', { className: 'slj-meta', style: { marginLeft: 8 } },
                tool.label,
                tool.skill ? ' · 属于「' + tool.skill.name + '」' : ' · 基础工具（不归任何技能）',
                tool.off ? ' · 技能页里关着' : ''),
            ),
            h('button', { type: 'button', className: 'slj-btn', disabled: busy === 'tools.whitelist', onClick: () => toggleTool(tool.name) }, toolOn(tool.name) ? '开' : '关'),
          ))),
        (data.unowned || []).length
          ? h('div', { className: 'slj-meta', style: { margin: '-8px 0 12px' } }, '没有归属的工具：' + data.unowned.join('、') + '。它们跑得动，但技能页上没有对应开关，也记不进「用过几次」。')
          : null,
        section('联网白名单', '开关控制；全关表示不允许联网。改完立即生效，可在「数据与调试 → 联网开关试一次」当场验证', domains.map((name) => h('div', { key: name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
          h('span', { style: { flex: 1 } }, name),
          h('button', { type: 'button', className: 'slj-btn', disabled: busy === 'net.allowlist', onClick: () => toggleNet(name) }, netOn(name) ? '开' : '关'),
        ))),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('input', { className: 'slj-input', placeholder: '新增域名，例如 api.example.com', value: domain, onChange: (e) => setDomain(e.target.value) }),
          h('button', { type: 'button', className: 'slj-btn', onClick: addDomain }, '添加'),
        ),
      )
    }

    /**
     * 设置表单。
     *
     * 以前每项右边一个「保存」，123 项就是 123 个按钮 —— 改三项要按三次，
     * 而且每按一次就重拉一遍整棵树。现在：**改 = 记草稿，存 = 一次提交**。
     * 只有标了「危险」的那几项还保留单项确认，因为它们不该被"顺手一起保存"。
     *
     * 只读项（当前值、版本号这类）默认折叠：27 行不能动的东西混在可改项里，
     * 只会让人以为"这里也能改，只是找不到开关"。
     */
    function DetailForm({ detail, drafts, busy, confirm, onDraft, onToggleBool, onSave, onSaveAll, onDiscard, onConfirm, onCancel }) {
      const form = detail.form || { items: [] }
      const items = Array.isArray(form.items) ? form.items : []
      const [query, setQuery] = useState('')
      const [showReadonly, setShowReadonly] = useState(false)

      const q = query.trim().toLowerCase()
      const hit = (item) =>
        !q ||
        [item.label, item.key, item.hint, item.group, item.unit]
          .some((text) => String(text === undefined || text === null ? '' : text).toLowerCase().includes(q))

      const editable = items.filter((item) => item.readonly !== true && hit(item))
      const readonly = items.filter((item) => item.readonly === true && hit(item))
      // 模型页的「默认跟随」开启时，provider/model 两项只展示、不接收输入。
      // 先看草稿（开关刚点还没回包时），再看服务端值。
      const followItem = items.find((item) => item.key === 'modelFollowDefault')
      const followRaw = drafts.modelFollowDefault !== undefined ? drafts.modelFollowDefault : followItem && followItem.value
      const followDefault = detail.id === 'settings.model' && followRaw === true
      const lockedKey = (key) => followDefault && (key === 'modelProvider' || key === 'model')
      const dirty = Object.keys(drafts || {}).filter((key) =>
        items.some((item) => item.key === key && item.readonly !== true) && !lockedKey(key))
      const batch = typeof onSaveAll === 'function'

      const rowOf = (item) =>
        h(SettingRow, {
          key: item.key,
          item,
          draft: drafts[item.key],
          busy: busy === item.key,
          confirming: confirm !== null && confirm.key === item.key,
          batch: batch && item.needConfirm !== true,
          dirty: drafts[item.key] !== undefined,
          locked: lockedKey(item.key),
          onDraft,
          onToggleBool,
          onSave,
          onConfirm,
          onCancel,
        })

      return h(
        'div',
        null,
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,

        // 搜索：123 项平铺时，"我记得有个开关叫...但不知道在哪组"是最常见的处境。
        // 匹配名字、键名、说明、组名 —— 用户记得哪一个就用哪一个搜。
        h(
          'div',
          { className: 'slj-formBar' },
          h('input', {
            className: 'slj-input',
            type: 'search',
            value: query,
            placeholder: '搜设置：名字、键名、说明都能搜',
            'aria-label': '搜索设置项',
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'slj-meta' }, q ? `${editable.length + readonly.length} 项匹配` : `${editable.length} 项可改`),
        ),

        // 模型页给一个明确的默认档，不用用户自己记 provider 和 model 两个值。
        // 点一下只填草稿，仍要走下面的「保存」，不绕过统一写入口。
        detail.id === 'settings.model'
          ? followDefault
            ? h('div', { className: 'slj-note' }, '默认跟随已开启：下面两项暂不生效；关闭上面的开关后才按它们走。')
            : h(
                'div',
                { className: 'slj-formBar' },
                h('span', { className: 'slj-meta' }, '快速填入默认档：'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'slj-btn',
                    title: '填入 deepseek-account / deepseek-flash，再点保存',
                    onClick: () => {
                      onDraft('modelProvider', 'deepseek-account')
                      onDraft('model', 'deepseek-flash')
                    },
                  },
                  'deepseek-account / deepseek-flash',
                ),
              )
          : null,

        editable.map(rowOf),

        q && !editable.length && !readonly.length
          ? h('div', { className: 'slj-empty' }, '没有匹配的设置项')
          : null,

        readonly.length
          ? h(
              'div',
              { className: 'slj-roGroup' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'slj-roToggle',
                  'aria-expanded': showReadonly ? 'true' : 'false',
                  onClick: () => setShowReadonly((prev) => !prev),
                },
                h('span', { className: 'slj-roCaret' }, showReadonly ? '▾' : '▸'),
                ' 当前值（只读，' + readonly.length + ' 项）',
              ),
              showReadonly ? readonly.map(rowOf) : null,
            )
          : null,

        // 吸底：只有存在草稿时才出现。没有改动时不占位置，
        // 也就不用解释"为什么这里一直有个灰按钮"。
        batch && dirty.length
          ? h(
              'div',
              { className: 'slj-dirtyBar' },
              h('span', { className: 'slj-dirtyText' }, dirty.length + ' 项没保存'),
              h('button', { type: 'button', className: 'slj-btn', onClick: onDiscard }, '撤销'),
              h(
                'button',
                { type: 'button', className: 'slj-btn', 'data-variant': 'primary', disabled: busy === '__batch__', onClick: () => onSaveAll(dirty) },
                busy === '__batch__' ? '保存中…' : '保存',
              ),
            )
          : null,
      )
    }

    // ── 主面板 ──────────────────────────────────────────────────

    function Panel() {
      injectStyle()

      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [toast, setToast] = useState(null)
      const [busy, setBusy] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [confirmSkill, setConfirmSkill] = useState(null)
      const [drafts, setDrafts] = useState({})
      const [token, setToken] = useState(0)
      /**
       * 现场几何。三件事必须一起量，分开记就会互相打架：
       *   container 宿主给这个插件的宽度
       *   left      根节点在视口里的左偏移
       *   viewport  浏览器视口宽度
       *
       * 「能看见的宽度」= min(container, viewport - left)。差出来的那截，
       * 就是被外层裁掉的像素 —— 它可能不为 0（宿主自己的横向布局溢出），
       * 而插件内部永远报「没有溢出」（overflow:hidden 自己吃掉了）。
       */
      const [geom, setGeom] = useState({ container: 0, left: 0, viewport: 0, height: 0, top: 0, viewportH: 0, ownWidth: 0, ownHeight: 0, cssViewport: 0, cssViewportH: 0, dpr: 1, dprFix: false })
      const [pref, setPref] = useState(readStore)

      // 详情：id 为空表示还在区域页
      const [detailId, setDetailId] = useState('')
      // 详情查询串（审计页的级别/类型/噪音胶囊）。以前只存 id，openDetail 的
      // 第二个参数被丢掉，点胶囊只会重开同一页 —— 看起来像「筛选按钮没用」。
      const [detailQuery, setDetailQuery] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
      /** 上一次真正打开的详情（id + 查询串）：token 刷新同一页时不能再 setDetail(null) */
      const shownDetailIdRef = useRef('')
      const shownDetailQueryRef = useRef('')
      const [loadingMore, setLoadingMore] = useState(false)
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)

      // ── 沙箱确认 ──
      // ask 是当前这一条待确认；reason / remember 跟着它走，所以换一条要清空。
      const [ask, setAsk] = useState(null)
      const [askReason, setAskReason] = useState('')
      const [askRemember, setAskRemember] = useState(false)
      const [askBusy, setAskBusy] = useState('')
      const [, setAskTick] = useState(0)
      // 已经提交过 / 自动超时提交过的 id。轮询每 1.5 秒回来一次，
      // 没有这张表就会对着同一条重复提交，第二次必然拿到「已经结束了」。
      const askDoneRef = useRef(null)
      if (!askDoneRef.current) askDoneRef.current = new Set()
      // 服务端与本机的时钟差。倒计时按服务端的 expiresAt 算，本机只负责走秒
      const askSkewRef = useRef(0)

      const rootRef = useRef(null)
      const widthRef = useRef(0)
      const dragRef = useRef(null)
      /** 见过的最大容器宽度。见 measureGeom：量不到父节点时靠它不上当 */
      const containerRef = useRef(0)

      /**
       * 量一次现场。**优先量父节点**：
       * 一旦因为「被裁」把根节点收窄，再量自己的宽度就永远等于收窄后的值，
       * 判断会在「裁 → 不裁 → 裁」之间来回跳（实测过一次，会出现宽度抖动）。
       *
       * 但父节点不一定量得到：宿主把槽位做成 display:contents 时它的 clientWidth 是 0。
       * 这时候退回量自己，并把「见过的最大值」记住 —— 收窄之后仍然知道自己原本有多宽，
       * 否则下一帧就会以为「已经不裁了」把宽度还回去，然后再裁一次，来回闪。
       */
      const measureGeom = useCallback(() => {
        const el = rootRef.current
        if (!el) return { container: 0, left: 0, viewport: 0, height: 0, top: 0, viewportH: 0 }
        const rect = el.getBoundingClientRect()
        const parent = el.parentElement
        const parentWidth = parent ? Math.round(parent.clientWidth || 0) : 0
        const ownWidth = Math.round(rect.width || 0)
        const left = Math.round(rect.left || 0)
        const viewport = Math.round(window.innerWidth || 0)
        const visible = viewport > 0 ? viewport - Math.max(0, left) : 0
        const seen = containerRef.current
        let container = parentWidth
        if (!container) {
          // 量不到父节点：只有「可见区还装得下上次那个宽度」时才重新采信自己的宽度
          container = seen > 0 && visible > 0 && visible < seen ? seen : ownWidth
        }
        containerRef.current = container
        // 纵向同一套：宿主给的槽位不一定等于窗口里看得见的那一块高度。
        // 聊天页的输入框常驻底部，一旦槽位比可视区高，它就落在窗口外面 ——
        // 从 CSS 上怎么看都是对的，只有这两个数能说清。
        const parentHeight = parent ? Math.round(parent.clientHeight || 0) : 0
        const top = Math.round(rect.top || 0)
        const viewportH = Math.round(window.innerHeight || 0)

        /**
         * 宿主在 125% / 150% 系统缩放下有个坑：WebView 位图被放大了 dpr 倍，
         * 但布局视口没跟着缩 —— innerWidth/innerHeight 报的仍是"未缩放的 CSS 像素"，
         * 而窗口物理像素只有 outerWidth × outerHeight。
         *
         * 实测：dpr 1.25、视口 1282×816、窗口 1296×824、输入框在 CSS y=691…796，
         * 按 1.25 放大后是物理 y=864…995，整块落在窗口外面。页面内部一切正常
         * （elementFromPoint 都命中 textarea），只有屏幕上永远看不见。
         * 所以「真正能用的 CSS 视口」是 inner / dpr，不是 inner 本身。
         *
         * 限定条件是有意的：高分屏（dpr=2）里 outer 已经是 DIP、不该再除一次，
         * 否则界面会被无端缩成一半。只在 1<dpr<1.6 且 outer≈inner（说明两者
         * 同单位、没被换算过）时启用，其余情况维持原样。
         */
        const dpr = Number(window.devicePixelRatio || 1) || 1
        const outerW = Math.round(window.outerWidth || 0)
        const outerH = Math.round(window.outerHeight || 0)
        // 只有「布局视口比整块屏幕还大」才说明 innerWidth 报的是未缩放像素。
        // 正常 125% 缩放下 innerWidth 已经等于 CSS 视口（例如 1536），再除一次
        // dpr 会把它算成 1229，于是 1256 的可见宽度被误判成 949 —— 面板会周期性
        // 收窄 307px 再弹回来（clientProbe 里 root 1256↔949、cut 307↔0 的抖动）。
        const screenW = Math.round(Number(window.screen?.availWidth || window.screen?.width) || 0)
        const screenH = Math.round(Number(window.screen?.availHeight || window.screen?.height) || 0)
        const viewportUnscaled = screenW > 0 && screenH > 0 &&
          (viewport > screenW + 1 || viewportH > screenH + 1)
        const dprFix = viewportUnscaled && dpr > 1 && dpr < 1.6 && outerW > 0 && outerH > 0 &&
          Math.abs(outerW - viewport) < 60 && Math.abs(outerH - viewportH) < 60
        return {
          container, left, viewport, viewportH,
          // 槽位尺寸 vs 根节点实际尺寸：收窄/收高生效后两者会不一样，
          // 只报槽位的话「到底收没收到」永远看不出来。
          height: parentHeight || Math.round(rect.height || 0),
          ownWidth, ownHeight: Math.round(rect.height || 0),
          top,
          cssViewport: dprFix ? Math.round(viewport / dpr) : viewport,
          cssViewportH: dprFix ? Math.round(viewportH / dpr) : viewportH,
          dpr, dprFix,
        }
      }, [])

      // 几何只有一份来源：宿主下发的 layout。数据没到之前不猜数字，
      // 由 CSS 的 --slj-nav-w 默认值撑住，数据到了再切内联宽度（同一帧内，眼睛看不到跳）。
      const layout = (data && data.layout) || null
      const nav = data && Array.isArray(data.nav) ? data.nav : []
      // 旧页面 id 的翻译表也由宿主下发：`memory` → `mind` 这类映射写在 blueprint 里，
      // 浏览器再抄一份的下场是"下次合并页面，这份没人改"，旧书签静默落到首页。
      const aliases = (data && data.aliases) || {}
      const wanted = aliases[pref.region] || pref.region
      const regionId = nav.some((item) => item.id === wanted) ? wanted : (nav[0] ? nav[0].id : '')
      const region = data && data.regions ? data.regions[regionId] : null
      const regionMeta = nav.find((item) => item.id === regionId) || nav[0] || null

      /**
       * 真正能看见的宽度。
       *
       * 宿主给插件的容器宽度不一定等于窗口里能显示的那一块：宿主的横向布局
       * 自己溢出时，容器右边那截就落在窗口外面，看得见的只有 container 减去超出量。
       * 断点必须按**看得见**的宽度算，否则 1256 的容器会开三栏，而实际
       * 只露出 1180 —— 第三栏的右边缘（以及卡片里的字）就被窗口切掉了。
       */
      const availWidth = (() => {
        if (geom.container > 0) {
          const vw = geom.cssViewport || geom.viewport
          if (vw <= 0) return geom.container
          const visible = vw - Math.max(0, geom.left)
          return Math.max(300, Math.min(geom.container, visible > 0 ? visible : geom.container))
        }
        return 0
      })()
      // 被外层裁掉的像素数：> 0 说明「宿主给的位置不够」，不是样式写宽了。
      const clipped = geom.container > 0 && geom.container - availWidth > 2

      /** 纵向同理：根节点收到「从这个位置到视口底」的高度，输入框才不会落在窗口外。 */
      const availHeight = (() => {
        if (!(geom.height > 0)) return 0
        const vh = geom.cssViewportH || geom.viewportH
        if (vh <= 0) return 0
        const visible = vh - Math.max(0, geom.top)
        return visible > 0 ? Math.min(geom.height, visible) : 0
      })()
      const clippedY = availHeight > 0 && geom.height - availHeight > 2

      // 两个收起理由必须分开记：用户自己收的记住，窗口太窄被系统收的不记
      // 容器的可见宽度断点：只有拿到下发的几何之后才知道断点在哪。
      // 第一帧 availWidth 还是 0，两个判断本来就是 false，所以不需要兜底数字。
      const autoRail = !!layout && availWidth > 0 && availWidth < layout.autoCollapseAt
      const compact = !!layout && availWidth > 0 && availWidth < layout.compactAt
      // 三栏的开关：导航 248 + 列表 272 + 详情至少 520（表单要放两列标签和输入框），
      // 再加两处缝隙，取 1080。实测 995px 时三栏里详情只剩 400 出头，
      // 搜索框会被右边缘切掉一半 —— "看得见一半"比"看不见"更让人困惑。
      const wide = !compact && availWidth >= 1080
      const rail = pref.collapsed || autoRail

      // 修订号一变就把主数据、当前详情一起重拉：详情页以前只在
      // 「点开另一张卡」或「本窗口保存」时才取数，外部改动看不到。
      useEffect(() => {
        onRevisionChange = () => {
          if (localConfigWrites === 0) setDrafts({})
          setToken((n) => n + 1)
        }
        return () => { onRevisionChange = null }
      }, [])

      useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            // 顺带把**实测**的现场报上去。
            //
            // 为什么值得单独加这几个数：界面"右边被切掉"这类问题，从截图上看
            // 和从代码上看都只能猜 —— 猜错就会去改一个九成无关的样式。
            // 报了「宿主给了多宽 / 视口多宽 / 左边从哪开始」，服务端一句话就能回答
            // "是样式写宽了，还是宿主给的位置不够、差多少"，不用截图对比。
            const g = measureGeom()
            const visible = (g.cssViewport || g.viewport) - Math.max(0, g.left)
            const cut = visible > 0 ? Math.max(0, g.container - visible) : 0
            // 分栏实测：宽@左 / 高@上（视口坐标）。三栏挤没挤、聊天输入框
            // 到底在不在窗口里，有这几个数就不用看图猜；截图只能看出"不对劲"。
            // 聊天相关层只有打开会话时才存在，缺了就写 '-'，不猜。
            const geo = (() => {
              const el = rootRef.current
              if (!el) return ''
              const parts = [
                'win:' + g.viewport + 'x' + g.viewportH,
                'fix:' + g.dpr + '/' + (g.dprFix ? 'on' : 'off') + '/' + g.cssViewport + 'x' + g.cssViewportH,
                'root:' + g.ownWidth + 'x' + g.ownHeight + '@' + g.left + ',' + g.top,
                'slot:' + g.container + 'x' + g.height,
                'cut:' + cut + 'x' + Math.max(0, g.height - Math.max(0, (g.cssViewportH || g.viewportH) - Math.max(0, g.top))),
              ]
              ;['.slj-nav', '.slj-inner', '.slj-content', '.slj-talkPage', '.slj-splitMain',
                '.slj-splitSide', '.slj-chatWrap', '.slj-thread', '.slj-composer'].forEach((sel) => {
                const node = el.querySelector(sel)
                const name = sel.replace('.slj-', '')
                if (!node) { parts.push(name + ':-'); return }
                const r = node.getBoundingClientRect()
                parts.push(name + ':' + Math.round(r.width) + '@' + Math.round(r.left) +
                  '/' + Math.round(r.height) + '@' + Math.round(r.top))
              })
              // 选择器有没有生效、消息区是不是真的在自己滚 —— 这两件事
              // 只看 rect 看不出来，得问 computed style 和 scrollHeight。
              const content = el.querySelector('.slj-content')
              if (content && typeof window.getComputedStyle === 'function') {
                const cs = window.getComputedStyle(content)
                parts.push('css:' + cs.display + '/' + cs.overflowY + '/' + cs.position)
              }
              // 视口原点在屏幕上的位置 + 缩放：截图用的是屏幕物理像素，
              // getBoundingClientRect 用的是视口 CSS 像素，两者对不上时
              // 「元素在视口内」并不等于「截图里看得见」。
              parts.push('dpr:' + (window.devicePixelRatio || 1) +
                ' scr:' + Math.round(window.screenX || 0) + ',' + Math.round(window.screenY || 0) +
                '/' + Math.round(window.outerWidth || 0) + 'x' + Math.round(window.outerHeight || 0))
              const comp = el.querySelector('.slj-composer')
              if (comp) {
                if (typeof window.getComputedStyle === 'function') {
                  const cs = window.getComputedStyle(comp)
                  parts.push('comp:' + cs.position + '/' + cs.zIndex + '/' + cs.display)
                }
                // 输入栏中心点最上面盖着谁：命中它自己 = 真的画出来了
                const cr = comp.getBoundingClientRect()
                const hit = typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
                  ? document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2)
                  : null
                parts.push('hit:' + (hit ? String(hit.className || hit.tagName || '?').slice(0, 32) : 'none'))
              }
              const thread = el.querySelector('.slj-thread')
              if (thread) parts.push('scroll:' + Math.round(thread.scrollHeight || 0) + '/' + Math.round(thread.clientHeight || 0))
              return parts.join(' ')
            })()
            const next = await api(
              '/panel?rev=' + CLIENT_REV +
              '&w=' + g.container +
              '&vw=' + g.viewport +
              '&left=' + g.left +
              '&ow=' + cut +
              '&geo=' + encodeURIComponent(geo),
            )
            if (!alive) return
            // 挂载那一帧 WebView 常常还没完成布局：outerWidth 是 0，dpr 补偿算不出来，
            // 而 ResizeObserver 之后不会为"窗口没变、只是数值补齐了"再发一次通知。
            // 每次拉面板都把现场测量回填到状态，几何才不会永远停在首屏那份旧数。
            setGeom((prev) => (
              prev.container === g.container && prev.left === g.left && prev.viewport === g.viewport &&
              prev.height === g.height && prev.top === g.top && prev.viewportH === g.viewportH &&
              prev.ownWidth === g.ownWidth && prev.ownHeight === g.ownHeight &&
              prev.cssViewport === g.cssViewport && prev.cssViewportH === g.cssViewportH &&
              prev.dprFix === g.dprFix ? prev : g
            ))
            setData(next)
            setError('')
          } catch (err) {
            if (alive) setError(String((err && err.message) || err))
          }
        }
        // 不再每 5 秒拉一次完整载荷：由 SSE 的 invalidate 驱动 token，
        // 连不上时由下面那段降级成定时轮询。取数只留这一处，不复制第二份。
        pull()
        return () => { alive = false }
      }, [token, measureGeom])

      /**
       * 事件流接管刷新。
       *
       * 宿主每秒算一次低成本状态摘要，变了才推 invalidate；前端收到就 +1 token，
       * 上面那个 effect 重拉一次。心跳（ping）不触发取数 —— 那正是省下来的部分。
       *
       * 两条兜底不能省：
       * - EventSource 不存在 / 连不上 / 中途断了 → 5 秒轮询，行为退回旧版，界面不会瞎；
       * - 连上了也留 20 秒一次低频轮询 → 状态摘要没覆盖到的字段最多晚 20 秒出现，
       *   不会出现「改了但永远不刷新」。
       */
      useEffect(() => {
        let alive = true
        let source = null
        let fallback = null
        const bump = () => { if (alive) setToken((n) => n + 1) }
        const stopFallback = () => {
          if (fallback) { window.clearInterval(fallback); fallback = null }
        }
        const startFallback = (ms) => {
          if (fallback || !alive) return
          fallback = window.setInterval(bump, ms)
        }

        if (typeof window.EventSource !== 'function') {
          startFallback(5000)
          return () => { alive = false; stopFallback() }
        }
        try {
          source = new window.EventSource(ES_URL)
          source.onmessage = (event) => {
            if (!alive) return
            try {
              const payload = JSON.parse(event.data)
              if (payload && payload.type === 'invalidate') bump()
            } catch { /* 心跳或半截数据，忽略 */ }
          }
          source.onopen = () => {
            stopFallback()
            startFallback(20000)
          }
          source.onerror = () => {
            // EventSource 会自己重连；重连期间别让界面停在那儿不动。
            stopFallback()
            startFallback(5000)
          }
        } catch {
          startFallback(5000)
        }
        return () => {
          alive = false
          if (source) source.close()
          stopFallback()
        }
      }, [])

      // 响应式看的是**自己这块地方**的宽度，不是窗口宽度：宿主左右两栏都会伸缩。
      // 同时监听 window resize：宿主窗口改大小时，容器的左偏移会变（侧栏可能伸缩），
      // 只盯 ResizeObserver 会漏掉「容器没变、可见区变了」这种情况。
      useEffect(() => {
        const sync = () => setGeom((prev) => {
          const next = measureGeom()
          return prev.container === next.container && prev.left === next.left && prev.viewport === next.viewport &&
            prev.height === next.height && prev.top === next.top && prev.viewportH === next.viewportH &&
            prev.ownWidth === next.ownWidth && prev.ownHeight === next.ownHeight &&
            prev.cssViewport === next.cssViewport && prev.cssViewportH === next.cssViewportH &&
            prev.dprFix === next.dprFix ? prev : next
        })
        // 窗口尺寸变了先松掉上一次的收窄，让父槽位按真实可用宽度重新撑开；
        // 不松的话，父槽位已经缩到我们写死的宽度，ResizeObserver 只会量到旧值。
        const onWindowResize = () => {
          const el = rootRef.current
          if (el) {
            el.style.width = ''
            el.style.height = ''
          }
          containerRef.current = 0
          sync()
        }
        sync()
        const el = rootRef.current
        let observer = null
        if (el && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(sync)
          observer.observe(el)
          // 父节点也要盯：被宿主收窄时根节点的宽度不一定立刻变
          if (el.parentElement) observer.observe(el.parentElement)
        }
        window.addEventListener('resize', onWindowResize)
        return () => {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', onWindowResize)
        }
      }, [measureGeom])

      /**
       * 把根节点收进真正看得见的那块地方 —— 直接量 DOM、直接写 style。
       *
       * 以前这一步走「measureGeom → state → render → style prop」，链上有两个
       * 会掉链子的地方：首屏 outerWidth=0 算不出 dpr 补偿；之后 ResizeObserver
       * 又不会为"数值补齐了"再发通知。结果是自证里写着 fix:on、cut:256x163，
       * 根节点却还是 1002×776，输入框照样在窗口外。
       *
       * 改成每次渲染后重新量一次：数据每 5 秒回来一次，量错了下一轮自动纠正，
       * 不依赖任何一次测量恰好赶上布局完成。依赖里带 data 就是为此。
       */
      useEffect(() => {
        const el = rootRef.current
        if (!el) return
        const g = measureGeom()
        const visibleW = (g.cssViewport || g.viewport) - Math.max(0, g.left)
        const visibleH = (g.cssViewportH || g.viewportH) - Math.max(0, g.top)
        // 不再只在「裁掉了 >2px」时才写尺寸。以前裁一次→根节点变窄→父槽位也跟着
        // 变窄（它按内容撑宽）→下一次测量以为不裁了，把 width 清空→根节点弹回原宽，
        // 下一轮又裁 —— 形成 1256↔949 的循环。这里每次都把宽度钉在
        // min(槽位, 可见区)，清空只留给「量不到槽位/可见区」的异常帧。
        const w = g.container > 0 && visibleW > 0 ? Math.max(300, Math.min(g.container, visibleW)) : 0
        const h = g.height > 0 && visibleH > 0 ? Math.max(240, Math.min(g.height, visibleH)) : 0
        el.style.width = w ? w + 'px' : ''
        el.style.height = h ? h + 'px' : ''
      }, [geom, data, measureGeom])

      useEffect(() => {
        writeStore(pref)
      }, [pref])

      useEffect(() => {
        if (!toast) return undefined
        const timer = window.setTimeout(() => setToast(null), 4000)
        return () => window.clearTimeout(timer)
      }, [toast])

      // 取详情。detailId 一变就取；不发请求时把上一页清掉，
      // 免得「点了新卡、屏幕上还是上一页的字」。
      useEffect(() => {
        if (!detailId) {
          shownDetailIdRef.current = ''
          shownDetailQueryRef.current = ''
          setDetail(null)
          return undefined
        }
        let alive = true
        // 只有换卡或换筛选口径才清空旧内容。token 刷新（SSE / 20 秒兜底）时保留
        // 当前详情，等新数据回来原地替换 —— 否则每 20 秒整页闪一次「正在打开…」。
        const switched = shownDetailIdRef.current !== detailId || shownDetailQueryRef.current !== detailQuery
        shownDetailIdRef.current = detailId
        shownDetailQueryRef.current = detailQuery
        if (switched) setDetail(null)
        setDetailBusy(true)
        api('/detail?id=' + encodeURIComponent(detailId) + (detailQuery ? '&' + detailQuery : ''))
          .then((next) => {
            if (alive) setDetail(next)
          })
          .catch((err) => {
            if (alive) setDetail({ ok: false, kind: 'rows', title: '打不开', rows: [], empty: String((err && err.message) || err) })
          })
          .finally(() => {
            if (alive) setDetailBusy(false)
          })
        return () => {
          alive = false
        }
      }, [detailId, detailQuery, token])

      useEffect(() => {
        if (detailId !== 'process.cot') return undefined
        let alive = true
        const timer = window.setInterval(async () => {
          try {
            const next = await api('/detail?id=process.cot')
            if (alive && next) setDetail(next)
          } catch {}
        }, 2000)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [detailId])

      const say = useCallback((text, tone) => setToast({ text, tone: tone || 'ok' }), [])

      // ── 沙箱确认：取待确认列表 ──
      // 单独一个 1.5 秒的轮询，不跟面板那 5 秒混在一起：
      // 倒计时要走秒，5 秒一跳的界面会让人以为它卡住了。
      useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            const next = await api('/list/approvals')
            if (!alive) return
            askSkewRef.current = Date.now() - (Number(next.now) || Date.now())
            const first = Array.isArray(next.pending) && next.pending.length ? next.pending[0] : null
            setAsk((prev) => {
              if (prev && first && prev.id === first.id) return { ...prev, ...first }
              if (prev && !first) return null
              return first
            })
          } catch {
            // 拉不到就保持现状：面板断一下不代表这次确认被撤销了
          }
        }
        pull()
        const timer = window.setInterval(pull, 1500)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [token])

      // 换一条请求就把「理由」和「记住」清掉 —— 它们属于上一条，带过来就是错的授权
      useEffect(() => {
        setAskReason('')
        setAskRemember(false)
      }, [ask && ask.id])

      // 走秒：250ms 一跳，1 秒的倒计时才看得出来在动
      useEffect(() => {
        if (!ask) return undefined
        const timer = window.setInterval(() => setAskTick((n) => n + 1), 250)
        return () => window.clearInterval(timer)
      }, [ask && ask.id])

      const decideAsk = useCallback(async (allow, reason, remember) => {
        const current = ask
        if (!current || askDoneRef.current.has(current.id)) return
        askDoneRef.current.add(current.id)
        // 表只留最近 50 个：长跑时它是只增不减的，跟上一轮修的注意力账本一个毛病
        if (askDoneRef.current.size > 50) {
          askDoneRef.current = new Set([...askDoneRef.current].slice(-50))
        }
        setAskBusy(current.id)
        try {
          const result = await action('approval.decide', { id: current.id, allow, remember, reason })
          if (result && result.ok === false) say(String(result.error || '这个确认已经结束了'), 'bad')
          else if (allow) say(remember ? '已同意；以后同类请求不再弹窗' : '已同意，开始跑', 'ok')
          else say(remember ? '已拒绝；以后同类请求不再弹窗' : '已拒绝，这次不跑', 'ok')
        } catch (err) {
          say('提交失败：' + String((err && err.message) || err), 'bad')
        } finally {
          setAskBusy('')
          setAsk(null)
          // 面板上的「等人确认 / 确认记录」要立刻变，不等下一个 5 秒
          setToken((n) => n + 1)
        }
      }, [ask, say])

      // 倒计时走完：带着已经填好的理由按拒绝提交。
      // 服务端还有一道自己的兜底（比这里晚 2 秒），所以面板关着也不会永远挂着。
      const askLeftMs = ask
        ? Math.max(0, Number(ask.expiresAt) - (Date.now() - askSkewRef.current))
        : 0
      useEffect(() => {
        if (!ask || askLeftMs > 0) return
        if (askDoneRef.current.has(ask.id)) return
        decideAsk(false, askReason || '超时未确认（倒计时走完时没人点）', false)
      }, [askLeftMs, ask, askReason, decideAsk])

      const refresh = useCallback(() => {
        setError('')
        // 保留 detailId / detailQuery：刷新当前页，不把用户踢回列表。
        setDetail(null)
        setToken((n) => n + 1)
      }, [])

      const toggleRail = useCallback(() => {
        setPref((prev) => ({ ...prev, collapsed: !prev.collapsed }))
      }, [])

      const selectRegion = useCallback((id) => {
        setDraft('')
        setError('')
        setDetail(null)
        setDetailQuery('')
        setPref((prev) => (prev.region === id ? prev : { ...prev, region: id }))
        const first = id !== 'talk' && data && data.regions && data.regions[id] && Array.isArray(data.regions[id].modules)
          ? data.regions[id].modules[0]
          : null
        setDetailId(first ? first.detail : '')
        setToken((n) => n + 1)
      }, [data])

      // 首屏或刷新后，非对话页自动打开左侧第一项，保持“左选项/右详情”
      useEffect(() => {
        if (regionId === 'talk' || detailId || !data) return
        const first = data.regions && data.regions[regionId] && Array.isArray(data.regions[regionId].modules)
          ? data.regions[regionId].modules[0]
          : null
        if (first) {
          setDetailQuery('')
          setDetailId(first.detail)
        }
      }, [data, regionId, detailId])

      const openDetail = useCallback((id, query = '') => {
        setDraft('')
        // 先清掉上一页，避免审计切思维链时还停在旧内容上，看起来像“没跳转”
        setDetail(null)
        setDetailBusy(true)
        setDetailQuery(String(query || ''))
        setDetailId(String(id || ''))
      }, [])

      // 删错了要能退回来。之前「删除」是单向门：点歪一次，那条记忆就没了，
      // 只能重新跟它说一遍。这里留一段后悔时间。
      //
      // 位置说明：这两个东西必须待在 **Panel** 的作用域里，因为它下面的详情区
      // （memory / skills 这些分区的行操作）要引用它们。0.31.0 一开始把它们写进了
      // TalkSplit，结果一点「记忆」就 ReferenceError: undoBar is not defined ——
      // 整块面板白屏，而单测只渲染第一帧，看不出来。
      const [undo, setUndo] = useState(null)

      /** 把刚删掉的那条写回去。用「再记一遍」实现，走同一条写入路径最不容易出错。 */
      const runUndo = useCallback(async () => {
        if (!undo) return
        const item = undo.item || {}
        try {
          let result = null
          if (item.type === 'fact') result = await action('memory.remember', { text: item.text })
          else if (item.type === 'self') result = await action('memory.rememberSelf', { text: item.text })
          else if (item.type === 'person') result = await action('memory.editPerson', { uin: item.uin, name: item.name, note: item.note, impression: item.impression })
          else if (item.type === 'group') {
            result = await action('memory.editGroup', { groupId: item.groupId, label: item.label, topic: (item.topics || [])[0] || '' })
            // 话题是列表，接口一次只收一条 —— 其余的补一遍，别只恢复第一条还说「回来了」
            for (const topic of (item.topics || []).slice(1)) {
              await action('memory.editGroup', { groupId: item.groupId, topic })
            }
          }
          if (result && result.ok) {
            say('撤销了，那条又回来了')
            setUndo(null)
            // 详情区的取数 effect 挂在 [detailId, token] 上：+1 就会重取这一页
            setToken((n) => n + 1)
          } else {
            say((result && result.error) || '没撤销成，可能已经被别的操作改过', 'bad')
          }
        } catch (error) {
          say(String((error && error.message) || error), 'bad')
        }
      }, [undo, say])

      const undoBar = undo
        ? h(
            'div',
            { className: 'slj-panel', style: { marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { style: { fontSize: 13 } }, `删了${undo.label ? '「' + undo.label + '」' : '一条记忆'}`),
            h('button', { type: 'button', className: 'slj-btn', onClick: runUndo }, '撤销'),
            h('button', { type: 'button', className: 'slj-btn', onClick: () => setUndo(null) }, '不用了'),
          )
        : null

      const startDrag = useCallback(
        (event) => {
          if (rail || !layout) return
          event.preventDefault()
          const startX = event.clientX
          const startWidth = widthRef.current || layout.expanded
          dragRef.current = { startX, startWidth }
          const move = (moveEvent) => {
            const drag = dragRef.current
            if (!drag) return
            const next = clampWidth(drag.startWidth + (moveEvent.clientX - drag.startX), layout.min, layout.max)
            widthRef.current = next
            setPref((prev) => (prev.width === next ? prev : { ...prev, width: next }))
          }
          const up = () => {
            dragRef.current = null
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        },
        [rail, layout],
      )

      const resetWidth = useCallback(() => {
        widthRef.current = 0
        setPref((prev) => ({ ...prev, width: 0 }))
      }, [])

      // 0 = 还不知道（数据没到）。这时候不要写内联宽度，交给 CSS 的默认值。
      const width = layout ? clampWidth(pref.width, layout.min, layout.max) || layout.expanded : 0
      widthRef.current = width

      /**
       * 一次提交多项改动。
       *
       * 为什么要有这条路：设置 123 项、每项一个保存按钮，改三项就要点三次，
       * 每点一次重拉一遍整棵树 —— 用户看到的是"改个设置要等三下"。
       * 现在草稿攒着，一次 POST /config {items:[...]} 交上去。
       *
       * 两件事**不**进批量，宁可少省一次点击：
       *   1. 标了「危险」的项 —— 它们要逐项确认，混进批量等于绕过确认；
       *   2. 留空的敏感项 —— 留空的意思是"不修改"，不该被当成一次写入。
       */
      const saveMany = useCallback(
        async (keys) => {
          const items = detail && detail.form && Array.isArray(detail.form.items) ? detail.form.items : []
          const byKey = new Map(items.map((item) => [item.key, item]))
          const payload = []
          const skipped = []
          for (const key of keys || []) {
            const item = byKey.get(key)
            if (!item || item.needConfirm === true) continue
            const value = drafts[key]
            if (item.secret && String(value).trim() === '') {
              skipped.push(item.label || key)
              continue
            }
            const numeric = Number(value)
            payload.push({
              key: item.key,
              value: item.kind === 'number' ? (item.scale ? Math.round(numeric * Number(item.scale)) : numeric) : String(value),
            })
          }
          if (!payload.length) {
            say(skipped.length ? '敏感项留空表示不修改' : '没有要保存的改动', 'bad')
            return
          }
          setBusy('__batch__')
          localConfigWrites += 1
          try {
            const result = await api('/config', { method: 'POST', body: JSON.stringify({ items: payload }) })
            const saved = result && Array.isArray(result.items) ? result.items : []
            const failed = result && Array.isArray(result.failed) ? result.failed : []
            setDrafts((prev) => {
              const next = { ...prev }
              for (const key of saved) delete next[key]
              return next
            })
            if (failed.length) {
              say(`存了 ${saved.length} 项；${failed.length} 项没成：${failed.map((one) => one.key).join('、')}`, 'bad')
            } else {
              say(`存好了 ${saved.length} 项`)
            }
          } catch (err) {
            say(String((err && err.message) || err), 'bad')
          } finally {
            localConfigWrites = Math.max(0, localConfigWrites - 1)
            setBusy('')
          }
        },
        [detail, drafts, say],
      )

      const discardDrafts = useCallback(() => setDrafts({}), [])

      const toggleSkill = useCallback(
        async (skill, confirmNow) => {
          setBusy(skill.id)
          try {
            const result = await action('skill.set', { id: skill.id, on: skill.state !== 'on', confirm: confirmNow === true })
            if (result && result.needConfirm) {
              setConfirmSkill(skill)
              return
            }
            if (result && result.ok) {
              say(result.message || '改好了')
              setConfirmSkill(null)
              setToken((n) => n + 1)
            } else {
              setConfirmSkill(null)
              say((result && result.error) || '没改成', 'bad')
            }
          } catch (err) {
            say(String((err && err.message) || err), 'bad')
          } finally {
            setBusy('')
          }
        },
        [say],
      )

      const saveConfig = useCallback(
        async (item, value, confirmNow) => {
          setBusy(item.key)
          localConfigWrites += 1
          try {
            if (item.secret && String(value).trim() === '') {
              say('敏感项留空表示不修改', 'bad')
              return
            }
            const numeric = Number(value)
            const payload = item.kind === 'number' ? (item.scale ? Math.round(numeric * Number(item.scale)) : numeric) : String(value)
            const result = await api('/config', {
              method: 'POST',
              body: JSON.stringify({ key: item.key, value: payload, confirm: confirmNow === true }),
            })
            if (result && result.needConfirm) {
              setConfirm({ key: item.key, value })
              return
            }
            if (result && result.ok) {
              say(result.message || '改好了')
              setConfirm(null)
              setDrafts((prev) => {
                const next = { ...prev }
                delete next[item.key]
                return next
              })
              // 刷新交给响应里的 revision 统一触发：这块数据、主面板、
              // 当前打开的详情会一起重拉，不再只刷「本窗口记得刷的那一块」。
            } else {
              say((result && result.error) || '没改成', 'bad')
            }
          } catch (err) {
            say(String((err && err.message) || err), 'bad')
          } finally {
            localConfigWrites = Math.max(0, localConfigWrites - 1)
            setBusy('')
          }
        },
        [say],
      )

      // 开关不做「先存后确认」：宿主判定危险会回头要 confirm，界面再显示确认条。
      // 这样高危项不可能被一个开关悄悄打开。
      const toggleBool = useCallback(
        async (item) => {
          await saveConfig(item, item.value === true ? 'false' : 'true', false)
        },
        [saveConfig],
      )

      const onDraft = useCallback((key, value) => {
        setDrafts((prev) => ({ ...prev, [key]: value }))
      }, [])

      const onMore = useCallback(async () => {
        if (!detail || !detail.hasMore) return
        const before = detail.nextBefore
        const kind = detail.chat ? 'chat' : 'rows'
        setLoadingMore(true)
        try {
          // 聊天按自己的页大小继续；审计/思维链仍用服务端默认页
          const pageParam = detail.chat ? '&limit=' + encodeURIComponent(String(detail.chat.pageSize || 100)) : ''
          const next = await api('/detail?id=' + encodeURIComponent(detail.id) + '&before=' + encodeURIComponent(before || '') + pageParam)
          setDetail((prev) => {
            if (!prev) return next
            if (kind === 'chat') {
              const older = (next.chat && next.chat.rows) || []
              return {
                ...prev,
                chat: { ...prev.chat, rows: older.concat(prev.chat.rows || []), hasMore: next.chat ? next.chat.hasMore : false, nextBefore: next.chat ? next.chat.nextBefore : null },
              }
            }
            return { ...prev, rows: (prev.rows || []).concat(next.rows || []), hasMore: next.hasMore, nextBefore: next.nextBefore }
          })
        } catch (err) {
          say(String((err && err.message) || err), 'bad')
        } finally {
          setLoadingMore(false)
        }
      }, [detail, say])

      const sendChat = useCallback(async () => {
        const text = String(draft || '').trim()
        if (!text || !detail || !detail.chat || !detail.chat.canSend || sending) return
        setSending(true)
        setDraft('')
        try {
          if (detail.chat.source === 'local') {
            const result = await api('/chat', { method: 'POST', body: JSON.stringify({ text }) })
            if (result && result.ok) {
              setDetail((prev) =>
                prev ? { ...prev, chat: { ...prev.chat, rows: result.rows || [] } } : prev,
              )
              setToken((n) => n + 1)
            } else {
              setDraft(text)
              say((result && result.error) || '没发出去', 'bad')
            }
          } else {
            const result = await action('qq.send', { conversation: detail.chat.conversation, text })
            if (result && result.ok) {
              say('发出去了')
              setToken((n) => n + 1)
            } else {
              setDraft(text)
              say((result && result.error) || '没发出去', 'bad')
            }
          }
        } catch (err) {
          setDraft(text)
          say(String((err && err.message) || err), 'bad')
        } finally {
          setSending(false)
        }
      }, [draft, detail, sending, say])

      // 对话页：左侧模式/会话，右侧可滚动消息
      const talkRef = useRef(null)
      if (!talkRef.current) talkRef.current = function TalkSplit({ token, wide }) {
        const [mode, setMode] = useState('qq')
        const [filter, setFilter] = useState('all')
        const [rows, setRows] = useState([])
        const [active, setActive] = useState('')
        const [query, setQuery] = useState('')
        const [detail, setDetail] = useState(null)
        const [draft, setDraft] = useState('')
        const [sending, setSending] = useState(false)
        // 当前选中的会话，给「token 刷新」用：它不在加载 effect 的依赖里，
        // 否则每次选中都会触发一轮列表重拉。查询串同理（审计口径用）。
        const activeRef = useRef('')
        const queryRef = useRef('')

        /**
         * 打开一个详情页。
         *
         * `query` 是给审计页那三个胶囊用的（级别 / 类型 / 含不含噪音）：
         * 页面上临时点的口径只作用于这一次请求，不写回设置 ——
         * 「看一眼全部」不该顺手把默认口径改掉。
         */
        const openDetail = useCallback(async (id, query = '', keepDraft = false) => {
          activeRef.current = String(id || '')
          queryRef.current = String(query || '')
          setActive(id)
          setQuery(query)
          // token 刷新当前会话时保留用户还没发出去的草稿；只有真的切会话才清空。
          if (!keepDraft) setDraft('')
          try {
            setDetail(await api('/detail?id=' + encodeURIComponent(id) + (query ? '&' + query : '')))
          } catch (err) {
            setDetail({ ok: false, kind: 'rows', title: '打不开', rows: [], empty: String((err && err.message) || err) })
          }
        }, [])

        /**
         * 模式/宽窄变化才重置整页；token 只是「有数据变了」的信号。
         * 以前 token 也在依赖里，20 秒兜底轮询一到就 setRows([])/setActive('')/
         * setDetail(null)，对话页会整页清空再拉回 —— 用户看到的就是「像刷新一样」。
         * 现在 token 刷新只更新列表和当前详情，保留选中会话与滚动位置。
         */
        const loadStateRef = useRef({ mode: '', wide: null })
        useEffect(() => {
          let alive = true
          const prev = loadStateRef.current
          const reset = prev.mode !== mode || prev.wide !== wide
          loadStateRef.current = { mode, wide }
          if (reset) {
            setRows([])
            setActive('')
            setDetail(null)
            activeRef.current = ''
            queryRef.current = ''
          }
          // 窄屏一次只显示一屏：进来先看会话列表，点开哪个才进哪段对话。
          // 以前不分宽窄都自动打开第一条，等于"进对话页直接展示一段聊天"，
          // 想换会话得先点返回 —— 在只能显示一屏的地方，这个默认动作是错的。
          if (mode === 'local') {
            if (reset) openDetail('talk.local')
            // token 刷新/点顶栏「刷新」时，当前这段独立对话也要立刻重取
            else if (activeRef.current) openDetail(activeRef.current, queryRef.current, true)
            return () => { alive = false }
          }
          api('/detail?id=talk.qq')
            .then((next) => {
              if (!alive) return
              const list = next && Array.isArray(next.rows) ? next.rows : []
              setRows(list)
              // 只有首次进入/切模式时才自动选第一条；刷新时用户选哪条就留在哪条。
              if (reset && wide && list[0]) openDetail(list[0].open)
              // token 刷新/「刷新」按钮：不重置列表，只把当前会话的详情立刻重取一次，
              // 不再等 3 秒的轮询 —— 否则点刷新像没反应。
              else if (!reset && activeRef.current) openDetail(activeRef.current, queryRef.current, true)
            })
            .catch((err) => { if (alive) say(String((err && err.message) || err), 'bad') })
          return () => { alive = false }
        }, [mode, token, wide, openDetail, say])

        useEffect(() => {
          if (!active) return undefined
          let alive = true
          const timer = window.setInterval(async () => {
            try {
              const next = await api('/detail?id=' + encodeURIComponent(active) + (query ? '&' + query : ''))
              if (alive && next) setDetail(next)
            } catch {}
          }, 3000)
          return () => {
            alive = false
            window.clearInterval(timer)
          }
        }, [active, query])

        const visible = rows.filter((row) => {
          if (filter === 'all') return true
          const group = String(row.open || '').startsWith('qq:group:')
          return filter === 'group' ? group : !group
        })

        const send = async () => {
          const text = String(draft || '').trim()
          if (!text || !detail || !detail.chat || !detail.chat.canSend || sending) return
          setSending(true)
          try {
            const result = detail.chat.source === 'local'
              ? await api('/chat', { method: 'POST', body: JSON.stringify({ text }) })
              : await action('qq.send', { conversation: detail.chat.conversation, text })
            if (result && result.ok) {
              setDraft('')
              await openDetail(active)
              say(detail.chat.source === 'local' ? '发出去了' : '发到 QQ 了')
            } else {
              say((result && result.error) || '没发出去', 'bad')
            }
          } finally {
            setSending(false)
          }
        }

        const side = h(
          'div',
          { className: wide ? 'slj-splitSide' : 'slj-splitSide slj-splitSideFull' },
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', className: 'slj-btn', 'aria-pressed': mode === 'local', onClick: () => setMode('local') }, '独立对话'),
            h('button', { type: 'button', className: 'slj-btn', 'aria-pressed': mode === 'qq', onClick: () => setMode('qq') }, 'QQ 会话'),
          ),
          mode === 'qq'
            ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                [['all', '全部'], ['group', '群聊'], ['private', '私聊']].map(([key, label]) =>
                  h('button', { key, type: 'button', className: 'slj-btn', 'aria-pressed': filter === key, onClick: () => setFilter(key) }, label),
                ),
              )
            : null,
          mode === 'qq'
            ? visible.map((row) =>
                h('button', { key: row.open, type: 'button', className: 'slj-splitRow', 'aria-current': active === row.open ? 'true' : 'false', onClick: () => openDetail(row.open) },
                  h('b', null, row.title),
                  h('small', null, row.meta),
                  h('small', null, row.desc),
                ),
              )
            : h('button', { type: 'button', className: 'slj-splitRow', 'aria-current': active === 'talk.local' ? 'true' : 'false', onClick: () => openDetail('talk.local') },
                h('b', null, '独立对话'), h('small', null, '不走 QQ，直接说话'),
              ),
          // 列表为空时别只留一片白：说清是"没有会话"还是"还没拉到"
          mode === 'qq' && !visible.length
            ? h('div', { className: 'slj-empty' }, rows.length ? '这一类里没有会话' : '还没有会话记录')
            : null,
        )

        const chatPane = h('div', { className: 'slj-splitMain' },
          detail && detail.kind === 'chat'
            ? h(DetailChat, { detail, draft, sending, onDraft: setDraft, onSend: send, onMore: () => {}, loadingMore: false })
            : h('div', { className: 'slj-empty' }, !detail && active ? '正在打开…' : (detail && detail.empty ? detail.empty : '选一个会话')),
        )

        // 窄屏：一屏一件事。列表 → 点开 → 整页对话 + 一条返回。
        //
        // 以前不分宽窄都并排：实测 1002 宽时左侧占 240、聊天列只剩 435，
        // 气泡里的字每行只能放十来个 —— 两边都不好用，还不如一次只给一屏。
        if (!wide) {
          if (!active) return h('div', { className: 'slj-talkList' }, side)
          return h(
            'div',
            { className: 'slj-talkPage' },
            h(
              'div',
              { className: 'slj-crumb' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'slj-back',
                  onClick: () => { activeRef.current = ''; queryRef.current = ''; setActive(''); setDetail(null); setDraft('') },
                },
                h(Icon, { name: 'chevronLeft', size: 12 }),
                ' 会话列表',
              ),
              detail && detail.title ? h('span', null, detail.title) : null,
            ),
            chatPane,
          )
        }

        return h('div', { className: 'slj-split', 'data-slj-wide': 'true' }, side, chatPane)
      }
      const TalkSplit = talkRef.current

      const body = (() => {
        if (error && !data) {
          return h(
            'div',
            null,
            h(Banner, { tone: 'bad' }, '连不上宿主：' + error),
            h('button', { type: 'button', className: 'slj-btn', onClick: refresh }, '再试一次'),
          )
        }
        if (!data) return h('div', { className: 'slj-empty' }, '正在读状态…')

        const renderDetail = () => {
          if (detailBusy && !detail) return h('div', { className: 'slj-empty' }, '正在打开…')
          if (!detail) return h('div', { className: 'slj-empty' }, '没有内容')
          if (detail.kind === 'cards') return h(DetailCards, { detail })
          if (detail.kind === 'debug') return h(DebugPanel, { detail, notify: say })
          if (detail.kind === 'image') return h(QrPanel, { detail })
          if (detail.kind === 'groups') return h(GroupPanel, { detail })
          if (detail.kind === 'vision') return h(VisionPanel, { detail })
          if (detail.kind === 'chat') {
            return h(DetailChat, {
              detail,
              draft,
              sending,
              onDraft: setDraft,
              onSend: sendChat,
              onMore,
              loadingMore,
            })
          }
          if (detail.kind === 'form' && detail.id === 'settings.tools') return h(PolicyPanel)
          if (detail.kind === 'form') {
            return h(DetailForm, {
              detail,
              drafts,
              busy,
              confirm,
              onDraft,
              onToggleBool: toggleBool,
              onSave: (item, value) => saveConfig(item, value, false),
              onSaveAll: saveMany,
              onDiscard: discardDrafts,
              onConfirm: () => {
                const item = confirm ? findItem(detail, confirm.key) : null
                if (!item || !confirm) return
                saveConfig(item, confirm.value, true)
              },
              onCancel: () => setConfirm(null),
            })
          }
          return h(DetailRows, {
            detail,
            busy,
            onOpen: openDetail,
            // 审计页的胶囊：改口径 = 带参数重开这一页（不是就地过滤已加载的那 40 条，
            // 那样「翻不到更早的」会变成假话 —— 服务端得按新口径重新扫）
            onFilter: (next) => openDetail('process.audit', next),
            onMore,
            loadingMore,
            onToggleSkill: (skill) => toggleSkill(skill),
            onAction: async (row) => {
              if (row.action === 'forget-approval') {
                try {
                  const result = await action('approval.forget', {})
                  say(result && result.cleared ? '记住的结论已经清掉，下次会重新问' : '本来就没记住', result && result.ok !== false ? 'ok' : 'bad')
                } catch (error) {
                  say(String((error && error.message) || error), 'bad')
                }
                setToken((n) => n + 1)
                return
              }
              if (String(row.action || '').startsWith('login-')) {
                const map = {
                  'login-retry': 'retry',
                  'login-refresh': 'refresh',
                  'login-qr': 'qr',
                  'login-start': 'start',
                  'login-restart': 'restart',
                }
                const action = map[row.action] || 'retry'
                try {
                  const result = await api('/napcat/login', { method: 'POST', body: JSON.stringify({ action }) })
                  say((result && (result.message || result.error)) || '已提交', result && result.ok !== false ? 'ok' : 'bad')
                } catch (error) {
                  say(String((error && error.message) || error), 'bad')
                }
                setToken((n) => n + 1)
                return
              }
              if (row.action === 'edit-reminder') {
                const text = window.prompt('提醒内容：', row.text || '')
                const when = window.prompt('提醒时间（YYYY-MM-DD HH:mm）：', new Date(row.at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'))
                const at = when ? Date.parse(String(when).replace(' ', 'T')) : NaN
                if (text && String(text).trim() && Number.isFinite(at)) {
                  const result = await action('reminder.update', { id: row.value, text: String(text).trim(), at })
                  say(result && result.ok ? '提醒改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'cancel-reminder') {
                const result = await action('reminder.cancel', { id: row.value })
                say(result && result.ok ? '提醒取消了' : (result && result.error) || '没取消', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-self') {
                const result = await action('memory.editSelf', { old: row.value, text: row.values?.text })
                say(result && result.ok ? '自我记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-self') {
                const result = await action('memory.forgetSelf', { text: row.value })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.value || '').slice(0, 24) })
                say(result && result.ok ? '这条自我记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-fact') {
                const result = await action('memory.edit', { old: row.value, text: row.values?.text })
                say(result && result.ok ? '改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-person') {
                const result = await action('memory.editPerson', { uin: row.value, name: row.values?.name, note: row.values?.note, impression: row.values?.impression })
                say(result && result.ok ? '人物改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-group') {
                const result = await action('memory.editGroup', { groupId: row.value, label: row.values?.label, topic: row.values?.topic })
                say(result && result.ok ? '群记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'edit-fact') {
                const next = window.prompt('把这条事实改成：', row.value)
                if (next && String(next).trim() && String(next).trim() !== row.value) {
                  const result = await action('memory.edit', { old: row.value, text: String(next).trim() })
                  say(result && result.ok ? '改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'edit-person') {
                const name = window.prompt('这个人叫什么：', row.title)
                if (name && String(name).trim()) {
                  const note = window.prompt('加一条备注（可留空）：', '') || ''
                  const result = await action('memory.editPerson', { uin: row.value, name: String(name).trim(), note: String(note).trim() })
                  say(result && result.ok ? '人物改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'edit-group') {
                const label = window.prompt('这个群叫什么：', row.title)
                if (label && String(label).trim()) {
                  const topic = window.prompt('加一条群话题（可留空）：', '') || ''
                  const result = await action('memory.editGroup', { groupId: row.value, label: String(label).trim(), topic: String(topic).trim() })
                  say(result && result.ok ? '群记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'forget-fact') {
                const result = await action('memory.forget', { text: row.value })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.value || '').slice(0, 24) })
                say(result && result.ok ? '忘了这条' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-person') {
                const result = await action('memory.forgetPerson', { uin: row.value })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.title || '') })
                say(result && result.ok ? '这个人的记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-group') {
                const result = await action('memory.forgetGroup', { groupId: row.value })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.title || '') })
                say(result && result.ok ? '这个群的记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-skill') {
                const result = await action('skill.amend', { id: (row.skill && row.skill.id) || row.id, name: row.values?.name, what: row.values?.what })
                say((result && (result.ok ? result.message : result.error)) || (result && result.ok ? '改好了' : '没改成'), result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-skill') {
                const result = await action('skill.forget', { id: row.skill.id })
                say(result && result.ok ? '技能删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              }
              setToken((n) => n + 1)
            },
            extra: [
              undoBar,
              detail.id === 'skills.all'
                ? h(TeachSkillForm, { onDone: () => setToken((n) => n + 1), notify: say })
                : detail.id === 'memory.facts' || detail.id === 'memory.all'
                  ? h(AddMemoryForm, { onDone: () => setToken((n) => n + 1), notify: say })
                  : null,
            ],
          })
        }

        // 详情页。宽屏下即使没选详情也走两栏（列表常驻），
        // 因为"点开一张卡就离开列表"在宽屏上纯属浪费空间；窄屏保留原来的替换式。
        const splitable = regionId !== 'talk' && region && Array.isArray(region.modules) && region.modules.length

        // 窄屏：详情整页显示，左上角给返回。
        //
        // 以前窄屏也硬做成「列表 240 + 详情」两栏，实测在 1295 宽的窗口里
        // 详情区只剩 400px —— 搜索框、输入框、说明全在右边缘被切掉一半。
        // 看得见一半比看不见更糟：人不知道该拖哪、也不知道还有没有别的内容。
        if (detailId && !wide && regionId !== 'talk') {
          return h(
            'div',
            null,
            h(
              'div',
              { className: 'slj-crumb' },
              h(
                'button',
                { type: 'button', className: 'slj-back', onClick: () => { setDetailId(''); setDetailQuery('') } },
                h(Icon, { name: 'chevronLeft', size: 12 }),
                ' ' + (regionMeta ? regionMeta.label : '返回'),
              ),
            ),
            renderDetail(),
          )
        }

        if (wide && splitable) {
          if (splitable) {
            return h(
              'div',
              { className: 'slj-split', 'data-slj-wide': wide ? 'true' : 'false' },
              h(
                'div',
                { className: 'slj-splitSide' },
                region.modules.map((module) =>
                  h(
                    'button',
                    {
                      key: module.detail,
                      type: 'button',
                      className: 'slj-splitRow',
                      'aria-current': detailId === module.detail ? 'true' : 'false',
                      onClick: () => openDetail(module.detail),
                    },
                    h('b', null, module.label),
                    h('small', null, module.desc),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'slj-splitMain' },
                // 宽屏且还没选：右手边给一句话，而不是一片空白。
                // 这里不自动打开第一项 —— 自动打开等于每次切页都多发一个详情请求，
                // 而用户可能只是想看一眼左边的名单。
                detailId ? renderDetail() : h('div', { className: 'slj-empty' }, '从左边选一项'),
              ),
            )
          }
        }
        if (detailId) return renderDetail()

        // 对话页走专用两栏：左侧模式/会话，右侧滚动消息
        if (regionId === 'talk') return h(TalkSplit, { token, wide })

        // 区域页
        if (!region) return h('div', { className: 'slj-empty' }, '这一栏还没准备好')
        return h(
          'div',
          null,
          // 概览额外给一排状态牌：进来先看结论，再决定点哪张卡
          regionId === 'overview' && data.sections && data.sections.overview
            ? h(
                'div',
                null,
                h('div', { className: 'slj-tiles' }, (data.sections.overview.tiles || []).map((tile, index) => h(Tile, { key: index, tile }))),
                data.sections.overview.note ? h('p', { className: 'slj-note' }, data.sections.overview.note) : null,
              )
            : null,
          moduleSections(region.modules || []).map((group, groupIndex) =>
            h(
              'section',
              { key: groupIndex, className: 'slj-modSection' },
              group.label ? h('h3', { className: 'slj-modSectionHead' }, group.label) : null,
              h(
                'div',
                { className: 'slj-mods' },
                group.items.map((module) => h(ModuleCard, { key: module.detail, module, onOpen: openDetail })),
              ),
            ),
          ),
        )
      })()

      const title = detailId && detail ? detail.title : regionMeta ? regionMeta.label : '深蓝鲸'
      const subtitle = detailId && detail ? detail.subtitle || '' : regionMeta ? regionMeta.hint : ''

      return h(
        'div',
        {
          className: 'slj-root',
          ref: rootRef,
          'data-slj-rail': rail ? 'true' : 'false',
          'data-slj-compact': compact ? 'true' : 'false',
          // 被外层裁掉时把根节点自己收到看得见的宽度。
          //
          // 这不是"美化"：宿主给的位置比窗口窄时，第三栏的右边缘会落在窗口外，
          // 卡片里的字被切一半 —— 而插件内部一切正常，报"没有溢出"。
          // 收窄之后所有内容都落在可见区里，代价只是右边多一条看不见的空白。
          'data-slj-clipped': clipped ? 'true' : 'false',
          'data-slj-clipped-y': clippedY ? 'true' : 'false',
          // 尺寸不写在 style prop 里：见下面 fitToVisibleViewport。
          // 首屏量不到 outerWidth、状态回填晚一拍这些坑，靠"每次渲染后直接量 DOM"
          // 比靠一层层 state 传递可靠得多。
        },

        h(
          'aside',
          { className: 'slj-nav', style: { width: rail || compact || !width ? undefined : width + 'px' } },
          h(
            'div',
            { className: 'slj-brand' },
            h('div', { className: 'slj-mark', 'aria-hidden': 'true' }, '深'),
            h(
              'div',
              { className: 'slj-brandText' },
              h('span', { className: 'slj-brandName' }, (data && data.head && data.head.title) || '深蓝鲸'),
              h('span', { className: 'slj-brandSub' }, (data && data.head && data.head.subtitle) || '长在这台机器上'),
            ),
          ),
          // 版本号放在最显眼的地方是有用的：改了代码重启却没变化时，
          // 先看这里。数字没动 = 宿主还在跑旧副本，别在界面里找原因。
          data && data.head && data.head.version
            ? h('div', { className: 'slj-ver', title: '宿主当前加载的深蓝鲸版本' }, 'v' + String(data.head.version))
            : null,
          // 版本号在复制时不会变，它证明不了「跑的是不是最新」。真正能证明的是这一条：
          // 副本落后 → 说清"源码比副本新"；副本残缺失模块 → 直接把缺的列出来。
          (() => {
            const build = data && data.head && data.head.build
            if (!build || !build.hint) return null
            const broken = Array.isArray(build.broken) ? build.broken : []
            return h(
              'div',
              {
                className: 'slj-build',
                'data-tone': broken.length ? 'bad' : 'warn',
                title: broken.length
                  ? '副本里缺这些模块：' + broken.slice(0, 8).join('；')
                  : '源码 ' + String(build.sourceDir || '') + ' 已更新，副本还是旧的',
              },
              build.hint,
            )
          })(),
          h(
            'nav',
            { className: 'slj-navList', 'aria-label': '深蓝鲸分区' },
            (() => {
              const rowOf = (item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: 'slj-navRow',
                    title: rail || compact ? item.label : undefined,
                    'aria-current': item.id === regionId ? 'page' : undefined,
                    onClick: () => selectRegion(item.id),
                  },
                  h('span', { className: 'slj-navGlyph' }, h(Icon, { name: item.icon })),
                  h('span', { className: 'slj-navLabel' }, item.label),
                  item.badge ? h('span', { className: 'slj-navBadge' }, String(item.badge)) : null,
                )
              // 数据还没到：画几行灰条，等 /panel 回来。
              if (!nav.length) {
                return [0, 1, 2, 3, 4].map((i) => h('div', { key: 'skel-' + i, className: 'slj-skelRow' }))
              }
              const sections = data && Array.isArray(data.navSections) ? data.navSections : null
              // 收起状态下不画段标题：窄栏里多一行字只会挤掉入口。
              if (!sections || rail || compact) return nav.map(rowOf)
              const covered = new Set()
              const out = []
              for (const section of sections) {
                const list = nav.filter((item) => (section.regions || []).includes(item.id))
                if (!list.length) continue
                out.push(h('div', { key: 'section-' + section.id, className: 'slj-navSection' }, String(section.label)))
                for (const item of list) {
                  covered.add(item.id)
                  out.push(rowOf(item))
                }
              }
              // 新加的区域若还没归段，不能从侧栏消失
              for (const item of nav) if (!covered.has(item.id)) out.push(rowOf(item))
              return out
            })(),
          ),
          h(
            'div',
            { className: 'slj-navFoot' },
            h(
              'div',
              { className: 'slj-state' },
              h('span', { className: 'slj-dot', 'data-tone': channelTone(data) }),
              h('span', { className: 'slj-stateText' }, channelText(data)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'slj-iconBtn',
                onClick: toggleRail,
                'aria-label': rail ? '展开侧边栏' : '收起侧边栏',
                'aria-expanded': rail ? 'false' : 'true',
                title: rail ? '展开侧边栏' : '收起侧边栏',
              },
              h(Icon, { name: rail ? 'chevronRight' : 'chevronLeft' }),
            ),
          ),
        ),

        h('div', {
          className: 'slj-grip',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整侧边栏宽度，双击复位',
          onPointerDown: startDrag,
          onDoubleClick: resetWidth,
        }),

        h(
          'div',
          { className: 'slj-body' },
          h(
            'div',
            { className: 'slj-inner' },
            // 只显示一句人话（「正在核对数据」），不显示轮数、调用次数等过程信息。
            data && data.progress
              ? h('div', { className: 'slj-progress' },
                  h('span', { className: 'slj-progressDot' }),
                  h('span', null, String(data.progress)),
                )
              : null,
            h(
              'div',
              { className: 'slj-head' },
              h(
                'div',
                { className: 'slj-headMain' },
                detailId && regionId === 'talk'
                  ? h(
                      'div',
                      { className: 'slj-crumb' },
                      h(
                        'button',
                        { type: 'button', className: 'slj-back', onClick: () => { setDetailId(''); setDetailQuery('') } },
                        h(Icon, { name: 'chevronLeft', size: 12 }),
                        ' ' + (regionMeta ? regionMeta.label : '返回'),
                      ),
                      h('span', null, '/'),
                      h('span', null, title),
                    )
                  : null,
                h('h1', { className: 'slj-title' }, title),
                subtitle ? h('p', { className: 'slj-sub' }, subtitle) : null,
              ),
              h(
                'button',
                { type: 'button', className: 'slj-btn', onClick: refresh, title: '重新读一次状态' },
                h(Icon, { name: 'refresh', size: 14 }),
                h('span', { style: { marginLeft: '4px' } }, '刷新'),
              ),
            ),
            h('div', { className: 'slj-rule' }),

            error && data ? h(Banner, { tone: 'bad' }, '这次刷新没成功，下面是上一次的数据：' + error) : null,
            // 首屏数据还没到（data===null）时也会走到这里：必须先判空，
            // 否则「正在读状态…」还没画出来就先抛异常，用户看到的是白屏。
            data && data.notices && data.notices.length
              ? h(
                  Banner,
                  { tone: 'warn' },
                  '有 ' + data.notices.length + ' 项没算出来：' + data.notices.map((one) => one.section).join('、') + '。其余照常显示。',
                )
              : null,

            // 技能高危项被打开前要二次确认。不用 window.confirm：
            // 桌面壳里原生弹窗可能被禁用，而且它会把整页卡住。
            confirmSkill
              ? h(
                  'div',
                  { className: 'slj-row' },
                  h(
                    'div',
                    { className: 'slj-rowMain' },
                    h('div', { className: 'slj-rowTitle' }, h(Chip, { tone: 'bad' }, '要确认'), '打开「' + confirmSkill.name + '」'),
                    h('div', { className: 'slj-rowText' }, '这项能直接动手，打开前再确认一次。'),
                    h(
                      'div',
                      { className: 'slj-field' },
                      h('button', { type: 'button', className: 'slj-btn', onClick: () => setConfirmSkill(null) }, '算了'),
                      h(
                        'button',
                        { type: 'button', className: 'slj-btn', 'data-variant': 'primary', onClick: () => toggleSkill(confirmSkill, true) },
                        '确认打开',
                      ),
                    ),
                  ),
                )
              : null,

            h('div', { className: 'slj-content' }, body),
            h(Toast, { toast }),
          ),
        ),

        // 弹窗挂在根节点上，不挂在内容区：它要盖住侧边栏，
        // 否则用户还能一边看着「要跑代码」的弹窗一边点开别的页签。
        ask
          ? h(AskDialog, {
              ask,
              leftMs: askLeftMs,
              reason: askReason,
              remember: askRemember,
              busy: askBusy,
              onReason: setAskReason,
              onRemember: setAskRemember,
              onAllow: () => decideAsk(true, askReason, askRemember),
              onDeny: () => decideAsk(false, askReason, askRemember),
            })
          : null,
      )
    }

    /** 在详情里按 key 找配置项：确认时要用它拿到 kind 与值 */
    function findItem(detail, key) {
      const items = (detail && detail.form && detail.form.items) || []
      return items.find((item) => item.key === key) || null
    }

    function channelTone(data) {
      const tiles = (data && data.sections && data.sections.overview && data.sections.overview.tiles) || []
      const hit = tiles.find((tile) => tile.label === '通道')
      return (hit && hit.tone) || 'idle'
    }

    function channelText(data) {
      const tiles = (data && data.sections && data.sections.overview && data.sections.overview.tiles) || []
      const hit = tiles.find((tile) => tile.label === '通道')
      return (hit && hit.value) || (data ? '状态未知' : '未连接')
    }

    /**
     * 宿主左栏的入口图标。注册在 `sidebar.panellist`，
     * 宿主会传 { size, active }：收起态给 18，展开态给 16。
     */
    function PanelIcon(props) {
      const size = (props && props.size) || 18
      return h(Icon, { name: 'fish', size })
    }

    // ── 接进宿主 ────────────────────────────────────────────────

    const inject = ['slots']

    function apply(ctx) {
      injectStyle()

      // 主面板：keyed 槽位，key 必须与下面的入口 id 一致
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
      )

      // 左栏入口：宿主负责选中态、折叠、图标尺寸，我们只给 id / 顺序 / 名字
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '深蓝鲸' }, PanelIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
