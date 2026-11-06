/**
 * lib/client.js — 浏览器那一半：把「深蓝鲸」挂进 DSH 的左侧，并画出整个控制台。
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
 *     （lib/panel-view.mjs），这里只把字段摆到屏幕上。前端一旦开始算数，
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
    /** 界面偏好（当前区域 / 是否收起 / 宽度）。换机器不同步，这是本机外观 */
    const STORE_KEY = 'slj.panel.v2'

    /**
     * 兜底导航：宿主还没应答时，左栏不能是空的 ——
     * 空侧边栏会让人以为插件没装上，而不是「数据还没到」。
     * 十个 id / label / icon 必须与 lib/taxonomy.mjs 的 REGIONS 完全一致，有用例钉住。
     * 这里只兜第一帧；数据到了以后一律用宿主给的 nav，别在浏览器里另排一次顺序。
     */
    const FALLBACK_NAV = [
      { id: 'overview', label: '概览', icon: 'pulse' },
      { id: 'connection', label: 'QQ 连接', icon: 'plug' },
      { id: 'talk', label: '对话', icon: 'chat' },
      { id: 'memory', label: '记忆', icon: 'spark' },
      { id: 'skills', label: '技能', icon: 'grid' },
      { id: 'evolve', label: '学习', icon: 'spark' },
      { id: 'usage', label: '花费', icon: 'coin' },
      { id: 'process', label: '过程', icon: 'layers' },
      { id: 'rules', label: '规则', icon: 'shield' },
      { id: 'settings', label: '设置', icon: 'sliders' },
    ]

    /**
     * 首屏兜底几何：第一帧还没拿到宿主视图时用它，避免「先闪一下 248 再跳」。
     * 这组数必须与 lib/panel-view.mjs 的 SIDEBAR 一致（有用例按字面量对账）。
     */
    const FALLBACK_LAYOUT = { expanded: 248, collapsed: 56, min: 200, max: 320, autoCollapseAt: 720, compactAt: 480 }

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
      '.slj-ver{margin:-6px 6px 8px;font-size:10.5px;font-family:var(--dsw-font-family-mono,monospace);color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
      '.slj-root[data-slj-rail="true"] .slj-ver,.slj-root[data-slj-compact="true"] .slj-ver{display:none}',

      '.slj-navList{display:flex;flex-direction:column;gap:2px;flex:none}',
      '.slj-navRow{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 8px;margin:0;',
      'border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
      'font:inherit;text-align:left;cursor:pointer;overflow:hidden}',
      '.slj-navRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-navRow[aria-current="page"]{background:var(--dsw-alias-interactive-bg-hover);font-weight:500}',
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

      '.slj-navFoot{margin-top:auto;padding-top:8px;flex:none;display:flex;flex-direction:column;gap:6px}',
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
      '.slj-inner{height:100%;max-width:880px;margin:0 auto;padding:22px clamp(16px,3vw,32px) 20px;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.slj-content{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px}',
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
      '.slj-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}',
      // 分组标题只在小标题有意义时出现；没有 section 的区域不会多出一层空行
      '.slj-modSection{margin-bottom:16px}',
      '.slj-modSection:last-child{margin-bottom:0}',
      '.slj-modSectionHead{margin:0 0 8px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
      '.slj-rowGroup{margin:14px 0 8px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}',
      '.slj-rowGroup:first-child{margin-top:0}',
      '.slj-split{display:flex;gap:12px;min-height:0;height:100%;align-items:stretch}',
      '.slj-splitSide{flex:0 0 220px;min-width:180px;max-width:280px;display:flex;flex-direction:column;gap:6px;overflow:auto;padding-right:4px}',
      '.slj-splitMain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:auto}',
      '.slj-splitRow{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.slj-splitRow[aria-current="true"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}',
      '.slj-splitRow b{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.slj-splitRow small{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.slj-root[data-slj-compact="true"] .slj-mods{grid-template-columns:1fr}',
      '.slj-mod{display:flex;align-items:flex-start;gap:10px;width:100%;padding:12px 14px;text-align:left;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);',
      'color:inherit;font:inherit;cursor:pointer}',
      '.slj-mod:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-mod:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.slj-modGlyph{flex:none;width:26px;height:26px;border-radius:var(--dsw-radius-sm);display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.slj-modMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}',
      '.slj-modTitle{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500}',
      '.slj-modDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
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

      '.slj-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md);',
      'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);margin-bottom:8px}',
      '.slj-row[data-open="true"]{cursor:pointer}',
      '.slj-row[data-open="true"]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.slj-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.slj-rowTitle{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;font-weight:500}',
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

      '.slj-input,.slj-select,.slj-area{width:100%;min-width:0;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);',
      'border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px}',
      '.slj-area{height:auto;min-height:64px;padding:6px 8px;line-height:18px;resize:vertical}',
      '.slj-input:focus-visible,.slj-select:focus-visible,.slj-area:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.slj-field{display:flex;align-items:center;gap:6px;margin-top:6px}',
      '.slj-field[data-wide="true"]{align-items:stretch;flex-direction:column}',
      '.slj-field[data-wide="true"] .slj-btn{align-self:flex-start}',

      '.slj-banner{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;margin-bottom:14px;border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-interactive-bg-hover);border-left:3px solid var(--dsw-alias-state-warn-primary);',
      'color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}',
      '.slj-banner[data-tone="bad"]{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',

      '.slj-empty{padding:28px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}',

      // 聊天窗口
      '.slj-thread{display:flex;flex-direction:column;gap:8px;margin:4px 0 14px}',
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
      '.slj-composer{display:flex;flex-direction:column;gap:6px;position:sticky;bottom:0;padding:10px 0 4px;',
      'background:linear-gradient(to bottom,transparent,var(--dsw-alias-bg-base) 22%)}',
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

    /** 只注入一次；宿主热重载本插件时换掉旧标签，不叠第二份 */
    function injectStyle() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-shenlan-whale/panel.css'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-shenlan-whale'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 小工具 ──────────────────────────────────────────────────

    /** 读本机外观偏好。localStorage 在隐私模式会抛异常，读不到就当没存过 */
    function readStore() {
      const fallback = { region: '', collapsed: false, width: 0 }
      try {
        const raw = window.localStorage.getItem(STORE_KEY) || window.localStorage.getItem('slj.panel.v1')
        if (!raw) return fallback
        const value = JSON.parse(raw)
        return {
          // v1 存的是 section，v2 是 region：老用户不该因为改了个字段名就丢偏好
          region: typeof value.region === 'string' ? value.region : typeof value.section === 'string' ? value.section : '',
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
      if (!res.ok) throw new Error(body && body.error ? body.error : '宿主返回 ' + res.status)
      return body || {}
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
          module.desc ? h('span', { className: 'slj-modDesc' }, module.desc) : null,
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
          const result = await api('/skill/teach', { method: 'POST', body: JSON.stringify({ name: title, what, group }) })
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
          const result = await api('/memory/remember', { method: 'POST', body: JSON.stringify({ text: value }) })
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
      // 不在前端判断「在线/过期」，判断只留一份在 lib/qq/napcat.mjs。
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
          ? h(editing.action === 'edit-skill' ? SkillEditForm : MemoryEditForm, {
              row: editing,
              onCancel: () => setEditing(null),
              onSave: (values) => {
                onAction && onAction({ ...editing, action: 'save-' + editing.action, values })
                setEditing(null)
              },
            })
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
        null,
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 6 } },
          h('button', { type: 'button', className: 'slj-btn', onClick: toggleAutoScroll }, autoScroll ? '自动滚动：开' : '自动滚动：关'),
        ),
        chat.hasMore
          ? h(
              'div',
              { style: { textAlign: 'center', marginBottom: '8px' } },
              h('button', { type: 'button', className: 'slj-btn', disabled: loadingMore, onClick: onMore }, loadingMore ? '正在读…' : '看更早的消息'),
            )
          : null,
        rows.length
          ? h('div', { className: 'slj-thread', ref: threadRef }, rows.map((row) => h(ChatBubble, { key: row.id, row, conversation: chat.conversation })))
          : h('div', { className: 'slj-empty' }, chat.source === 'qq' ? '这段会话还没有消息' : '说一句话试试'),
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

    function SettingRow({ item, draft, busy, confirming, onDraft, onToggleBool, onSave, onConfirm, onCancel }) {
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
          h(SaveButton, { item, value, onSave, busy }),
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
          h(SaveButton, { item, value, onSave, busy }),
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
          h(SaveButton, { item, value, onSave, busy }),
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
            onChange: (event) => onDraft(item.key, event.target.value),
          }),
          unit ? h('span', { className: 'slj-meta' }, unit) : null,
          h(SaveButton, { item, value, onSave, busy }),
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
            item.badge ? h(Chip, { tone: item.pending ? 'warn' : 'idle' }, item.badge) : null,
            item.needConfirm ? h(Chip, { tone: 'bad' }, '危险') : null,
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

    function PolicyPanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [domain, setDomain] = useState('')
      const load = async () => {
        try {
          const next = await api('/policy')
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
        section('联网白名单', '开关控制；全关表示不允许联网', domains.map((name) => h('div', { key: name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
          h('span', { style: { flex: 1 } }, name),
          h('button', { type: 'button', className: 'slj-btn', disabled: busy === 'net.allowlist', onClick: () => toggleNet(name) }, netOn(name) ? '开' : '关'),
        ))),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('input', { className: 'slj-input', placeholder: '新增域名，例如 api.example.com', value: domain, onChange: (e) => setDomain(e.target.value) }),
          h('button', { type: 'button', className: 'slj-btn', onClick: addDomain }, '添加'),
        ),
      )
    }

    function DetailForm({ detail, drafts, busy, confirm, onDraft, onToggleBool, onSave, onConfirm, onCancel }) {
      const form = detail.form || { items: [] }
      return h(
        'div',
        null,
        detail.notice ? h(Banner, { tone: 'warn' }, detail.notice) : null,
        (form.items || []).map((item) =>
          h(SettingRow, {
            key: item.key,
            item,
            draft: drafts[item.key],
            busy: busy === item.key,
            confirming: confirm !== null && confirm.key === item.key,
            onDraft,
            onToggleBool,
            onSave,
            onConfirm,
            onCancel,
          }),
        ),
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
      const [rootWidth, setRootWidth] = useState(0)
      const [pref, setPref] = useState(readStore)

      // 详情：id 为空表示还在区域页
      const [detailId, setDetailId] = useState('')
      const [detail, setDetail] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
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

      const layout = (data && data.layout) || FALLBACK_LAYOUT
      const nav = data && data.nav && data.nav.length ? data.nav : FALLBACK_NAV
      const navIds = nav.map((item) => item.id)
      const regionId = navIds.indexOf(pref.region) >= 0 ? pref.region : nav[0].id
      const region = data && data.regions ? data.regions[regionId] : null
      const regionMeta = nav.find((item) => item.id === regionId) || nav[0]

      // 两个收起理由必须分开记：用户自己收的记住，窗口太窄被系统收的不记
      const autoRail = rootWidth > 0 && rootWidth < layout.autoCollapseAt
      const compact = rootWidth > 0 && rootWidth < layout.compactAt
      const rail = pref.collapsed || autoRail

      useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            const next = await api('/panel')
            if (!alive) return
            setData(next)
            setError('')
          } catch (err) {
            if (alive) setError(String((err && err.message) || err))
          }
        }
        pull()
        const timer = window.setInterval(pull, 5000)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [token])

      // 响应式看的是**自己的**宽度，不是窗口宽度：宿主左右两栏都会伸缩
      useEffect(() => {
        const el = rootRef.current
        if (!el || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const width = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0
          setRootWidth(width)
        })
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

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
          setDetail(null)
          return undefined
        }
        let alive = true
        setDetail(null)
        setDetailBusy(true)
        api('/detail?id=' + encodeURIComponent(detailId))
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
      }, [detailId, token])

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
            const next = await api('/approvals')
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
          const result = await api('/approvals/decide', {
            method: 'POST',
            body: JSON.stringify({ id: current.id, allow, remember, reason }),
          })
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
        if (first) setDetailId(first.detail)
      }, [data, regionId, detailId])

      const openDetail = useCallback((id) => {
        setDraft('')
        // 先清掉上一页，避免审计切思维链时还停在旧内容上，看起来像“没跳转”
        setDetail(null)
        setDetailBusy(true)
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
          if (item.type === 'fact') result = await api('/memory/remember', { method: 'POST', body: JSON.stringify({ text: item.text }) })
          else if (item.type === 'self') result = await api('/memory/remember-self', { method: 'POST', body: JSON.stringify({ text: item.text }) })
          else if (item.type === 'person') result = await api('/memory/edit-person', { method: 'POST', body: JSON.stringify({ uin: item.uin, name: item.name, note: item.note, impression: item.impression }) })
          else if (item.type === 'group') {
            result = await api('/memory/edit-group', { method: 'POST', body: JSON.stringify({ groupId: item.groupId, label: item.label, topic: (item.topics || [])[0] || '' }) })
            // 话题是列表，接口一次只收一条 —— 其余的补一遍，别只恢复第一条还说「回来了」
            for (const topic of (item.topics || []).slice(1)) {
              await api('/memory/edit-group', { method: 'POST', body: JSON.stringify({ groupId: item.groupId, topic }) })
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
          if (rail) return
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
        [rail, layout.expanded, layout.min, layout.max],
      )

      const resetWidth = useCallback(() => {
        widthRef.current = 0
        setPref((prev) => ({ ...prev, width: 0 }))
      }, [])

      const width = clampWidth(pref.width, layout.min, layout.max) || layout.expanded
      widthRef.current = width

      const toggleSkill = useCallback(
        async (skill, confirmNow) => {
          setBusy(skill.id)
          try {
            const result = await api('/skill', {
              method: 'POST',
              body: JSON.stringify({ id: skill.id, on: skill.state !== 'on', confirm: confirmNow === true }),
            })
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
              setToken((n) => n + 1)
            } else {
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
            const result = await api('/qq/send', {
              method: 'POST',
              body: JSON.stringify({ conversation: detail.chat.conversation, text }),
            })
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
      if (!talkRef.current) talkRef.current = function TalkSplit({ token }) {
        const [mode, setMode] = useState('qq')
        const [filter, setFilter] = useState('all')
        const [rows, setRows] = useState([])
        const [active, setActive] = useState('')
        const [query, setQuery] = useState('')
        const [detail, setDetail] = useState(null)
        const [draft, setDraft] = useState('')
        const [sending, setSending] = useState(false)

        /**
         * 打开一个详情页。
         *
         * `query` 是给审计页那三个胶囊用的（级别 / 类型 / 含不含噪音）：
         * 页面上临时点的口径只作用于这一次请求，不写回设置 ——
         * 「看一眼全部」不该顺手把默认口径改掉。
         */
        const openDetail = useCallback(async (id, query = '') => {
          setActive(id)
          setQuery(query)
          setDraft('')
          try {
            setDetail(await api('/detail?id=' + encodeURIComponent(id) + (query ? '&' + query : '')))
          } catch (err) {
            setDetail({ ok: false, kind: 'rows', title: '打不开', rows: [], empty: String((err && err.message) || err) })
          }
        }, [])

        useEffect(() => {
          let alive = true
          setRows([])
          setActive('')
          setDetail(null)
          if (mode === 'local') {
            openDetail('talk.local')
            return () => { alive = false }
          }
          api('/detail?id=talk.qq')
            .then((next) => {
              if (!alive) return
              const list = next && Array.isArray(next.rows) ? next.rows : []
              setRows(list)
              if (list[0]) openDetail(list[0].open)
            })
            .catch((err) => { if (alive) say(String((err && err.message) || err), 'bad') })
          return () => { alive = false }
        }, [mode, token, openDetail, say])

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
              : await api('/qq/send', { method: 'POST', body: JSON.stringify({ conversation: detail.chat.conversation, text }) })
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
          { className: 'slj-splitSide' },
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
        )

        return h('div', { className: 'slj-split' }, side,
          h('div', { className: 'slj-splitMain' },
            detail && detail.kind === 'chat'
              ? h(DetailChat, { detail, draft, sending, onDraft: setDraft, onSend: send, onMore: () => {}, loadingMore: false })
              : h('div', { className: 'slj-empty' }, detail && detail.empty ? detail.empty : '选一个会话'),
          ),
        )
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
                  const result = await api('/approvals/forget', { method: 'POST', body: '{}' })
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
                  const result = await api('/reminder/update', { method: 'POST', body: JSON.stringify({ id: row.value, text: String(text).trim(), at }) })
                  say(result && result.ok ? '提醒改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'cancel-reminder') {
                const result = await api('/reminder/cancel', { method: 'POST', body: JSON.stringify({ id: row.value }) })
                say(result && result.ok ? '提醒取消了' : (result && result.error) || '没取消', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-self') {
                const result = await api('/memory/edit-self', { method: 'POST', body: JSON.stringify({ old: row.value, text: row.values?.text }) })
                say(result && result.ok ? '自我记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-self') {
                const result = await api('/memory/forget-self', { method: 'POST', body: JSON.stringify({ text: row.value }) })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.value || '').slice(0, 24) })
                say(result && result.ok ? '这条自我记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-fact') {
                const result = await api('/memory/edit', { method: 'POST', body: JSON.stringify({ old: row.value, text: row.values?.text }) })
                say(result && result.ok ? '改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-person') {
                const result = await api('/memory/edit-person', { method: 'POST', body: JSON.stringify({ uin: row.value, name: row.values?.name, note: row.values?.note, impression: row.values?.impression }) })
                say(result && result.ok ? '人物改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-group') {
                const result = await api('/memory/edit-group', { method: 'POST', body: JSON.stringify({ groupId: row.value, label: row.values?.label, topic: row.values?.topic }) })
                say(result && result.ok ? '群记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'edit-fact') {
                const next = window.prompt('把这条事实改成：', row.value)
                if (next && String(next).trim() && String(next).trim() !== row.value) {
                  const result = await api('/memory/edit', { method: 'POST', body: JSON.stringify({ old: row.value, text: String(next).trim() }) })
                  say(result && result.ok ? '改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'edit-person') {
                const name = window.prompt('这个人叫什么：', row.title)
                if (name && String(name).trim()) {
                  const note = window.prompt('加一条备注（可留空）：', '') || ''
                  const result = await api('/memory/edit-person', { method: 'POST', body: JSON.stringify({ uin: row.value, name: String(name).trim(), note: String(note).trim() }) })
                  say(result && result.ok ? '人物改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'edit-group') {
                const label = window.prompt('这个群叫什么：', row.title)
                if (label && String(label).trim()) {
                  const topic = window.prompt('加一条群话题（可留空）：', '') || ''
                  const result = await api('/memory/edit-group', { method: 'POST', body: JSON.stringify({ groupId: row.value, label: String(label).trim(), topic: String(topic).trim() }) })
                  say(result && result.ok ? '群记忆改好了' : (result && result.error) || '没改成', result && result.ok ? 'ok' : 'bad')
                }
              } else if (row.action === 'forget-fact') {
                const result = await api('/memory/forget', { method: 'POST', body: JSON.stringify({ text: row.value }) })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.value || '').slice(0, 24) })
                say(result && result.ok ? '忘了这条' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-person') {
                const result = await api('/memory/forget-person', { method: 'POST', body: JSON.stringify({ uin: row.value }) })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.title || '') })
                say(result && result.ok ? '这个人的记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-group') {
                const result = await api('/memory/forget-group', { method: 'POST', body: JSON.stringify({ groupId: row.value }) })
                if (result && result.ok) setUndo({ item: row.undo, label: String(row.title || '') })
                say(result && result.ok ? '这个群的记忆删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'save-edit-skill') {
                const result = await api('/skill/amend', { method: 'POST', body: JSON.stringify({ id: (row.skill && row.skill.id) || row.id, name: row.values?.name, what: row.values?.what }) })
                say((result && (result.ok ? result.message : result.error)) || (result && result.ok ? '改好了' : '没改成'), result && result.ok ? 'ok' : 'bad')
              } else if (row.action === 'forget-skill') {
                const result = await api('/skill/forget', { method: 'POST', body: JSON.stringify({ id: row.skill.id }) })
                say(result && result.ok ? '技能删了' : (result && result.error) || '没删掉', result && result.ok ? 'ok' : 'bad')
              }
              setToken((n) => n + 1)
            },
            extra: [
              undoBar,
              detail.id === 'skills.all'
                ? h(TeachSkillForm, { onDone: () => setToken((n) => n + 1), notify: say })
                : detail.id === 'memory.facts'
                  ? h(AddMemoryForm, { onDone: () => setToken((n) => n + 1), notify: say })
                  : null,
            ],
          })
        }

        // 详情页
        if (detailId) {
          if (regionId !== 'talk' && region && Array.isArray(region.modules) && region.modules.length) {
            return h(
              'div',
              { className: 'slj-split' },
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
              h('div', { className: 'slj-splitMain' }, renderDetail()),
            )
          }
          return renderDetail()
        }

        // 对话页走专用两栏：左侧模式/会话，右侧滚动消息
        if (regionId === 'talk') return h(TalkSplit, { token })

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
        },

        h(
          'aside',
          { className: 'slj-nav', style: { width: rail || compact ? undefined : width + 'px' } },
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
          h(
            'nav',
            { className: 'slj-navList', 'aria-label': '深蓝鲸分区' },
            nav.map((item) =>
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
              ),
            ),
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
                        { type: 'button', className: 'slj-back', onClick: () => setDetailId('') },
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
