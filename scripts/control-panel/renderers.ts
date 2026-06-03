export interface ControlPanelRenderInput {
  readonly panelToken: string;
  readonly defaultGraphScopeType: string;
  readonly defaultGraphScopeId: string;
  readonly projectRoot: string;
  readonly refreshIntervalMs: number;
}

export function renderControlPanelHtml(input: ControlPanelRenderInput): string {
  const { panelToken, defaultGraphScopeType, defaultGraphScopeId, projectRoot, refreshIntervalMs } = input;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>memory-xx 控制面板</title>
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js"}}</script>
  <style>
    :root{--bg:#07111f;--rail:#081321;--rail-2:#0d1d31;--surface:#0d1b2d;--surface-2:#12243a;--surface-3:#172d48;--text:#e7f2ff;--muted:#91a7c1;--line:#24405d;--line-strong:#31d7ff;--ok:#2ee59d;--bad:#ff5b6e;--blue:#38bdf8;--green:#2dd4bf;--violet:#a78bfa;--amber:#fbbf24;--shadow:0 18px 42px rgba(0,0,0,.35);--focus:0 0 0 3px rgba(56,189,248,.30)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 18% -10%,rgba(56,189,248,.18),transparent 32%),radial-gradient(circle at 88% 6%,rgba(167,139,250,.14),transparent 30%),linear-gradient(180deg,#07111f 0,#091827 46%,#07111f 100%);color:var(--text);font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif}
    header{position:sticky;top:0;z-index:4;background:rgba(7,17,31,.92);backdrop-filter:blur(14px);border-bottom:1px solid rgba(49,215,255,.22);box-shadow:0 1px 0 rgba(49,215,255,.10),0 10px 32px rgba(0,0,0,.22)}
    .topbar{max-width:1520px;margin:0 auto;padding:11px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px}
    h1{margin:0;font-size:21px;letter-spacing:0}.meta{color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere}.header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .app-shell{max-width:1520px;margin:0 auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:16px;padding:16px 22px 34px}.sidebar{position:sticky;top:74px;align-self:start;background:linear-gradient(180deg,rgba(13,29,49,.96),rgba(8,19,33,.96));border:1px solid rgba(49,215,255,.20);border-radius:8px;box-shadow:var(--shadow);padding:10px;display:grid;gap:5px}.sidebar-title{color:#e5f7ff;font:700 12px/1.3 "JetBrains Mono","Consolas",monospace;text-transform:uppercase;letter-spacing:.04em;padding:8px 9px 6px}.navlink{border:1px solid transparent;background:transparent;color:#b8cce3;text-align:left;border-radius:7px;min-height:36px;padding:8px 10px;font-weight:700;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease}.navlink:hover{background:rgba(56,189,248,.10);border-color:rgba(56,189,248,.22);color:#fff}.navlink.active{background:linear-gradient(90deg,rgba(56,189,248,.24),rgba(45,212,191,.12));border-color:rgba(56,189,248,.50);color:#effbff}.content{display:grid;gap:14px;min-width:0}.dashboard-section{display:grid;gap:14px}.dashboard-section.hidden{display:none}.status-bar{background:linear-gradient(180deg,rgba(13,27,45,.96),rgba(11,23,39,.96));border:1px solid rgba(56,189,248,.26);border-left:4px solid var(--blue);border-radius:8px;box-shadow:var(--shadow);padding:12px 14px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px}.status-bar strong{font-size:14px}.status-bar span{color:var(--muted);font-size:12px}.status-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;align-items:start}.metric,.services-panel,.graph-panel,.control-console{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}
    .metric{padding:13px 14px;height:112px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-start}.metric .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.metric .value{margin-top:8px;font:750 20px/1.18 "IBM Plex Sans","Segoe UI",system-ui;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.metric.ok .value{color:var(--ok)}.metric.bad .value{color:var(--bad)}#m-cause{grid-column:span 2}#m-cause .value{font-size:15px;line-height:1.35;-webkit-line-clamp:3;max-height:62px;overflow:auto;padding-right:4px}#m-generation .value,#m-embedding-upstream .value{font-size:18px}
    .control-console{padding:14px 16px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr);gap:14px;align-items:center}.console-copy h2{margin:0 0 6px;font-size:16px}.console-copy p{margin:0;color:var(--muted);font-size:13px;line-height:1.45}.console-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.console-button{border:1px solid var(--line-strong);background:var(--surface-3);color:var(--text);border-radius:8px;min-height:68px;padding:10px 11px;text-align:left;cursor:pointer;transition:border-color .16s ease,background .16s ease}.console-button:hover{border-color:var(--blue);background:#e1edf8}.console-button strong{display:block;font-size:13px}.console-button span{display:block;color:var(--muted);font-size:11px;margin-top:4px;line-height:1.35}
    .services-panel{padding:14px 16px;display:grid;gap:12px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.panel-head h2{margin:0;font-size:15px}.service-grid{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:10px}.service-tile{border:1px solid var(--line);border-radius:8px;padding:10px;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;min-height:72px;background:var(--surface);transition:border-color .16s ease,background .16s ease}.service-tile:hover{border-color:var(--line-strong);background:#e7f0fb}.service-name{font-size:13px;font-weight:800}.service-desc{font-size:12px;color:var(--muted);margin-top:3px}.service-state{font-size:11px;color:var(--muted);grid-column:1/-1;overflow-wrap:anywhere}.switch{position:relative;display:inline-flex;align-items:center;width:58px;height:30px;border-radius:999px;background:#c02f2f;border:0;cursor:pointer;transition:background .16s ease;flex:0 0 auto}.switch input{position:absolute;opacity:0;pointer-events:none}.switch .knob{position:absolute;left:4px;width:22px;height:22px;border-radius:999px;background:#fff;box-shadow:0 1px 5px rgba(15,23,42,.34);transition:transform .16s ease}.switch.on{background:#139a63}.switch.on .knob{transform:translateX(28px)}.switch.busy{opacity:.62;cursor:wait}
    .graph-panel{min-height:720px;display:grid;grid-template-rows:auto 1fr;overflow:hidden}.graph-head{padding:14px 16px 10px;border-bottom:1px solid var(--line);display:grid;gap:12px}
    .graph-title-row{display:flex;justify-content:space-between;align-items:center;gap:10px}.graph-title-row h2{margin:0;font-size:15px}
    .legend{display:flex;flex-wrap:wrap;gap:9px;color:var(--muted);font-size:12px}.legend span{display:inline-flex;align-items:center;gap:5px}.dot{width:9px;height:9px;border-radius:999px;display:inline-block}.memory-dot{background:var(--blue)}.entity-dot{background:var(--green)}.episode-dot{background:var(--violet)}.file-dot{background:#475569}.symbol-dot{background:var(--amber)}
    .graph-toolbar{display:grid;grid-template-columns:120px minmax(220px,1fr) 82px 88px minmax(118px,.42fr) minmax(150px,.55fr) minmax(180px,.7fr) auto;gap:8px;align-items:end}
    label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:700} input,select{border:1px solid #b7c4d6;border-radius:7px;min-height:38px;padding:7px 9px;background:#f8fbfe;color:var(--text);font:inherit} input:focus,select:focus,button:focus-visible,a:focus-visible{outline:0;box-shadow:var(--focus)} button{border:1px solid var(--blue);background:var(--blue);color:#fff;border-radius:7px;min-height:38px;padding:8px 11px;font-weight:700;cursor:pointer;transition:background .16s ease,border-color .16s ease,color .16s ease}button:hover{background:#2455bb;border-color:#2455bb}button.secondary{background:var(--surface);color:var(--blue)}
    .graph-shell{min-height:620px;display:grid;grid-template-columns:minmax(0,1fr)320px}.graph-canvas-wrap{position:relative;min-height:620px;background:#0f172a;overflow:hidden}.graph-canvas-wrap canvas{display:block;width:100%;height:100%}.graph-empty{position:absolute;inset:0;display:grid;place-items:center;color:#dbeafe;font-size:14px;pointer-events:none;text-align:center;padding:24px}
    .graph-details{border-left:1px solid var(--line);padding:14px;overflow:auto;background:var(--surface)}.graph-details h3{margin:0 0 8px;font-size:15px}.detail-row{border-top:1px solid var(--line);padding:8px 0;font-size:13px;overflow-wrap:anywhere}.detail-row strong{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;margin-bottom:4px}.subtle{color:var(--muted)}.component{display:grid;grid-template-columns:130px 1fr;gap:10px;border-top:1px solid var(--line);padding:8px 0;font-size:13px}.pill,.chip{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:750;color:#475569;background:#e2e8f0}.chip.ok{background:#dff7ea;color:#0f6848}.chip.bad{background:#fee2e2;color:#a32121}.chip.warn{background:#fff3d6;color:#8a5a0a}.chip.info{background:#e7efff;color:#224d9b}
    .settings-shell{display:grid;grid-template-columns:300px minmax(0,1fr);gap:14px}.settings-index{border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,#eef5fb,#e2edf6);padding:12px;align-self:start;position:sticky;top:88px}.settings-index h3{margin:2px 0 8px;font-size:13px}.settings-index .index-row{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:8px 0;font-size:12px}.settings-index .index-row:first-of-type{border-top:0}.settings-index strong{font-family:"JetBrains Mono","Consolas",monospace}.settings-category-list{display:grid;gap:6px;margin:10px 0}.settings-category-button{border:1px solid var(--line);background:var(--surface-3);color:var(--text);border-radius:8px;min-height:34px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;font-size:12px}.settings-category-button:hover{background:#e1edf8;border-color:var(--line-strong)}.settings-category-button.active{background:#dce9ff;border-color:var(--blue);color:#173466}.settings-feedback{min-height:38px;border:1px dashed var(--line-strong);border-radius:8px;padding:9px 10px;color:var(--muted);font-size:12px;background:rgba(245,249,252,.72)}
    .parameter-groups{display:grid;gap:14px;min-width:0}.parameter-group{border:1px solid var(--line);border-radius:8px;background:rgba(245,249,252,.42);padding:12px;box-shadow:0 6px 18px rgba(30,41,59,.06)}.parameter-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.parameter-group-title{margin:0;font-size:14px}.parameter-group-desc{color:var(--muted);font-size:12px;margin-top:3px}.parameter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:12px}.parameter-card{border:1px solid var(--line);border-top:3px solid var(--line-strong);border-radius:8px;padding:12px;background:linear-gradient(180deg,#f6f9fc,#eaf2f8);display:grid;grid-template-rows:auto 1fr auto;gap:10px;min-height:210px;box-shadow:0 4px 12px rgba(30,41,59,.07);transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}.parameter-card:hover{border-color:var(--line-strong);background:linear-gradient(180deg,#f9fbfd,#e8f1f9);box-shadow:0 8px 18px rgba(30,41,59,.1)}.parameter-card.dirty{border-color:var(--amber);border-top-color:var(--amber);background:linear-gradient(180deg,#fffdf7,#f8eedb)}.parameter-card[data-safety="safe"]{border-top-color:var(--ok)}.parameter-card[data-safety="guarded"]{border-top-color:var(--amber)}.parameter-card[data-safety="high-risk"]{border-top-color:var(--bad)}.parameter-card.readonly{min-height:158px;border-top-color:#94a3b8}.parameter-card-head{display:grid;gap:7px}.parameter-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.parameter-title{font-size:14px;font-weight:850;line-height:1.35;overflow-wrap:anywhere}.parameter-key{font:700 11px/1.45 "JetBrains Mono","Consolas",monospace;color:#40516a;background:#dfe9f2;border:1px solid #c9d6e4;border-radius:6px;padding:3px 6px;max-width:100%;overflow-wrap:anywhere}.parameter-desc{font-size:12px;color:var(--muted);line-height:1.5}.parameter-badges,.parameter-meta{font-size:11px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center}.parameter-body{display:grid;gap:9px;align-content:end}.parameter-value-label{font-size:11px;color:var(--muted);font-weight:800}.parameter-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.parameter-card input,.parameter-card select{min-height:38px;background:#f8fbfe}.setting-editor{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}.setting-editor.range{grid-template-columns:minmax(160px,1fr) 110px auto}.setting-editor input[type="range"]{padding:0;min-height:34px;accent-color:var(--blue)}.setting-unit{min-width:68px;min-height:38px;border:1px solid #c9d6e4;border-radius:7px;background:#e2edf6;color:#40516a;font:800 11px/1 "JetBrains Mono","Consolas",monospace;display:inline-flex;align-items:center;justify-content:center;padding:0 8px;white-space:nowrap}.danger{color:var(--bad);font-weight:800}.runtime-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 180px 160px auto;gap:8px;margin-bottom:10px}.runtime-map{display:grid;grid-template-columns:repeat(7,minmax(110px,1fr));gap:8px}.runtime-step{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:10px;min-height:78px;position:relative}.runtime-step:not(:last-child)::after{content:"";position:absolute;right:-8px;top:36px;width:8px;border-top:2px solid var(--line-strong)}.runtime-step strong{font-size:12px}.runtime-step span{display:block;color:var(--muted);font-size:11px;margin-top:5px}.runtime-step.ok{border-color:#86efac}.runtime-step.bad{border-color:#fca5a5}.runtime-step.pending{border-color:#fcd34d}.data-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}.data-table th,.data-table td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;font-size:12px;vertical-align:top}.data-table th{color:var(--muted);background:var(--surface-2);font-size:11px;text-transform:uppercase}.data-table tr:last-child td{border-bottom:0}.toolbar-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.toolbar-row a{border:1px solid var(--blue);border-radius:7px;min-height:38px;padding:8px 11px;text-decoration:none;color:var(--blue);font-weight:700;background:var(--surface)}.toolbar-row a:hover{background:#e7f0fb}.empty-state{border:1px dashed var(--line-strong);border-radius:8px;padding:14px;color:var(--muted);font-size:13px;background:var(--surface-2)}
    .metric,.services-panel,.graph-panel,.control-console,.settings-index,.parameter-group,.parameter-card,.service-tile,.runtime-step,.data-table{background:linear-gradient(180deg,rgba(18,36,58,.94),rgba(13,27,45,.94));border-color:rgba(56,189,248,.20);box-shadow:0 18px 42px rgba(0,0,0,.30)}.metric .label,.subtle,.parameter-desc,.parameter-meta,.service-desc,.service-state,.detail-row strong{color:var(--muted)}input,select{background:#071421!important;color:var(--text)!important;border-color:#2a4766!important}button{background:linear-gradient(180deg,#0ea5e9,#0369a1);border-color:#38bdf8;color:#f0fbff}button.secondary{background:rgba(56,189,248,.10);color:#c7f4ff}.chip{background:rgba(148,163,184,.16);color:#d7e8fb}.chip.ok{background:rgba(46,229,157,.14);color:#8ff7c8}.chip.bad{background:rgba(255,91,110,.15);color:#ff9aa7}.chip.warn{background:rgba(251,191,36,.16);color:#ffe08a}.chip.info{background:rgba(56,189,248,.14);color:#b7eeff}.parameter-key,.setting-unit{background:#091827;border-color:#284764;color:#cae8ff}.parameter-card.dirty{background:linear-gradient(180deg,rgba(65,49,15,.92),rgba(31,28,21,.92));border-color:rgba(251,191,36,.70)}.parameter-card:hover,.service-tile:hover,.console-button:hover{background:linear-gradient(180deg,rgba(22,47,76,.96),rgba(12,31,52,.96))}.settings-feedback,.empty-state{background:rgba(18,36,58,.72)}.graph-canvas-wrap{background:#050b14}.detail-grid,.insight-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.insight-card{border:1px solid rgba(56,189,248,.20);border-radius:8px;background:linear-gradient(180deg,rgba(11,27,45,.92),rgba(8,20,34,.92));padding:12px;min-height:112px}.insight-card h3{margin:0 0 8px;font-size:13px}.insight-card .big{font:800 24px/1.15 "IBM Plex Sans","Segoe UI",system-ui;color:#e9fbff}.insight-card p{margin:7px 0 0;color:var(--muted);font-size:12px;line-height:1.45}.action-strip{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.feedback-buttons{display:flex;gap:6px;flex-wrap:wrap}.feedback-buttons button{min-height:30px;padding:5px 8px;font-size:12px}.risk-line{height:6px;border-radius:999px;background:linear-gradient(90deg,#2ee59d,#fbbf24,#ff5b6e);opacity:.8}.mini-pre{margin:8px 0 0;max-height:180px;overflow:auto;background:#050b14;border:1px solid rgba(56,189,248,.18);border-radius:7px;padding:8px;font-size:12px;color:#c8e7ff}
    @media(max-width:1180px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;grid-template-columns:repeat(4,minmax(0,1fr))}.sidebar-title{grid-column:1/-1}.summary{grid-template-columns:repeat(2,minmax(180px,1fr))}#m-cause{grid-column:span 1}.service-grid{grid-template-columns:repeat(2,minmax(190px,1fr))}.parameter-grid{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}.settings-shell,.control-console{grid-template-columns:1fr}.settings-index{position:static}.graph-toolbar{grid-template-columns:1fr 1fr 82px 88px}.graph-shell{grid-template-columns:1fr}.graph-details{border-left:0;border-top:1px solid var(--line)}}@media(max-width:780px){.summary{grid-template-columns:1fr 1fr}.service-grid,.parameter-grid{grid-template-columns:1fr}.parameter-card{grid-template-columns:1fr}.setting-editor.range{grid-template-columns:1fr}.runtime-toolbar{grid-template-columns:1fr}.runtime-map{grid-template-columns:1fr}.runtime-step::after{display:none}.graph-toolbar{grid-template-columns:1fr}.topbar,.panel-head,.status-bar{align-items:flex-start;grid-template-columns:1fr;flex-direction:column}.sidebar{grid-template-columns:1fr 1fr}.console-actions{grid-template-columns:1fr}}@media(max-width:520px){.summary{grid-template-columns:1fr}.sidebar{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto;transition:none!important}}
  </style>
</head>
<body>
  <header><div class="topbar"><div><h1>memory-xx 运行时控制面板</h1><div class="meta" id="meta">127.0.0.1 本地控制面</div></div><div class="header-actions toolbar-row"><a href="/flows">链路追踪</a><button class="secondary" data-jump="settings">参数设置</button><button id="refresh">刷新</button></div></div></header>
  <div class="app-shell">
  <aside class="sidebar">
    <div class="sidebar-title">控制区</div>
    <button class="navlink active" data-section="overview">总览</button>
    <button class="navlink" data-section="runtime-map">运行机制</button>
    <button class="navlink" data-section="clients">连接监控</button>
    <button class="navlink" data-section="settings">参数设置</button>
    <button class="navlink" data-section="services">服务开关</button>
    <button class="navlink" data-section="workers">后台任务</button>
    <button class="navlink" data-section="cache">缓存</button>
    <button class="navlink" data-section="write">写入</button>
    <button class="navlink" data-section="recall">召回</button>
    <button class="navlink" data-section="auto-approval">自动审批</button>
    <button class="navlink" data-section="auto-update-lab">自动更新实验室</button>
    <button class="navlink" data-section="approval-capacity">审批容量</button>
    <button class="navlink" data-section="feedback-loop">反馈闭环</button>
    <button class="navlink" data-section="database">数据库</button>
    <button class="navlink" data-section="qdrant">向量投影</button>
    <button class="navlink" data-section="graph">图谱</button>
    <button class="navlink" data-section="graph-ops">图谱生产化</button>
    <button class="navlink" data-section="security">安全治理</button>
    <button class="navlink" data-section="platform">平台适配</button>
    <button class="navlink" data-section="migration">迁移预检</button>
    <button class="navlink" data-section="ops-automation">自动化运维</button>
    <button class="navlink" data-section="audit">审计</button>
  </aside>
  <main class="content">
    <section class="status-bar"><div><strong id="status-title">正在加载运行状态</strong><br><span id="status-detail">等待服务健康、参数和数据库维护摘要。</span></div><div class="status-chips"><span class="chip info" id="status-refresh">未刷新</span><span class="chip" id="status-registry">参数 0</span><span class="chip" id="status-dirty">未修改</span></div></section>
    <section class="dashboard-section" data-panel="overview">
    <div class="summary">
      <div class="metric" id="m-overall"><div class="label">核心状态</div><div class="value">加载中</div></div>
      <div class="metric" id="m-cause"><div class="label">核心原因</div><div class="value">检查中</div></div>
      <div class="metric" id="m-profile"><div class="label">运行层级</div><div class="value">未知</div></div>
      <div class="metric" id="m-embedding-upstream"><div class="label">Embedding 上游</div><div class="value">检查中</div></div>
      <div class="metric" id="m-generation"><div class="label">向量版本</div><div class="value">未知</div></div>
      <div class="metric" id="m-graph"><div class="label">图谱节点</div><div class="value">0</div></div>
    </div>
    <section class="control-console">
      <div class="console-copy">
        <h2>参数设置中心</h2>
        <p>这里是当前控制面板的主要操作入口。可直接搜索缓存过期时间、健康检查间隔、写入限流、召回参数、后台任务批量大小、自动审批阈值等运行时参数；每项都会显示真实来源、风险等级和生效方式。</p>
      </div>
      <div class="console-actions">
        <button class="console-button" data-jump="settings"><strong>打开参数中心</strong><span>全量运行时参数，可修改数值和开关</span></button>
        <button class="console-button" data-jump="runtime-map"><strong>查看运行机制</strong><span>写入 -> 审批 -> 向量投影 -> 召回</span></button>
        <button class="console-button" data-jump="database"><strong>数据库健康</strong><span>WAL、dead tuples、autovacuum 只读监控</span></button>
      </div>
    </section>
    <section class="services-panel">
      <div class="panel-head"><h2>为什么当前不能全开</h2><span class="subtle">来自实时 runtime snapshot（运行时快照）</span></div>
      <div id="closure-reasons" class="detail-grid"></div>
    </section>
    <section class="services-panel">
      <div class="panel-head"><h2>组件实时状态</h2><span class="subtle" id="component-status-updated">等待状态</span></div>
      <div id="component-status-grid" class="insight-grid"></div>
    </section>
    <section class="services-panel">
      <div class="panel-head"><h2>最近连接 Agent</h2><span class="subtle" id="client-connections-updated">等待连接记录</span></div>
      <div id="client-connections-table"></div>
    </section>
    </section>
    <section class="dashboard-section hidden" data-panel="clients">
      <section class="services-panel">
        <div class="panel-head"><h2>Agent / MCP 连接监控</h2><span class="subtle">显示通过 MCP、HTTP API 或控制面板连接到 memory-xx 的调用方</span></div>
        <div id="client-connections-page"></div>
      </section>
      <section class="services-panel">
        <div class="panel-head"><h2>MCP 工具调用矩阵</h2><span class="subtle" id="mcp-tools-updated">等待 MCP 调用指标</span></div>
        <div id="mcp-tools-page"></div>
      </section>
      <section class="services-panel">
        <div class="panel-head"><h2>组件状态矩阵</h2><span class="subtle">实时探测 wrapper、OVMS、Qdrant、Redis、worker、队列和投影一致性</span></div>
        <div id="component-status-page" class="insight-grid"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="runtime-map">
      <section class="services-panel">
        <div class="panel-head"><h2>运行机制图</h2><span class="subtle" id="runtime-map-updated">等待状态</span></div>
        <div class="runtime-map" id="runtime-map-grid"></div>
      </section>
      <section class="services-panel">
        <div class="panel-head"><h2>运行时历史</h2><span class="subtle">保留 7 天，默认展示最近 24 小时</span></div>
        <div id="runtime-history"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="services">
    <section class="services-panel">
      <div class="panel-head"><h2>运行开关</h2><span class="subtle" id="services-updated">等待状态</span></div>
      <div class="service-grid" id="service-grid"></div>
    </section>
    </section>
    <section class="dashboard-section hidden" data-panel="settings">
      <section class="services-panel">
        <div class="panel-head"><h2>参数设置中心</h2><span class="subtle" id="settings-updated">等待状态</span></div>
        <div class="runtime-toolbar">
          <input id="settings-search" placeholder="搜索 key、功能名、中文说明" />
          <select id="settings-category"><option value="">全部分类</option></select>
          <select id="settings-safety"><option value="">全部风险</option><option value="safe">安全</option><option value="guarded">受保护</option><option value="high-risk">高风险</option></select>
          <button id="settings-apply">应用已修改</button>
        </div>
        <div class="settings-shell">
          <aside class="settings-index">
            <h3>运行时参数总表</h3>
            <div id="settings-index"></div>
            <div class="settings-feedback" id="settings-feedback" role="status" aria-live="polite">修改参数后可单项保存，或批量预览后应用。</div>
          </aside>
          <div class="parameter-groups" id="runtime-settings-grid"></div>
        </div>
      </section>
      <section class="services-panel">
        <div class="panel-head"><h2>环境变量只读视图</h2><span class="subtle">修改 .env 后需要按服务重启</span></div>
        <div class="parameter-grid" id="env-settings-grid"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="workers"><section class="services-panel"><div class="panel-head"><h2>后台任务</h2><span class="subtle">执行间隔 / 批量大小 / 重试</span></div><div id="runtime-workers"></div></section></section>
    <section class="dashboard-section hidden" data-panel="cache"><section class="services-panel"><div class="panel-head"><h2>缓存</h2><span class="subtle">Redis 缓存过期时间 / 缓存健康</span></div><div id="runtime-cache"></div></section></section>
    <section class="dashboard-section hidden" data-panel="write"><section class="services-panel"><div class="panel-head"><h2>写入</h2><span class="subtle">速率限制 / 队列 / 语义锁</span></div><div id="runtime-write"></div></section></section>
    <section class="dashboard-section hidden" data-panel="recall"><section class="services-panel"><div class="panel-head"><h2>召回</h2><span class="subtle">延迟 / 重排序 / 快速路径</span></div><div id="runtime-recall"></div></section></section>
    <section class="dashboard-section hidden" data-panel="auto-approval">
    <section class="services-panel">
      <div class="panel-head"><h2>自动审批开关</h2><span class="subtle" id="auto-approval-controls-updated">等待状态</span></div>
      <div class="service-grid" id="auto-approval-control-grid"></div>
    </section>
    <section class="services-panel">
      <div class="panel-head"><h2>审批容量建议</h2><span class="subtle">按近 1h / 24h / 7d 数据评估，不自动修改</span></div>
      <div id="auto-approval-capacity-inline" class="insight-grid"></div>
    </section>
    </section>
    <section class="dashboard-section hidden" data-panel="auto-update-lab">
      <section class="services-panel">
        <div class="panel-head"><h2>Auto-update Lab（自动更新实验室：随机测试与 apply/rollback 报告）</h2><span class="subtle" id="auto-update-lab-updated">等待报告</span></div>
        <div id="auto-update-lab-summary" class="insight-grid"></div>
        <div id="auto-update-lab-report"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="approval-capacity">
      <section class="services-panel">
        <div class="panel-head"><h2>Approval Capacity（审批容量：小时上限建议和积压分析）</h2><span class="subtle" id="approval-capacity-updated">等待评估</span></div>
        <div id="approval-capacity-grid" class="insight-grid"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="feedback-loop">
      <section class="services-panel">
        <div class="panel-head"><h2>Feedback Loop（反馈闭环：召回标注、修复队列和冻结指标）</h2><span class="subtle" id="feedback-loop-updated">等待数据</span></div>
        <div id="feedback-loop-summary" class="insight-grid"></div>
        <div id="feedback-loop-traces"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="database">
      <section class="services-panel">
        <div class="panel-head"><h2>数据库健康</h2><span class="subtle" id="database-updated">只读监控，不执行 VACUUM 或配置修改</span></div>
        <div id="database-maintenance"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="qdrant"><section class="services-panel"><div class="panel-head"><h2>向量投影</h2><span class="subtle">PostgreSQL 与 Qdrant 数量差异 / 投影积压</span></div><div id="runtime-qdrant"></div></section></section>
    <section class="dashboard-section hidden" data-panel="audit"><section class="services-panel"><div class="panel-head"><h2>审计</h2><span class="subtle">参数差异 / 治理动作 / 告警</span></div><div id="runtime-audit"></div></section></section>
    <section class="dashboard-section hidden" data-panel="security">
      <section class="services-panel">
        <div class="panel-head"><h2>Security（安全治理：密钥审计与轮换清单）</h2><span class="subtle" id="security-updated">等待扫描</span></div>
        <div id="security-summary" class="insight-grid"></div>
        <div id="security-findings"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="platform">
      <section class="services-panel">
        <div class="panel-head"><h2>Platform（平台适配：Linux / WSL / Windows / Docker）</h2><span class="subtle" id="platform-updated">等待检测</span></div>
        <div id="platform-summary" class="insight-grid"></div>
        <div id="platform-components"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="migration">
      <section class="services-panel">
        <div class="panel-head"><h2>Migration（迁移预检：部署阻断项与手动步骤）</h2><span class="subtle" id="migration-updated">等待预检</span></div>
        <div id="migration-summary" class="insight-grid"></div>
        <div id="migration-checks"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="graph">
    <section class="graph-panel">
      <div class="graph-head">
        <div class="graph-title-row">
          <div><h2>3D 图谱</h2><div class="legend"><span><i class="dot memory-dot"></i>记忆</span><span><i class="dot entity-dot"></i>实体</span><span><i class="dot episode-dot"></i>片段</span><span><i class="dot file-dot"></i>文件</span><span><i class="dot symbol-dot"></i>符号</span></div></div>
          <span class="subtle" id="running"></span>
        </div>
        <div class="graph-toolbar">
          <label>图谱 <select id="graph-kind"><option value="memory">知识图谱</option><option value="code">代码图谱</option></select></label>
          <label>搜索 <input id="graph-query" placeholder="实体、记忆、文件、符号" /></label>
          <label>深度 <select id="graph-depth"><option value="1">1 跳</option><option value="2">2 跳</option></select></label>
          <label>数量 <select id="graph-limit"><option>50</option><option selected>80</option><option>140</option><option>220</option></select></label>
          <label>范围类型 <input id="graph-scope-type" value="${defaultGraphScopeType}" /></label>
          <label>范围 ID <input id="graph-scope-id" value="${defaultGraphScopeId}" /></label>
          <label>代码根目录 <input id="code-root" value="${projectRoot}" /></label>
          <button id="graph-refresh">加载图谱</button>
        </div>
      </div>
      <div class="graph-shell">
        <div class="graph-canvas-wrap" id="graph-wrap"><div class="graph-empty" id="graph-empty">正在加载图谱...</div></div>
        <aside class="graph-details" id="graph-details"><h3>图谱概览</h3><div id="components"></div><div class="detail-row"><strong>当前选择</strong><span class="subtle">点击节点查看详情。</span></div></aside>
      </div>
    </section>
    </section>
    <section class="dashboard-section hidden" data-panel="graph-ops">
      <section class="services-panel">
        <div class="panel-head"><h2>Graph Ops（图谱生产化：证据链与项目级 code graph）</h2><span class="subtle" id="graph-ops-updated">等待图谱状态</span></div>
        <div id="graph-ops-summary" class="insight-grid"></div>
        <div id="graph-ops-details"></div>
      </section>
    </section>
    <section class="dashboard-section hidden" data-panel="ops-automation">
      <section class="services-panel">
        <div class="panel-head"><h2>Ops Automation（自动化运维：自动审批和 self-improvement 建议）</h2><span class="subtle" id="ops-automation-updated">report-only</span></div>
        <div id="ops-automation-summary" class="insight-grid"></div>
        <div id="ops-automation-plan"></div>
      </section>
    </section>
  </main>
  </div>
  <script type="module">
    import * as THREE from "three";
    const PANEL_TOKEN = ${JSON.stringify(panelToken)};
    const wrap = document.getElementById("graph-wrap");
    const empty = document.getElementById("graph-empty");
    const details = document.getElementById("graph-details");
    const running = document.getElementById("running");
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    wrap.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const camera = new THREE.PerspectiveCamera(58, 1, 1, 5000);
    camera.position.set(0, 0, 760);
    scene.add(new THREE.AmbientLight(0xffffff, 0.82));
    const light = new THREE.DirectionalLight(0xffffff, 0.72);
    light.position.set(300, 500, 400);
    scene.add(light);
    let group = new THREE.Group();
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let clickable = [];
    let currentGraph = { nodes: [], edges: [], summary: {} };
    let dragging = false;
    let moved = false;
    let last = { x: 0, y: 0 };

    function setMetric(id, value, state) {
      const node = document.getElementById(id);
      node.classList.remove("ok", "bad");
      if (state) node.classList.add(state);
      node.querySelector(".value").textContent = value;
    }
    function primaryIssue(health) {
      const issues = Array.isArray(health.issues) ? health.issues : [];
      if (issues.length > 0) {
        return issues.find((issue) => issue.severity === "critical") || issues[0];
      }
      const repairIssues = Array.isArray(health.repair_summary?.issues) ? health.repair_summary.issues : [];
      return repairIssues.find((issue) => issue.severity === "critical") || repairIssues[0] || null;
    }
    function embeddingProbeIssue(probe) {
      if (!probe || probe.ok) return null;
      if (probe.status) return "embedding_upstream_unavailable HTTP " + probe.status + (probe.detail ? ": " + probe.detail : "");
      return "embedding_upstream_unavailable" + (probe.error ? ": " + probe.error : "");
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function badgeClass(value) {
      if (value === "safe" || value === "hot" || value === "runtime_json" || value === "default") return "ok";
      if (value === "high-risk" || value === "restart_pending") return "bad";
      if (value === "guarded" || value === "restart") return "warn";
      return "info";
    }
    function settingMode(setting) {
      if (setting.effect_status === "hot_reload") return "hot";
      if (setting.effect_status === "pending_restart") return "restart";
      if (setting.effect_status === "read_only_env") return "read only";
      if (setting.effect_status === "external_service_owned") return "external";
      return setting.hot_reloadable ? "hot" : setting.requires_restart ? "restart" : "read only";
    }
    function safetyLabel(value) {
      return ({ safe: "安全", guarded: "受保护", "high-risk": "高风险" })[value] || String(value || "未知");
    }
    function sourceLabel(value) {
      return ({
        runtime_json: "运行时配置",
        env: "环境变量",
        default: "默认值",
        restart_pending: "等待重启",
        database_override: "数据库覆盖",
        service_snapshot: "服务快照",
      })[value] || String(value || "未知来源");
    }
    function modeLabel(value) {
      return ({ hot: "热更新", restart: "需重启", "read only": "只读", external: "外部服务" })[value] || String(value || "未知");
    }
    function displayUnit(setting) {
      if (setting.unit) return setting.unit;
      if (setting.type === "boolean") return "开关";
      if (setting.type === "string") return "文本";
      return "数值";
    }
    function categoryLabel(value) {
      return ({
        config: "基础配置",
        service: "服务",
        worker: "后台任务",
        cache: "缓存",
        queue: "队列",
        policy: "策略",
        health_gate: "健康门禁",
        database: "数据库",
        qdrant: "向量投影",
        recall: "召回",
        write: "写入",
        auto_approval: "自动审批",
        ui: "控制面板",
      })[value] || String(value || "未分类");
    }
    function categoryDescription(value) {
      return ({
        worker: "控制后台 worker 的轮询间隔、批量大小、租约和重试参数。",
        cache: "控制 Redis 缓存过期时间、空召回缓存和缓存连接参数。",
        write: "控制写入限流、语义锁、写入票据和智能写入预检参数。",
        recall: "控制召回数量、图谱健康缓存、重排序和快速召回超时。",
        qdrant: "控制 Qdrant 向量投影、投影 worker 和数据库向量一致性。",
        health_gate: "控制健康门禁阈值；触发后会阻断高风险自动动作。",
        auto_approval: "控制自动审批 scope、阈值、冻结、user/global 和 update apply 子功能。",
        database: "控制数据库连接和维护告警阈值，autovacuum 仍以只读监控为主。",
        ui: "控制面板自身的刷新间隔、图谱默认范围和展示密度。",
        config: "基础运行配置和服务启动相关参数。",
      })[value] || "该分类下的运行时参数。";
    }
    function groupByCategory(items) {
      const order = ["auto_approval", "write", "recall", "cache", "worker", "health_gate", "qdrant", "database", "ui", "config"];
      const groups = new Map();
      for (const item of items) {
        const key = item.category || "uncategorized";
        groups.set(key, [...(groups.get(key) || []), item]);
      }
      return [...groups.entries()].sort((a, b) => {
        const ai = order.indexOf(a[0]);
        const bi = order.indexOf(b[0]);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return categoryLabel(a[0]).localeCompare(categoryLabel(b[0]), "zh-CN");
      });
    }
    function renderParameterCard(setting) {
      return '<article class="parameter-card" data-safety="' + escapeHtml(setting.safety) + '" data-key="' + escapeHtml(setting.key) + '">' +
        '<div class="parameter-card-head">' +
          '<div class="parameter-title-row"><div class="parameter-title">' + escapeHtml(setting.label) + '</div><span class="chip ' + badgeClass(setting.safety) + '">' + escapeHtml(safetyLabel(setting.safety)) + '</span></div>' +
          '<div class="parameter-desc">' + escapeHtml(setting.description) + '</div>' +
          '<div class="parameter-badges"><span class="chip ' + badgeClass(setting.source) + '">' + escapeHtml(sourceLabel(setting.source)) + '</span><span class="chip ' + badgeClass(settingMode(setting)) + '">' + escapeHtml(modeLabel(settingMode(setting))) + '</span><span class="chip info">' + escapeHtml(categoryLabel(setting.category)) + '</span>' + (setting.safety === "high-risk" ? '<span class="danger">需要二次确认</span>' : '') + (setting.source === "restart_pending" ? '<span class="danger">等待重启生效</span>' : '') + '</div>' +
        '</div>' +
        '<div class="parameter-body"><div class="parameter-value-label">当前真实值：' + escapeHtml(setting.effective_value ?? "(unset)") + ' · 默认：' + escapeHtml(setting.default_value ?? "(unset)") + '</div>' + inputForSetting(setting) + '</div>' +
        '<div><div class="parameter-actions"><button data-key="' + escapeHtml(setting.key) + '">保存</button><button class="secondary" data-reset-key="' + escapeHtml(setting.key) + '">默认</button></div><div class="parameter-meta"><span class="parameter-key">' + escapeHtml(setting.key) + '</span><span>单位 ' + escapeHtml(setting.unit || "无单位") + '</span><span>生效 ' + escapeHtml(modeLabel(settingMode(setting))) + '</span><span>' + escapeHtml(setting.updated_at || "未记录更新时间") + '</span></div></div>' +
      '</article>';
    }
    function renderReadonlySettingCard(setting) {
      return '<article class="parameter-card readonly">' +
        '<div class="parameter-card-head"><div class="parameter-title-row"><div class="parameter-title">' + escapeHtml(setting.label) + '</div><span class="chip info">只读</span></div><div class="parameter-desc">' + escapeHtml(setting.description) + '</div><div class="parameter-badges"><span class="chip info">环境变量</span><span class="chip ' + (setting.requires_restart ? "warn" : "ok") + '">' + escapeHtml(setting.requires_restart ? "需重启" : "热更新") + '</span></div></div>' +
        '<div class="parameter-body"><div class="parameter-value-label">当前值</div><div class="parameter-key">' + escapeHtml(setting.value ?? "(unset)") + '</div></div>' +
        '<div class="parameter-meta"><span class="parameter-key">' + escapeHtml(setting.key) + '</span><span>' + escapeHtml(setting.service || "服务") + '</span></div>' +
      '</article>';
    }
    function setActiveSection(name) {
      document.querySelectorAll(".navlink").forEach((button) => button.classList.toggle("active", button.dataset.section === name));
      document.querySelectorAll(".dashboard-section").forEach((section) => section.classList.toggle("hidden", section.dataset.panel !== name));
      if (name === "graph") resize();
    }
    function inputForSetting(setting) {
      const unit = '<span class="setting-unit">' + escapeHtml(displayUnit(setting)) + '</span>';
      if (setting.type === "boolean") {
        return '<div class="setting-editor"><select class="setting-control" data-key="' + escapeHtml(setting.key) + '"><option value="true"' + (setting.value === true ? " selected" : "") + '>开启</option><option value="false"' + (setting.value !== true ? " selected" : "") + '>关闭</option></select>' + unit + '</div>';
      }
      if (setting.type === "number") {
        const min = Number(setting.min ?? 0);
        const max = Number(setting.max ?? 100);
        const step = Number(setting.step ?? 1);
        const value = Number(setting.value ?? setting.default_value ?? min);
        const hasRange = Number.isFinite(min) && Number.isFinite(max) && max > min && (max - min) <= 100000;
        return '<div class="setting-editor ' + (hasRange ? "range" : "") + '">' +
          (hasRange ? '<input class="setting-control setting-range" data-key="' + escapeHtml(setting.key) + '" type="range" min="' + escapeHtml(min) + '" max="' + escapeHtml(max) + '" step="' + escapeHtml(step) + '" value="' + escapeHtml(value) + '" />' : '') +
          '<input class="setting-control setting-number" data-key="' + escapeHtml(setting.key) + '" value="' + escapeHtml(value) + '" type="number" min="' + escapeHtml(min) + '" max="' + escapeHtml(max) + '" step="' + escapeHtml(step) + '" />' +
          unit +
        '</div>';
      }
      return '<div class="setting-editor"><input class="setting-control" data-key="' + escapeHtml(setting.key) + '" value="' + escapeHtml(setting.value ?? "") + '" type="text" />' + unit + '</div>';
    }
    let latestSettings = { registry: [], env: [], pending_restart: [] };
    const dirtySettings = new Map();
    function valueFromControl(input) {
      return input.tagName === "SELECT" ? input.value === "true" : input.type === "number" || input.type === "range" ? Number(input.value) : input.value;
    }
    function renderSettingsIndex(registry, runtime, env, filtered, settings) {
      const node = document.getElementById("settings-index");
      if (!node) return;
      const pending = Array.isArray(settings?.pending_restart) ? settings.pending_restart : [];
      const highRisk = runtime.filter((setting) => setting.safety === "high-risk").length;
      node.innerHTML =
        '<div class="index-row"><span>全量参数</span><strong>' + escapeHtml(registry.length) + '</strong></div>' +
        '<div class="index-row"><span>可写 runtime</span><strong>' + escapeHtml(runtime.length) + '</strong></div>' +
        '<div class="index-row"><span>当前筛选</span><strong>' + escapeHtml(filtered.length) + '</strong></div>' +
        '<div class="index-row"><span>高风险项</span><strong>' + escapeHtml(highRisk) + '</strong></div>' +
        '<div class="index-row"><span>只读 env</span><strong>' + escapeHtml(env.length) + '</strong></div>' +
        '<div class="index-row"><span>等待重启</span><strong>' + escapeHtml(pending.length) + '</strong></div>' +
        '<div class="settings-category-list">' + groupByCategory(runtime).map(([key, items]) => '<button class="settings-category-button" data-settings-category="' + escapeHtml(key) + '"><span>' + escapeHtml(categoryLabel(key)) + '</span><strong>' + escapeHtml(items.length) + '</strong></button>').join("") + '</div>';
      const registryChip = document.getElementById("status-registry");
      if (registryChip) registryChip.textContent = "参数 " + registry.length;
    }
    function updateDirtyStatus() {
      const chip = document.getElementById("status-dirty");
      if (chip) {
        chip.textContent = dirtySettings.size ? "待保存 " + dirtySettings.size : "未修改";
        chip.className = "chip " + (dirtySettings.size ? "warn" : "ok");
      }
      const feedback = document.getElementById("settings-feedback");
      if (feedback && dirtySettings.size) feedback.textContent = "已修改 " + dirtySettings.size + " 项。点击“应用已修改”会先预览风险和重启影响。";
    }
    function renderSettings(settings) {
      latestSettings = settings || { registry: [], env: [], pending_restart: [] };
      const registry = Array.isArray(settings?.registry) ? settings.registry : [];
      const runtime = registry.filter((setting) => setting.writable);
      const env = Array.isArray(settings?.env) ? settings.env : [];
      const query = (document.getElementById("settings-search")?.value || "").toLowerCase();
      const category = document.getElementById("settings-category")?.value || "";
      const safety = document.getElementById("settings-safety")?.value || "";
      const categories = [...new Set(registry.map((setting) => setting.category).filter(Boolean))].sort();
      const categorySelect = document.getElementById("settings-category");
      if (categorySelect && categorySelect.options.length <= 1) {
        categorySelect.innerHTML = '<option value="">全部分类</option>' + categories.map((item) => '<option value="' + escapeHtml(item) + '">' + escapeHtml(categoryLabel(item)) + '</option>').join("");
      }
      const filtered = runtime.filter((setting) => {
        const haystack = [setting.key, setting.label, setting.description, setting.category, setting.source].join(" ").toLowerCase();
        return (!query || haystack.includes(query)) && (!category || setting.category === category) && (!safety || setting.safety === safety);
      });
      const runtimeGrid = document.getElementById("runtime-settings-grid");
      const envGrid = document.getElementById("env-settings-grid");
      renderSettingsIndex(registry, runtime, env, filtered, settings);
      runtimeGrid.innerHTML = filtered.length ? groupByCategory(filtered).map(([key, items]) =>
        '<section class="parameter-group"><div class="parameter-group-head"><div><h3 class="parameter-group-title">' + escapeHtml(categoryLabel(key)) + '</h3><div class="parameter-group-desc">' + escapeHtml(categoryDescription(key)) + '</div></div><span class="chip info">' + escapeHtml(items.length) + ' 项</span></div><div class="parameter-grid">' + items.map(renderParameterCard).join("") + '</div></section>'
      ).join("") : '<div class="empty-state">没有匹配的可写 runtime 参数。请清空搜索或切换分类/风险筛选。</div>';
      envGrid.innerHTML = env.map(renderReadonlySettingCard).join("");
      document.getElementById("settings-updated").textContent = "参数 " + registry.length + " 项 · 可写 " + runtime.length + " 项 · 环境变量 " + env.length + " 项 · 待重启 " + ((settings.pending_restart || []).length);
      const feedback = document.getElementById("settings-feedback");
      if (feedback && dirtySettings.size === 0) feedback.textContent = "当前显示 " + filtered.length + " 项可写参数。修改后可单项保存，或批量预览后应用。";
      updateDirtyStatus();
      document.querySelectorAll(".settings-category-button[data-settings-category]").forEach((button) => {
        const buttonCategory = button.getAttribute("data-settings-category") || "";
        button.classList.toggle("active", buttonCategory === category);
        button.addEventListener("click", () => {
          const select = document.getElementById("settings-category");
          if (select) select.value = buttonCategory === category ? "" : buttonCategory;
          renderSettings(latestSettings);
        });
      });
      runtimeGrid.querySelectorAll(".setting-control[data-key]").forEach((input) => {
        if (input.tagName === "BUTTON") return;
        input.addEventListener("input", () => {
          const key = input.getAttribute("data-key");
          const item = registry.find((candidate) => candidate.key === key);
          if (!item) return;
          const value = valueFromControl(input);
          const editor = input.closest(".setting-editor");
          if (editor) {
            editor.querySelectorAll(".setting-control[data-key]").forEach((peer) => {
              if (peer !== input && peer.type !== "select-one") peer.value = input.value;
            });
          }
          dirtySettings.set(key, value);
          const card = input.closest(".parameter-card");
          if (card) card.classList.add("dirty");
          updateDirtyStatus();
        });
      });
      runtimeGrid.querySelectorAll("button[data-key]").forEach((button) => {
        button.addEventListener("click", async () => {
          const key = button.getAttribute("data-key");
          const card = button.closest(".parameter-card");
          const input = card.querySelector(".setting-control[data-key]");
          const highRisk = card.getAttribute("data-safety") === "high-risk";
          if (highRisk && !confirm("这是高风险参数，确认保存 " + key + " ?")) return;
          const value = valueFromControl(input);
          const response = await fetch("/api/settings/update", {
            method: "POST",
            headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
            body: JSON.stringify({ key, value }),
          });
          if (!response.ok) throw new Error(await response.text());
          const body = await response.json();
          dirtySettings.delete(key);
          const feedback = document.getElementById("settings-feedback");
          if (feedback) feedback.textContent = "已保存 " + key + "。";
          renderSettings(body.settings || {});
        });
      });
      runtimeGrid.querySelectorAll("button[data-reset-key]").forEach((button) => {
        button.addEventListener("click", async () => {
          const key = button.getAttribute("data-reset-key");
          if (!confirm("恢复默认值 " + key + " ?")) return;
          const response = await fetch("/api/settings/reset", {
            method: "POST",
            headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
            body: JSON.stringify({ key }),
          });
          if (!response.ok) throw new Error(await response.text());
          const body = await response.json();
          dirtySettings.delete(key);
          const feedback = document.getElementById("settings-feedback");
          if (feedback) feedback.textContent = "已恢复默认 " + key + "。";
          renderSettings(body.settings || {});
        });
      });
    }
    function tableForRegistry(items) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return '<div class="detail-row"><strong>暂无数据</strong><span class="subtle">没有匹配的 runtime 项。</span></div>';
      return '<table class="data-table"><thead><tr><th>参数键</th><th>当前真实值</th><th>来源</th><th>生效方式</th><th>风险</th><th>服务</th></tr></thead><tbody>' +
        list.map((item) => '<tr><td>' + escapeHtml(item.key) + '<br><span class="subtle">' + escapeHtml(item.label) + '</span></td><td>' + escapeHtml(item.effective_value ?? item.value ?? "") + '</td><td>' + escapeHtml(sourceLabel(item.source)) + '</td><td>' + escapeHtml(modeLabel(settingMode(item))) + '</td><td>' + escapeHtml(safetyLabel(item.safety)) + '</td><td>' + escapeHtml(item.service || "-") + '</td></tr>').join("") +
        '</tbody></table>';
    }
    function renderRuntimeCategory(registry, category, targetId) {
      const node = document.getElementById(targetId);
      if (!node) return;
      node.innerHTML = tableForRegistry(category ? (registry || []).filter((item) => item.category === category) : (registry || []));
    }
    function renderRuntimeMap(snapshot) {
      const grid = document.getElementById("runtime-map-grid");
      if (!grid) return;
      const metrics = snapshot?.metrics || {};
      const outbox = metrics.outbox || {};
      const cache = metrics.cache_invalidation || {};
      const records = metrics.memory_records || {};
      const auto = metrics.auto_approval || {};
      const recall = metrics.recall || {};
      const steps = [
        ["write", "写入", "已批准=" + (records.approved_current ?? "?") + " 候选=" + (records.candidate_current ?? "?"), "ok"],
        ["approval", "审批", "1 小时批准=" + (auto.approved_1h ?? 0) + " 阻断=" + (auto.blocked_1h ?? 0), Number(auto.blocked_1h ?? 0) > 0 ? "pending" : "ok"],
        ["pg", "PostgreSQL 主存储", "当前=" + (records.approved_current ?? "?"), "ok"],
        ["outbox", "Outbox 队列", "等待=" + (outbox.pending ?? 0) + " 失败=" + (outbox.failed ?? 0), Number(outbox.pending ?? 0) > 0 ? "pending" : "ok"],
        ["qdrant", "向量投影", "状态=" + (snapshot?.status || "未知"), snapshot?.status === "blocked" ? "bad" : "ok"],
        ["cache", "缓存失效", "等待=" + (cache.pending ?? 0) + " 失败=" + (cache.failed ?? 0), Number(cache.pending ?? 0) > 0 ? "pending" : "ok"],
        ["recall", "召回", "1 小时链路=" + (recall.recall_traces_1h ?? 0) + " P95=" + Math.round(Number(recall.recall_p95_ms ?? 0)) + "ms", "ok"],
      ];
      grid.innerHTML = steps.map((step) => '<div class="runtime-step ' + step[3] + '"><strong>' + escapeHtml(step[1]) + '</strong><span>' + escapeHtml(step[2]) + '</span></div>').join("");
      document.getElementById("runtime-map-updated").textContent = "快照 " + (snapshot?.collected_at || "未知") + " · " + (snapshot?.status || "未知");
    }
    function renderClosureReasons(snapshot) {
      const node = document.getElementById("closure-reasons");
      if (!node) return;
      const reasons = snapshot?.summary?.closure_reasons || {};
      const rows = [
        ["global", "Global 全局自动审批", reasons.global_manual_reason || "保持人工审批。"],
        ["update", "真实 update apply", reasons.real_update_apply_scope || "真实长期作用域更新应用未全开。"],
        ["user", "User/Workspace/Global update", reasons.user_update_apply_reason || "仍保持硬阻断。"],
        ["candidate", "Candidate-only 安全开关", reasons.candidate_only_reason || "保留全局 kill switch。"],
        ["pending", "候选积压", "当前 pending candidate=" + (reasons.pending_candidate_backlog ?? 0)],
      ];
      node.innerHTML = rows.map((row) => '<div class="detail-row"><strong>' + escapeHtml(row[1]) + '</strong><span class="subtle">' + escapeHtml(row[2]) + '</span></div>').join("");
    }
    function renderApprovalCapacity(advice) {
      const profiles = Array.isArray(advice?.profiles) ? advice.profiles : [];
      const html = profiles.map((profile) => {
        const current = Number(profile.current_limit ?? 0);
        const recommended = Number(profile.recommended_limit ?? 0);
        const delta = recommended - current;
        return '<article class="insight-card">' +
          '<h3>' + escapeHtml(String(profile.profile || "unknown").toUpperCase()) + ' 小时上限</h3>' +
          '<div class="big">' + escapeHtml(current) + ' -> ' + escapeHtml(recommended) + '</div>' +
          '<div class="risk-line" title="容量风险参考"></div>' +
          '<p>eligible pending（可自动处理候选）=' + escapeHtml(profile.eligible_pending ?? 0) + '，p95 小时批准=' + escapeHtml(profile.p95_hourly_approved ?? 0) + '，冻结 cohort=' + escapeHtml(profile.frozen_cohorts ?? 0) + '。</p>' +
          '<p>' + escapeHtml(profile.reason || (delta > 0 ? "建议手动提高。" : "当前值足够。")) + '</p>' +
        '</article>';
      }).join("");
      for (const id of ["approval-capacity-grid", "auto-approval-capacity-inline"]) {
        const node = document.getElementById(id);
        if (node) node.innerHTML = html || '<div class="empty-state">暂无审批容量建议。</div>';
      }
      const updated = document.getElementById("approval-capacity-updated");
      if (updated) updated.textContent = advice?.generated_at ? "已评估 " + advice.generated_at : "暂无评估";
    }
    function renderAutoUpdateLab(ops) {
      const latest = ops?.latest_reports?.auto_update_random_full || null;
      const snapshot = ops?.runtime_snapshot || {};
      const metrics = snapshot.metrics || {};
      const node = document.getElementById("auto-update-lab-summary");
      if (node) {
        node.innerHTML =
          '<article class="insight-card"><h3>随机全量报告</h3><div class="big">' + escapeHtml(latest?.ok === true ? "通过" : "待运行") + '</div><p>run_id=' + escapeHtml(latest?.run_id || "暂无") + '</p></article>' +
          '<article class="insight-card"><h3>真实 scope 阻断</h3><div class="big">保持开启</div><p>user / workspace / global update apply 仍硬阻断；project 只允许 guarded 单条试运行。</p></article>' +
          '<article class="insight-card"><h3>当前候选积压</h3><div class="big">' + escapeHtml(snapshot.summary?.closure_reasons?.pending_candidate_backlog ?? 0) + '</div><p>用于判断是否需要提高 add-only 自动审批小时上限。</p></article>' +
          '<article class="insight-card"><h3>召回链路样本</h3><div class="big">' + escapeHtml(metrics.recall?.recall_traces_1h ?? 0) + '</div><p>最近 1 小时 recall trace 数。</p></article>';
      }
      const report = document.getElementById("auto-update-lab-report");
      if (report) report.innerHTML = latest
        ? '<div class="detail-row"><strong>报告路径</strong><span class="subtle">' + escapeHtml(latest.report_path || "未记录") + '</span></div><pre class="mini-pre">' + escapeHtml(JSON.stringify(latest, null, 2)) + '</pre>'
        : '<div class="empty-state">还没有 auto-update random full 报告。可运行 npm run test:auto-update-apply-random-full。</div>';
      const updated = document.getElementById("auto-update-lab-updated");
      if (updated) updated.textContent = ops?.generated_at ? "已刷新 " + ops.generated_at : "暂无报告";
    }
    function renderFeedbackLoop(feedback) {
      const traces = Array.isArray(feedback?.traces) ? feedback.traces : [];
      const counts = Array.isArray(feedback?.feedback_7d) ? feedback.feedback_7d : [];
      const repairs = Array.isArray(feedback?.repair_queue) ? feedback.repair_queue : [];
      const summary = document.getElementById("feedback-loop-summary");
      if (summary) {
        summary.innerHTML =
          '<article class="insight-card"><h3>最近 trace（召回追踪）</h3><div class="big">' + escapeHtml(traces.length) + '</div><p>可人工标注有用、没用、错了、过期、应更新或应合并。</p></article>' +
          '<article class="insight-card"><h3>7 天反馈类型</h3><div class="big">' + escapeHtml(counts.length) + '</div><p>' + escapeHtml(counts.map((row) => row.feedback_type + ":" + row.count).join(" / ") || "暂无反馈") + '</p></article>' +
          '<article class="insight-card"><h3>召回修复队列</h3><div class="big">' + escapeHtml(repairs.reduce((sum, row) => sum + Number(row.count || 0), 0)) + '</div><p>false_null 等反馈会进入 repair queue。</p></article>';
      }
      const list = document.getElementById("feedback-loop-traces");
      if (list) {
        list.innerHTML = traces.length ? '<table class="data-table"><thead><tr><th>trace</th><th>查询</th><th>候选</th><th>反馈</th><th>标注</th></tr></thead><tbody>' +
          traces.slice(0, 20).map((trace) => {
            const memoryId = Array.isArray(trace.memory_ids) ? trace.memory_ids[0] : "";
            return '<tr><td>' + escapeHtml(trace.recall_trace_id) + '<br><span class="subtle">' + escapeHtml(trace.created_at) + '</span></td><td>' + escapeHtml(trace.query_excerpt || "-") + '</td><td>' + escapeHtml(memoryId || "-") + '</td><td>' + escapeHtml(trace.feedback_count || 0) + '</td><td><div class="feedback-buttons">' +
              ["used_in_context:有用","not_relevant:没用","false_positive:错了","outdated:过期","should_update:应更新","should_merge:应合并"].map((item) => {
                const parts = item.split(":");
                return '<button data-feedback-trace="' + escapeHtml(trace.recall_trace_id) + '" data-feedback-memory="' + escapeHtml(memoryId) + '" data-feedback-type="' + escapeHtml(parts[0]) + '">' + escapeHtml(parts[1]) + '</button>';
              }).join("") + '</div></td></tr>';
          }).join("") + '</tbody></table>' : '<div class="empty-state">暂无可标注 recall trace。</div>';
        list.querySelectorAll("button[data-feedback-trace]").forEach((button) => {
          button.addEventListener("click", async () => {
            const traceId = button.getAttribute("data-feedback-trace");
            const memoryId = button.getAttribute("data-feedback-memory");
            const feedbackType = button.getAttribute("data-feedback-type");
            const response = await fetch("/api/feedback/label", {
              method: "POST",
              headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
              body: JSON.stringify({ recall_trace_id: traceId, memory_id: memoryId, feedback_type: feedbackType, reason: "control_panel_manual_label" }),
            });
            if (!response.ok) throw new Error(await response.text());
            await loadFeedbackLoop();
          });
        });
      }
      const updated = document.getElementById("feedback-loop-updated");
      if (updated) updated.textContent = feedback?.generated_at ? "已刷新 " + feedback.generated_at : "暂无数据";
    }
    async function renderGraphOpsSummary() {
      const node = document.getElementById("graph-ops-summary");
      const detailsNode = document.getElementById("graph-ops-details");
      if (!node || !detailsNode) return;
      try {
        const [graphResponse, codeResponse] = await Promise.all([
          fetch("/api/graph/summary", { headers: { "x-panel-token": PANEL_TOKEN } }),
          fetch("/api/code-graph?root=" + encodeURIComponent(document.getElementById("code-root")?.value || ""), { headers: { "x-panel-token": PANEL_TOKEN } }),
        ]);
        const graph = graphResponse.ok ? await graphResponse.json() : {};
        const code = codeResponse.ok ? await codeResponse.json() : {};
        const codeSummary = code.summary || {};
        node.innerHTML =
          '<article class="insight-card"><h3>关系证据链</h3><div class="big">' + escapeHtml(graph.relation_count ?? graph.relations ?? "未知") + '</div><p>relation 必须包含 evidence、source path 和可重建 metadata。</p></article>' +
          '<article class="insight-card"><h3>Code Graph 项目</h3><div class="big">' + escapeHtml(codeSummary.code_graph_project_id || "current") + '</div><p>scope=' + escapeHtml(codeSummary.code_graph_scope || "project-level") + '</p></article>' +
          '<article class="insight-card"><h3>符号 / 边</h3><div class="big">' + escapeHtml((codeSummary.symbol_count ?? 0) + " / " + (codeSummary.edge_count ?? 0)) + '</div><p>每个项目独立生成，不写入 global。</p></article>';
        detailsNode.innerHTML = '<pre class="mini-pre">' + escapeHtml(JSON.stringify({ graph, code_summary: codeSummary }, null, 2)) + '</pre>';
        document.getElementById("graph-ops-updated").textContent = "已刷新 " + new Date().toISOString();
      } catch (error) {
        detailsNode.innerHTML = '<div class="empty-state">' + escapeHtml(String(error)) + '</div>';
      }
    }
    function renderOpsAutomation(ops) {
      const recommendations = Array.isArray(ops?.recommendations) ? ops.recommendations : [];
      const summary = document.getElementById("ops-automation-summary");
      if (summary) {
        summary.innerHTML =
          '<article class="insight-card"><h3>运维模式</h3><div class="big">' + escapeHtml(ops?.mode || "report_only") + '</div><p>借鉴 self-improvement，只生成建议和 gated plan，不自动执行高风险配置变更。</p></article>' +
          '<article class="insight-card"><h3>建议数量</h3><div class="big">' + escapeHtml(recommendations.length) + '</div><p>覆盖容量、候选积压、update apply、freeze 和门禁状态。</p></article>' +
          '<article class="insight-card"><h3>最新全量门禁</h3><div class="big">' + escapeHtml(ops?.latest_reports?.production_closure?.ok === true ? "通过" : "待复核") + '</div><p>production closure run_id=' + escapeHtml(ops?.latest_reports?.production_closure?.run_id || "暂无") + '</p></article>';
      }
      const plan = document.getElementById("ops-automation-plan");
      if (plan) plan.innerHTML = recommendations.length
        ? '<table class="data-table"><thead><tr><th>动作</th><th>风险</th><th>是否门禁</th><th>原因</th></tr></thead><tbody>' + recommendations.map((item) => '<tr><td>' + escapeHtml(item.action) + '</td><td>' + escapeHtml(item.severity || "info") + '</td><td>' + escapeHtml(item.gated ? "是" : "否") + '</td><td>' + escapeHtml(item.reason || "") + '</td></tr>').join("") + '</tbody></table>'
        : '<div class="empty-state">暂无运维建议。</div>';
      const updated = document.getElementById("ops-automation-updated");
      if (updated) updated.textContent = ops?.generated_at ? "已刷新 " + ops.generated_at : "report-only";
    }
    async function loadApprovalCapacity() {
      const response = await fetch("/api/auto-approval/limit-advice", { headers: { "x-panel-token": PANEL_TOKEN } });
      if (response.ok) renderApprovalCapacity((await response.json()).advice);
    }
    async function loadOpsAutomation() {
      const response = await fetch("/api/auto-approval/ops", { headers: { "x-panel-token": PANEL_TOKEN } });
      if (response.ok) {
        const ops = await response.json();
        renderAutoUpdateLab(ops);
        renderOpsAutomation(ops);
        if (ops.capacity) renderApprovalCapacity(ops.capacity);
      }
    }
    async function loadFeedbackLoop() {
      const response = await fetch("/api/feedback/recent?limit=30", { headers: { "x-panel-token": PANEL_TOKEN } });
      if (response.ok) renderFeedbackLoop(await response.json());
    }
    function renderSecurityAudit(report) {
      const findings = Array.isArray(report?.findings) ? report.findings : [];
      const summary = document.getElementById("security-summary");
      if (summary) {
        summary.innerHTML =
          '<article class="insight-card"><h3>审计状态</h3><div class="big">' + escapeHtml(report?.ok ? "通过" : "阻断") + '</div><p>repo-tracked 明文密钥会阻断迁移。</p></article>' +
          '<article class="insight-card"><h3>发现项</h3><div class="big">' + escapeHtml(findings.length) + '</div><p>tracked=' + escapeHtml(report?.tracked_secret_count || 0) + '，blocker=' + escapeHtml(report?.blocker_count || 0) + '</p></article>' +
          '<article class="insight-card"><h3>轮换清单</h3><div class="big">' + escapeHtml((report?.rotation_required || []).length || 0) + '</div><p>不自动轮换外部 provider key。</p></article>';
      }
      const table = document.getElementById("security-findings");
      if (table) table.innerHTML = findings.length
        ? '<table class="data-table"><thead><tr><th>文件</th><th>字段</th><th>风险</th><th>Git 跟踪</th><th>建议</th></tr></thead><tbody>' + findings.slice(0, 80).map((finding) =>
          '<tr><td>' + escapeHtml(finding.file) + ':' + escapeHtml(finding.line) + '</td><td>' + escapeHtml(finding.field) + '<br><span class="subtle">' + escapeHtml(finding.kind) + '</span></td><td>' + escapeHtml(finding.severity) + '</td><td>' + escapeHtml(finding.tracked ? "是" : "否") + '</td><td>' + escapeHtml(finding.recommendation) + '</td></tr>'
        ).join("") + '</tbody></table>'
        : '<div class="empty-state">未发现需要处理的明文密钥。</div>';
      const updated = document.getElementById("security-updated");
      if (updated) updated.textContent = report?.checked_at ? "已扫描 " + report.checked_at : "暂无扫描";
    }
    function renderPlatformDoctor(report) {
      const profiles = report?.profiles || {};
      const profileRows = Object.keys(profiles).map((key) => profiles[key]);
      const summary = document.getElementById("platform-summary");
      if (summary) {
        summary.innerHTML =
          '<article class="insight-card"><h3>当前系统</h3><div class="big">' + escapeHtml(report?.current_os || "unknown") + '</div><p>推荐 profile=' + escapeHtml(report?.recommended_profile || "-") + '</p></article>' +
          '<article class="insight-card"><h3>请求 profile</h3><div class="big">' + escapeHtml(report?.requested_profile || "-") + '</div><p>service manager=' + escapeHtml(report?.service_manager || "-") + '</p></article>' +
          '<article class="insight-card"><h3>可用 profile</h3><div class="big">' + escapeHtml(profileRows.filter((item) => item.available).length) + '</div><p>' + escapeHtml(profileRows.map((item) => item.profile + ":" + (item.available ? "ok" : "missing")).join(" / ")) + '</p></article>';
      }
      const components = Array.isArray(report?.components) ? report.components : [];
      const node = document.getElementById("platform-components");
      if (node) node.innerHTML = '<table class="data-table"><thead><tr><th>组件</th><th>状态</th><th>探针</th><th>详情</th></tr></thead><tbody>' +
        components.map((item) => '<tr><td>' + escapeHtml(item.label || item.name) + '</td><td>' + escapeHtml(item.status) + '</td><td>' + escapeHtml(item.probe_degraded ? "降级" : "正常") + '</td><td>' + escapeHtml(item.detail || "") + '</td></tr>').join("") +
        '</tbody></table>';
      const updated = document.getElementById("platform-updated");
      if (updated) updated.textContent = report?.checked_at ? "已检测 " + report.checked_at : "暂无检测";
    }
    function renderMigrationPreflight(report) {
      const checks = Array.isArray(report?.checks) ? report.checks : [];
      const summary = document.getElementById("migration-summary");
      if (summary) {
        summary.innerHTML =
          '<article class="insight-card"><h3>迁移状态</h3><div class="big">' + escapeHtml(report?.status || "unknown") + '</div><p>profile=' + escapeHtml(report?.profile || "-") + '</p></article>' +
          '<article class="insight-card"><h3>检查项</h3><div class="big">' + escapeHtml(checks.filter((item) => item.ok).length) + '/' + escapeHtml(checks.length) + '</div><p>critical 失败会阻断迁移。</p></article>' +
          '<article class="insight-card"><h3>手动步骤</h3><div class="big">' + escapeHtml((report?.manual_steps || []).length || 0) + '</div><p>' + escapeHtml((report?.manual_steps || []).slice(0, 2).join(" / ") || "暂无") + '</p></article>';
      }
      const node = document.getElementById("migration-checks");
      if (node) node.innerHTML = '<table class="data-table"><thead><tr><th>检查</th><th>结果</th><th>级别</th><th>详情</th></tr></thead><tbody>' +
        checks.map((item) => '<tr><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(item.ok ? "通过" : "失败") + '</td><td>' + escapeHtml(item.severity) + '</td><td>' + escapeHtml(item.detail) + '</td></tr>').join("") +
        '</tbody></table>';
      const updated = document.getElementById("migration-updated");
      if (updated) updated.textContent = report?.checked_at ? "已预检 " + report.checked_at : "暂无预检";
    }
    async function loadSecurityPlatformMigration() {
      const [security, platform, migration] = await Promise.allSettled([
        fetch("/api/runtime/secrets-audit", { headers: { "x-panel-token": PANEL_TOKEN } }),
        fetch("/api/runtime/platform?profile=wsl-windows-gpu", { headers: { "x-panel-token": PANEL_TOKEN } }),
        fetch("/api/runtime/deployment-preflight?profile=wsl-windows-gpu", { headers: { "x-panel-token": PANEL_TOKEN } }),
      ]);
      if (security.status === "fulfilled" && security.value.ok) renderSecurityAudit(await security.value.json());
      if (platform.status === "fulfilled" && platform.value.ok) renderPlatformDoctor(await platform.value.json());
      if (migration.status === "fulfilled" && migration.value.ok) renderMigrationPreflight(await migration.value.json());
    }
    function renderDatabaseMaintenance(maintenance) {
      const node = document.getElementById("database-maintenance");
      if (!maintenance || maintenance.error) {
        node.innerHTML = '<div class="detail-row"><strong>错误</strong>' + escapeHtml(maintenance?.error || "暂无数据") + '</div>';
        return;
      }
      const wal = maintenance.wal || {};
      const dead = Array.isArray(maintenance.top_dead_tuples) ? maintenance.top_dead_tuples : [];
      const options = maintenance.small_table_autovacuum || {};
      node.innerHTML =
        '<div class="summary" style="margin-bottom:12px">' +
        '<div class="metric"><div class="label">WAL 大小</div><div class="value">' + escapeHtml(wal.wal_size || "未知") + '</div></div>' +
        '<div class="metric"><div class="label">WAL 比例</div><div class="value">' + escapeHtml(wal.wal_ratio === null || wal.wal_ratio === undefined ? "n/a" : Math.round(Number(wal.wal_ratio) * 100) + "%") + '</div></div>' +
        '<div class="metric"><div class="label">自动清理目标</div><div class="value">' + escapeHtml((options.configured || []).length || 0) + '</div></div>' +
        '</div>' +
        '<table class="data-table"><thead><tr><th>表</th><th>活跃行</th><th>死元组</th><th>死元组比例</th><th>最近自动清理</th><th>参数</th></tr></thead><tbody>' +
        dead.map((row) => '<tr><td>' + escapeHtml(row.relname) + '</td><td>' + escapeHtml(row.n_live_tup) + '</td><td>' + escapeHtml(row.n_dead_tup) + '</td><td>' + escapeHtml(row.dead_pct) + '</td><td>' + escapeHtml(row.last_autovacuum || "-") + '</td><td>' + escapeHtml((row.reloptions || []).join(", ")) + '</td></tr>').join("") +
        '</tbody></table>';
      document.getElementById("database-updated").textContent = "已刷新 " + (maintenance.generated_at || "");
    }
    function serviceStateText(service) {
      const load = service.load_state || "未知";
      const active = service.active_state || "未知";
      const sub = service.sub_state || "未知";
      return load + " / " + active + " / " + sub;
    }
    function renderServices(services) {
      const grid = document.getElementById("service-grid");
      const list = Array.isArray(services) ? services : [];
      grid.innerHTML = list.map((service) => {
        const on = service.active === true;
        return '<div class="service-tile" data-unit="' + escapeHtml(service.unit) + '" data-runtime-control="' + (service.runtime_control ? "1" : "0") + '">' +
          '<div><div class="service-name">' + escapeHtml(service.label) + '</div><div class="service-desc">' + escapeHtml(service.description) + '</div></div>' +
          '<label class="switch ' + (on ? "on" : "") + '" title="' + escapeHtml(on ? "关闭" : "开启") + '">' +
          '<input type="checkbox" ' + (on ? "checked" : "") + ' aria-label="' + escapeHtml(service.label) + '" />' +
          '<span class="knob"></span></label>' +
          '<div class="service-state">' + escapeHtml(serviceStateText(service)) + (service.error ? " | " + escapeHtml(service.error) : "") + '</div>' +
          '</div>';
      }).join("");
      document.getElementById("services-updated").textContent = list.length ? "已加载 " + list.length + " 个服务" : "没有服务状态";
      grid.querySelectorAll(".service-tile").forEach((tile) => {
      const input = tile.querySelector("input");
      const unit = tile.getAttribute("data-unit");
      const runtimeControl = tile.getAttribute("data-runtime-control") === "1";
      input.addEventListener("change", async () => {
          await toggleService(unit, input.checked, tile, runtimeControl);
      });
    });
  }
    function componentChip(status) {
      if (status === "ok") return '<span class="chip ok">正常</span>';
      if (status === "blocked") return '<span class="chip bad">阻断</span>';
      if (status === "degraded") return '<span class="chip warn">降级</span>';
      return '<span class="chip info">未知</span>';
    }
    function renderComponentStatus(snapshot) {
      const components = Array.isArray(snapshot?.metrics?.component_statuses) ? snapshot.metrics.component_statuses : [];
      const cards = components.map((component) => {
        return '<article class="insight-card">' +
          '<h3>' + escapeHtml(component.label || component.name || "未知组件") + '</h3>' +
          '<div>' + componentChip(component.status) + '</div>' +
          '<p>' + escapeHtml(component.detail || "无详情") + '</p>' +
          '<p><span class="subtle">' + escapeHtml(component.source || "unknown") + '</span></p>' +
          (component.remediation ? '<p class="danger">' + escapeHtml(component.remediation) + '</p>' : '') +
        '</article>';
      }).join("");
      for (const id of ["component-status-grid", "component-status-page"]) {
        const node = document.getElementById(id);
        if (node) node.innerHTML = cards || '<div class="empty-state">暂无组件状态。</div>';
      }
      const updated = document.getElementById("component-status-updated");
      if (updated) updated.textContent = components.length ? "已加载 " + components.length + " 个组件" : "暂无状态";
    }
    function connectionRows(snapshot) {
      const direct = snapshot?.metrics?.client_connections?.connections;
      return Array.isArray(direct) ? direct : [];
    }
    function renderClientConnections(snapshot) {
      const rows = connectionRows(snapshot);
      const html = rows.length ? '<table class="data-table"><thead><tr><th>Agent</th><th>连接方式</th><th>入口/方法</th><th>最近状态</th><th>最近活跃</th></tr></thead><tbody>' +
        rows.slice(0, 40).map((row) => {
          const methods = Array.isArray(row.methods) ? row.methods.slice(0, 8).join(", ") : "-";
          const perms = Array.isArray(row.permissions) ? row.permissions.join(", ") : "";
          return '<tr>' +
            '<td><strong>' + escapeHtml(row.agent_id || "unknown") + '</strong><br><span class="subtle">' + escapeHtml(row.identity_source || "unknown") + '</span></td>' +
            '<td>' + escapeHtml(row.transport || "unknown") + '<br><span class="subtle">' + escapeHtml(row.user_agent || row.remote_address || "") + '</span></td>' +
            '<td>' + escapeHtml(row.endpoint || "-") + '<br><span class="subtle">' + escapeHtml(methods) + '</span></td>' +
            '<td>' + componentChip(Number(row.last_status || 0) >= 400 ? "blocked" : "ok") + '<br><span class="subtle">' + escapeHtml(perms || "无权限记录") + '</span></td>' +
            '<td>' + escapeHtml(row.last_seen_at || "-") + '<br><span class="subtle">请求 ' + escapeHtml(row.request_count || 0) + ' 次</span></td>' +
          '</tr>';
        }).join("") + '</tbody></table>' : '<div class="empty-state">还没有连接记录。MCP、HTTP API 或控制面板请求进入 wrapper 后会自动显示在这里。</div>';
      for (const id of ["client-connections-table", "client-connections-page"]) {
        const node = document.getElementById(id);
        if (node) node.innerHTML = html;
      }
      const updated = document.getElementById("client-connections-updated");
      if (updated) updated.textContent = rows.length ? "最近 " + rows.length + " 个连接身份" : "暂无连接";
    }
    function renderMcpToolInvocations(metrics) {
      const store = metrics && typeof metrics === "object" ? metrics : {};
      const tools = Array.isArray(store.tools) ? store.tools : [];
      const html = tools.length ? '<table class="data-table"><thead><tr><th>工具</th><th>调用</th><th>成功/失败</th><th>延迟</th><th>调用方</th><th>最近错误</th></tr></thead><tbody>' +
        tools.slice(0, 60).map((tool) => {
          const calls = Number(tool.call_count || 0);
          const failures = Number(tool.failure_count || 0);
          const success = Number(tool.success_count || 0);
          const avg = calls > 0 ? Math.round(Number(tool.latency_total_ms || 0) / calls) : 0;
          const agents = Array.isArray(tool.agents) ? tool.agents.slice(0, 8).join(", ") : "unknown-agent";
          return '<tr>' +
            '<td><strong>' + escapeHtml(tool.tool_name || "unknown_tool") + '</strong><br><span class="subtle">' + escapeHtml(tool.last_seen_at || "-") + '</span></td>' +
            '<td>' + escapeHtml(calls) + '</td>' +
            '<td><span class="chip ok">成功 ' + escapeHtml(success) + '</span> <span class="chip ' + (failures > 0 ? "bad" : "ok") + '">失败 ' + escapeHtml(failures) + '</span></td>' +
            '<td>平均 ' + escapeHtml(avg) + 'ms<br><span class="subtle">最近 ' + escapeHtml(tool.last_latency_ms || 0) + 'ms / 最大 ' + escapeHtml(tool.latency_max_ms || 0) + 'ms</span></td>' +
            '<td>' + escapeHtml(agents) + '</td>' +
            '<td>' + escapeHtml(tool.last_error || "-") + '</td>' +
          '</tr>';
        }).join("") + '</tbody></table>' : '<div class="empty-state">还没有 MCP tool 调用指标。通过 MCP 调用 memory-xx 工具后会自动显示调用次数、失败率、延迟和 agent。</div>';
      const node = document.getElementById("mcp-tools-page");
      if (node) node.innerHTML = html;
      const updated = document.getElementById("mcp-tools-updated");
      if (updated) updated.textContent = tools.length ? "已记录 " + tools.length + " 个 MCP 工具" : "暂无 MCP 工具调用";
    }
    async function toggleService(unit, enabled, tile, runtimeControl) {
      const switchNode = tile.querySelector(".switch");
      const input = tile.querySelector("input");
      switchNode.classList.add("busy");
      input.disabled = true;
      try {
        const response = await fetch(runtimeControl ? "/api/conversation/toggle" : "/api/services/toggle", {
          method: "POST",
          headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
          body: JSON.stringify({ unit, enabled }),
        });
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        const service = body.service || {};
        input.checked = service.active === true;
        switchNode.classList.toggle("on", input.checked);
        tile.querySelector(".service-state").textContent = serviceStateText(service);
        document.getElementById("services-updated").textContent = "已更新 " + (service.label || unit);
      } catch (error) {
        input.checked = !enabled;
        switchNode.classList.toggle("on", input.checked);
        document.getElementById("services-updated").textContent = "切换失败: " + String(error).slice(0, 160);
      } finally {
        input.disabled = false;
        switchNode.classList.remove("busy");
      }
    }
    function renderAutoApprovalControls(definitions) {
      const grid = document.getElementById("auto-approval-control-grid");
      const list = Array.isArray(definitions) ? definitions : [];
      grid.innerHTML = list.map((control) => {
        const on = control.active === true;
        const safety = control.safety || "guarded";
        return '<div class="service-tile" data-group="' + escapeHtml(control.group) + '" data-key="' + escapeHtml(control.key) + '">' +
          '<div><div class="service-name">' + escapeHtml(control.label) + '</div><div class="service-desc">' + escapeHtml(control.description) + '</div></div>' +
          '<label class="switch ' + (on ? "on" : "") + '" title="' + escapeHtml(on ? "关闭" : "开启") + '">' +
          '<input type="checkbox" ' + (on ? "checked" : "") + ' aria-label="' + escapeHtml(control.label) + '" />' +
          '<span class="knob"></span></label>' +
          '<div class="service-state">' + escapeHtml(control.group + "." + control.key + " · " + safetyLabel(safety)) + '</div>' +
          '</div>';
      }).join("");
      document.getElementById("auto-approval-controls-updated").textContent = list.length ? "已加载 " + list.length + " 个开关" : "没有自动审批开关";
      grid.querySelectorAll(".service-tile").forEach((tile) => {
        const input = tile.querySelector("input");
        const group = tile.getAttribute("data-group");
        const key = tile.getAttribute("data-key");
        input.addEventListener("change", async () => {
          await toggleAutoApprovalControl(group, key, input.checked, tile);
        });
      });
    }
    async function toggleAutoApprovalControl(group, key, enabled, tile) {
      const switchNode = tile.querySelector(".switch");
      const input = tile.querySelector("input");
      switchNode.classList.add("busy");
      input.disabled = true;
      try {
        const response = await fetch("/api/auto-approval/controls/toggle", {
          method: "POST",
          headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
          body: JSON.stringify({ group, key, enabled }),
        });
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        renderAutoApprovalControls(body.controls || []);
        document.getElementById("auto-approval-controls-updated").textContent = "已更新 " + group + "." + key;
      } catch (error) {
        input.checked = !enabled;
        switchNode.classList.toggle("on", input.checked);
        document.getElementById("auto-approval-controls-updated").textContent = "切换失败: " + String(error).slice(0, 160);
      } finally {
        input.disabled = false;
        switchNode.classList.remove("busy");
      }
    }
    function colorFor(type) {
      if (type === "entity") return 0x0f766e;
      if (type === "episode") return 0x7c3aed;
      if (type === "file") return 0x64748b;
      if (type === "symbol") return 0xd97706;
      if (type === "external") return 0xdc2626;
      if (type === "repository") return 0x22c55e;
      return 0x2563eb;
    }
    function nodeTypeLabel(type) {
      return ({ memory: "记忆", entity: "实体", episode: "片段", file: "文件", symbol: "符号", external: "外部包", repository: "仓库" })[type] || type || "未知";
    }
    function hash(value) {
      let h = 2166136261;
      for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
      return Math.abs(h >>> 0);
    }
    function positionFor(node, index, total) {
      const h = hash(node.id);
      const ring = node.type === "repository" ? 0 : node.type === "memory" || node.type === "file" ? 250 : node.type === "symbol" ? 330 : 410;
      if (ring === 0) return new THREE.Vector3(0, 0, 0);
      const theta = ((index / Math.max(1, total)) * Math.PI * 2) + (h % 360) * Math.PI / 180;
      const phi = Math.acos(2 * (((h % 997) + 1) / 998) - 1);
      return new THREE.Vector3(
        ring * Math.sin(phi) * Math.cos(theta),
        ring * Math.sin(phi) * Math.sin(theta),
        ring * Math.cos(phi)
      );
    }
    function makeLabel(text) {
      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 128;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "600 30px Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(String(text || "").slice(0, 30), 8, 64);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      sprite.scale.set(130, 32, 1);
      return sprite;
    }
    function clearGroup() {
      scene.remove(group);
      group.traverse((item) => {
        if (item.geometry) item.geometry.dispose();
        if (item.material) {
          if (item.material.map) item.material.map.dispose();
          item.material.dispose();
        }
      });
      group = new THREE.Group();
      scene.add(group);
      clickable = [];
    }
    function renderGraph(graph) {
      currentGraph = graph || { nodes: [], edges: [], summary: {} };
      clearGroup();
      const nodes = currentGraph.nodes || [];
      const edges = currentGraph.edges || [];
      empty.textContent = nodes.length ? "" : "没有匹配到图谱节点。";
      const positions = new Map();
      nodes.forEach((node, index) => positions.set(node.id, positionFor(node, index, nodes.length)));
      for (const edge of edges) {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (!a || !b) continue;
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const mat = new THREE.LineBasicMaterial({ color: edge.type?.includes("imports") ? 0x60a5fa : edge.type === "calls" ? 0xf59e0b : 0x94a3b8, transparent: true, opacity: Math.max(.28, Math.min(.9, Number(edge.weight || .5))) });
        const line = new THREE.Line(geo, mat);
        line.userData = { edge };
        group.add(line);
      }
      for (const node of nodes) {
        const p = positions.get(node.id) || new THREE.Vector3();
        const radius = node.type === "memory" || node.type === "file" ? 14 : node.type === "repository" ? 20 : 10;
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 24, 18),
          new THREE.MeshStandardMaterial({ color: colorFor(node.type), roughness: .48, metalness: .1 })
        );
        mesh.position.copy(p);
        mesh.userData = { node };
        group.add(mesh);
        clickable.push(mesh);
        const label = makeLabel(node.label);
        label.position.set(p.x + radius + 26, p.y + 8, p.z);
        group.add(label);
      }
      renderGraphSummary(currentGraph);
    }
    function renderGraphSummary(graph) {
      const summary = graph.summary || {};
      const rows = Object.entries(summary).filter(([, value]) => typeof value !== "object").slice(0, 12);
      document.getElementById("components").innerHTML = rows.map(([key, value]) => '<div class="component"><strong>' + escapeHtml(key) + '</strong><span class="pill">' + escapeHtml(value) + '</span></div>').join("");
      setMetric("m-graph", String((graph.nodes || []).length), "ok");
    }
    async function selectNode(node) {
      let more = null;
      if (node.type === "memory") {
        try {
          const response = await fetch("/api/graph/memory/" + encodeURIComponent(node.id.replace(/^memory:/, "")), { headers: { "x-panel-token": PANEL_TOKEN } });
          more = await response.json();
        } catch {}
      }
      details.innerHTML = '<h3>' + escapeHtml(node.label) + '</h3>' +
        '<div class="detail-row"><strong>类型</strong>' + escapeHtml(nodeTypeLabel(node.type)) + '</div>' +
        '<div class="detail-row"><strong>说明</strong>' + escapeHtml(node.subtitle) + '</div>' +
        '<div class="detail-row"><strong>分数</strong>' + escapeHtml(Number(node.score || 0).toFixed(3)) + '</div>' +
        '<div class="detail-row"><strong>元数据</strong><pre style="white-space:pre-wrap;margin:0">' + escapeHtml(JSON.stringify(node.metadata || {}, null, 2)) + '</pre></div>' +
        (more ? '<div class="detail-row"><strong>记忆图谱</strong><pre style="white-space:pre-wrap;margin:0">' + escapeHtml(JSON.stringify(more, null, 2)) + '</pre></div>' : "");
    }
    async function loadGraph(focusId) {
      running.textContent = "正在加载图谱";
      const params = new URLSearchParams();
      const kind = document.getElementById("graph-kind").value;
      params.set("query", document.getElementById("graph-query").value || "");
      params.set("limit", document.getElementById("graph-limit").value || "80");
      if (kind === "memory") {
        params.set("depth", document.getElementById("graph-depth").value || "1");
        params.set("scopeType", document.getElementById("graph-scope-type").value || "");
        params.set("scopeId", document.getElementById("graph-scope-id").value || "");
        if (focusId) params.set("focusId", focusId);
      } else {
        params.set("root", document.getElementById("code-root").value || "");
      }
      try {
        const path = kind === "code" ? "/api/code-graph" : "/api/graph/neighborhood";
        const response = await fetch(path + "?" + params.toString(), { headers: { "x-panel-token": PANEL_TOKEN } });
        renderGraph(await response.json());
      } catch (error) {
        empty.textContent = String(error);
      } finally {
        running.textContent = "";
      }
    }
    async function refresh() {
      try {
        const response = await fetch("/api/summary", { headers: { "x-panel-token": PANEL_TOKEN } });
        const summary = await response.json();
        const health = summary.wrapper_health || {};
        const embeddingProbe = summary.embedding_probe || null;
        const embeddingIssue = embeddingProbeIssue(embeddingProbe);
        const serviceStatus = health.service_status || health.status;
        const issue = primaryIssue(health);
        setMetric("m-overall", embeddingIssue ? "已阻断" : serviceStatus === "ok" ? "就绪" : serviceStatus === "repairing" ? "修复中" : serviceStatus === "blocked" ? "已阻断" : "可降级", embeddingIssue || serviceStatus !== "ok" ? "bad" : "ok");
        setMetric("m-cause", embeddingIssue || (issue ? issue.root_cause : (health.repair_summary?.status ? "最近修复 " + health.repair_summary.status : "无核心错误")), embeddingIssue || issue ? "bad" : "ok");
        setMetric("m-profile", health.runtime_profile || health.wrapper_mode || "未知", "ok");
        setMetric(
          "m-embedding-upstream",
          embeddingProbe ? (embeddingProbe.ok ? "OVMS 就绪" : (embeddingProbe.status ? "OVMS " + embeddingProbe.status : "OVMS 不可用")) : "未知",
          embeddingProbe?.ok ? "ok" : "bad"
        );
        setMetric("m-generation", health.embedding_generation?.active_generation?.generation_id || "未知", health.embedding_generation?.ok === false ? "bad" : "ok");
        renderServices(summary.service_controls);
        renderAutoApprovalControls(summary.auto_approval_control_definitions);
        renderSettings(summary.parameter_settings || {});
        renderDatabaseMaintenance(summary.database_maintenance || {});
        const registry = (summary.parameter_settings && summary.parameter_settings.registry) || [];
        const snapshot = summary.runtime_snapshot && !summary.runtime_snapshot.error ? summary.runtime_snapshot : {};
        renderComponentStatus(snapshot);
        renderClientConnections(snapshot);
        renderMcpToolInvocations(snapshot.metrics?.mcp_tool_invocations);
        renderRuntimeMap(snapshot);
        renderClosureReasons(snapshot);
        renderRuntimeCategory(registry, "worker", "runtime-workers");
        renderRuntimeCategory(registry, "cache", "runtime-cache");
        renderRuntimeCategory(registry, "write", "runtime-write");
        renderRuntimeCategory(registry, "recall", "runtime-recall");
        renderRuntimeCategory(registry, "qdrant", "runtime-qdrant");
        renderRuntimeCategory([...(registry || []).filter((item) => item.source === "restart_pending"), ...((snapshot.summary?.restart_plan?.pending) || [])], "", "runtime-audit");
        const historyResponse = await fetch("/api/runtime/history?window=24h", { headers: { "x-panel-token": PANEL_TOKEN } }).catch(() => null);
        if (historyResponse?.ok) {
          const history = await historyResponse.json();
          const historyNode = document.getElementById("runtime-history");
          if (historyNode) historyNode.innerHTML = '<div class="detail-row"><strong>24 小时快照</strong>' + escapeHtml(history.count || 0) + ' 条 · 最新=' + escapeHtml(history.snapshots?.[0]?.collected_at || "无") + '</div>';
        }
        await Promise.allSettled([loadApprovalCapacity(), loadOpsAutomation(), loadFeedbackLoop(), renderGraphOpsSummary(), loadSecurityPlatformMigration()]);
        document.getElementById("status-title").textContent = embeddingIssue ? "运行状态：已阻断" : serviceStatus === "ok" ? "运行状态：就绪" : "运行状态：" + (serviceStatus || "未知");
        document.getElementById("status-detail").textContent = embeddingIssue || (issue ? issue.root_cause : "核心服务、参数和数据库维护指标已加载。");
        document.getElementById("status-refresh").textContent = summary.generated_at || new Date().toISOString();
        document.getElementById("meta").textContent = "更新时间 " + (summary.generated_at || new Date().toISOString()) +
          " | 面板启动 " + (summary.panel_started_at || "未知") +
          " | 版本 " + (summary.git_commit || "未知") +
          " | 路由 " + ((summary.route_registry && summary.route_registry.count) || "?") +
          " | " + (summary.wrapper_url || "");
        await loadGraph();
      } catch (error) {
        setMetric("m-overall", "错误", "bad");
        empty.textContent = String(error);
      }
    }
    function resize() {
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(420, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    function pointerEvent(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }
    renderer.domElement.addEventListener("pointerdown", (event) => { dragging = true; moved = false; last = { x: event.clientX, y: event.clientY }; renderer.domElement.setPointerCapture(event.pointerId); });
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      group.rotation.y += dx * 0.006;
      group.rotation.x += dy * 0.004;
      last = { x: event.clientX, y: event.clientY };
    });
    renderer.domElement.addEventListener("pointerup", (event) => {
      dragging = false;
      if (moved) return;
      pointerEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      if (hit?.object?.userData?.node) selectNode(hit.object.userData.node);
    });
    renderer.domElement.addEventListener("dblclick", (event) => {
      pointerEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      const node = hit?.object?.userData?.node;
      if (node?.type === "memory") loadGraph(node.id);
    });
    renderer.domElement.addEventListener("wheel", (event) => {
      event.preventDefault();
      camera.position.z = Math.max(260, Math.min(1400, camera.position.z + (event.deltaY > 0 ? 55 : -55)));
    }, { passive: false });
    function animate() {
      requestAnimationFrame(animate);
      if (!dragging) group.rotation.y += 0.0014;
      renderer.render(scene, camera);
    }
    window.addEventListener("resize", resize);
    document.querySelectorAll(".navlink").forEach((button) => button.addEventListener("click", () => setActiveSection(button.dataset.section)));
    document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => {
      const target = button.getAttribute("data-jump");
      setActiveSection(target);
      if (target === "settings") document.getElementById("settings-search")?.focus();
    }));
    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("settings-search")?.addEventListener("input", () => renderSettings(latestSettings));
    document.getElementById("settings-category")?.addEventListener("change", () => renderSettings(latestSettings));
    document.getElementById("settings-safety")?.addEventListener("change", () => renderSettings(latestSettings));
    document.getElementById("settings-apply")?.addEventListener("click", async () => {
      if (dirtySettings.size === 0) return;
      const changes = Object.fromEntries(dirtySettings.entries());
      const previewResponse = await fetch("/api/settings/preview", {
        method: "POST",
        headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
        body: JSON.stringify({ changes }),
      });
      if (!previewResponse.ok) throw new Error(await previewResponse.text());
      const previewBody = await previewResponse.json();
      const preview = previewBody.preview || {};
      const feedback = document.getElementById("settings-feedback");
      if (feedback) feedback.textContent = "预览通过：" + (preview.changes?.length || dirtySettings.size) + " 项，需重启 " + (preview.restart_required_count || 0) + " 项，高风险 " + (preview.high_risk_count || 0) + " 项。";
      if (preview.high_risk_count > 0 && !confirm("包含 " + preview.high_risk_count + " 个高风险参数，确认保存？")) return;
      if (preview.restart_required_count > 0 && !confirm("包含 " + preview.restart_required_count + " 个需要重启的参数，将只写入待重启计划，确认保存？")) return;
      const response = await fetch("/api/settings/batch-update", {
        method: "POST",
        headers: { "content-type": "application/json", "x-panel-token": PANEL_TOKEN },
        body: JSON.stringify({ changes }),
      });
      if (!response.ok) throw new Error(await response.text());
      const body = await response.json();
      dirtySettings.clear();
      updateDirtyStatus();
      if (feedback) feedback.textContent = "批量保存完成。热更新项已写入运行时配置；需重启项已进入重启计划。";
      renderSettings(body.settings || {});
    });
    document.getElementById("graph-refresh").addEventListener("click", () => loadGraph());
    document.getElementById("graph-kind").addEventListener("change", () => loadGraph());
    document.getElementById("graph-query").addEventListener("keydown", (event) => { if (event.key === "Enter") loadGraph(); });
    resize();
    animate();
    refresh();
    setInterval(refresh, ${refreshIntervalMs});
  </script>
</body>
</html>`;
}

export function renderFlowsHtml(input: { readonly panelToken: string }): string {
  const { panelToken } = input;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>memory-xx 链路追踪</title>
  <style>
    :root{--bg:#d6e1ea;--surface:#edf3f8;--surface-2:#e3ecf4;--text:#182235;--muted:#667085;--line:#d7dee9;--ok:#108a4f;--wait:#b7791f;--bad:#c02626;--blue:#2563eb;--shadow:0 8px 22px rgba(15,23,42,.07)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,"Segoe UI",system-ui,sans-serif}header{position:sticky;top:0;z-index:2;background:rgba(237,243,248,.97);border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
    .topbar{max-width:1480px;margin:0 auto;padding:15px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}.nav{display:flex;gap:10px;align-items:center}.nav a,.nav button{border:1px solid var(--blue);border-radius:7px;min-height:38px;padding:8px 12px;background:var(--blue);color:#fff;text-decoration:none;font-weight:750;cursor:pointer}.nav a.secondary{background:#fff;color:var(--blue)}
    h1{margin:0;font-size:20px}.meta{font-size:13px;color:var(--muted);margin-top:3px}main{max-width:1480px;margin:0 auto;padding:18px 22px 32px;display:grid;gap:16px}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr) minmax(220px,1fr) auto;gap:10px;align-items:end;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px;box-shadow:var(--shadow)}
    label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:750}input,select{border:1px solid #b7c4d6;border-radius:7px;min-height:38px;padding:8px 10px;font:inherit;background:#f8fbfe}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);min-height:460px;overflow:hidden}.panel h2{margin:0;padding:13px 15px;border-bottom:1px solid var(--line);font-size:15px}.steps{display:grid;gap:9px;padding:13px}.step{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface)}.step-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.step-name{font-weight:800;font-size:13px}.status{border-radius:999px;padding:3px 8px;font-size:12px;font-weight:800}.complete{background:#dcfce7;color:var(--ok)}.waiting{background:#fef3c7;color:var(--wait)}.degraded{background:#ffedd5;color:#c2410c}.failed{background:#fee2e2;color:var(--bad)}.detail{font-size:12px;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}pre{margin:8px 0 0;max-height:210px;overflow:auto;background:#101827;color:#e5edf7;border-radius:7px;padding:9px;font-size:12px;line-height:1.45}.recent{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.list{background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}.list h3{font-size:14px;margin:0;padding:11px 13px;border-bottom:1px solid var(--line)}.ops-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:10px;border-bottom:1px solid var(--line);background:var(--surface-2)}.item{display:grid;gap:4px;border-top:1px solid var(--line);padding:10px 13px;cursor:pointer}.item:first-of-type{border-top:0}.item:hover{background:#e7f0fb}.item strong{font-size:13px}.item span{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
    @media(max-width:980px){.grid,.recent,.toolbar{grid-template-columns:1fr}.topbar{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <header><div class="topbar"><div><h1>写入 / 召回链路追踪</h1><div class="meta">左侧写入链路，右侧召回链路；数据来自现有审计表和 Qdrant 探测。</div></div><div class="nav"><a class="secondary" href="/">首页</a><button id="refresh">刷新</button></div></div></header>
  <main>
    <section class="toolbar">
      <label>记忆 ID <input id="memory-id" placeholder="memory_record id" /></label>
      <label>请求 ID <input id="request-id" placeholder="ingest request id" /></label>
      <label>召回追踪 ID <input id="trace-id" placeholder="recall trace id" /></label>
      <button id="load">加载链路</button>
    </section>
    <section class="recent">
      <div class="list"><h3>最近写入</h3><div id="recent-writes"></div></div>
      <div class="list"><h3>最近召回</h3><div id="recent-recalls"></div></div>
      <div class="list"><h3>自动审批</h3><div id="recent-auto-approval"></div></div>
      <div class="list"><h3>运维智能</h3><div class="ops-filters">
        <label>类型 <select id="ops-type"><option value="">全部</option><option value="learning">学习</option><option value="error">错误</option><option value="feature_request">功能需求</option><option value="ops_proposal">运维建议</option></select></label>
        <label>优先级 <select id="ops-priority"><option value="">全部</option><option value="critical">关键</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
        <label>状态 <select id="ops-status"><option value="">全部</option><option value="pending">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option><option value="promoted">已提升</option><option value="wont_fix">不处理</option></select></label>
      </div><div id="recent-ops"></div></div>
    </section>
    <section class="list"><h3>对话监听</h3><div id="conversation-monitor"></div></section>
    <section class="grid">
      <div class="panel"><h2>写入全过程</h2><div class="steps" id="write-steps"></div></div>
      <div class="panel"><h2>召回全过程</h2><div class="steps" id="recall-steps"></div></div>
    </section>
  </main>
  <script>
    const PANEL_TOKEN = ${JSON.stringify(panelToken)};
    const headers = { "x-panel-token": PANEL_TOKEN };
    const writeSteps = document.getElementById("write-steps");
    const recallSteps = document.getElementById("recall-steps");
    function pretty(value){ try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
    function renderSteps(node, steps){
      node.innerHTML = "";
      if (!Array.isArray(steps) || steps.length === 0) { node.innerHTML = '<div class="detail">暂无数据</div>'; return; }
      for (const step of steps) {
        const div = document.createElement("div");
        div.className = "step";
        const status = step.status || "waiting";
        div.innerHTML = '<div class="step-head"><div class="step-name"></div><span class="status '+status+'">'+status+'</span></div><div class="detail"></div>' + (step.data !== undefined ? "<pre></pre>" : "");
        div.querySelector(".step-name").textContent = step.name || "step";
        div.querySelector(".detail").textContent = step.detail || "";
        const pre = div.querySelector("pre");
        if (pre) pre.textContent = pretty(step.data);
        node.appendChild(div);
      }
    }
    function item(text, sub, onClick){
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = "<strong></strong><span></span>";
      div.querySelector("strong").textContent = text || "未知";
      div.querySelector("span").textContent = sub || "";
      div.addEventListener("click", onClick);
      return div;
    }
    function opsInfo(row){
      const si = row.self_improvement || {};
      const type = row.self_improvement_type || si.type || "legacy";
      const priority = row.self_improvement_priority || si.priority || "未知";
      const status = row.self_improvement_status || si.status || row.review_state;
      const recurrence = row.self_improvement_recurrence_count || si.recurrence_count || 1;
      const promoted = String(row.self_improvement_promotion_candidate || si.promotion_candidate || "false") === "true";
      return type + " · " + priority + " · " + status + " · recurrence " + recurrence + (promoted ? " · promotion candidate" : "");
    }
    async function showConversationBatch(batchId) {
      const body = await fetch("/api/conversation/batch?batchId=" + encodeURIComponent(batchId), { headers }).then(r => r.json());
      renderSteps(writeSteps, [
        { name: "conversation batch", status: body.batch ? "complete" : "waiting", detail: batchId, data: body.batch },
        { name: "source events", status: (body.events || []).length ? "complete" : "waiting", detail: String((body.events || []).length) + " events", data: body.events },
      ]);
    }
    async function showConversationSession(sessionId) {
      const body = await fetch("/api/conversation/session?sessionId=" + encodeURIComponent(sessionId), { headers }).then(r => r.json());
      renderSteps(writeSteps, [
        { name: "session events", status: (body.events || []).length ? "complete" : "waiting", detail: sessionId, data: body.events },
        { name: "session batches", status: (body.batches || []).length ? "complete" : "waiting", detail: String((body.batches || []).length) + " batches", data: body.batches },
        { name: "session candidates", status: (body.candidates || []).length ? "complete" : "waiting", detail: String((body.candidates || []).length) + " candidates", data: body.candidates },
      ]);
    }
    async function loadRecent(){
      const params = new URLSearchParams({ limit: "30" });
      const type = document.getElementById("ops-type").value;
      const priority = document.getElementById("ops-priority").value;
      const status = document.getElementById("ops-status").value;
      if (type) params.set("type", type);
      if (priority) params.set("priority", priority);
      if (status) params.set("status", status);
      const body = await fetch("/api/flows/recent?" + params.toString(), { headers }).then(r => r.json());
      const conversation = await fetch("/api/conversation/recent?limit=30", { headers }).then(r => r.json()).catch(error => ({ error: String(error) }));
      const writes = document.getElementById("recent-writes");
      const recalls = document.getElementById("recent-recalls");
      const ops = document.getElementById("recent-ops");
      const auto = document.getElementById("recent-auto-approval");
      const conv = document.getElementById("conversation-monitor");
      writes.innerHTML = ""; recalls.innerHTML = ""; auto.innerHTML = ""; ops.innerHTML = ""; conv.innerHTML = "";
      for (const row of body.writes || []) {
        writes.appendChild(item(row.title || row.memory_id, row.lifecycle_status + "/" + row.review_state + " · " + row.scope_type + ":" + row.scope_id, () => {
          document.getElementById("memory-id").value = row.memory_id; loadFlow();
        }));
      }
      for (const row of body.recalls || []) {
        recalls.appendChild(item(row.query_excerpt || row.trace_id, row.query_type + " · " + row.primary_backend + " · " + row.created_at, () => {
          document.getElementById("trace-id").value = row.trace_id; loadFlow();
        }));
      }
      for (const row of body.auto_approval || []) {
        const memoryId = row.approved_memory_id || row.candidate_memory_id || "";
        const blocked = Array.isArray(row.blocked_reasons) ? row.blocked_reasons.join(",") : "";
        auto.appendChild(item(row.decision + " · " + (row.scope_type || "") + ":" + (row.scope_id || ""), "score=" + row.score + " · " + (row.policy_version || "") + (row.rollback_memory_event_id ? " · rolled back" : "") + (blocked ? " · blocked=" + blocked : ""), () => {
          if (memoryId) { document.getElementById("memory-id").value = memoryId; loadFlow(); }
        }));
      }
      const autoSummary = body.auto_approval_summary || {};
      const canary = autoSummary.canary || {};
      const candidateOnly = autoSummary.candidate_only_flag || {};
      const healthBlockers = autoSummary.health_blockers || [];
      auto.prepend(item("governance summary", "approved24h=" + (autoSummary.approved_24h || 0) + " · blocked24h=" + (autoSummary.blocked_24h || 0) + " · rollback24h=" + (autoSummary.rollback_count_24h || 0) + " · healthBlockers=" + healthBlockers.length + " · candidateOnly=" + Boolean(candidateOnly.enabled), () => {
        renderSteps(writeSteps, [
          { name: "test-scope e2e compatibility config", status: canary.enabled ? "complete" : "waiting", detail: "legacy canary file; semantic path is test-scope E2E", data: canary },
          { name: "运行时热插拔开关", status: "complete", detail: "用户/全局/自动更新应用开关", data: autoSummary.runtime_controls || null },
          { name: "候选模式紧急开关", status: candidateOnly.enabled ? "degraded" : "complete", detail: "全局安全开关", data: candidateOnly },
          { name: "健康阻断项", status: (autoSummary.health_blockers || []).length ? "degraded" : "complete", detail: String((autoSummary.health_blockers || []).length) + " 个阻断项", data: { blockers: autoSummary.health_blockers || [], warnings: autoSummary.health_warnings || [], snapshots: autoSummary.latest_health_snapshots || [] } },
          { name: "feedback freeze metrics", status: (autoSummary.feedback_metrics || []).length ? "complete" : "waiting", detail: String((autoSummary.feedback_metrics || []).length) + " cohorts", data: autoSummary.feedback_metrics || [] },
          { name: "frozen cohorts", status: (autoSummary.frozen_cohorts || []).length ? "degraded" : "complete", detail: String((autoSummary.frozen_cohorts || []).length) + " frozen", data: autoSummary.frozen_cohorts || [] },
          { name: "latest random corpus", status: autoSummary.latest_random_corpus_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_random_corpus_report?.run_id || "no report", data: autoSummary.latest_random_corpus_report || null },
          { name: "latest scope matrix", status: autoSummary.latest_scope_matrix_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_scope_matrix_report?.run_id || "no report", data: autoSummary.latest_scope_matrix_report || null },
          { name: "latest privacy corpus", status: autoSummary.latest_privacy_corpus_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_privacy_corpus_report?.run_id || "no report", data: autoSummary.latest_privacy_corpus_report || null },
          { name: "latest temporal corpus", status: autoSummary.latest_temporal_corpus_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_temporal_corpus_report?.run_id || "no report", data: autoSummary.latest_temporal_corpus_report || null },
          { name: "latest auto-update dry-run", status: autoSummary.latest_auto_update_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_auto_update_report?.run_id || "no report", data: autoSummary.latest_auto_update_report || null },
          { name: "latest real project guarded update", status: autoSummary.latest_auto_update_real_project_guarded_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_auto_update_real_project_guarded_report?.run_id || "no report", data: autoSummary.latest_auto_update_real_project_guarded_report || null },
          { name: "latest production closure", status: autoSummary.latest_production_closure_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_production_closure_report?.run_id || "no report", data: autoSummary.latest_production_closure_report || null },
          { name: "latest test-scope e2e", status: autoSummary.latest_test_scope_e2e_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_test_scope_e2e_report?.run_id || "no report", data: autoSummary.latest_test_scope_e2e_report || null },
          { name: "latest canary e2e compatibility report", status: autoSummary.latest_canary_e2e_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_canary_e2e_report?.run_id || "no report", data: autoSummary.latest_canary_e2e_report || null },
          { name: "latest feedback freeze", status: autoSummary.latest_feedback_freeze_report?.ok ? "complete" : "waiting", detail: autoSummary.latest_feedback_freeze_report?.run_id || "no report", data: autoSummary.latest_feedback_freeze_report || null },
        ]);
      }));
      for (const row of body.ops_intelligence || []) {
        ops.appendChild(item(row.title || row.self_improvement?.summary || row.memory_id, opsInfo(row) + " · " + row.updated_at, () => {
          document.getElementById("memory-id").value = row.memory_id; loadFlow();
        }));
      }
      const controls = conversation.controls || {};
      const heartbeat = conversation.worker_heartbeat || {};
      conv.appendChild(item("开关状态", "monitor=" + Boolean(controls.conversation_monitor) + " · auto_extract=" + Boolean(controls.conversation_auto_extract), () => {}));
      conv.appendChild(item("后台任务心跳", (heartbeat.updated_at || "暂无心跳") + " · 阶段=" + (heartbeat.phase || "未知") + " · 正常=" + String(heartbeat.ok ?? false) + (heartbeat.last_error ? " · " + heartbeat.last_error : ""), () => {
        renderSteps(writeSteps, [{ name: "后台任务心跳", status: heartbeat.ok ? "complete" : "degraded", detail: heartbeat.updated_at || "", data: heartbeat }]);
      }));
      for (const row of conversation.sessions || []) {
        conv.appendChild(item("session " + (row.session_id || ""), row.conversation_id + " · events=" + row.event_count + " · pending=" + row.pending_event_count + " · batches=" + row.batch_count + " · candidates=" + row.candidate_count, () => {
          if (row.session_id) showConversationSession(row.session_id);
        }));
      }
      for (const row of conversation.batches || []) {
        conv.appendChild(item("batch " + row.id, row.status + " · " + (row.mem0_mode || row.extraction_backend || "pending") + " · candidates=" + ((row.candidate_memory_ids || []).length || 0) + " · noop=" + ((row.no_op_reasons || []).join?.(",") || ""), () => showConversationBatch(row.id)));
      }
      for (const row of conversation.events || []) {
        conv.appendChild(item(row.role + " turn " + row.turn_id, row.conversation_id + "/" + (row.session_id || "") + " · " + (row.processed_at ? "processed" : "pending") + " · " + row.content_preview, () => {}));
      }
    }
    async function loadFlow(){
      const memoryId = document.getElementById("memory-id").value.trim();
      const requestId = document.getElementById("request-id").value.trim();
      const traceId = document.getElementById("trace-id").value.trim();
      if (memoryId || requestId) {
        const qs = new URLSearchParams();
        if (memoryId) qs.set("memoryId", memoryId);
        if (requestId) qs.set("requestId", requestId);
        const body = await fetch("/api/flows/write?" + qs, { headers }).then(r => r.json());
        renderSteps(writeSteps, body.steps);
      }
      if (traceId) {
        const body = await fetch("/api/flows/recall?traceId=" + encodeURIComponent(traceId), { headers }).then(r => r.json());
        renderSteps(recallSteps, body.steps);
      }
    }
    document.getElementById("load").addEventListener("click", loadFlow);
    document.getElementById("refresh").addEventListener("click", () => { loadRecent(); loadFlow(); });
    document.getElementById("ops-type").addEventListener("change", loadRecent);
    document.getElementById("ops-priority").addEventListener("change", loadRecent);
    document.getElementById("ops-status").addEventListener("change", loadRecent);
    loadRecent();
  </script>
</body>
</html>`;
}
