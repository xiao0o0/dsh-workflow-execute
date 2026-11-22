/**
 * dsh-workflow-execute — Browser half（工作流管理）。
 *
 * 三个挂载面：
 * - 侧栏入口行（DOM 注入「新会话」下方，与任务看板同一家族块；滚动数字 = 我的 | 内置）。
 * - 主页面：中栏接管视图（taskboard 同款，容器挂会话列末尾、html[data-dswfe-active] 驱动开合，
 *   盖会话列不盖侧栏；列表+详情/编辑器工作台；Esc / 点会话行 / 与其他面板互斥时关闭）。
 * - 兜底：会话列缺席的退化壳层下，开面板 450ms 后容器强制挂 body 退回全屏浮层。
 *
 * 数据流：EventSource /dsh-workflow-execute/events 变更帧 → 全量 refetch + revision 追赶
 * （taskboard S16 同款）；编辑走 baseHash 乐观锁，409 给「重新加载 / 仍然覆盖」。
 *
 * React 是 loader 平台模块；plain Node（契约测试）下降级为最小 shim。
 */

let __React = null
try { __React = require('react') } catch {}
if (!__React || typeof __React.createElement !== 'function') {
  __React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true) }
    },
    useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
    useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
  }
}
const { createElement: h, useState, useEffect, useMemo, useRef, useCallback } = __React
const useLayoutEffect = __React.useLayoutEffect || useEffect // React shim 兜底

const CLIENT_NAME = 'dsh-workflow-execute'
// API 基址随页面走：子路径反代（如 https://host/app/dsh/）下，绝对路径 /dsh-workflow-execute
// 会打到站点根而 404。与宿主官方客户端一致，用 document.baseURI 推导（dsh-sync#14 同款）。
const API = (() => {
  try {
    const base = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : '/')
    return new URL('dsh-workflow-execute', new URL('.', base)).pathname.replace(/\/+$/, '')
  } catch { return '/dsh-workflow-execute' }
})()
const NS = 'dshProcess'
const PANEL_NAME = 'dsh-workflow-execute'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const ENTRY_ATTR = 'data-dswfe-entry'
// 中栏接管（taskboard 同款）开合属性 + 兄弟面板属性表
const PRC_ACTIVE_ATTR = 'data-dswfe-active'
const PRC_OTHER_ACTIVE_ATTRS = ['data-dsh-atb-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active', 'data-dsh-git-active', 'data-dsh-kb-active']
const PRC_SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="newSession"]'
// 侧栏整列：点「文档管理/插件/记忆系统」这类导航项也要退出中栏接管，否则 html[data-dswfe-active]
// 会把壳层渲染在中栏的其他视图一起隐藏，看起来像切不回去。
const PRC_SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
const PREFS_KEY = 'dswfe:prefs'

// ── i18n ─────────────────────────────────────────────────────────────────

const ZH = {
  title: '工作流',
  entryAria: '打开工作流',
  entryTitle: '工作流 — 我的 {user} · 内置 {bundled}',
  count: '我的 {user} · 内置 {bundled}',
  searchPlaceholder: '搜索名称 / 描述…',
  filterAll: '全部来源', filterUser: '我的', filterBundled: '内置',
  categoryAll: '全部分类', complexityAll: '全部复杂度',
  sortDefault: '按名称', sortUpdated: '按更新时间', sortComplexity: '按复杂度', sortLinks: '按环节数',
  newTask: '新建', newBlank: '空白工作流', newFromExisting: '复制现有…',
  importBtn: '导入', exportBtn: '导出', exportAll: '全部（zip）', exportUser: '我的库（zip）', exportOne: '本工作流（yaml）',
  settingsBtn: '设置', aiBtn: 'AI 生成',
  close: '关闭', cancel: '取消', save: '保存', confirm: '确认', delete: '删除', edit: '编辑', copy: '复制', rename: '重命名',
  copyToMine: '复制到我的库', reload: '重新加载', overwrite: '仍然覆盖', discard: '放弃修改', keepEditing: '继续编辑',
  tabOverview: '概览', tabStructure: '结构', tabYaml: 'YAML',
  loading: '加载中…', emptyList: '没有匹配的工作流', emptyListHint: '试试清空筛选，或「新建 / 导入」一个工作流',
  emptyDetail: '从左侧选择一个工作流', selectFirst: '左侧选择工作流后在这里看概览、结构与 YAML',
  errOne: '处错误', warnOne: '处警告',
  readOnly: '内置 · 只读', mine: '我的', bundled: '内置',
  limits: '限额', steps: '环节执行上限', tokens: 'token 上限', unlimited: '不限',
  abnormal: '异常触发', phases: '阶段', links: '环节',
  diagnostics: '诊断', noIssues: '结构正常 · 没有发现错误或警告',
  name: '名称', displayName: '显示名', guid: 'GUID', version: '版本', category: '分类', complexity: '复杂度',
  prompt: '指令 prompt', executor: '执行器', expert: '专家', skills: '技能', model: '模型',
  artifacts: '期望产物', gates: '门禁', flow: '流转', rework: '返工上限', acceptance: '验收标准', reviewPrompt: '复核提示词', reviewType: '复核方式',
  onSuccess: '成功后', onGateFail: '门禁不过', onRatingFail: '评级不过',
  flowNext: '下一环节', flowEnd: '结束', flowBreak: '中止（询问用户）',
  flowBreakStop: '中止（停下问我）', flowJumpTo: '跳到「环节{no} · {name}」',
  editorTitle: '编辑', editorCreate: '新建工作流', editorCopy: '复制工作流',
  unsaved: '未保存', saved: '已保存', validating: '校验中…',
  saveConflict: '文件已被外部修改（可能是其他编辑器）。', forcedHint: '覆盖将丢弃外部改动。',
  dirtyGuard: '有未保存的修改，确定放弃吗？',
  deleteConfirm: '删除后移入回收站（.trash），确定删除',
  createName: '工作流名（文件名，不含 .yaml）', createDir: '子目录（可选，如 software）', createDisplayName: '显示名（可选）',
  copyName: '新工作流名', importTitle: '导入工作流', importHint: '选择或拖入 .yaml / .yml（可多选），导入到我的库',
  importOverwrite: '覆盖同名文件', importPick: '选择文件', importResults: '导入结果',
  importCreated: '已导入', importOverwritten: '已覆盖', importExists: '同名已存在（未导入）', importInvalid: '校验未通过',
  settingsTitle: '工作流库设置', settingsUserRoot: '我的库根目录', settingsBundledRoot: '内置库根目录（只读）',
  settingsMaxDepth: '扫描深度', settingsSaved: '设置已保存，正在重扫',
  renameTitle: '重命名显示名', newName: '新显示名', renameHint: '只改界面显示的名称，文件名与标识不变',
  aiTitle: 'AI 生成工作流', aiHint: '描述要解决的需求，AI 会产出一版工作流 YAML；生成后可校验并写入我的库',
  aiRequirement: '要做什么（需求描述）', aiComplexity: '复杂度（低 / 中 / 高）', aiReference: '参考工作流（可选）',
  aiPreviewTitle: '生成结果预览', aiSaveName: '写入名称', aiSave: '写入我的库', aiParseFail: '输出里没有找到 YAML 代码块',
  copied: '已复制', copyYaml: '复制 YAML',
  openSession: '打开会话', aiRunning: '生成中…', aiDone: '生成完成',
  openLib: '打开工作流库', settingsSectionHint: '工作流 = 多阶段 agent 工作流模板；此处配置工作流库根目录。',
  validate: '校验', linesCount: '{n} 行',
  validateOk: '校验通过：0 错误 0 警告', validateResult: '校验完成：{e} 个错误 · {w} 个警告',
  toastSaved: '已保存', toastForceSaved: '已覆盖保存', toastCopied: '已复制到我的库', toastRenamed: '已重命名',
  toastTrashed: '已移入回收站（.trash）', toastImported: '{n} 个工作流已导入', toastAiSaved: '已写入我的库',
  copyPrompt: '复制 Prompt', aiOutput: '输出', aiFailed: '失败', aiRequirementPh: '例如：把口头需求整理成 PRD 并拆解成开发任务',
  kitMissing: 'dsh-plugin-kit 未内联（构建问题）', nameRule: '名称不能为空、不能含 / 或 \\、不能以点开头',
  sessionUnavailable: '当前页面拿不到会话服务，无法跳转',
  atAgent: '给 agent', atAgentTitle: '@ 进对话框，让 agent 帮你修改这个工作流（输入你的修改要求后发送）',
  atAgentBundledTitle: '@ 进对话框（内置只读，agent 会改完存成你的新工作流）',
  atAgentBundledHint: '（这是内置只读工作流——请改完用 workflow_save 存成我的库里的新工作流）',
  atInserted: '已 @ 进对话框：输入你的修改要求后发送', atCopied: '没找到输入框，已复制引用到剪贴板',
  viewLib: '工作流', viewExec: '执行记录',
  runCreate: '▶ 按工作流执行', runWorkspace: '工作区（可选）', runStarted: '运行已发起',
  workspaceDefault: '默认（不绑定）',
  statusQueued: '排队中', statusRunning: '运行中', statusPaused: '已暂停', statusAwaiting: '等待裁决', statusAwaitingReview: '等待人工审核',
  statusDone: '已完成', statusStopped: '已停止', statusFailed: '失败',
  pause: '暂停', resume: '继续', stopRun: '停止运行', stopConfirm: '停止后当前环节结果作废，确定停止？',
  noRuns: '还没有运行记录', noRunsHint: '到「工作流」打开一个工作流，点「▶ 按工作流执行」发起一次运行',
  emptyRun: '左侧选择一次运行查看看板',
  runLoadFailed: '运行详情加载失败',
  retryLoad: '重试',
  progress: '{done}/{total} 环节', attemptN: '第 {n} 次尝试', reworkN: '返工 ×{n}',
  usageTitle: '输入 {input} · 输出 {output} · {calls} 次调用（含门禁评审）', usageTotal: 'Token',
  artifactsTitle: '产物', artifactMissing: '未生成',
  artifactsNone: '还没有观察到文件写入：执行中用 write / edit / str-replace-editor 改动的文件会出现在这里',
  fileViewTitle: '产物预览', fileBinary: '二进制文件，暂不支持预览', fileTruncated: '文件较大，仅显示前 {size}，完整内容请在工作区打开',
  viewFiles: '查看输出物', linkFilesTitle: '环节产物', diffLabel: '变更', contentLabel: '内容', noFiles: '本环节没有声明产物，也没有观察到文件写入', pickFile: '选择左侧文件后在这里查看内容',
  gateLabel: '门禁', gateScore: '{score} 分（线 {min}）',
  openSession: '打开会话', outputLabel: '实时输出', retryLink: '从本环节重新运行', skipLink: '跳过本环节',
  breakTitle: '门禁未过，等待你的裁决', decisionRetry: '重试本环节', decisionSkip: '跳过本环节', decisionStop: '中止运行',
  humanReviewTitle: '人工审核，等待你的验收', decisionApprove: '审核通过，继续下一步', decisionReject: '打回重做',
  gateReasonLabel: '评审理由', linkAwaitingReviewHint: '该环节已执行完毕，请查看产物与执行报告后裁决',
  linkPending: '待跑', linkDone: '完成', linkRunning: '进行中', linkGateFailed: '门禁未过', linkSkipped: '跳过', linkFailed: '失败', linkAbandoned: '中断', linkAwaitingReview: '待人工审核', linkApproved: '审核通过', linkRejected: '打回重做',
  currentStep: '当前', runError: '运行异常',
  runUserInput: '需求 / 要处理的问题（必填，只注入第一个环节）', runUserInputPh: '例如：把「XX」这条口头需求整理成 PRD 并拆解任务',
  formMode: '画布', yamlMode: 'YAML', formUnparseable: '当前 YAML 有语法错误，请切到 YAML 模式修复后再用画布',
  canvasHint: '点击节点在右侧编辑属性；点空白处看工作流属性', canvasEmpty: '还没有任何阶段，点「＋ 添加阶段」开始',
  propGlobal: '工作流属性', propPhase: '阶段属性', propLink: '环节属性',
  canvasDelPhase: '删除阶段「{name}」及其下 {n} 个环节？', canvasDelLink: '删除环节「{name}」？',
  formProvider: '供应商', modelDefault: '（默认）', modelProvDefault: '（供应商默认）',
  skillsPick: '点选技能…', skillsNone: '无可用技能', skillsClear: '清空已选（{n}）',
  formBasic: '基本信息', formLimits: '限额', formPhases: '阶段', formAddPhase: '+ 添加阶段', formAddLink: '+ 添加环节',
  formDelPhase: '删除阶段', formDelLink: '删除环节', formAddGate: '+ 添加门禁', formGateName: '门禁名（如 证据齐全）', formGateMin: '分数线',
  formName: '环节名', formGates: '门禁', formGateType: '门禁类型', formGateArtifact: '产物名',
  formSkillsPh: '技能1, 技能2',
  formDisplayName: '显示名', formVersion: '版本', formCategory: '分类', formComplexity: '复杂度', formDescription: '描述',
  cxLow: '低', cxMid: '中', cxHigh: '高',
  formMaxSteps: '环节执行上限（空=不限）', formMaxTokens: 'token 上限（空=不限）', formPrompt: '指令 prompt',
  formAcceptance: '验收标准', formPhaseName: '阶段名', formPhaseSpec: '阶段说明', formExecutor: '执行器', formExpert: '专家',
  formModel: '模型', formReviewType: '复核方式', formMaxRework: '返工上限', formOnSuccess: '成功后',
  formOnGateFail: '门禁不过', formOnRatingFail: '评级不过', formNewLinkName: '新环节',
  tabFlow: '流程图',
  flowGate: '门禁 ≥{min}', flowRework: '返工≤{n}', flowNoGate: '无门禁',
  flowLegendForward: '正常流转', flowLegendJump: '跳转', flowLegendFail: '门禁未过回跳', flowLegendBreak: '中止（不连线）',
  flowRunCurrent: '当前环节', flowRunDone: '已完成', flowRunGateFailed: '门禁未过', flowRunSkipped: '跳过', flowRunFailed: '失败',
  flowNoParsed: '工作流无法解析，无法绘制流程图',
  flowReviewAi: 'AI评审', flowReviewHuman: '人工评审', flowReviewNone: '无需评审',
  flowScore: '得分：{score}',
  flowStartLabel: '开始', flowEndLabel: '结束',
  linkNo: '环节{n}', phaseNo: '阶段{n}',
  execAI: 'AI 评审', execHuman: '人工评审', execNone: '无需评审',
  reviewAi: 'AI 评审', reviewHuman: '人工评审', reviewNone: '无需评审',
  overviewTitle: '概述', overviewEmpty: '这个工作流还没有环节',
  helpReviewType: '环节由谁判定是否通过：AI = 评审会话按门禁分数自动判定；人工 = 执行完停下等人审核；无需 = 直接进入下一环节。',
  helpPrompt: '发给执行会话的指令正文。写清要做什么、产物写到哪个文件、执行报告要写什么。',
  helpAcceptance: '本环节的验收标准，门禁评审时按它打分。',
  helpGates: '门禁是一组评审规则：评审分数低于分数线即判不通过，按「门禁不过」流转。',
  helpGateMin: '门禁分数线（0-100）。评审分数达到该值才算通过。',
  helpCanvas: '点击节点在右侧编辑属性；点空白处看工作流属性。',
  helpSessionMode: '多会话：每个环节开一个新会话，门禁单独开会话，上下文互不干扰。单会话：整条流程共用一个会话（门禁也在其中），省 token 但上下文会累积。',
  sessionMode: '对话模式', sessionMulti: '多会话（每环节一个）', sessionSingle: '单会话（全流程一个）', requestLabel: '需求',
  startedAt: '开始', endedAt: '结束', durationTotal: '总耗时', tokenLabel: 'TOKEN',
  durationUnknown: '—',
  viewArtifacts: '查看输出物', deleteRun: '删除', deleteRunConfirm: '删除这条运行记录？',
}

const EN = {
  title: 'Workflows', entryAria: 'Open workflow library', entryTitle: 'Workflows — mine {user} · bundled {bundled}',
  count: 'mine {user} · bundled {bundled}', searchPlaceholder: 'Search name / description…',
  filterAll: 'All sources', filterUser: 'Mine', filterBundled: 'Bundled',
  categoryAll: 'All categories', complexityAll: 'All complexities',
  sortDefault: 'By name', sortUpdated: 'By updated', sortComplexity: 'By complexity', sortLinks: 'By links',
  newTask: 'New', newBlank: 'Blank workflow', newFromExisting: 'Duplicate existing…',
  importBtn: 'Import', exportBtn: 'Export', exportAll: 'All (zip)', exportUser: 'Mine (zip)', exportOne: 'This one (yaml)',
  settingsBtn: 'Settings', aiBtn: 'AI generate',
  close: 'Close', cancel: 'Cancel', save: 'Save', confirm: 'OK', delete: 'Delete', edit: 'Edit', copy: 'Duplicate', rename: 'Rename',
  copyToMine: 'Copy to my library', reload: 'Reload', overwrite: 'Overwrite anyway', discard: 'Discard', keepEditing: 'Keep editing',
  tabOverview: 'Overview', tabStructure: 'Structure', tabYaml: 'YAML',
  loading: 'Loading…', emptyList: 'No matching workflows', emptyListHint: 'Try clearing filters, or create / import one',
  emptyDetail: 'Pick a workflow on the left', selectFirst: 'Overview, structure and YAML show up here after you select one',
  errOne: ' error(s)', warnOne: ' warning(s)',
  readOnly: 'Bundled · read-only', mine: 'Mine', bundled: 'Bundled',
  limits: 'Limits', steps: 'max step runs', tokens: 'max tokens', unlimited: 'unlimited',
  abnormal: 'Abnormal trigger', phases: 'phases', links: 'links',
  diagnostics: 'Diagnostics', noIssues: 'Structure looks fine · no errors or warnings',
  name: 'Name', displayName: 'Display name', guid: 'GUID', version: 'Version', category: 'Category', complexity: 'Complexity',
  prompt: 'Prompt', executor: 'Executor', expert: 'Expert', skills: 'Skills', model: 'Model',
  artifacts: 'Expected artifacts', gates: 'Gates', flow: 'Flow', rework: 'Max rework', acceptance: 'Acceptance', reviewPrompt: 'Review prompt', reviewType: 'Review',
  onSuccess: 'On success', onGateFail: 'On gate fail', onRatingFail: 'On rating fail',
  flowNext: 'next link', flowEnd: 'end', flowBreak: 'break (ask user)',
  flowBreakStop: 'break (stop and ask me)', flowJumpTo: 'Jump to link {no} · {name}',
  editorTitle: 'Edit', editorCreate: 'New workflow', editorCopy: 'Duplicate workflow',
  unsaved: 'Unsaved', saved: 'Saved', validating: 'Validating…',
  saveConflict: 'The file was changed externally (another editor).', forcedHint: 'Overwriting discards those changes.',
  dirtyGuard: 'Discard unsaved changes?',
  deleteConfirm: 'Delete moves the file into .trash. Delete',
  createName: 'Workflow name (file name, no .yaml)', createDir: 'Sub-directory (optional, e.g. software)', createDisplayName: 'Display name (optional)',
  copyName: 'New workflow name', importTitle: 'Import workflows', importHint: 'Pick or drop .yaml / .yml files (multi-select) into MY library',
  importOverwrite: 'Overwrite existing files', importPick: 'Choose files', importResults: 'Results',
  importCreated: 'imported', importOverwritten: 'overwritten', importExists: 'skipped (exists)', importInvalid: 'invalid',
  settingsTitle: 'Workflow library settings', settingsUserRoot: 'My library root', settingsBundledRoot: 'Bundled library root (read-only)',
  settingsMaxDepth: 'Scan depth', settingsSaved: 'Settings saved; rescanning',
  renameTitle: 'Rename display name', newName: 'New display name', renameHint: 'Only the shown name changes; file name and id stay.',
  aiTitle: 'AI generate workflow', aiHint: 'Describe the need; AI drafts a workflow YAML you can validate and save into MY library',
  aiRequirement: 'What should it do', aiComplexity: 'Complexity (low / medium / high)', aiReference: 'Reference workflow (optional)',
  aiPreviewTitle: 'Generated preview', aiSaveName: 'Save as', aiSave: 'Save to my library', aiParseFail: 'No YAML code block found in the output',
  copied: 'Copied', copyYaml: 'Copy YAML',
  openSession: 'Open chat', aiRunning: 'Generating…', aiDone: 'Generated',
  openLib: 'Open workflow library', settingsSectionHint: 'A workflow is a multi-phase agent workflow template; configure library roots here.',
  validate: 'Validate', linesCount: '{n} lines',
  validateOk: 'Validated: 0 errors, 0 warnings', validateResult: 'Validated: {e} errors · {w} warnings',
  toastSaved: 'Saved', toastForceSaved: 'Overwritten and saved', toastCopied: 'Copied to my library', toastRenamed: 'Renamed',
  toastTrashed: 'Moved to .trash', toastImported: '{n} workflow(es) imported', toastAiSaved: 'Saved to my library',
  copyPrompt: 'Copy prompt', aiOutput: 'Output', aiFailed: 'Failed', aiRequirementPh: 'e.g. turn a verbal requirement into a PRD and split it into dev tasks',
  kitMissing: 'dsh-plugin-kit not inlined (build issue)', nameRule: 'Name must be non-empty, without / or \\, and not start with a dot',
  sessionUnavailable: 'Session service unavailable on this page',
  atAgent: 'Ask agent', atAgentTitle: '@-reference into the composer and let an agent modify this workflow',
  atAgentBundledTitle: '@-reference (bundled is read-only; the agent will save a new workflow into your library)',
  atAgentBundledHint: '(this is a read-only bundled workflow — save your edited version as a new workflow in MY library via workflow_save)',
  atInserted: '@-referenced in the composer: type your change request and send', atCopied: 'Composer not found — reference copied to clipboard',
  viewLib: 'Library', viewExec: 'Runs',
  runCreate: '▶ Run workflow', runWorkspace: 'Workspace (optional)', runStarted: 'Run started',
  workspaceDefault: 'Default (unbound)',
  statusQueued: 'Queued', statusRunning: 'Running', statusPaused: 'Paused', statusAwaiting: 'Awaiting decision', statusAwaitingReview: 'Awaiting manual review',
  statusDone: 'Done', statusStopped: 'Stopped', statusFailed: 'Failed',
  pause: 'Pause', resume: 'Resume', stopRun: 'Stop run', stopConfirm: 'The running link result will be discarded. Stop?',
  noRuns: 'No runs yet', noRunsHint: 'Open a workflow in "Library" and click "▶ Run workflow"',
  emptyRun: 'Pick a run on the left to see its board',
  runLoadFailed: 'Failed to load this run',
  retryLoad: 'Retry',
  progress: '{done}/{total} links', attemptN: 'attempt {n}', reworkN: 'rework ×{n}',
  usageTitle: 'in {input} · out {output} · {calls} calls (incl. gate review)', usageTotal: 'Tokens',
  artifactsTitle: 'Artifacts', artifactMissing: 'missing',
  artifactsNone: 'No file writes observed: files changed via write / edit / str-replace-editor during execution appear here',
  fileViewTitle: 'Artifact preview', fileBinary: 'Binary file — preview not supported', fileTruncated: 'File is large; showing the first {size}. Open it in the workspace for the full content.',
  viewFiles: 'Artifacts', linkFilesTitle: 'Link artifacts', diffLabel: 'Diff', contentLabel: 'Content', noFiles: 'No artifacts declared or observed for this link', pickFile: 'Pick a file on the left to see its content',
  gateLabel: 'Gate', gateScore: '{score} (min {min})',
  openSession: 'Open chat', outputLabel: 'Live output', retryLink: 'Rerun from this link', skipLink: 'Skip link',
  breakTitle: 'Gate failed — awaiting your decision', decisionRetry: 'Retry this link', decisionSkip: 'Skip this link', decisionStop: 'Stop run',
  humanReviewTitle: 'Manual review — awaiting your approval', decisionApprove: 'Approve and continue', decisionReject: 'Reject and redo',
  gateReasonLabel: 'Reason', linkAwaitingReviewHint: 'This link finished; check the artifacts and report, then decide',
  linkPending: 'pending', linkDone: 'done', linkRunning: 'running', linkGateFailed: 'gate failed', linkSkipped: 'skipped', linkFailed: 'failed', linkAbandoned: 'abandoned', linkAwaitingReview: 'awaiting review', linkApproved: 'approved', linkRejected: 'rejected',
  currentStep: 'current', runError: 'run error',
  runUserInput: 'Requirement / what to work on (required, injected into the first link only)', runUserInputPh: 'e.g. turn requirement XX into a PRD and split tasks',
  formMode: 'Canvas', yamlMode: 'YAML', formUnparseable: 'YAML has syntax errors — fix them in YAML mode before using the canvas',
  canvasHint: 'Click a node to edit its properties on the right; click empty space for workflow properties', canvasEmpty: 'No phases yet — click "+ Add phase" to start',
  propGlobal: 'Workflow properties', propPhase: 'Phase properties', propLink: 'Link properties',
  canvasDelPhase: 'Delete phase "{name}" and its {n} link(s)?', canvasDelLink: 'Delete link "{name}"?',
  formProvider: 'Provider', modelDefault: '(default)', modelProvDefault: '(provider default)',
  skillsPick: 'Pick skills…', skillsNone: 'No skills available', skillsClear: 'Clear selection ({n})',
  formBasic: 'Basics', formLimits: 'Limits', formPhases: 'Phases', formAddPhase: '+ Add phase', formAddLink: '+ Add link',
  formDelPhase: 'Delete phase', formDelLink: 'Delete link', formAddGate: '+ Add gate', formGateName: 'Gate name (e.g. evidence provided)', formGateMin: 'Min score',
  formName: 'Link name', formGates: 'Gates', formGateType: 'Gate type', formGateArtifact: 'Artifact',
  formSkillsPh: 'skill1, skill2',
  formDisplayName: 'Display name', formVersion: 'Version', formCategory: 'Category', formComplexity: 'Complexity', formDescription: 'Description',
  cxLow: 'Low', cxMid: 'Medium', cxHigh: 'High',
  formMaxSteps: 'Max step runs (empty = unlimited)', formMaxTokens: 'Max tokens (empty = unlimited)', formPrompt: 'Prompt',
  formAcceptance: 'Acceptance', formPhaseName: 'Phase name', formPhaseSpec: 'Phase spec', formExecutor: 'Executor', formExpert: 'Expert',
  formModel: 'Model', formReviewType: 'Review', formMaxRework: 'Max rework', formOnSuccess: 'On success',
  formOnGateFail: 'On gate fail', formOnRatingFail: 'On rating fail', formNewLinkName: 'New link',
  tabFlow: 'Flow',
  flowGate: 'gate ≥{min}', flowRework: 'rework≤{n}', flowNoGate: 'no gate',
  flowLegendForward: 'forward', flowLegendJump: 'jump', flowLegendFail: 'gate-fail back', flowLegendBreak: 'break (no edge)',
  flowRunCurrent: 'current', flowRunDone: 'done', flowRunGateFailed: 'gate failed', flowRunSkipped: 'skipped', flowRunFailed: 'failed',
  flowNoParsed: 'Workflow cannot be parsed — cannot draw flow',
  flowReviewAi: 'AI', flowReviewHuman: 'Human', flowReviewNone: 'No review',
  flowScore: 'Score: {score}',
  flowStartLabel: 'Start', flowEndLabel: 'End',
  linkNo: 'Link {n}', phaseNo: 'Phase {n}',
  execAI: 'AI review', execHuman: 'Human review', execNone: 'No review',
  reviewAi: 'AI review', reviewHuman: 'Human review', reviewNone: 'No review',
  overviewTitle: 'Overview', overviewEmpty: 'This workflow has no links yet',
  helpReviewType: 'Who decides whether the link passed: AI = a review session scores against the gate; Human = execution pauses for your approval; None = continue directly.',
  helpPrompt: 'The instruction sent to the execution session. State what to do, which file to write, and what the report must contain.',
  helpAcceptance: 'Acceptance criteria for this link; the gate review scores against it.',
  helpGates: 'A gate is a review rule: a score below the threshold means failed, and the flow follows "on gate fail".',
  helpGateMin: 'Gate threshold (0-100). The review score must reach it to pass.',
  helpCanvas: 'Click a node to edit its properties on the right; click empty space for workflow properties.',
  helpSessionMode: 'Multi-session: one fresh session per link, gates get their own session, contexts stay isolated. Single-session: the whole run shares one session (gates included) — fewer tokens, but context accumulates.',
  sessionMode: 'Conversation mode', sessionMulti: 'Multi-session (one per link)', sessionSingle: 'Single-session (one for the run)', requestLabel: 'Request',
  startedAt: 'Start', endedAt: 'End', durationTotal: 'Total', tokenLabel: 'TOKEN',
  durationUnknown: '—',
  viewArtifacts: 'Artifacts', deleteRun: 'Delete', deleteRunConfirm: 'Delete this run record?',
}

function makeT(bound) {
  return (key, vars) => {
    let out = (bound && bound(key)) || EN[key] || ZH[key] || key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
    return out
  }
}

// ── 样式 ─────────────────────────────────────────────────────────────────

const STYLE = `
.dswfe-entry { display:flex; align-items:center; gap:8px; position:relative; width:calc(100% - 8px); margin:2px 4px; padding:6px 10px; border:none; border-radius:8px; background:transparent; color:var(--dsw-text-secondary, inherit); font:inherit; font-size:13px; cursor:pointer; text-align:left; }
.dswfe-entry:hover { background:var(--dsw-hover, rgba(128,128,128,.12)); color:var(--dsw-text-primary, inherit); }
.dswfe-entry[data-active="true"] { background:var(--dsw-active, rgba(128,128,128,.18)); color:var(--dsw-text-primary, inherit); font-weight:500; }
.dswfe-entry svg { flex:none; }
.dswfe-entry-stats { margin-left:auto; display:inline-flex; align-items:center; gap:3px; font-size:11px; line-height:1; color:var(--dsw-text-secondary, gray); font-variant-numeric:tabular-nums; white-space:nowrap; }
.dswfe-entry-sep { opacity:.5; }
.dswfe-roll { position:relative; display:inline-block; overflow:hidden; height:12px; min-width:1ch; text-align:center; vertical-align:middle; }
.dswfe-roll[data-stat="user"] { color:#3e63dd; }
.dswfe-roll[data-stat="bundled"] { color:#8e8e93; }
.dswfe-rn { display:block; height:12px; line-height:12px; text-align:center; }
.dswfe-rn-next { position:absolute; left:0; right:0; top:100%; }
.dswfe-roll[data-dir="down"] .dswfe-rn-next { top:auto; bottom:100%; }
.dswfe-roll .dswfe-rn { transition:transform .3s cubic-bezier(.25,.1,.25,1); }
.dswfe-roll[data-anim="1"][data-dir="up"] .dswfe-rn { transform:translateY(-100%); }
.dswfe-roll[data-anim="1"][data-dir="down"] .dswfe-rn { transform:translateY(100%); }
@media (prefers-reduced-motion: reduce) { .dswfe-roll .dswfe-rn { transition:none; } }
[data-sidebar-collapsed] [data-dswfe-entry], [class*="_collapsed"] [data-dswfe-entry] { width:36px; height:36px; min-width:36px; margin:0 0 12px; padding:0; justify-content:center; gap:0; text-align:center; }
[data-sidebar-collapsed] [data-dswfe-entry] .dswfe-entry-label, [data-sidebar-collapsed] [data-dswfe-entry] .dswfe-entry-stats,
[class*="_collapsed"] [data-dswfe-entry] .dswfe-entry-label, [class*="_collapsed"] [data-dswfe-entry] .dswfe-entry-stats { display:none; }

/* 中栏接管视图（taskboard 同款）：容器挂进会话列末尾，html 属性驱动开合，只隐藏列内兄弟。
 * 三代壳层选择器：dev shell data-pane / 官方 CSS-Module centerCol / Desktop 扩展框。 */
.dswfe-view { display:none; }
html[data-dswfe-active] [data-pane="conversation"] > *:not([data-dswfe-view]),
html[data-dswfe-active] [class*="centerCol"] > *:not([data-dswfe-view]),
html[data-dswfe-active] .dshDesktopConversationSurface > *:not([data-dswfe-view]) { display:none !important; }
html[data-dswfe-active] .dswfe-view { display:flex; flex-direction:column; height:100%; overflow:hidden; }
/* 壳层退化（会话列缺席）：容器兜底挂 body 时退回全屏浮层，保证入口点击永远有响应 */
.dswfe-view[data-dswfe-fallback] { position:fixed; inset:0; z-index:2147483000; display:flex; }
.dswfe-panel { position:relative; flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; pointer-events:auto; background:var(--dsw-alias-bg-base, var(--dsw-bg, #fff)); color:var(--dsw-alias-label-primary, var(--dsw-text-primary, inherit)); font:var(--dsw-font-family, inherit); font-size:13px; }
.dswfe-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background:var(--dsw-alias-bg-layer-1, transparent); }
.dswfe-title { font-size:15px; font-weight:600; margin:0; }
.dswfe-count { font-size:12px; color:var(--dsw-text-secondary, gray); }
.dswfe-spacer { flex:1; }
.dswfe-btn { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background:transparent; color:inherit; border-radius:8px; padding:5px 10px; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.dswfe-btn:hover { background:var(--dsw-hover, rgba(128,128,128,.12)); }
.dswfe-btn[data-primary="true"] { background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); border-color:transparent; color:var(--dsw-alias-label-primary-inverted, #fff); }
.dswfe-btn[data-danger="true"] { color:var(--dsw-alias-state-error, #c75050); border-color:var(--dsw-alias-state-error, #c75050); }
.dswfe-btn:disabled { opacity:.5; cursor:default; }
.dswfe-input, .dswfe-select { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)) !important; background:var(--dsw-alias-bg-layer-2, transparent); color:inherit; border-radius:8px; padding:5px 8px; font:inherit; font-size:13px; }
.dswfe-input:focus, .dswfe-select:focus, .dswfe-textarea:focus { border-color:var(--dsw-alias-accent, rgba(77,107,254,.85)) !important; outline:2px solid rgba(77,107,254,.35); outline-offset:1px; }
.dswfe-search { width:170px; }
.dswfe-body { flex:1; display:flex; min-height:0; }
.dswfe-list { width:300px; min-width:240px; overflow-y:auto; border-right:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); padding:6px; box-sizing:border-box; }
.dswfe-group { margin:8px 2px 4px; font-size:11px; color:var(--dsw-text-secondary, gray); display:flex; align-items:center; gap:6px; }
.dswfe-row { display:flex; flex-direction:column; gap:3px; width:100%; text-align:left; border:1px solid transparent; border-left-width:3px; border-radius:8px; background:transparent; color:inherit; padding:7px 9px; margin:2px 0; cursor:pointer; font:inherit; font-size:13px; position:relative; box-sizing:border-box; }
.dswfe-row:hover { background:var(--dsw-hover, rgba(128,128,128,.1)); }
.dswfe-row[data-selected="true"] { background:var(--dsw-active, rgba(128,128,128,.16)); border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.3)); }
.dswfe-row[data-source="bundled"] { border-left-style:dashed; }
.dswfe-row[data-complexity="low"] { border-left-color:#3e63dd; }
.dswfe-row[data-complexity="medium"] { border-left-color:#8e8e93; }
.dswfe-row[data-complexity="high"] { border-left-color:#8e4ec6; }
.dswfe-row-name { font-weight:500; display:flex; align-items:center; gap:6px; min-width:0; }
.dswfe-row-name span.lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-row-meta { display:flex; gap:6px; align-items:center; font-size:11px; color:var(--dsw-text-secondary, gray); flex-wrap:wrap; }
.dswfe-badge { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:6px; padding:0 5px; font-size:10px; line-height:16px; white-space:nowrap; }
.dswfe-badge[data-kind="err"] { color:var(--dsw-alias-state-error, #c75050); border-color:var(--dsw-alias-state-error, #c75050); }
.dswfe-badge[data-kind="warn"] { color:#b8860b; border-color:#b8860b; }
.dswfe-dot { width:6px; height:6px; border-radius:6px; display:inline-block; }
.dswfe-dot[data-kind="err"] { background:var(--dsw-alias-state-error, #c75050); }
.dswfe-dot[data-kind="warn"] { background:#d9a514; }
.dswfe-detail { flex:1; min-width:0; overflow-y:auto; padding:14px 18px; box-sizing:border-box; }
.dswfe-detail-head { display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.dswfe-detail-title { font-size:17px; font-weight:700; margin:0; letter-spacing:-.01em; }
.dswfe-chips { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0 14px; }
.dswfe-chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:999px; padding:2px 10px; font-size:11px; line-height:18px; white-space:nowrap; color:var(--dsw-text-secondary, gray); font-variant-numeric:tabular-nums; background:var(--dsw-alias-bg-layer-2, transparent); }
.dswfe-actions { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
.dswfe-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); margin-bottom:12px; }
.dswfe-tab { border:none; background:transparent; color:var(--dsw-text-secondary, inherit); padding:7px 12px; font:inherit; font-size:13px; cursor:pointer; border-bottom:2px solid transparent; }
.dswfe-tab[data-on="true"] { color:var(--dsw-text-primary, inherit); font-weight:600; border-bottom-color:var(--dsw-alias-brand-primary, currentColor); }
.dswfe-desc { white-space:pre-wrap; line-height:1.65; margin:0 0 12px; }
.dswfe-kv { display:flex; gap:8px; font-size:12px; margin:3px 0; flex-wrap:wrap; }
.dswfe-kv b { opacity:.7; font-weight:500; }
.dswfe-diag { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:8px; padding:8px 10px; margin:6px 0; display:flex; flex-direction:column; gap:4px; }
.dswfe-diag-item { display:flex; gap:8px; align-items:baseline; cursor:pointer; font-size:12px; border:none; background:transparent; color:inherit; padding:2px 4px; border-radius:6px; text-align:left; font:inherit; width:100%; box-sizing:border-box; }
.dswfe-diag-item:hover { background:var(--dsw-hover, rgba(128,128,128,.1)); }
.dswfe-diag-item[data-kind="err"] .dswfe-diag-code { color:var(--dsw-alias-state-error, #c75050); }
.dswfe-diag-item[data-kind="warn"] .dswfe-diag-code { color:#b8860b; }
.dswfe-diag-code { font-weight:600; flex:none; }
.dswfe-diag-line { opacity:.6; flex:none; min-width:34px; }
.dswfe-phase { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:11px; padding:12px 14px; margin:10px 0; }
.dswfe-phase-head { display:flex; align-items:baseline; gap:8px; font-weight:700; font-size:13px; }
.dswfe-phase-spec { white-space:pre-wrap; font-size:12px; opacity:.8; margin:6px 0; }
.dswfe-link { border-top:1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.2)); margin-top:6px; padding-top:6px; }
.dswfe-link-row { display:flex; align-items:baseline; gap:8px; width:100%; border:none; background:transparent; color:inherit; font:inherit; font-size:13px; cursor:pointer; padding:4px 2px; border-radius:6px; text-align:left; box-sizing:border-box; }
.dswfe-link-row:hover { background:var(--dsw-hover, rgba(128,128,128,.1)); }
.dswfe-link-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; opacity:.75; flex:none; }
.dswfe-link-meta { font-size:11px; color:var(--dsw-text-secondary, gray); margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
.dswfe-link-body { padding:6px 8px 2px; display:flex; flex-direction:column; gap:6px; }
.dswfe-pre { white-space:pre-wrap; line-height:1.6; font-size:12px; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.07)); border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius:8px; padding:8px 10px; margin:0; overflow-x:auto; }
.dswfe-code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.55; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:10px; overflow:auto; max-height:calc(100vh - 260px); background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
.dswfe-code-line { display:flex; }
.dswfe-code-line[data-hl="true"] { background:rgba(217,130,43,.18); }
.dswfe-code-no { flex:none; width:44px; text-align:right; padding-right:10px; color:var(--dsw-text-secondary, gray); user-select:none; opacity:.7; }
.dswfe-code-tx { white-space:pre; padding-right:16px; }
.dswfe-cm { color:var(--dsw-text-secondary, gray); font-style:italic; }
.dswfe-key { color:#3e63dd; }
.dswfe-editor { display:flex; flex-direction:column; gap:8px; flex:1; min-height:0; }
.dswfe-editor-wrap { display:flex; flex:1; min-height:0; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
.dswfe-gutter { flex:none; width:46px; text-align:right; padding:8px 10px 8px 0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:19px; color:var(--dsw-text-secondary, gray); overflow:hidden; user-select:none; opacity:.7; box-sizing:border-box; }
.dswfe-textarea { flex:1; border:none; outline:none; resize:none; background:transparent; color:inherit; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:19px; padding:8px 12px; white-space:pre; overflow:auto; tab-size:2; }
.dswfe-status { display:flex; gap:10px; align-items:center; font-size:12px; color:var(--dsw-text-secondary, gray); flex-wrap:wrap; }
.dswfe-conflict { border:1px solid var(--dsw-alias-state-error, #c75050); border-radius:8px; padding:8px 10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; }
.dswfe-modal-backdrop { position:fixed; inset:0; z-index:2147482900; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; }
html[data-windows-titlebar] .dswfe-modal-backdrop { top:var(--dsh-windows-titlebar-height, 38px); }
html[data-windows-titlebar][data-fullscreen] .dswfe-modal-backdrop { top:0; }
.dswfe-modal { width:min(560px, 92vw); max-height:86vh; overflow:auto; background:var(--dsw-alias-bg-layer-1, #fff); color:var(--dsw-alias-label-primary, inherit); border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:14px; padding:18px; display:flex; flex-direction:column; gap:12px; font:var(--dsw-font-family, inherit); }
.dswfe-modal h3 { margin:0; font-size:16px; }
.dswfe-field { display:flex; flex-direction:column; gap:6px; font-size:12px; }
.dswfe-field input, .dswfe-field select, .dswfe-field textarea { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background:var(--dsw-alias-bg-layer-2, transparent); color:inherit; border-radius:8px; padding:6px 10px; font:inherit; font-size:13px; }
.dswfe-field textarea { resize:vertical; min-height:52px; width:100%; box-sizing:border-box; line-height:1.5; }
.dswfe-menuback { position:fixed; inset:0; z-index:2147482800; }
.dswfe-menu { position:fixed; z-index:2147482850; background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #252830)); color:var(--dsw-alias-label-primary, inherit); border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:10px; padding:4px; display:flex; flex-direction:column; min-width:150px; box-shadow:0 8px 30px rgba(0,0,0,.25); }
.dswfe-menu button { border:none; background:transparent; color:inherit; text-align:left; padding:7px 10px; border-radius:7px; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.dswfe-menu button:hover { background:var(--dsw-hover, rgba(128,128,128,.15)); }
.dswfe-toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); z-index:2147483000; background:var(--dsw-alias-bg-overlay, #252830); color:var(--dsw-alias-label-primary, #fff); border-radius:10px; padding:8px 14px; font-size:13px; box-shadow:0 6px 24px rgba(0,0,0,.3); max-width:70vw; }
.dswfe-toast[data-kind="err"] { outline:1px solid var(--dsw-alias-state-error, #c75050); }
.dswfe-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--dsw-text-secondary, gray); text-align:center; padding:20px; }
.dswfe-error { margin:8px 14px 0; border:1px solid var(--dsw-alias-state-error, #c75050); color:var(--dsw-alias-state-error, #c75050); border-radius:8px; padding:6px 10px; font-size:12px; }
.dswfe-drop { border:2px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius:10px; padding:22px; text-align:center; font-size:12px; color:var(--dsw-text-secondary, gray); }
.dswfe-drop[data-over="true"] { border-color:var(--dsw-alias-brand-primary, #3e63dd); }
.dswfe-sec { margin:10px 0; }
.dswfe-sec h4 { margin:0 0 8px; font-size:12.5px; font-weight:700; letter-spacing:.04em; color:var(--dsw-alias-label-secondary, inherit); }

.dswfe-runlist { width:296px; min-width:230px; overflow-y:auto; border-right:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); padding:8px; box-sizing:border-box; }
.dswfe-runrow { display:flex; flex-direction:column; gap:4px; width:100%; text-align:left; border:1px solid transparent; border-radius:9px; background:transparent; color:inherit; padding:9px 10px; margin:3px 0; cursor:pointer; font:inherit; font-size:12px; box-sizing:border-box; }
.dswfe-runrow:hover { background:var(--dsw-hover, rgba(128,128,128,.1)); }
.dswfe-runrow[data-selected="true"] { background:var(--dsw-active, rgba(128,128,128,.16)); border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.3)); }
.dswfe-runrow-top { display:flex; align-items:center; gap:6px; min-width:0; }
.dswfe-runrow-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.dswfe-runrow-meta { display:flex; flex-wrap:wrap; gap:8px; color:var(--dsw-text-secondary, gray); font-size:11px; font-variant-numeric:tabular-nums; }
.dswfe-runrow-req { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-text-secondary, gray); font-size:11px; line-height:1.5; opacity:.9; }
.dswfe-runrow[data-selected="true"] .dswfe-runrow-req { opacity:1; }
.dswfe-rundel { opacity:0; transition:opacity .12s; }
.dswfe-runrow:hover .dswfe-rundel, .dswfe-runrow:focus-within .dswfe-rundel { opacity:1; }
.dswfe-linkdur { flex:none; font-size:11px; opacity:.8; font-variant-numeric:tabular-nums; margin-left:6px; padding-left:8px; border-left:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
.dswfe-help { position:relative; display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; margin-left:6px; border-radius:50%; border:1px solid currentColor; opacity:.45; font-size:9.5px; line-height:1; cursor:help; vertical-align:middle; user-select:none; flex:none; }
.dswfe-help:hover, .dswfe-help:focus-visible { opacity:.9; }
.dswfe-tip { position:fixed; z-index:2147483100; padding:8px 10px; border-radius:9px; background:#000 !important; background-color:#000 !important; color:#fff !important; border:1px solid rgba(255,255,255,.16); font-size:12px; line-height:18px; font-weight:400; text-align:left; white-space:normal; word-break:break-word; box-shadow:0 10px 28px rgba(0,0,0,.35); pointer-events:none; }
.dswfe-field-label { display:inline-flex; align-items:center; margin:10px 0 0; font-size:11px; opacity:.75; }
.dswfe-check { display:flex; flex-direction:row; align-items:center; gap:6px; font-size:12px; }
.dswfe-check input { margin:0; }
.dswfe-outline { display:flex; flex-direction:column; gap:2px; }
.dswfe-ovphase { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px; font-weight:600; }
.dswfe-ovlink { display:flex; align-items:center; gap:8px; padding:2px 0 2px 10px; font-size:12.5px; }
.dswfe-ovno { flex:none; min-width:52px; color:var(--dsw-text-secondary, gray); font-variant-numeric:tabular-nums; }
.dswfe-ovname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-ovkind { flex:none; margin-left:auto; font-size:11px; color:var(--dsw-text-secondary, gray); font-variant-numeric:tabular-nums; }
.dswfe-ovno { flex:none; min-width:56px; opacity:.6; font-size:11px; }
.dswfe-ovname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-ovkind { flex:none; margin-left:auto; font-size:11px; color:var(--dsw-text-secondary, gray); font-variant-numeric:tabular-nums; }
.dswfe-artgroup { margin-bottom:4px; }
.dswfe-artrow { display:flex; gap:8px; align-items:center; width:100%; text-align:left; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius:8px; background:transparent; color:inherit; padding:6px 10px; margin:3px 0; cursor:pointer; font:inherit; font-size:12px; box-sizing:border-box; }
.dswfe-artrow:hover { background:var(--dsw-hover, rgba(128,128,128,.1)); border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.35)); }
.dswfe-artrow[data-selected="true"] { background:var(--dsw-active, rgba(128,128,128,.16)); border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.35)); }
.dswfe-mini[data-active="true"] { background:var(--dsw-active, rgba(128,128,128,.16)); }
.dswfe-pill { border-radius:999px; padding:2px 9px; font-size:10.5px; line-height:15px; white-space:nowrap; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); }
.dswfe-pill[data-status="running"] { color:#d9822b; border-color:#d9822b; }
.dswfe-pill[data-status="queued"] { color:#3e63dd; border-color:#3e63dd; }
.dswfe-pill[data-status="awaiting"] { color:#c75050; border-color:#c75050; }
.dswfe-pill[data-status="paused"] { color:#b8860b; border-color:#b8860b; }
.dswfe-pill[data-status="done"] { color:#2e9e5b; border-color:#2e9e5b; }
.dswfe-pill[data-status="stopped"] { color:var(--dsw-text-secondary, gray); }
.dswfe-pill[data-status="failed"] { color:var(--dsw-alias-state-error, #c75050); border-color:var(--dsw-alias-state-error, #c75050); }
.dswfe-board { flex:1; min-width:0; overflow-y:auto; padding:16px 20px; box-sizing:border-box; }
.dswfe-runhead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.dswfe-break { border:1px solid var(--dsw-alias-state-error, #c75050); border-radius:10px; padding:10px 12px; margin:8px 0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dswfe-linkcard { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:9px; padding:9px 11px; margin:6px 0; display:flex; flex-direction:column; gap:6px; }
.dswfe-linkcard[data-state="running"] { border-color:#d9822b; }
.dswfe-linkcard[data-state="done"] { opacity:.82; }
.dswfe-linkcard[data-state="gate_failed"] { border-color:var(--dsw-alias-state-error, #c75050); }
.dswfe-linktop { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dswfe-linktop .grow { flex:1; }
.dswfe-mini { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background:transparent; color:inherit; border-radius:6px; padding:2px 7px; font:inherit; font-size:11px; cursor:pointer; white-space:nowrap; }
.dswfe-mini:hover { background:var(--dsw-hover, rgba(128,128,128,.12)); }
.dswfe-tail { max-height:180px; overflow:auto; margin:0; }
.dswfe-flowwrap { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:10px; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); overflow:auto; max-height:min(64vh, 640px); }
.dswfe-flowlegend { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--dsw-text-secondary, gray); margin:6px 2px 10px; align-items:center; }
.dswfe-flowlegend .sw { display:inline-block; width:26px; height:0; border-top:2px solid; margin-right:5px; vertical-align:middle; }
.dswfe-flowlegend .sw.fwd { border-color:var(--dsw-text-secondary, #94a3b8); }
.dswfe-flowlegend .sw.jump { border-color:#22c55e; }
.dswfe-flowlegend .sw.fail { border-color:var(--dsw-alias-state-error, #ef4444); border-top-width:2px; border-top-style:dashed; }
.dswfe-form { flex:1; min-height:0; overflow-y:auto; padding:12px 16px; box-sizing:border-box; }
/* 画布编辑器：左画布（阶段泳道+环节节点）+ 右属性面板 */
.dswfe-canvas { flex:1; min-height:0; display:flex; overflow:hidden; }
.dswfe-canvas-left { flex:1; min-width:0; overflow:auto; padding:14px; box-sizing:border-box; }
.dswfe-canvas-bar { display:flex; align-items:center; gap:10px; margin-bottom:12px; position:sticky; top:0; z-index:2; background:var(--dsw-alias-bg-base, inherit); padding:4px 0; }
.dswfe-canvas-hint { font-size:11px; opacity:.55; }
.dswfe-canvas-empty { border:1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius:12px; padding:32px; text-align:center; opacity:.6; }
.dswfe-lane { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:12px; margin:0 0 12px; background:var(--dsw-alias-bg-layer-1, transparent); overflow:hidden; }
.dswfe-lane[data-sel="true"] { border-color:var(--dsw-alias-brand-primary, #d9822b); box-shadow:0 0 0 1px var(--dsw-alias-brand-primary, #d9822b); }
.dswfe-lane-head { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); user-select:none; }
.dswfe-lane-no { color:#fff; font-size:10px; font-weight:700; border-radius:8px; padding:2px 7px; font-family:ui-monospace, monospace; }
.dswfe-lane-name { font-weight:600; font-size:13px; }
.dswfe-lane-id { font-family:ui-monospace, monospace; font-size:11px; opacity:.5; }
.dswfe-lane-count { margin-left:auto; font-size:11px; opacity:.55; }
.dswfe-lane-body { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:12px; }
.dswfe-node { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius:10px; padding:8px 12px; cursor:pointer; min-width:130px; max-width:210px; background:var(--dsw-alias-bg-base, transparent); user-select:none; }
.dswfe-node:hover { border-color:var(--dsw-alias-brand-primary, #d9822b); }
.dswfe-node[data-sel="true"] { border-color:var(--dsw-alias-brand-primary, #d9822b); box-shadow:0 0 0 1px var(--dsw-alias-brand-primary, #d9822b); }
.dswfe-node-name { font-weight:600; font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-node-meta { display:flex; gap:6px; align-items:center; margin-top:3px; }
.dswfe-node-id { font-family:ui-monospace, monospace; font-size:10.5px; opacity:.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-node-badge { font-size:10.5px; color:#b8860b; white-space:nowrap; }
.dswfe-node-arrow { opacity:.45; font-size:14px; }
.dswfe-node-add { border:1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.4)); background:transparent; color:inherit; border-radius:10px; min-width:34px; height:38px; font-size:16px; cursor:pointer; opacity:.65; }
.dswfe-node-add:hover { opacity:1; border-color:var(--dsw-alias-brand-primary, #d9822b); }
.dswfe-props { width:400px; min-width:340px; flex:none; border-left:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); overflow-y:auto; padding:12px 16px; box-sizing:border-box; }
/* 模型两极下拉 + 技能多选下拉 */
.dswfe-modelrow { display:flex; gap:6px; }
.dswfe-native-sel { flex:1; min-width:0; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background:var(--dsw-alias-bg-layer-2, transparent); color:inherit; border-radius:8px; padding:6px 8px; font:inherit; font-size:12.5px; }
.dswfe-native-sel:disabled { opacity:.45; }
.dswfe-selbtn { width:100%; display:flex; align-items:center; gap:6px; text-align:left; border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background:var(--dsw-alias-bg-layer-2, transparent); color:inherit; border-radius:8px; padding:6px 10px; font:inherit; font-size:12.5px; cursor:pointer; }
.dswfe-selbtn .dswfe-selph { opacity:.45; }
.dswfe-selbtn span:first-child { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-selcar { opacity:.5; }
.dswfe-skillpick { position:relative; }
.dswfe-skillpop { position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:30; background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #252830)); color:var(--dsw-alias-label-primary, inherit); border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,.25); max-height:260px; overflow-y:auto; padding:4px; }
.dswfe-skillrow { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:12.5px; }
.dswfe-skillrow:hover { background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }
.dswfe-skillrow input { flex:none; }
.dswfe-skillname { font-weight:600; white-space:nowrap; }
.dswfe-skilldesc { opacity:.55; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dswfe-skillnone { padding:10px; opacity:.55; font-size:12px; text-align:center; }
.dswfe-skillclear { width:100%; border:none; border-top:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); background:transparent; color:inherit; padding:7px; font:inherit; font-size:12px; cursor:pointer; opacity:.7; }
.dswfe-skillclear:hover { opacity:1; }
.dswfe-fsec { margin:0 0 14px; }
.dswfe-fsec h4 { margin:0 0 8px; font-size:13px; }
.dswfe-fgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px 12px; }
.dswfe-fphase { border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:10px; padding:10px 12px; margin:8px 0; background:var(--dsw-alias-bg-layer-1, transparent); }
.dswfe-flink { border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius:8px; padding:8px 10px; margin:8px 0; background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.04)); }
.dswfe-flink .dswfe-field { margin:6px 0; }
.dswfe-fgates { border-top:1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.2)); padding-top:6px; }
`

let stylesInjected = false
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.id = 'dswfe-styles'
  el.textContent = STYLE
  document.head.appendChild(el)
  stylesInjected = true
}

// ── API 帮手 ─────────────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch(API + path, {
    method: (opts && opts.method) || 'GET',
    headers: opts && opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
  })
  let data = {}
  try { data = await res.json() } catch { /* 空响应 */ }
  if (!res.ok) {
    const e = new Error(data.error || (res.statusText + ' (' + res.status + ')'))
    e.code = data.code
    e.status = res.status
    e.data = data
    throw e
  }
  return data
}

// 旧包名时代的面板偏好存在 dsh-prc:prefs：新键缺失时读一次旧键并写回新键
function loadPrefs() {
  let raw = null
  try { raw = localStorage.getItem(PREFS_KEY) } catch { /* 隐身模式等 */ }
  if (!raw) {
    try {
      const legacy = localStorage.getItem('dsh-prc:prefs')
      if (legacy) { raw = legacy; localStorage.setItem(PREFS_KEY, legacy) }
    } catch { /* 同上 */ }
  }
  try { return JSON.parse(raw) || {} } catch { return {} }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 隐身模式等 */ }
}

// ── Controller ───────────────────────────────────────────────────────────

function initialState() {
  const prefs = loadPrefs()
  return {
    loaded: false, revision: 0, roots: { user: '', bundled: '' }, processes: [], lastError: undefined, error: undefined,
    panelOpen: false,
    selectedId: prefs.selectedId, tab: prefs.tab || 'overview',
    item: undefined, itemLoading: false, highlightLine: undefined,
    search: '', filters: Object.assign({ source: 'all', category: '', complexity: '' }, prefs.filters || {}),
    sortBy: prefs.sortBy || 'default',
    editor: null,
    dialog: null,
    toast: null,
    settings: undefined,
    view: prefs.view || 'lib',
    runs: { revision: -1, list: [] },
    runId: prefs.runId, run: undefined, runLoading: false, runError: null,
  }
}

class Controller {
  constructor() {
    this.state = initialState()
    this.subs = new Set()
    this.es = null
    this.seenRevision = undefined
    this.seenRunsRevision = undefined
    this.refreshInFlight = null
    this.validateTimer = null
    this.toastTimer = null
    this.disposed = false
  }
  getSnapshot() { return this.state }
  subscribe(fn) { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  setState(patch) { this.state = { ...this.state, ...patch }; this.emit() }
  emit() { if (this.disposed) return; for (const fn of this.subs) { try { fn() } catch {} } }
  persist() {
    const s = this.state
    savePrefs({ selectedId: s.selectedId, tab: s.tab, filters: s.filters, sortBy: s.sortBy, view: s.view, runId: s.runId })
  }
  toast(text, kind) {
    this.setState({ toast: { text, kind: kind || 'ok' } })
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => { if (!this.disposed) this.setState({ toast: null }) }, 2600)
  }

  start() {
    void this.refresh()
    try { this.connectStream() } catch { /* 实时通道不可用：仅手动刷新 */ }
  }
  connectStream() {
    const onEvent = (event, payload) => {
      if (event !== 'hello' && event !== 'change') return
      try { this.seenRevision = payload.revision; this.seenRunsRevision = payload.runsRevision } catch (e) {}
      void this.refresh()
    }
    // 枢纽优先（dsh-plugin-kit ≥0.4 的共享单连接）；帧形状 {event, data}
    if (typeof PluginKit !== 'undefined' && typeof PluginKit.connectEvents === 'function') {
      this.hubOff = PluginKit.connectEvents('dsh-workflow-execute', (data) => {
        if (data && typeof data.event === 'string') onEvent(data.event, data.data)
      }, () => {})
      if (this.hubOff) return
    }
    const es = new EventSource(API + '/events')
    this.es = es
    es.addEventListener('hello', (e) => {
      let d; try { d = JSON.parse(e.data) } catch (err) { return }
      onEvent('hello', d)
    })
    es.addEventListener('change', (e) => {
      let d; try { d = JSON.parse(e.data) } catch (err) { return }
      onEvent('change', d)
    })
    es.onerror = () => { /* EventSource 自动重连；hello 里对齐 gap */ }
  }
  async refresh() {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        let snap
        // revision 追赶：变更帧落在请求飞行中时，旧响应可能落后（taskboard S16）
        for (let round = 0; round < 3; round++) {
          const [stateRsp, runsRsp] = await Promise.all([api('/state'), api('/runs')])
          snap = stateRsp
          const keep = this.state.selectedId && snap.processes.some((p) => p.id === this.state.selectedId)
            ? this.state.selectedId : undefined
          this.setState({
            loaded: true, revision: snap.revision, roots: snap.roots, processes: snap.processes,
            lastError: snap.lastError, error: undefined, selectedId: keep,
            runs: { revision: runsRsp.revision, list: runsRsp.runs },
          })
          const libCaughtUp = this.seenRevision === undefined || snap.revision >= this.seenRevision
          const runsCaughtUp = this.seenRunsRevision === undefined || runsRsp.revision >= this.seenRunsRevision
          if (libCaughtUp && runsCaughtUp) break
        }
        // 选中的运行已不在台账里 → 清选中，避免看板停留在「加载中」
        if (this.state.runId && !this.state.runs.list.some((r) => r.id === this.state.runId)) {
          this.setState({ runId: null, run: undefined, runLoading: false, runError: null })
          this.persist()
        }
        // 运行看板：活跃运行随帧刷新；静态运行只取一次
        if (this.state.view === 'exec' && this.state.runId) {
          const active = ['queued', 'running', 'awaiting'].includes((this.state.run && this.state.run.status) || '')
          if (active || !this.state.run) void this.loadRun(this.state.runId)
        }
        // 选中项跟随外部改动：非编辑态自动刷新；编辑态不打断（保存时乐观锁兜底）
        if (this.state.selectedId && !this.state.itemLoading) {
          if (this.state.editor && this.state.editor.id === this.state.selectedId) { /* 编辑中：跳过 */ }
          else if (this.state.item && this.state.item.meta.id === this.state.selectedId) {
            const fresh = snap.processes.find((p) => p.id === this.state.selectedId)
            if (fresh && this.state.item.meta.hash !== fresh.hash) void this.loadItem(this.state.selectedId)
          } else void this.loadItem(this.state.selectedId)
        }
      } catch (error) {
        this.setState({ error: String(error && error.message || error) })
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }
  dispose() {
    this.disposed = true
    if (this.hubOff) { try { this.hubOff() } catch {} }
    if (this.es) { try { this.es.close() } catch {} }
    if (this.validateTimer) clearTimeout(this.validateTimer)
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.subs.clear()
  }

  // ── 面板 ──
  openPanel() {
    this.setState({ panelOpen: true })
    try { document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME })) } catch {}
    if (!this.state.loaded) void this.refresh()
    // 兜底：视图容器未能在中栏放置（壳层退化）→ 450ms 后强制挂 body 全屏，
    // 保证侧栏入口点击永远有响应
    setTimeout(() => {
      if (this.disposed) return
      const s = this.getSnapshot()
      if (s.panelOpen && typeof document !== 'undefined' && !document.querySelector('[data-dswfe-panel]')) {
        if (prcView) prcView.ensure(true)
      }
    }, 450)
  }
  closePanel() { this.setState({ panelOpen: false, dialog: null }) }
  togglePanel() { if (this.state.panelOpen) this.closePanel(); else this.openPanel() }

  // ── 选择 / 筛选 ──
  select(id) {
    if (!id) return
    const ed = this.state.editor
    if (ed && ed.id !== id) {
      // 编辑中切换：脏了先确认，干净直接关编辑器
      if (ed.dirty) {
        this.setState({ dialog: { type: 'confirm', message: this.tr('dirtyGuard'), danger: true, yes: 'discard', onYes: () => { this.setState({ editor: null, dialog: null }); this.select(id) } } })
        return
      }
      this.setState({ editor: null })
    }
    this.setState({ selectedId: id, item: undefined, itemLoading: true, highlightLine: undefined })
    this.persist()
    void this.loadItem(id)
  }
  async loadItem(id) {
    try {
      const item = await api('/item?id=' + encodeURIComponent(id))
      if (this.state.selectedId !== id) return
      this.setState({ item, itemLoading: false })
    } catch (error) {
      if (this.state.selectedId === id) this.setState({ itemLoading: false, error: String(error && error.message || error) })
    }
  }
  /** 跳到某个会话（AI 生成任务的会话）：客户端 sessions 服务 open(id)，逐次懒解析。 */
  openSession(sessionId) {
    const svc = this.sessionsSvc
    if (!svc || typeof svc.open !== 'function') { this.toast(this.tr('sessionUnavailable'), 'err'); return }
    try { svc.open(sessionId); this.closePanel() } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  tr(key, vars) { return this.t ? this.t(key, vars) : (ZH[key] || key) }
  setTab(tab) { this.setState({ tab }); this.persist() }
  setSearch(search) { this.setState({ search }) }
  setFilter(key, value) {
    const filters = { ...this.state.filters, [key]: value }
    this.setState({ filters }); this.persist()
  }
  setSortBy(sortBy) { this.setState({ sortBy }); this.persist() }

  // ── 编辑器 ──
  openEditor(payload) {
    this.setState({
      editor: {
        mode: payload.mode, id: payload.id || null, name: payload.name || '', dir: payload.dir || '',
        text: payload.text || '', baseHash: payload.baseHash || null, original: payload.text || '',
        dirty: false, diagnostics: payload.diagnostics || null, busy: false, conflict: null, error: null,
      },
    })
    this.scheduleValidate(50)
  }
  async editSelected() {
    const item = this.state.item
    if (!item) return
    const t0 = Date.now()
    this.openEditor({ mode: 'update', id: item.meta.id, text: item.yaml, baseHash: item.hash, diagnostics: item.diagnostics })
  }
  async createBlank(name, dir, displayName) {
    try {
      const q = '?name=' + encodeURIComponent(name) + (displayName ? '&displayName=' + encodeURIComponent(displayName) : '')
      const { yaml } = await api('/skeleton' + q)
      this.setState({ dialog: null })
      this.openEditor({ mode: 'create', name, dir, text: yaml })
    } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  setEditorText(text) {
    const ed = this.state.editor
    if (!ed) return
    this.setState({ editor: { ...ed, text, dirty: text !== ed.original, conflict: null, validatedAt: null } })
    this.scheduleValidate()
  }
  scheduleValidate(delay) {
    if (this.validateTimer) clearTimeout(this.validateTimer)
    this.validateTimer = setTimeout(() => { this.validateTimer = null; void this.validateEditor(true) }, delay === undefined ? 400 : delay)
  }
  async validateEditor(silent) {
    const ed = this.state.editor
    if (!ed || ed.text.trim() === '') return
    try {
      const d = await api('/validate', { method: 'POST', body: { yaml: ed.text } })
      const cur = this.state.editor
      if (cur && cur.text === ed.text) {
        this.setState({ editor: { ...cur, diagnostics: { errors: d.errors, warnings: d.warnings }, validatedAt: Date.now() } })
      }
      // 自动校验（防抖后逐字触发）不弹提示，结果只体现在状态栏与诊断区；
      // 只有手动点「校验」才 toast，避免每输入一个字就冒一个气泡。
      if (!silent) {
        const errors = (d.errors || []).length
        const warnings = (d.warnings || []).length
        this.toast(errors === 0 && warnings === 0
          ? this.tr('validateOk')
          : this.tr('validateResult', { e: errors, w: warnings }), errors > 0 ? 'err' : undefined)
      }
    } catch (error) {
      if (!silent) this.toast(String((error && error.message) || error), 'err')
    }
  }
  async saveEditor(force) {
    const ed = this.state.editor
    if (!ed || ed.busy) return
    this.setState({ editor: { ...ed, busy: true, error: null } })
    try {
      let body
      if (ed.mode === 'create') body = { mode: 'create', name: ed.name, dir: ed.dir, yaml: ed.text }
      else body = { mode: 'update', id: ed.id, yaml: ed.text, baseHash: force && ed.conflict ? ed.conflict.currentHash : ed.baseHash }
      const result = await api('/save', { method: 'POST', body })
      // 保存后留在编辑器：用落盘内容刷新文本与基线，清脏标、保留画布选中与 form/yaml 子模式
      let item = null
      try { item = await api('/item?id=' + encodeURIComponent(result.id)) } catch {}
      const cur = this.state.editor || ed
      this.setState({
        dialog: null,
        selectedId: result.id,
        item: item || this.state.item,
        itemLoading: false,
        editor: Object.assign({}, cur, {
          mode: 'update', id: result.id, name: ed.name, dir: ed.dir,
          text: item ? item.yaml : cur.text,
          original: item ? item.yaml : cur.text,
          baseHash: item ? item.hash : cur.baseHash,
          dirty: false, busy: false, conflict: null, error: null,
          diagnostics: item ? item.diagnostics : cur.diagnostics,
        }),
      })
      void this.refresh()
      this.toast(force ? this.tr('toastForceSaved') : this.tr('toastSaved'))
    } catch (error) {
      const cur = this.state.editor
      if (!cur) return
      if (error.code === 'conflict') this.setState({ editor: { ...cur, busy: false, conflict: { currentHash: error.data && error.data.currentHash }, error: null } })
      else if (error.data && error.data.diagnostics) this.setState({ editor: { ...cur, busy: false, diagnostics: error.data.diagnostics, error: String(error.message) } })
      else this.setState({ editor: { ...cur, busy: false, error: String(error && error.message || error) } })
    }
  }
  async reloadEditor() {
    const ed = this.state.editor
    if (!ed || !ed.id) return
    try {
      const item = await api('/item?id=' + encodeURIComponent(ed.id))
      this.setState({ editor: { ...ed, text: item.yaml, original: item.yaml, baseHash: item.hash, dirty: false, conflict: null, diagnostics: item.diagnostics, error: null } })
    } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  requestCloseEditor() {
    const ed = this.state.editor
    if (ed && ed.dirty) this.setState({ dialog: { type: 'confirm', message: this.tr('dirtyGuard'), danger: true, yes: 'discard', onYes: () => this.setState({ editor: null, dialog: null }) } })
    else this.setState({ editor: null })
  }

  // ── 动作 ──
  async copyProcess(fromId, name, dir) {
    try {
      const result = await api('/save', { method: 'POST', body: { mode: 'copy', fromId, name, dir } })
      this.setState({ dialog: null })
      this.select(result.id)
      void this.refresh()
      this.toast(this.tr('toastCopied'))
    } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  async renameProcess(id, newName) {
    try {
      const result = await api('/rename', { method: 'POST', body: { id, newName } })
      this.setState({ dialog: null })
      this.select(result.id || id)
      void this.refresh()
      this.toast(this.tr('toastRenamed'))
    } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  async removeProcess(id) {
    try {
      await api('/delete', { method: 'POST', body: { id } })
      this.setState({ dialog: null, selectedId: undefined, item: undefined, editor: null })
      await this.refresh()
      this.toast(this.tr('toastTrashed'))
    } catch (error) { this.toast(String(error && error.message || error), 'err') }
  }
  async importFiles(files, overwrite) {
    const results = await api('/import', { method: 'POST', body: { files, overwrite } }).then((d) => d.results)
    await this.refresh()
    return results
  }
  async loadSettings() {
    const d = await api('/settings')
    this.setState({ settings: d.settings })
    return d.settings
  }
  async saveSettings(patch) {
    const d = await api('/settings', { method: 'POST', body: patch })
    this.setState({ settings: d.settings })
    await this.refresh()
    return d.settings
  }
  aiRun(prompt) { return api('/ai-generate', { method: 'POST', body: { prompt } }).then((d) => d.jobId) }
  aiPoll(jobId) { return api('/jobs?id=' + encodeURIComponent(jobId)) }

  /**
   * @ 给 agent：把工作流文件以 @绝对路径 引用进当前会话的 composer（file-share 同款
   * 双形态写入 + 剪贴板兜底），用户接着输入修改要求发送即可——agent 会用
   * workflow_get/workflow_validate/workflow_save 工具完成修改。
   */
  atAgent(meta) {
    const root = meta.source === 'user' ? this.state.roots.user : this.state.roots.bundled
    const abs = (root || '').replace(/\/+$/, '') + '/' + meta.relPath
    const hint = meta.source === 'bundled' ? this.tr('atAgentBundledHint') : ''
    const text = '@' + abs + ' ' + hint
    const result = insertComposerText(text)
    this.closePanel()
    if (result === 'ok') this.toast(this.tr('atInserted'))
    else this.toast(this.tr('atCopied'), 'err')
  }

  // ── 执行视图（v0.2）──
  setView(view) { this.setState({ view }); this.persist() }
  selectRun(id) {
    if (!id) return
    this.setState({ runId: id, run: undefined, runLoading: true })
    this.persist()
    void this.loadRun(id)
  }
  async loadRun(id) {
    try {
      const d = await api('/run?id=' + encodeURIComponent(id))
      if (this.state.runId !== id) return
      this.setState({ run: d.run, runLoading: false, runError: null })
    } catch (error) {
      if (this.state.runId !== id) return
      const msg = String(error && error.message || error)
      // 台账里已经没有这条运行（已删除/被清理）：清掉选中，别让看板永远停在「加载中」
      if (error && error.code === 'not_found') {
        this.setState({ runId: null, run: undefined, runLoading: false, runError: null })
        this.persist()
        this.toast(msg, 'err')
        return
      }
      this.setState({ runLoading: false, runError: msg, error: msg })
    }
  }
  async loadLinkFiles(runId, linkId) {
    const d = await api('/run-link-files?run=' + encodeURIComponent(runId) + '&link=' + encodeURIComponent(linkId))
    return d.files || []
  }
  async loadArtifact(runId, path) {
    const d = await api('/run-file?run=' + encodeURIComponent(runId) + '&path=' + encodeURIComponent(path))
    return d.file
  }
  async runAction(action, body) {
    const d = await api('/run-action', { method: 'POST', body: { action, ...body } })
    if (this.state.runId === d.run.id) void this.loadRun(d.run.id)
    void this.refresh()
    return d.run
  }
  /** 删除一条已结束的运行台账（服务端只允许删除终态）。 */
  async deleteRun(id) {
    try {
      await api('/run-delete', { method: 'POST', body: { id } })
      if (this.state.runId === id) this.setState({ runId: null, run: undefined })
      this.persist()
      this.toast(this.tr('delete'))
      void this.refresh()
    } catch (error) {
      // 以前静默吞掉：接口报错时按钮看着像没生效，这里把原因显出来
      this.toast(String((error && error.message) || error), 'err')
    }
  }
  async createRun(body) {
    const d = await api('/run-create', { method: 'POST', body })
    this.setState({ dialog: null, view: 'exec', runId: d.run.id, run: undefined, runLoading: true })
    this.persist()
    void this.loadRun(d.run.id)
    this.toast(this.tr('runStarted'))
    return d.run
  }
}

// ── 侧栏入口行（DOM 注入，taskboard 家族同款） ─────────────────────────────

/** 把文本写进当前会话的 composer（file-share 同款双形态 + 剪贴板兜底）。
 *  返回 'ok'（已写入输入框）或 'copied'（退化为剪贴板）。 */
function insertComposerText(text) {
  try {
    const card = document.querySelector('[data-composer-card]')
    const ta = card && card.querySelector('textarea')
    const ce = card && (card.querySelector('[contenteditable="true"]') || card.querySelector('[contenteditable=""]'))
    if (typeof document.execCommand === 'function' && (ta || ce)) {
      if (ta) {
        ta.focus()
        const len = ta.value ? ta.value.length : 0
        try { ta.setSelectionRange(len, len) } catch {}
      } else if (ce) {
        ce.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(ce)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      if (document.execCommand('insertText', false, text)) return 'ok'
    }
  } catch {}
  try { navigator.clipboard.writeText(text) } catch {}
  return 'copied'
}


// ── 表单编辑：Document API 双向同步（v0.4）──────────────────────────────

/** yaml 库：bundle 内 YamlLibSrc 源经 new Function 隔离构造（懒加载，避开其他插件
 * 加载期的全局污染窗口）；plain Node（单测）退回 require('yaml')。 */
function getYamlLib() {
  try { if (typeof YamlLib !== 'undefined' && YamlLib) return YamlLib } catch {}
  try { if (typeof makeYamlLibIsolated === 'function') { YamlLib = makeYamlLibIsolated(); return YamlLib } } catch {}
  try { return require('yaml') } catch { return null }
}

/** 解析编辑器文本为 Document；语法错误返回 null（表单不可用）。 */
function fmDoc(text) {
  const lib = getYamlLib()
  if (!lib) return null
  try {
    const doc = lib.parseDocument(String(text || ''), { keepSourceTokens: true })
    return doc.errors.length === 0 ? doc : null
  } catch { return null }
}

/** setIn：写标量/对象；中间节点缺失自动创建。返回新文本。 */
function fmSet(text, path, value) {
  const doc = fmDoc(text)
  if (!doc) return text
  try { doc.setIn(path, value) } catch { return text }
  return doc.toString()
}

/** deleteIn：删除键或序列项。返回新文本。 */
function fmDel(text, path) {
  const doc = fmDoc(text)
  if (!doc) return text
  try { doc.deleteIn(path) } catch { return text }
  return doc.toString()
}

/** 向序列（如 phases / links / gates）追加一个普通对象。 */
function fmAppend(text, path, value) {
  const doc = fmDoc(text)
  if (!doc) return text
  try {
    const seq = doc.getIn(path, true)
    if (seq && typeof seq.add === 'function') seq.add(value)
    else doc.setIn(path, [value])
  } catch { return text }
  return doc.toString()
}

/** 读路径上的 JS 值（缺失 → dflt）。 */
function fmGet(text, path, dflt) {
  const doc = fmDoc(text)
  if (!doc) return dflt
  const v = doc.getIn(path)
  return v === undefined || v === null ? dflt : v
}

const fmSeqLen = (doc, path) => { const s = doc.getIn(path, true); return s && s.items ? s.items.length : 0 }

/** 删除环节 + 级联：所有指向被删 id 的 on_success/on_gate_fail 重置（next/break）。 */
function fmDeleteLink(text, phaseIndex, linkIndex) {
  const doc = fmDoc(text)
  if (!doc) return text
  const linksPath = ['phases', phaseIndex, 'links']
  const deletedId = String(doc.getIn([...linksPath, linkIndex, 'id']) ?? '')
  try { doc.getIn(linksPath, true).delete(linkIndex) } catch { return text }
  if (deletedId) {
    const pc = fmSeqLen(doc, ['phases'])
    for (let pi = 0; pi < pc; pi++) {
      const lc = fmSeqLen(doc, ['phases', pi, 'links'])
      for (let li = 0; li < lc; li++) {
        for (const field of ['on_success', 'on_gate_fail']) {
          const v = doc.getIn(['phases', pi, 'links', li, field])
          if (v === deletedId || v === 'goto:' + deletedId) {
            doc.setIn(['phases', pi, 'links', li, field], field === 'on_success' ? 'next' : 'break')
          }
        }
      }
    }
  }
  return doc.toString()
}

/** 删除阶段 + 级联重置其下所有环节 id 的引用。 */
function fmDeletePhase(text, phaseIndex) {
  const doc = fmDoc(text)
  if (!doc) return text
  const deletedIds = []
  const lc0 = fmSeqLen(doc, ['phases', phaseIndex, 'links'])
  for (let li = 0; li < lc0; li++) {
    const id = doc.getIn(['phases', phaseIndex, 'links', li, 'id'])
    if (id) deletedIds.push(String(id))
  }
  try { doc.getIn(['phases'], true).delete(phaseIndex) } catch { return text }
  const pc = fmSeqLen(doc, ['phases'])
  for (let pi = 0; pi < pc; pi++) {
    const lc = fmSeqLen(doc, ['phases', pi, 'links'])
    for (let li = 0; li < lc; li++) {
      for (const field of ['on_success', 'on_gate_fail']) {
        const v = doc.getIn(['phases', pi, 'links', li, field])
        if (v && (deletedIds.includes(v) || deletedIds.includes(String(v).replace(/^goto:/, '')))) {
          doc.setIn(['phases', pi, 'links', li, field], field === 'on_success' ? 'next' : 'break')
        }
      }
    }
  }
  return doc.toString()
}

/** 环节改 id + 级联：所有引用旧 id 的流转值同步替换（含 goto: 前缀）。 */
function fmSetLinkId(text, phaseIndex, linkIndex, newId) {
  const doc = fmDoc(text)
  if (!doc) return text
  const oldId = String(doc.getIn(['phases', phaseIndex, 'links', linkIndex, 'id']) ?? '')
  doc.setIn(['phases', phaseIndex, 'links', linkIndex, 'id'], newId)
  if (!oldId || oldId === newId) return doc.toString()
  const pc = fmSeqLen(doc, ['phases'])
  for (let pi = 0; pi < pc; pi++) {
    const lc = fmSeqLen(doc, ['phases', pi, 'links'])
    for (let li = 0; li < lc; li++) {
      for (const field of ['on_success', 'on_gate_fail']) {
        const v = doc.getIn(['phases', pi, 'links', li, field])
        if (v === oldId) doc.setIn(['phases', pi, 'links', li, field], newId)
        else if (v === 'goto:' + oldId) doc.setIn(['phases', pi, 'links', li, field], 'goto:' + newId)
      }
    }
  }
  return doc.toString()
}

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="4.5" rx="1"/><rect x="9.5" y="10" width="5" height="4.5" rx="1"/><path d="M4 6v3.5A1.5 1.5 0 0 0 5.5 11h4"/></svg>'

function sidebarRoot() {
  const column = document.querySelector(PRC_SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  const logoOwner = column.querySelector('[class*="logoRow"]') && column.querySelector('[class*="logoRow"]').parentElement
  return logoOwner || (column.firstElementChild || undefined)
}

function newSessionButton(root) {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement && !child.matches('[' + ENTRY_ATTR + ']')) return child
  }
  const byAria = root.querySelector('button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]')
  if (byAria) return byAria
  const buttons = Array.from(root.querySelectorAll('button'))
  return buttons.find((b) => !b.matches('[' + ENTRY_ATTR + ']') && /新会话|新建会话|new session/i.test(b.textContent || ''))
}

function createEntry(controller, t) {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.className = 'dswfe-entry'
  entry.setAttribute('aria-label', t('entryAria'))
  entry.innerHTML = '<span class="dswfe-entry-icon">' + ICON + '</span><span class="dswfe-entry-label"></span><span class="dswfe-entry-stats"></span>'
  entry.addEventListener('click', () => controller.togglePanel())
  return entry
}

function setRollValue(slot, value) {
  const text = String(value)
  if (slot.dataset.value === text) return
  const previous = slot.dataset.value
  slot.dataset.value = text
  slot.style.minWidth = text.length + 'ch'
  if (previous === undefined) { slot.textContent = text; return }
  if (slot.dataset.busy === '1') { slot.dataset.busy = ''; slot.dataset.anim = '' }
  const oldEl = document.createElement('span'); oldEl.className = 'dswfe-rn'; oldEl.textContent = previous
  const newEl = document.createElement('span'); newEl.className = 'dswfe-rn dswfe-rn-next'; newEl.textContent = text
  slot.replaceChildren(oldEl, newEl)
  slot.dataset.dir = value > Number(previous) ? 'up' : 'down'
  slot.dataset.busy = '1'
  requestAnimationFrame(() => { slot.dataset.anim = '1' })
  const finish = () => {
    if (slot.dataset.busy !== '1') return
    slot.dataset.busy = ''; slot.dataset.anim = ''
    slot.textContent = slot.dataset.value || ''
  }
  slot.addEventListener('transitionend', finish, { once: true })
  setTimeout(finish, 400)
}

function wireEntrySync(entry, controller, t) {
  const stats = entry.querySelector('.dswfe-entry-stats')
  const label = entry.querySelector('.dswfe-entry-label')
  const slots = []
  if (stats) {
    for (let i = 0; i < 2; i++) {
      if (i > 0) { const sep = document.createElement('span'); sep.className = 'dswfe-entry-sep'; sep.textContent = '|'; stats.append(sep) }
      const slot = document.createElement('span')
      slot.className = 'dswfe-roll'
      slot.dataset.stat = i === 0 ? 'user' : 'bundled'
      stats.append(slot); slots.push(slot)
    }
  }
  const sync = () => {
    const s = controller.getSnapshot()
    if (s.panelOpen) entry.dataset.active = 'true'; else delete entry.dataset.active
    const user = s.processes.filter((p) => p.source === 'user').length
    const bundled = s.processes.filter((p) => p.source === 'bundled').length
    if (slots[0]) setRollValue(slots[0], user)
    if (slots[1]) setRollValue(slots[1], bundled)
    if (label) label.textContent = t('title')
    entry.setAttribute('aria-label', t('entryAria'))
    entry.title = t('entryTitle', { user, bundled })
  }
  return sync
}

function placeEntry(root, entry) {
  const button = newSessionButton(root)
  if (!button) return false
  if (entry.parentElement !== root) {
    const family = Array.from(root.children).filter((el) => el instanceof HTMLElement
      && el.matches('[' + ENTRY_ATTR + '], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'))
    if (family.length > 0) {
      const last = family[family.length - 1]
      last.parentElement.insertBefore(entry, last.nextSibling)
    } else {
      const row = button.closest('[class*="logoRow"]')
      const base = (row && row.parentElement === root) ? row : button
      root.insertBefore(entry, base.nextSibling)
    }
  }
  return true
}

function mountSidebarEntry(controller, t) {
  const entry = createEntry(controller, t)
  const debug = { attempts: 0, found: false, placed: false }
  try {
    const host = globalThis.location && globalThis.location.hostname
    if (host === 'localhost' || host === '127.0.0.1') window.__prcDebug = debug
  } catch {}
  let root
  let placed = false
  const tryPlace = () => {
    debug.attempts++
    if (root && !root.isConnected) { rootObserver.disconnect(); root = undefined; placed = false }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect(); root = undefined; placed = false
    }
    root = root || sidebarRoot()
    if (!root) return
    debug.found = !!newSessionButton(root)
    placed = placeEntry(root, entry)
    debug.placed = placed
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const waitObserver = new MutationObserver(() => tryPlace())
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const rootObserver = new MutationObserver(() => {
    if (!root || !root.isConnected) { placed = false; tryPlace(); return }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })
  const retry = setInterval(() => tryPlace(), 2000)
  const sync = wireEntrySync(entry, controller, t)
  const unsubscribe = controller.subscribe(sync)
  sync()
  tryPlace()
  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

function complexityLabel(t, v) {
  const key = { low: 'cxLow', medium: 'cxMid', high: 'cxHigh' }[v]
  return key ? t(key) : String(v)
}

function filterProcesses(state) {
  const q = state.search.trim().toLowerCase()
  const rows = state.processes.filter((p) =>
    (state.filters.source === 'all' || p.source === state.filters.source)
    && (state.filters.category === '' || p.category === state.filters.category)
    && (state.filters.complexity === '' || p.complexity === state.filters.complexity)
    && (q === '' || (p.name + ' ' + (p.display_name || '') + ' ' + (p.description || '')).toLowerCase().includes(q)))
  const rank = { low: 0, medium: 1, high: 2 }
  const sorted = [...rows]
  if (state.sortBy === 'updated') sorted.sort((a, b) => b.mtime - a.mtime)
  else if (state.sortBy === 'complexity') sorted.sort((a, b) => (rank[a.complexity] ?? 9) - (rank[b.complexity] ?? 9) || a.relPath.localeCompare(b.relPath))
  else if (state.sortBy === 'links') sorted.sort((a, b) => b.linkCount - a.linkCount)
  else sorted.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return sorted
}

function flowLabel(t, v) {
  if (v === 'next') return t('flowNext')
  if (v === 'end') return t('flowEnd')
  if (v === 'break') return t('flowBreak')
  return String(v)
}

function linkExpert(ln) { return (ln && (ln.expert_name || ln.expert)) || undefined }

/** 极轻量 YAML 着色：注释灰、键蓝、其余默认。 */
function colorizeLine(line) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) return [h('span', { className: 'dswfe-cm' }, line)]
  const m = line.match(/^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(:)(.*)$/)
  if (m) {
    return [m[1], h('span', { className: 'dswfe-key' }, m[2] + ':'), m[4] ? colorizeScalar(m[4]) : '']
  }
  return [line]
}
function colorizeScalar(rest) {
  const t = rest.trim()
  if (t === '' || t === '|' || t === '>' || t === '|-' || t === '>-') return rest
  if (t.startsWith('#')) return [h('span', { className: 'dswfe-cm' }, rest)]
  return rest
}

// ── 组件 ─────────────────────────────────────────────────────────────────

function useControllerState(controller) {
  const getSnap = useCallback(() => controller.getSnapshot(), [controller])
  const subscribe = useCallback((cb) => controller.subscribe(cb), [controller])
  return useSyncExternalStore(subscribe, getSnap)
}
let useSyncExternalStore = __React.useSyncExternalStore
  || ((subscribe, getSnap) => {
    const [v, setV] = useState(getSnap)
    useEffect(() => subscribe(() => setV(getSnap())), [subscribe, getSnap])
    return v
  })

function Menu({ x, y, items, onClose }) {
  return h('div', null,
    h('div', { className: 'dswfe-menuback', onClick: onClose, onContextMenu: (e) => { e.preventDefault(); onClose() } }),
    h('div', { className: 'dswfe-menu', style: { left: Math.max(4, x) + 'px', top: Math.max(4, y) + 'px' } },
      items.map((it, i) => h('button', { key: i, onClick: () => { onClose(); it.onClick() } }, it.label))))
}

function anchorMenu(btn, items, onClose) {
  let pos = { x: 100, y: 100 }
  try { const r = btn.getBoundingClientRect(); pos = { x: r.left, y: r.bottom + 4 } } catch {}
  return h(Menu, { x: pos.x, y: pos.y, items, onClose })
}

function Toolbar({ state, controller, t }) {
  const [menu, setMenu] = useState(null) // {kind, btn}
  const categories = useMemo(() => [...new Set(state.processes.map((p) => p.category).filter(Boolean))].sort(), [state.processes])
  const user = state.processes.filter((p) => p.source === 'user').length
  const bundled = state.processes.filter((p) => p.source === 'bundled').length
  const sel = state.item && state.item.meta
  const openMenu = (kind) => (e) => setMenu(menu && menu.kind === kind ? null : { kind, btn: e.currentTarget })
  return h('div', { className: 'dswfe-toolbar' },
    h('h2', { className: 'dswfe-title' }, t('title')),
    h('span', { className: 'dswfe-count' }, t('count', { user, bundled })),
    h('div', { className: 'dswfe-tabs', style: { borderBottom: 'none', margin: '0 4px' } },
      h('button', { className: 'dswfe-tab', 'data-on': state.view === 'lib' ? 'true' : undefined, onClick: () => controller.setView('lib') }, t('viewLib')),
      h('button', { className: 'dswfe-tab', 'data-on': state.view === 'exec' ? 'true' : undefined, onClick: () => controller.setView('exec') }, t('viewExec'))),
    h('input', { className: 'dswfe-input dswfe-search', value: state.search, placeholder: t('searchPlaceholder'), spellCheck: false, onChange: (e) => controller.setSearch(e.target.value) }),
    h('select', { className: 'dswfe-select', value: state.filters.source, onChange: (e) => controller.setFilter('source', e.target.value) },
      h('option', { value: 'all' }, t('filterAll')), h('option', { value: 'user' }, t('filterUser')), h('option', { value: 'bundled' }, t('filterBundled'))),
    h('select', { className: 'dswfe-select', value: state.filters.category, onChange: (e) => controller.setFilter('category', e.target.value) },
      h('option', { value: '' }, t('categoryAll')), categories.map((c) => h('option', { key: c, value: c }, c))),
    h('select', { className: 'dswfe-select', value: state.filters.complexity, onChange: (e) => controller.setFilter('complexity', e.target.value) },
      h('option', { value: '' }, t('complexityAll')), [['low', t('cxLow')], ['medium', t('cxMid')], ['high', t('cxHigh')]].map(([v, label]) => h('option', { key: v, value: v }, label))),
    h('select', { className: 'dswfe-select', value: state.sortBy, title: t('sortDefault'), onChange: (e) => controller.setSortBy(e.target.value) },
      h('option', { value: 'default' }, t('sortDefault')), h('option', { value: 'updated' }, t('sortUpdated')),
      h('option', { value: 'complexity' }, t('sortComplexity')), h('option', { value: 'links' }, t('sortLinks'))),
    h('div', { className: 'dswfe-spacer' }),
    h('button', { className: 'dswfe-btn', title: t('aiBtn'), onClick: () => controller.setState({ dialog: { type: 'ai' } }) }, '⚡ ' + t('aiBtn')),
    h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: openMenu('new') }, '+ ' + t('newTask')),
    h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: { type: 'import' } }) }, t('importBtn')),
    h('button', { className: 'dswfe-btn', onClick: openMenu('export') }, t('exportBtn')),
    h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: { type: 'settings' } }) }, t('settingsBtn')),
    h('button', { className: 'dswfe-btn', title: t('close'), onClick: () => controller.closePanel() }, '✕'),
    menu === null ? null
      : menu.kind === 'new'
        ? anchorMenu(menu.btn, [
          { label: t('newBlank'), onClick: () => controller.setState({ dialog: { type: 'create' } }) },
          { label: t('newFromExisting'), onClick: () => controller.setState({ dialog: { type: 'copy', fromId: sel ? sel.id : undefined } }) },
        ], () => setMenu(null))
        : anchorMenu(menu.btn, [
          { label: t('exportAll'), onClick: () => download(API + '/export?all=1') },
          { label: t('exportUser'), onClick: () => download(API + '/export?source=user') },
          { label: t('exportOne'), onClick: () => { if (sel) download(API + '/export?id=' + encodeURIComponent(sel.id)) } },
        ], () => setMenu(null)))
}

function download(url) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function ListPane({ state, controller, t }) {
  const rows = filterProcesses(state)
  const userRows = rows.filter((p) => p.source === 'user')
  const bundledRows = rows.filter((p) => p.source === 'bundled')
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const ids = rows.map((p) => p.id)
    if (ids.length === 0) return
    const idx = ids.indexOf(state.selectedId)
    const next = e.key === 'ArrowDown' ? ids[Math.min(ids.length - 1, idx + 1)] || ids[0] : ids[Math.max(0, idx - 1)]
    controller.select(next)
  }
  const row = (p) => h('button', {
    key: p.id, className: 'dswfe-row', role: 'button', tabIndex: 0,
    'data-selected': state.selectedId === p.id ? 'true' : undefined,
    'data-source': p.source, 'data-complexity': p.complexity || 'medium',
    onClick: () => controller.select(p.id),
    onKeyDown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); controller.select(p.id) } },
  },
    h('div', { className: 'dswfe-row-name' },
      h('span', { className: 'lbl' }, p.display_name || p.name),
      p.errors > 0 ? h('span', { className: 'dswfe-dot', 'data-kind': 'err', title: p.errors + t('errOne') }) : null,
      p.warnings > 0 ? h('span', { className: 'dswfe-dot', 'data-kind': 'warn', title: p.warnings + t('warnOne') }) : null),
    h('div', { className: 'dswfe-row-meta' },
      h('span', null, p.name),
      p.complexity ? h('span', { className: 'dswfe-badge' }, complexityLabel(t, p.complexity)) : null,
      p.version ? h('span', null, 'v' + p.version) : null,
      h('span', null, p.phaseCount + t('phases') + ' · ' + p.linkCount + t('links'))))
  const group = (label, items) => h('div', null,
    h('div', { className: 'dswfe-group' }, label, h('span', null, items.length)),
    items.map(row))
  return h('div', { className: 'dswfe-list', onKeyDown: onKey, tabIndex: 0 },
    rows.length === 0
      ? h('div', { style: { padding: '18px 8px', color: 'var(--dsw-text-secondary, gray)', fontSize: 12 } }, t('emptyList'), h('div', { style: { marginTop: 4, opacity: .8 } }, t('emptyListHint')))
      : [group(t('mine'), userRows), group(t('bundled'), bundledRows)])
}

function DiagList({ diagnostics, t, onJump }) {
  const items = [...(diagnostics.errors || []).map((d) => ({ ...d, kind: 'err' })), ...(diagnostics.warnings || []).map((d) => ({ ...d, kind: 'warn' }))]
  if (items.length === 0) return h('div', { className: 'dswfe-diag', style: { opacity: .75 } }, t('noIssues'))
  return h('div', { className: 'dswfe-diag' }, items.map((d, i) => h('button', {
    key: i, className: 'dswfe-diag-item', 'data-kind': d.kind,
    onClick: () => onJump && d.line && onJump(d.line),
  },
    h('span', { className: 'dswfe-diag-line' }, d.line ? 'L' + d.line : ''),
    h('span', { className: 'dswfe-diag-code' }, d.kind === 'err' ? '✗' : '⚠'),
    h('span', null, d.message),
    h('span', { style: { opacity: .5, marginLeft: 'auto', flex: 'none' } }, d.code))))
}

function StructureLinkCard({ t, ln, phaseId, index }) {
  const [open, setOpen] = useState(false)
  const meta = []
  // 环节级 model 运行时不被读取（execution.js 只用 run.model），不展示也不配置
  meta.push(execLabel(t, { reviewType: ln.review_type || 'ai' }))
  if (Array.isArray(ln.gates) && ln.gates.length) meta.push(t('flowGate', { min: ln.gates.map((g) => (g && g.min_score != null ? g.min_score : '?')).join('/') }))
  if (ln.max_rework !== undefined && ln.max_rework !== null) meta.push(t('flowRework', { n: ln.max_rework }))
  return h('div', { className: 'dswfe-link' },
    h('button', { className: 'dswfe-link-row', onClick: () => setOpen(!open), 'aria-expanded': open },
      h('span', { className: 'dswfe-link-id' }, t('linkNo', { n: index })),
      h('span', null, ln.name || ''),
      h('span', { className: 'dswfe-link-meta' }, meta.join(' · '))),
    !open ? null : h('div', { className: 'dswfe-link-body' },
      ln.prompt ? h('div', null, h('div', { style: { fontSize: 11, opacity: .65, marginBottom: 3 } }, t('prompt')), h('pre', { className: 'dswfe-pre' }, ln.prompt)) : null,
      h('div', { className: 'dswfe-kv' }, h('b', null, t('onSuccess') + ':'), flowLabel(t, ln.on_success || '—')),
      h('div', { className: 'dswfe-kv' }, h('b', null, t('onGateFail') + ':'), flowLabel(t, ln.on_gate_fail || '—')),
      ln.review_type ? h('div', { className: 'dswfe-kv' }, h('b', null, t('reviewType') + ':'), t(ln.review_type === 'human' ? 'reviewHuman' : ln.review_type === 'none' ? 'reviewNone' : 'reviewAi')) : null,
      ln.review_prompt ? h('div', { className: 'dswfe-kv' }, h('b', null, t('reviewPrompt') + ':'), h('span', { style: { whiteSpace: 'pre-wrap' } }, ln.review_prompt)) : null,
      ln.acceptance_criteria ? h('div', { className: 'dswfe-kv' }, h('b', null, t('acceptance') + ':'), h('span', { style: { whiteSpace: 'pre-wrap' } }, ln.acceptance_criteria)) : null,
      Array.isArray(ln.expected_artifacts) && ln.expected_artifacts.length > 0 ? h('div', { className: 'dswfe-kv' },
        h('b', null, t('artifacts') + ':'),
        h('span', null, ln.expected_artifacts.map((a) => (a && (a.path || a.name)) || '').filter(Boolean).join(' · '))) : null,
      Array.isArray(ln.gates) && ln.gates.length > 0 ? h('div', { className: 'dswfe-kv' },
        h('b', null, t('gates') + ':'),
        h('span', null, ln.gates.map((g) => (g ? (g.name || '?') + (g.min_score !== undefined && g.min_score !== null ? ' ≥' + g.min_score : '') : '')).join(' · '))) : null,
      h('div', { style: { fontSize: 11, opacity: .55 } }, phaseId)))
}

function StructureTab({ t, parsed }) {
  const phases = parsed && Array.isArray(parsed.phases) ? parsed.phases : []
  if (phases.length === 0) return h('div', { className: 'dswfe-empty' }, '—')
  let seq = 0
  return h('div', null, phases.map((ph, i) => {
    const links = Array.isArray(ph.links) ? ph.links : []
    return h('div', { className: 'dswfe-phase', key: ph.id || i },
      h('div', { className: 'dswfe-phase-head' },
        h('span', { className: 'dswfe-badge' }, t('phaseNo', { n: i + 1 })),
        h('span', null, ph.name || ''),
        h('span', { className: 'dswfe-link-meta' }, links.length + ' ' + t('links'))),
      ph.spec ? h('div', { className: 'dswfe-phase-spec' }, ph.spec) : null,
      ph.acceptance_criteria ? h('div', { className: 'dswfe-kv' }, h('b', null, t('acceptance') + ':'), h('span', { style: { whiteSpace: 'pre-wrap' } }, ph.acceptance_criteria)) : null,
      links.map((ln, j) => { seq += 1; return h(StructureLinkCard, { key: ln.id || j, t, ln, phaseId: ph.id, index: seq }) }))
  }))
}

function YamlView({ yaml, highlightLine }) {
  const boxRef = useRef(null)
  const lines = useMemo(() => String(yaml || '').split('\n'), [yaml])
  useEffect(() => {
    if (!highlightLine || !boxRef.current) return
    const el = boxRef.current.querySelector('[data-line="' + highlightLine + '"]')
    if (el) el.scrollIntoView({ block: 'center' })
  }, [highlightLine, yaml])
  return h('div', { className: 'dswfe-code', ref: boxRef },
    lines.map((line, i) => h('div', { key: i, className: 'dswfe-code-line', 'data-line': i + 1, 'data-hl': highlightLine === i + 1 ? 'true' : undefined },
      h('span', { className: 'dswfe-code-no' }, i + 1),
      h('span', { className: 'dswfe-code-tx' }, colorizeLine(line)))))
}

function OverviewTab({ t, meta, parsed, diagnostics, onJump }) {
  const limits = parsed && parsed.limits
  const abnormal = parsed && parsed.abnormal_handler
  const phases = parsed && Array.isArray(parsed.phases) ? parsed.phases : []
  let seq = 0
  const outline = []
  phases.forEach((ph, pi) => {
    const links = Array.isArray(ph.links) ? ph.links : []
    outline.push(h('div', { className: 'dswfe-ovphase', key: 'ph' + pi },
      h('span', { className: 'dswfe-badge' }, t('phaseNo', { n: pi + 1 })),
      h('span', null, ph.name || '')))
    links.forEach((ln, li) => {
      seq += 1
      outline.push(h('div', { className: 'dswfe-ovlink', key: 'ln' + pi + '-' + li },
        h('span', { className: 'dswfe-ovno' }, t('linkNo', { n: seq })),
        h('span', { className: 'dswfe-ovname' }, ln.name || ln.id || ''),
        h('span', { className: 'dswfe-ovkind' }, [
          execLabel(t, { reviewType: ln.review_type || 'ai' }),
          (Array.isArray(ln.gates) && ln.gates.length > 0)
            ? t('flowGate', { min: Math.min(...ln.gates.map((g) => Number(g && g.min_score) || 0)) })
            : t('flowNoGate'),
          ln.max_rework === null || ln.max_rework === undefined ? null : t('flowRework', { n: ln.max_rework }),
        ].filter(Boolean).join(' · '))))
    })
  })
  return h('div', null,
    h('div', { className: 'dswfe-kv' }, h('b', null, t('name') + ':'), meta.name),
    limits ? h('div', { className: 'dswfe-kv' }, h('b', null, t('limits') + ':'),
      (limits.max_step_executions == null ? t('unlimited') : limits.max_step_executions + ' ' + t('steps')) + ' · '
      + (limits.max_total_tokens == null ? t('unlimited') : limits.max_total_tokens + ' ' + t('tokens'))) : null,
    abnormal && Array.isArray(abnormal.trigger_on) ? h('div', { className: 'dswfe-kv' }, h('b', null, t('abnormal') + ':'), abnormal.trigger_on.join(', ')) : null,
    h('div', { className: 'dswfe-sec' },
      h('h4', null, t('overviewTitle')),
      meta.description ? h('p', { className: 'dswfe-desc' }, meta.description) : null,
      outline.length === 0 ? h('div', { className: 'dswfe-diag', style: { opacity: .75 } }, t('overviewEmpty')) : h('div', { className: 'dswfe-outline' }, outline)),
    h('div', { className: 'dswfe-sec' }, h('h4', null, t('diagnostics')), h(DiagList, { t, diagnostics, onJump })))
}

function DetailPane({ state, controller, t }) {
  const item = state.item
  const meta = item && item.meta
  const isUser = meta && meta.source === 'user'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const jump = (line) => { controller.setState({ highlightLine: line }); controller.setTab('yaml') }
  const copyYaml = () => {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(item.yaml).then(() => controller.toast(t('copied'))).catch(() => {})
  }
  const atAgent = () => controller.atAgent(meta)
  if (state.itemLoading) return h('div', { className: 'dswfe-detail' }, t('loading'))
  if (!item || !meta) return h('div', { className: 'dswfe-empty' }, h('div', null, t('emptyDetail')), h('div', { style: { fontSize: 12, opacity: .8 } }, t('selectFirst')))
  return h('div', { className: 'dswfe-detail' },
    h('div', { className: 'dswfe-detail-head' },
      h('h3', { className: 'dswfe-detail-title' }, meta.display_name || meta.name),
      h('div', { className: 'dswfe-actions' },
        isUser ? [
          h('button', { key: 'e', className: 'dswfe-btn', 'data-primary': 'true', onClick: () => controller.editSelected() }, '✎ ' + t('edit')),
          h('button', { key: 'r', className: 'dswfe-btn', onClick: () => controller.setState({ dialog: { type: 'rename', id: meta.id, name: meta.display_name || meta.name } }) }, t('rename')),
          !confirmDelete
            ? h('button', { key: 'd', className: 'dswfe-btn', onClick: () => setConfirmDelete(true) }, '🗑 ' + t('delete'))
            : h('span', { key: 'dc', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
              h('span', { style: { fontSize: 12 } }, t('deleteConfirm') + '？'),
              h('button', { className: 'dswfe-btn', 'data-danger': 'true', onClick: () => { setConfirmDelete(false); controller.removeProcess(meta.id) } }, t('confirm')),
              h('button', { className: 'dswfe-btn', onClick: () => setConfirmDelete(false) }, t('cancel'))),
        ] : [
          h('button', { key: 'c', className: 'dswfe-btn', 'data-primary': 'true', onClick: () => controller.setState({ dialog: { type: 'copy', fromId: meta.id } }) }, '⧉ ' + t('copyToMine')),
        ],
        h('button', { key: 'run', className: 'dswfe-btn', 'data-primary': 'true', title: t('runCreate'), onClick: () => controller.setState({ dialog: { type: 'newrun', processId: meta.id } }) }, t('runCreate')),
        h('button', { key: 'x', className: 'dswfe-btn', onClick: copyYaml }, t('copyYaml')))),
    h('div', { className: 'dswfe-chips' },
      h('span', { className: 'dswfe-chip' }, isUser ? t('mine') : t('readOnly')),
      meta.category ? h('span', { className: 'dswfe-chip' }, t('category') + ': ' + meta.category) : null,
      meta.complexity ? h('span', { className: 'dswfe-chip' }, t('complexity') + ': ' + complexityLabel(t, meta.complexity)) : null,
      meta.version ? h('span', { className: 'dswfe-chip' }, 'v' + meta.version) : null,
      h('span', { className: 'dswfe-chip' }, meta.phaseCount + ' ' + t('phases') + ' · ' + meta.linkCount + ' ' + t('links')),
      item.diagnostics && item.diagnostics.errors.length > 0 ? h('span', { className: 'dswfe-badge', 'data-kind': 'err' }, item.diagnostics.errors.length + t('errOne')) : null,
      item.diagnostics && item.diagnostics.warnings.length > 0 ? h('span', { className: 'dswfe-badge', 'data-kind': 'warn' }, item.diagnostics.warnings.length + t('warnOne')) : null),
    h('div', { className: 'dswfe-tabs' },
      ['overview', 'flow', 'structure', 'yaml'].map((tab) => h('button', { key: tab, className: 'dswfe-tab', 'data-on': state.tab === tab ? 'true' : undefined, onClick: () => controller.setTab(tab) },
        t('tab' + tab[0].toUpperCase() + tab.slice(1))))),
    state.tab === 'overview' ? h(OverviewTab, { t, meta, parsed: item.parsed, diagnostics: item.diagnostics, onJump: jump })
      : state.tab === 'flow' ? h(FlowGraph, { t, parsed: item.parsed })
        : state.tab === 'structure' ? h(StructureTab, { t, parsed: item.parsed })
        : h(YamlView, { yaml: item.yaml, highlightLine: state.highlightLine }))
}

// ── 编辑器 ───────────────────────────────────────────────────────────────

// ── 表单编辑器（v0.4）：与 YAML 实时双向同步 ───────────────────────────
// 单一数据源 = 编辑器文本（ed.text）。表单字段修改：解析当前文本 →
// Document setIn/deleteIn/append → toString 写回 ed.text；YAML 子模式
// 的每次输入同样写回 ed.text——两个视图天然互相同步。

function FormField({ label, children, help }) {
  return h('label', { className: 'dswfe-field' },
    h('span', { className: 'dswfe-field-label' }, label, help ? h(Help, { text: help }) : null),
    children)
}

function FormText({ value, onChange, placeholder, multiline, rows, type }) {
  const style = { width: '100%', fontFamily: type === 'mono' ? 'ui-monospace, Menlo, monospace' : 'var(--dsw-font-family, inherit)', fontSize: 12.5, lineHeight: multiline ? 1.55 : 1.4, border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: 8, padding: multiline ? '7px 9px' : '5px 9px', background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', boxSizing: 'border-box', whiteSpace: multiline ? 'pre-wrap' : undefined }
  return multiline
    ? h('textarea', { value, placeholder: placeholder || '', spellCheck: false, rows: rows || 2, style: Object.assign({ resize: 'vertical' }, style), onChange: (e) => onChange(e.target.value) })
    : h('input', { value, type: type || 'text', placeholder: placeholder || '', spellCheck: false, style, onChange: (e) => onChange(e.target.value) })
}

function FormSelect({ value, onChange, options }) {
  return h('select', { value, onChange: (e) => onChange(e.target.value), style: { width: '100%', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', borderRadius: 8, padding: '5px 8px', font: 'inherit', fontSize: 12.5 } },
    options.map((o) => h('option', { key: o[0], value: o[0] }, o[1])))
}

// ── FormEditor（可视化表单，与 YAML 双向实时同步）─────────────────────────
// 单一数据源 = ed.text：表单改动经 Document API（fmSet 等，注释/未知字段不丢）
// 写回 ed.text；YAML 手改后表单随 useMemo 重新解析实时反映。

function FormField({ label, children, help }) {
  return h('label', { className: 'dswfe-field' },
    h('span', { className: 'dswfe-field-label' }, label, help ? h(Help, { text: help }) : null),
    children)
}

function FormText({ value, onChange, placeholder, mono }) {
  return h('input', { value: String(value ?? ''), spellCheck: false, placeholder,
    style: mono ? { fontFamily: 'ui-monospace, monospace' } : undefined,
    onChange: (e) => onChange(e.target.value) })
}

function FormNum({ value, onChange, placeholder, min }) {
  return h('input', { type: 'number', value: value === null || value === undefined || value === '' ? '' : String(value), min, placeholder, spellCheck: false,
    onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)) })
}

function FormArea({ value, onChange, rows, placeholder }) {
  return h('textarea', { value: String(value ?? ''), rows: rows || 3, spellCheck: false, placeholder,
    onChange: (e) => onChange(e.target.value) })
}

function FormSelect({ value, options, onChange }) {
  const cur = String(value ?? '')
  // 选项既可以是字符串，也可以是 [值, 显示文案]——后者用来把英文枚举显示成中文
  const pairs = options.map((o) => (Array.isArray(o) ? [String(o[0]), o[1]] : [String(o), o]))
  const list = pairs.some((p) => p[0] === cur) ? pairs : [[cur, cur]].concat(pairs)
  return h('select', { value: cur, onChange: (e) => onChange(e.target.value) },
    list.map((p) => h('option', { key: p[0], value: p[0] }, p[1])))
}

// 模型目录 + 技能目录的模块级缓存（跨 form↔yaml 切换、跨编辑器开关复用，不设过期）
const catalogCache = { loaded: false, models: { providers: [] }, skills: [] }
// 画布选中态的模块级记忆：form↔yaml 切换重挂载后按 id 恢复（id 对不上自动回落 global）
let canvasSelMemory = { kind: 'global' }

/** 模型两极下拉：供应商 → 模型（不让手填）。YAML 值 = 'provider/model'；空 = 跟随运行模型。 */
function ModelPicker({ value, catalog, onChange, t }) {
  const raw = String(value ?? '')
  const slash = raw.indexOf('/')
  const curProvider = slash >= 0 ? raw.slice(0, slash) : raw
  const curModel = slash >= 0 ? raw.slice(slash + 1) : ''
  const providers = (catalog.models && catalog.models.providers) || []
  const prov = providers.find((p) => p.id === curProvider)
  const models = prov ? prov.models : []
  const opts = [h('option', { key: '', value: '' }, t('modelDefault'))].concat(
    providers.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
    (curProvider && !prov) ? [h('option', { key: curProvider, value: curProvider }, curProvider)] : [])
  const mopts = [h('option', { key: '', value: '' }, curProvider ? t('modelProvDefault') : t('modelDefault'))].concat(
    models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
    (curModel && (!prov || !models.some((m) => m.id === curModel))) ? [h('option', { key: curModel, value: curModel }, curModel)] : [])
  return h('div', { className: 'dswfe-modelrow' },
    h('select', {
      className: 'dswfe-native-sel', value: curProvider, title: t('formProvider'),
      onChange: (e) => { const p = e.target.value; onChange(p === '' ? null : (models.some((m) => m.id === curModel) ? p + '/' + curModel : p)) },
    }, opts),
    h('select', {
      className: 'dswfe-native-sel', value: curModel, title: '模型', disabled: curProvider === '',
      onChange: (e) => { const m = e.target.value; onChange(curProvider === '' ? null : (m === '' ? curProvider : curProvider + '/' + m)) },
    }, mopts))
}

/** 技能多选下拉：dsh 技能目录（/skills），勾选写回 skills 数组。 */
function SkillPicker({ value, skills, onChange, t }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const arr = Array.isArray(value) ? value.map(String)
    : (value && Array.isArray(value.items)) ? value.items.map((n) => String(n && n.value !== undefined ? n.value : n))
      : []
  const toggle = (name) => onChange(arr.includes(name) ? arr.filter((x) => x !== name) : arr.concat(name))
  return h('div', { className: 'dswfe-skillpick', ref: wrapRef },
    h('button', { type: 'button', className: 'dswfe-selbtn', onClick: () => setOpen(!open), 'data-open': open ? 'true' : undefined },
      h('span', { className: arr.length ? '' : 'dswfe-selph' }, arr.length ? arr.join(', ') : t('skillsPick')),
      h('span', { className: 'dswfe-selcar' }, open ? '▴' : '▾')),
    !open ? null : h('div', { className: 'dswfe-skillpop' },
      (!skills || skills.length === 0) ? h('div', { className: 'dswfe-skillnone' }, t('skillsNone')) :
        skills.map((s) => h('label', { key: s.name, className: 'dswfe-skillrow' },
          h('input', { type: 'checkbox', checked: arr.includes(s.name), onChange: () => toggle(s.name) }),
          h('span', { className: 'dswfe-skillname' }, s.name),
          s.description ? h('span', { className: 'dswfe-skilldesc', title: s.description }, s.description) : null)),
      arr.length ? h('button', { type: 'button', className: 'dswfe-skillclear', onClick: () => onChange([]) }, t('skillsClear', { n: arr.length })) : null))
}

function FormEditor({ state, controller, t, ed }) {
  const doc = useMemo(() => fmDoc(ed.text), [ed.text])
  // 画布选中态：{kind:'global'} | {kind:'phase', id} | {kind:'link', id}。
  // 只存 id：编辑导致索引漂移时按 id 重扫，找不到（刚删掉）回落 global。
  const [sel, setSelState] = useState(() => canvasSelMemory)
  const setSel = (s) => { canvasSelMemory = s; setSelState(s) }
  // 模型目录 + dsh 技能目录（模块级缓存，编辑器每次挂载只拉一次）
  const [catalog, setCatalog] = useState(() => catalogCache)
  useEffect(() => {
    if (catalogCache.loaded) return
    let live = true
    Promise.all([api('/models').catch(() => null), api('/skills').catch(() => null)]).then(([m, s]) => {
      catalogCache.models = m || { providers: [] }
      catalogCache.skills = s && Array.isArray(s.skills) ? s.skills : []
      catalogCache.loaded = true
      if (live) setCatalog({ ...catalogCache })
    })
    return () => { live = false }
  }, [])
  if (!doc) {
    return h('div', { className: 'dswfe-form' },
      h('div', { className: 'dswfe-error' }, t('formUnparseable')))
  }
  const P = (path, dflt) => { const v = doc.getIn(path); return v === undefined || v === null ? dflt : v }
  const set = (path, value) => controller.setEditorText(fmSet(ed.text, path, value))

  const phaseCount = fmSeqLen(doc, ['phases'])
  const allLinkIds = []
  for (let pi = 0; pi < phaseCount; pi++) {
    const lc = fmSeqLen(doc, ['phases', pi, 'links'])
    for (let li = 0; li < lc; li++) {
      const id = P(['phases', pi, 'links', li, 'id'], '')
      if (id) allLinkIds.push(String(id))
    }
  }
  // 流转下拉：关键字显示中文；目标只列 goto:<id> 一种写法——引擎里 parseFlow 会剥掉 goto: 前缀，
  // 裸 <id> 与 goto:<id> 完全等价，之前两种都列出来才让人看不懂。当前值若是裸 id，就地补一条
  // 本地化文案（不静默改用户数据）。
  const linkMeta = []
  for (let pi = 0; pi < phaseCount; pi++) {
    const lc = fmSeqLen(doc, ['phases', pi, 'links'])
    for (let li = 0; li < lc; li++) {
      const id = String(P(['phases', pi, 'links', li, 'id'], '') || '')
      if (!id) continue
      linkMeta.push({ id, no: linkMeta.length + 1, name: String(P(['phases', pi, 'links', li, 'name'], '') || '') })
    }
  }
  const jumpLabel = (id) => {
    const m = linkMeta.find((x) => x.id === id)
    return m ? t('flowJumpTo', { no: m.no, name: m.name || m.id }) : t('flowJumpTo', { no: linkMeta.length + 1, name: id })
  }
  const flowOptions = (fixed, cur) => {
    const head = fixed.map((v) => [v, v === 'next' ? t('flowNext') : v === 'end' ? t('flowEnd') : v === 'break' ? t('flowBreakStop') : v])
    const raw = String(cur == null ? '' : cur)
    // 同一条目标只出现一次：当前值本来就是裸 id 时，这条目标就用裸 id 作值（不静默改用户数据也不重复列）
    const jumps = linkMeta.map((m) => [raw === m.id ? m.id : 'goto:' + m.id, jumpLabel(m.id)])
    if (raw && !head.some((p) => p[0] === raw) && !jumps.some((p) => p[0] === raw)) jumps.push([raw, jumpLabel(raw.replace(/^goto:/, ''))])
    return head.concat(jumps)
  }

  // ── 选中解析：按 id 重扫定位索引 ──
  const linkIdAt = (pi, li) => String(P(['phases', pi, 'links', li, 'id'], '') || '')
  const phaseIdAt = (pi) => String(P(['phases', pi, 'id'], '') || '')
  const R = (() => {
    if (sel.kind === 'global') return { kind: 'global' }
    for (let pi = 0; pi < phaseCount; pi++) {
      if (sel.kind === 'phase' && phaseIdAt(pi) === sel.id) return { kind: 'phase', pi }
      const lc = fmSeqLen(doc, ['phases', pi, 'links'])
      for (let li = 0; li < lc; li++) {
        if (sel.kind === 'link' && linkIdAt(pi, li) === sel.id) return { kind: 'link', pi, li }
      }
    }
    return { kind: 'global' }
  })()

  const addPhase = () => {
    let n = phaseCount + 1
    let pid = 'phase-' + n
    while (allLinkIds.some((id) => id.startsWith(pid))) { n += 1; pid = 'phase-' + n }
    controller.setEditorText(fmAppend(ed.text, ['phases'], { id: pid, name: '', spec: '', links: [] }))
    setSel({ kind: 'phase', id: pid })
  }
  const addLink = (pi) => {
    let n = allLinkIds.length + 1
    let lid = 'link-' + n
    while (allLinkIds.includes(lid)) { n += 1; lid = 'link-' + n }
    controller.setEditorText(fmAppend(ed.text, ['phases', pi, 'links'], {
      id: lid, name: t('formNewLinkName'), prompt: '', executor: null, expert: null, skills: [],
      model: null, review_type: 'ai', gates: [], on_success: 'next', on_gate_fail: 'break',
      on_rating_fail: 'break', max_rework: null,
    }))
    setSel({ kind: 'link', id: lid })
  }
  const delPhase = (pi) => {
    const name = String(P(['phases', pi, 'name'], '') || phaseIdAt(pi) || '#' + (pi + 1))
    const n = fmSeqLen(doc, ['phases', pi, 'links'])
    if (!window.confirm(t('canvasDelPhase', { name, n }))) return
    controller.setEditorText(fmDeletePhase(ed.text, pi))
    setSel({ kind: 'global' })
  }
  const delLink = (pi, li) => {
    const name = String(P(['phases', pi, 'links', li, 'name'], '') || linkIdAt(pi, li))
    if (!window.confirm(t('canvasDelLink', { name }))) return
    controller.setEditorText(fmDeleteLink(ed.text, pi, li))
    setSel({ kind: 'global' })
  }

  // ── 左：画布 ──
  const lane = (pi) => {
    const pid = phaseIdAt(pi)
    const pname = String(P(['phases', pi, 'name'], '') || pid)
    const lc = fmSeqLen(doc, ['phases', pi, 'links'])
    const phaseSel = R.kind === 'phase' && R.pi === pi
    const chipKids = []
    for (let li = 0; li < lc; li++) {
      const lid = linkIdAt(pi, li)
      const lname = String(P(['phases', pi, 'links', li, 'name'], '') || lid)
      const gateCount = fmSeqLen(doc, ['phases', pi, 'links', li, 'gates'])
      const isSel = R.kind === 'link' && R.pi === pi && R.li === li
      if (li > 0) chipKids.push(h('span', { className: 'dswfe-node-arrow', key: 'ar' + li }, '→'))
      chipKids.push(h('div', {
        key: 'nd' + li, className: 'dswfe-node', 'data-sel': isSel ? 'true' : undefined,
        onClick: (e) => { e.stopPropagation(); setSel({ kind: 'link', id: lid }) },
      },
        h('div', { className: 'dswfe-node-name' }, lname),
        h('div', { className: 'dswfe-node-meta' },
          h('span', { className: 'dswfe-node-id' }, lid),
          gateCount > 0 ? h('span', { className: 'dswfe-node-badge' }, '🔒' + gateCount) : null)),
      )
    }
    chipKids.push(h('button', {
      key: 'addlk', className: 'dswfe-node-add', title: t('formAddLink'),
      onClick: (e) => { e.stopPropagation(); addLink(pi) },
    }, '＋'))
    return h('div', { className: 'dswfe-lane', key: 'ph' + pi, 'data-sel': phaseSel ? 'true' : undefined },
      h('div', { className: 'dswfe-lane-head', onClick: () => setSel({ kind: 'phase', id: pid }) },
        h('span', { className: 'dswfe-lane-no', style: { background: flowPhaseColor(pid) } }, '#' + (pi + 1)),
        h('span', { className: 'dswfe-lane-name' }, pname),
        h('span', { className: 'dswfe-lane-id' }, pid),
        h('span', { className: 'dswfe-lane-count' }, lc + t('links'))),
      h('div', { className: 'dswfe-lane-body' }, chipKids))
  }

  const laneKids = []
  for (let pi = 0; pi < phaseCount; pi++) laneKids.push(lane(pi))

  const canvas = h('div', {
    className: 'dswfe-canvas-left',
    onClick: (e) => { if (e.target === e.currentTarget) setSel({ kind: 'global' }) },
  },
    h('div', { className: 'dswfe-canvas-bar' },
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: addPhase }, t('formAddPhase')),
      h('span', { className: 'dswfe-canvas-hint' }, h(Help, { text: t('helpCanvas') }))),
    phaseCount === 0 ? h('div', { className: 'dswfe-canvas-empty' }, t('canvasEmpty')) : null,
    h('div', null, laneKids))

  // ── 右：属性面板 ──
  const sec = (title, extra) => h('div', { className: 'dswfe-fsec' },
    h('h4', null, title), extra || null)

  const propsGlobal = [
    sec(t('propGlobal')),
    h('div', { className: 'dswfe-fsec', key: 'basic' },
      h('div', { className: 'dswfe-fgrid' },
        h(FormField, { label: t('formDisplayName') }, h(FormText, { value: P(['process', 'display_name'], ''), onChange: (v) => set(['process', 'display_name'], v) })),
        h(FormField, { label: t('formVersion') }, h(FormText, { value: P(['process', 'version'], ''), onChange: (v) => set(['process', 'version'], v) })),
        h(FormField, { label: t('formCategory') }, h(FormText, { value: P(['process', 'category'], ''), onChange: (v) => set(['process', 'category'], v) })),
        h(FormField, { label: t('formComplexity') }, h(FormSelect, { value: P(['process', 'complexity'], 'medium'), options: [['low', t('cxLow')], ['medium', t('cxMid')], ['high', t('cxHigh')]], onChange: (v) => set(['process', 'complexity'], v) }))),
      h('div', { style: { height: 8 } }),
      h(FormField, { label: t('formDescription') }, h(FormArea, { value: P(['process', 'description'], ''), rows: 5, onChange: (v) => set(['process', 'description'], v) }))),
    sec(t('formLimits')),
    h('div', { className: 'dswfe-fsec', key: 'limits' },
      h('div', { className: 'dswfe-fgrid' },
        h(FormField, { label: t('formMaxSteps') }, h(FormNum, { value: P(['limits', 'max_step_executions'], null), min: 1, onChange: (v) => set(['limits', 'max_step_executions'], v) })),
        h(FormField, { label: t('formMaxTokens') }, h(FormNum, { value: P(['limits', 'max_total_tokens'], null), min: 1, onChange: (v) => set(['limits', 'max_total_tokens'], v) }))))
  ]

  const propsPhase = (pi) => [
    sec(t('propPhase') + ' · #' + (pi + 1),
      h('button', { className: 'dswfe-btn', 'data-danger': 'true', style: { marginLeft: 'auto' }, onClick: () => delPhase(pi) }, t('formDelPhase'))),
    h('div', { className: 'dswfe-fsec', key: 'meta' },
      h('div', { className: 'dswfe-fgrid' },
        h(FormField, { label: 'id' }, h(FormText, { value: phaseIdAt(pi), mono: true, onChange: (v) => { if (v.trim() !== '') { set(['phases', pi, 'id'], v.trim()); setSel({ kind: 'phase', id: v.trim() }) } } })),
        h(FormField, { label: t('formPhaseName') }, h(FormText, { value: P(['phases', pi, 'name'], ''), placeholder: t('formPhaseName'), onChange: (v) => set(['phases', pi, 'name'], v) }))),
      h(FormField, { label: t('formPhaseSpec'), style: { marginTop: 6 } }, h(FormArea, { value: P(['phases', pi, 'spec'], ''), rows: 4, onChange: (v) => set(['phases', pi, 'spec'], v) })))
  ]

  const propsLink = (pi, li) => {
    const lp = ['phases', pi, 'links', li]
    const gatesPath = [...lp, 'gates']
    const gateCount = fmSeqLen(doc, gatesPath)
    // 执行器/专家：运行时都不读（只影响 prompt 措辞），面板已隐藏；YAML 里的旧字段仍能解析
    const metaFields = [
      ['id', 'id', true], [t('formName'), 'name', false],
    ]
    const gridKids = metaFields.map(([label, key, mono], i) => h(FormField, { label, key: 'm' + i },
      h(FormText, {
        value: key === 'id' ? linkIdAt(pi, li) : P([...lp, key], ''),
        mono,
        placeholder: key === 'id' ? 'req-01' : undefined,
        onChange: (v) => {
          if (key === 'id') {
            if (v.trim() !== '') { controller.setEditorText(fmSetLinkId(ed.text, pi, li, v.trim())); setSel({ kind: 'link', id: v.trim() }) }
          }
          else set([...lp, key], v === '' ? null : v)
        },
      })))
    gridKids.push(h(FormField, { label: t('formReviewType'), key: 'rt', help: t('helpReviewType') },
      h(FormSelect, { value: P([...lp, 'review_type'], 'ai'), options: [['ai', t('reviewAi')], ['human', t('reviewHuman')], ['none', t('reviewNone')]], onChange: (v) => set([...lp, 'review_type'], v) })))
    gridKids.push(h(FormField, { label: t('formMaxRework'), key: 'mr' },
      h(FormNum, { value: P([...lp, 'max_rework'], null), min: 0, onChange: (v) => set([...lp, 'max_rework'], v) })))

    const gateKids = []
    gateKids.push(h('div', { style: { display: 'flex', alignItems: 'center', margin: '6px 0' }, key: 'ghd' },
      h('b', { style: { fontSize: 12, letterSpacing: '.02em' } }, t('formGates'), h(Help, { text: t('helpGates') })),
      h('button', { className: 'dswfe-btn', style: { marginLeft: 'auto' }, onClick: () => controller.setEditorText(fmAppend(ed.text, gatesPath, { name: '', type: 'ai_criteria_review', min_score: 80 })) }, t('formAddGate'))))
    for (let gi = 0; gi < gateCount; gi++) {
      const gp = [...gatesPath, gi]
      gateKids.push(h('div', { className: 'dswfe-fgrid', key: 'g' + gi, style: { alignItems: 'end' } },
        h(FormField, { label: t('formGateName') }, h(FormText, { value: P([...gp, 'name'], ''), onChange: (v) => set([...gp, 'name'], v) })),
        h(FormField, { label: t('formGateMin'), help: t('helpGateMin') }, h(FormNum, { value: P([...gp, 'min_score'], null), min: 0, onChange: (v) => set([...gp, 'min_score'], v) })),
        h('button', { className: 'dswfe-btn', 'data-danger': 'true', onClick: () => controller.setEditorText(fmDel(ed.text, gp)) }, '✕')))
    }

    return [
      sec(t('propLink'),
        h('button', { className: 'dswfe-btn', 'data-danger': 'true', style: { marginLeft: 'auto' }, onClick: () => delLink(pi, li) }, t('formDelLink'))),
      h('div', { className: 'dswfe-fgrid', key: 'meta' }, gridKids),
      h(FormField, { label: t('formPrompt'), key: 'prompt', help: t('helpPrompt') },
        h(FormArea, { value: P([...lp, 'prompt'], ''), rows: 6, onChange: (v) => set([...lp, 'prompt'], v) })),
      h(FormField, { label: t('formAcceptance'), key: 'acc', help: t('helpAcceptance') },
        h(FormArea, { value: P([...lp, 'acceptance_criteria'], ''), rows: 2, onChange: (v) => set([...lp, 'acceptance_criteria'], v) })),
      h('div', { className: 'dswfe-fgrid', style: { marginTop: 6 }, key: 'flow' },
        h(FormField, { label: t('formOnSuccess') }, h(FormSelect, { value: P([...lp, 'on_success'], 'next'), options: flowOptions(['next', 'end'], P([...lp, 'on_success'], 'next')), onChange: (v) => set([...lp, 'on_success'], v) })),
        h(FormField, { label: t('formOnGateFail') }, h(FormSelect, { value: P([...lp, 'on_gate_fail'], 'break'), options: flowOptions(['break'], P([...lp, 'on_gate_fail'], 'break')), onChange: (v) => set([...lp, 'on_gate_fail'], v) }))),
      h('div', { className: 'dswfe-fgates', key: 'gates' }, gateKids),
    ]
  }

  const propsKids = R.kind === 'phase' ? propsPhase(R.pi)
    : R.kind === 'link' ? propsLink(R.pi, R.li)
      : propsGlobal

  return h('div', { className: 'dswfe-canvas' },
    canvas,
    h('div', { className: 'dswfe-props' }, propsKids))
}


function EditorPane({ state, controller, t }) {
  const ed = state.editor
  const taRef = useRef(null)
  const gutterRef = useRef(null)
  // 子模式：'form'（画布：左节点图+右属性面板）| 'yaml'（YAML 文本）——同一份 ed.text 双向实时同步
  const [subMode, setSubMode] = useState('form')
  const docOk = useMemo(() => !!fmDoc(ed ? ed.text : ''), [ed && ed.text])
  const mode = subMode === 'form' && !docOk ? 'yaml' : subMode
  if (!ed) return null
  const lines = ed.text.split('\n')
  const diag = ed.diagnostics || { errors: [], warnings: [] }
  const errCount = diag.errors.length
  const warnCount = diag.warnings.length
  const onScroll = () => { if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop }
  const jump = (line) => {
    const ta = taRef.current
    if (!ta) return
    const pos = lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0)
    ta.focus()
    ta.setSelectionRange(pos, pos)
    ta.scrollTop = Math.max(0, (line - 6) * 19)
  }
  const onKeyDown = (e) => {
    const ta = taRef.current
    if (!ta) return
    if (e.key === 'Tab') {
      e.preventDefault()
      const s = ta.selectionStart
      const next = ed.text.slice(0, s) + '  ' + ed.text.slice(ta.selectionEnd)
      controller.setEditorText(next)
      requestAnimationFrame(() => { ta.setSelectionRange(s + 2, s + 2) })
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      void controller.saveEditor(false)
    }
  }
  return h('div', { className: 'dswfe-detail dswfe-editor' },
    h('div', { className: 'dswfe-detail-head' },
      h('h3', { className: 'dswfe-detail-title' }, (ed.mode === 'create' ? t('editorCreate') : t('editorTitle')) + (ed.name ? '：' + ed.name : '')),
      h('div', { className: 'dswfe-tabs', style: { borderBottom: 'none', margin: '0 6px 0 0' } },
        h('button', { className: 'dswfe-tab', 'data-on': mode === 'form' ? 'true' : undefined, onClick: () => setSubMode('form'), disabled: !docOk, title: !docOk ? t('formUnparseable') : undefined }, t('formMode')),
        h('button', { className: 'dswfe-tab', 'data-on': mode === 'yaml' ? 'true' : undefined, onClick: () => setSubMode('yaml') }, t('yamlMode'))),
      h('div', { className: 'dswfe-actions' },
        ed.dirty ? h('span', { className: 'dswfe-badge', 'data-kind': 'warn' }, t('unsaved')) : null,
        h('button', { className: 'dswfe-btn', onClick: () => void controller.validateEditor(), disabled: ed.busy }, '✓ ' + t('validate')),
        h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: () => void controller.saveEditor(false), disabled: ed.busy || errCount > 0 }, '💾 ' + t('save')),
        h('button', { className: 'dswfe-btn', onClick: () => controller.requestCloseEditor() }, t('cancel')))),
    ed.conflict ? h('div', { className: 'dswfe-conflict' },
      h('span', null, '⚠ ' + t('saveConflict') + ' ' + t('forcedHint')),
      h('button', { className: 'dswfe-btn', onClick: () => void controller.reloadEditor() }, t('reload')),
      h('button', { className: 'dswfe-btn', 'data-danger': 'true', onClick: () => void controller.saveEditor(true) }, t('overwrite'))) : null,
    ed.error ? h('div', { className: 'dswfe-error' }, ed.error) : null,
    mode === 'form'
      ? h(FormEditor, { state, controller, t, ed })
      : h('div', { className: 'dswfe-editor-wrap' },
        h('div', { className: 'dswfe-gutter', ref: gutterRef }, lines.map((_, i) => h('div', { key: i }, i + 1))),
        h('textarea', {
          className: 'dswfe-textarea', ref: taRef, value: ed.text, spellCheck: false,
          onChange: (e) => controller.setEditorText(e.target.value),
          onScroll, onKeyDown,
        })),
    h('div', { className: 'dswfe-status' },
      h('span', null, t('linesCount', { n: lines.length })),
      ed.dirty ? null : h('span', null, t('saved')),
      ed.validatedAt ? h('span', { style: { opacity: .6 } }, '✓ ' + new Date(ed.validatedAt).toLocaleTimeString()) : null,
      errCount > 0 ? h('span', { className: 'dswfe-badge', 'data-kind': 'err' }, errCount + t('errOne')) : null,
      warnCount > 0 ? h('span', { className: 'dswfe-badge', 'data-kind': 'warn' }, warnCount + t('warnOne')) : null,
      errCount === 0 && warnCount === 0 && !ed.dirty ? h('span', { style: { opacity: .7 } }, t('noIssues')) : null),
    (errCount > 0 || warnCount > 0) ? h(DiagList, { t, diagnostics: diag, onJump: jump }) : null)
}

// ── 弹窗 ─────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return h('div', { className: 'dswfe-modal-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('div', { className: 'dswfe-modal', style: width ? { width: 'min(' + width + 'px, 94vw)' } : undefined, role: 'dialog', 'aria-modal': 'true' },
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('h3', null, title),
        h('button', { className: 'dswfe-btn', style: { marginLeft: 'auto', width: 28, height: 28, padding: 0, borderRadius: 28 }, onClick: onClose }, '✕')),
      children))
}

function FieldInput({ label, value, onChange, placeholder, type }) {
  return h('label', { className: 'dswfe-field' }, label,
    h('input', { value, type: type || 'text', placeholder, spellCheck: false, onChange: (e) => onChange(e.target.value) }))
}

function CreateDialog({ state, controller, t }) {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [display, setDisplay] = useState('')
  const ok = /^[^\\/\0\r\n.][^\\/\0\r\n]{0,79}$/.test(name.trim())
  return h(Modal, { title: t('editorCreate'), onClose: () => controller.setState({ dialog: null }) },
    h(FieldInput, { label: t('createName'), value: name, onChange: setName, placeholder: 'my-process' }),
    h(FieldInput, { label: t('createDir'), value: dir, onChange: setDir, placeholder: 'software' }),
    h(FieldInput, { label: t('createDisplayName'), value: display, onChange: setDisplay }),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', disabled: !ok || name.trim() === '', onClick: () => void controller.createBlank(name.trim(), dir.trim(), display.trim()) }, t('confirm'))),
    !ok && name.trim() !== '' ? h('div', { className: 'dswfe-error' }, t('nameRule')) : null)
}

function CopyDialog({ state, controller, t }) {
  const dlg = state.dialog
  const from = dlg && dlg.fromId ? state.processes.find((p) => p.id === dlg.fromId) : undefined
  const [name, setName] = useState(from ? from.fileName + '-copy' : '')
  const [dir, setDir] = useState(from && from.source === 'user' ? (from.relPath.includes('/') ? from.relPath.split('/').slice(0, -1).join('/') : '') : '')
  return h(Modal, { title: t('editorCopy'), onClose: () => controller.setState({ dialog: null }) },
    h('div', { className: 'dswfe-kv' }, h('b', null, t('name') + ':'), from ? (from.display_name || from.name) + '（' + from.relPath + '）' : '—'),
    h(FieldInput, { label: t('copyName'), value: name, onChange: setName, placeholder: 'my-process' }),
    h(FieldInput, { label: t('createDir'), value: dir, onChange: setDir }),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', disabled: !from || name.trim() === '', onClick: () => void controller.copyProcess(from.id, name.trim(), dir.trim()) }, t('copy'))))
}

function RenameDialog({ state, controller, t }) {
  const dlg = state.dialog
  const [name, setName] = useState(dlg ? dlg.name : '')
  return h(Modal, { title: t('renameTitle'), onClose: () => controller.setState({ dialog: null }) },
    h(FieldInput, { label: t('newName'), value: name, onChange: setName }),
    h('div', { style: { fontSize: 12, opacity: .7 } }, t('renameHint')),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', disabled: name.trim() === '', onClick: () => void controller.renameProcess(dlg.id, name.trim()) }, t('confirm'))))
}

function ConfirmDialog({ state, controller, t }) {
  const dlg = state.dialog
  return h(Modal, { title: t('confirm'), onClose: () => controller.setState({ dialog: null }) },
    h('div', null, dlg.message),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, dlg.yes === 'discard' ? t('keepEditing') : t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-danger': dlg.danger ? 'true' : undefined, onClick: () => dlg.onYes() }, dlg.yes === 'discard' ? t('discard') : t('confirm'))))
}

function ImportDialog({ state, controller, t }) {
  const [over, setOver] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const doImport = async (fileList) => {
    const files = []
    for (const f of fileList) {
      if (f.size > 1024 * 1024) { files.push({ name: f.name, content: '' }); continue }
      // eslint-disable-next-line no-await-in-loop
      files.push({ name: f.name, content: await f.text() })
    }
    setBusy(true)
    try {
      const r = await controller.importFiles(files, over)
      setResults(r)
      controller.toast(t('toastImported', { n: r.filter((x) => x.status === 'created' || x.status === 'overwritten').length }))
    } catch (error) { controller.toast(String(error && error.message || error), 'err') } finally { setBusy(false) }
  }
  const statusLabel = { created: t('importCreated'), overwritten: t('importOverwritten'), exists: t('importExists'), invalid: t('importInvalid') }
  return h(Modal, { title: t('importTitle'), onClose: () => controller.setState({ dialog: null }), width: 620 },
    h('div', null, t('importHint')),
    h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
      h('input', { type: 'checkbox', checked: over, onChange: (e) => setOver(e.target.checked) }), t('importOverwrite')),
    h('div', {
      className: 'dswfe-drop', 'data-over': dragOver ? 'true' : undefined,
      onDragOver: (e) => { e.preventDefault(); setDragOver(true) },
      onDragLeave: () => setDragOver(false),
      onDrop: (e) => { e.preventDefault(); setDragOver(false); if (!busy) void doImport(Array.from(e.dataTransfer.files)) },
    },
      t('importHint'),
      h('div', { style: { marginTop: 10 } },
        h('input', { type: 'file', accept: '.yaml,.yml', multiple: true, disabled: busy, onChange: (e) => { const list = Array.from(e.target.files || []); e.target.value = ''; if (!busy) void doImport(list) } }))),
    busy ? h('div', null, t('loading')) : null,
    results ? h('div', { className: 'dswfe-diag' },
      h('div', { style: { fontWeight: 600 } }, t('importResults')),
      results.map((r, i) => h('div', { key: i, style: { display: 'flex', gap: 8, fontSize: 12 } },
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
        h('span', { style: { color: r.status === 'created' || r.status === 'overwritten' ? 'var(--dsw-alias-state-success, #2e9e5b)' : r.status === 'invalid' ? 'var(--dsw-alias-state-error, #c75050)' : 'inherit' } },
          statusLabel[r.status] || r.status),
        r.errors && r.errors.length ? h('span', { style: { opacity: .7 } }, r.errors[0].message) : null))) : null)
}

function SettingsDialog({ state, controller, t }) {
  const [form, setForm] = useState(state.settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!state.settings) void controller.loadSettings() }, [])
  useEffect(() => { if (state.settings && !form) setForm(state.settings) }, [state.settings])
  if (!form) return h(Modal, { title: t('settingsTitle'), onClose: () => controller.setState({ dialog: null }) }, t('loading'))
  const set = (k) => (v) => setForm({ ...form, [k]: v })
  return h(Modal, { title: t('settingsTitle'), onClose: () => controller.setState({ dialog: null }) },
    h(FieldInput, { label: t('settingsUserRoot'), value: form.userRoot, onChange: set('userRoot') }),
    h(FieldInput, { label: t('settingsBundledRoot'), value: form.bundledRoot, onChange: set('bundledRoot') }),
    h('label', { className: 'dswfe-field' }, t('settingsMaxDepth'),
      h('select', { value: String(form.maxDepth), onChange: (e) => set('maxDepth')(Number(e.target.value)) },
        [1, 2, 3, 4, 5, 6].map((n) => h('option', { key: n, value: n }, n)))),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', disabled: busy, onClick: async () => {
        setBusy(true)
        try { await controller.saveSettings(form); controller.toast(t('settingsSaved')); controller.setState({ dialog: null }) }
        catch (error) { controller.toast(String(error && error.message || error), 'err') } finally { setBusy(false) }
      } }, t('save'))))
}

// ── ⚡ AI 生成（kit ActionShareDialog + completedView 预览确认） ────────────

const AI_PROMPT = `请为下面的需求设计一个工作流（Process：多阶段 phase、多环节 link 的 agent 工作流模板），输出严格的 YAML。

需求：{{requirement}}
复杂度：{{complexity}}
{{reference}}

硬性要求：
1. 只输出一个 \`\`\`yaml 代码块，不要任何其他解释文字。
2. 顶层结构：process（name / guid：生成一个 uuid v4 / display_name / description / category: software / complexity / version: 1.0.0）+ limits（max_step_executions / max_total_tokens，可为 null）+ abnormal_handler（可为 null）+ phases 列表。
3. 每个 phase：id、name、spec、acceptance_criteria、links 列表。每个 link：id（全工作流唯一，建议简短助记如 req-01）、name、prompt（明确可执行的指令，含产物落点）、executor、expert（专家库里的名字，不确定就 null）、skills（列表）、expected_artifacts（[{name, type: file, path}]）、gates（[{name, type: ai_criteria_review, min_score}]，可选）、on_success（next / end / <环节id>）、on_gate_fail（break / <环节id> / goto:<环节id>）、on_rating_fail: break、max_rework（0-3）。
4. on_success / on_gate_fail 引用的环节 id 必须真实存在；最后一步用 on_success: end。
5. 阶段数量与环节粒度贴合复杂度：轻需求 1-2 阶段 3-6 环节；复杂需求 3+ 阶段。`

function AiPreview({ controller, t, output, close }) {
  const parsedBlock = useMemo(() => {
    const blocks = [...String(output || '').matchAll(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/g)]
    if (blocks.length > 0) return blocks[blocks.length - 1][1].trim()
    const s = String(output || '').trim()
    return s.startsWith('process:') || s.startsWith('#') ? s : ''
  }, [output])
  const [yaml, setYaml] = useState(parsedBlock)
  const [diag, setDiag] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!yaml) { setDiag(null); return }
    let live = true
    api('/validate', { method: 'POST', body: { yaml } }).then((d) => { if (live) setDiag({ errors: d.errors, warnings: d.warnings, meta: d.meta }) }).catch(() => {})
    return () => { live = false }
  }, [yaml])
  useEffect(() => {
    if (diag && diag.meta && diag.meta.name && !name) setName(diag.meta.name)
  }, [diag])
  if (!parsedBlock) {
    return h('div', null, h('div', { className: 'dswfe-error' }, t('aiParseFail')), h('pre', { className: 'dswfe-pre', style: { maxHeight: 200 } }, String(output || '')))
  }
  const errCount = diag ? diag.errors.length : 0
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 'min(680px, 80vw)' } },
    h('div', { style: { fontWeight: 600 } }, t('aiPreviewTitle')),
    h('textarea', { value: yaml, onChange: (e) => setYaml(e.target.value), spellCheck: false, style: { minHeight: 260, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: 8, padding: 8, background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', whiteSpace: 'pre' } }),
    diag ? h(DiagList, { t, diagnostics: diag, onJump: () => {} }) : h('div', { style: { fontSize: 12, opacity: .7 } }, t('validating')),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('input', { value: name, onChange: (e) => setName(e.target.value), placeholder: t('aiSaveName'), spellCheck: false, style: { flex: 1, border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', borderRadius: 8, padding: '6px 10px', font: 'inherit' } }),
      h('button', {
        className: 'dswfe-btn', 'data-primary': 'true', disabled: busy || errCount > 0 || name.trim() === '',
        onClick: async () => {
          setBusy(true)
          try {
            const result = await api('/save', { method: 'POST', body: { mode: 'create', name: name.trim(), yaml } })
            await controller.refresh()
            controller.select(result.id)
            controller.toast(t('toastAiSaved'))
            close()
          } catch (error) { controller.toast(String(error && error.message || error), 'err') } finally { setBusy(false) }
        },
      }, t('aiSave'))))
}

function AiDialog({ state, controller, t }) {
  const Dialog = useMemo(() => { const kit = getKit(); return kit ? kit.makeActionShareDialog(ReactGlobal || __React, {}) : null }, [])
  if (!Dialog) return h(Modal, { title: t('aiTitle'), onClose: () => controller.setState({ dialog: null }) }, h('div', { className: 'dswfe-error' }, t('kitMissing')))
  return h(Dialog, {
    title: '⚡ ' + t('aiTitle'),
    hint: t('aiHint'),
    params: [
      { key: 'requirement', label: t('aiRequirement'), multiline: true, placeholder: t('aiRequirementPh') },
      { key: 'complexity', label: t('aiComplexity'), placeholder: 'medium' },
      { key: 'reference', label: t('aiReference'), placeholder: '' },
    ],
    initialPrompt: AI_PROMPT,
    run: (prompt) => controller.aiRun(prompt).then((jobId) => ({ jobId })),
    poll: (jobId) => controller.aiPoll(jobId),
    labels: { run: t('aiBtn'), running: t('aiRunning'), done: t('aiDone'), failed: t('aiFailed'), copy: t('copyPrompt'), copied: t('copied'), outputLabel: t('aiOutput'), openSession: t('openSession') },
    onOpenSession: (sessionId) => controller.openSession(sessionId),
    completedView: ({ job, output, close }) => h(AiPreview, { controller, t, output, close }),
    onClose: () => controller.setState({ dialog: null }),
  })
}

// ── 面板根 ───────────────────────────────────────────────────────────────

function ProcessPanel({ controller, t, slotProps }) {
  const state = useControllerState(controller)
  // 当前会话变化（点侧栏会话行/新会话）→ 关面板
  const useSess = slotProps && slotProps.useSessions
  const current = useSess ? useSess((s) => s.current) : undefined
  const prevCurrent = useRef(current)
  useEffect(() => {
    if (prevCurrent.current !== current && prevCurrent.current !== undefined && controller.getSnapshot().panelOpen) controller.closePanel()
    prevCurrent.current = current
  }, [current])
  // Esc 关面板（弹窗自己处理 Esc，开着弹窗时不抢）
  useEffect(() => {
    if (!state.panelOpen) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      const s = controller.getSnapshot()
      if (s.dialog) return
      // 编辑器里按 Esc 先离开文本框（再按一次才关面板）；其他地方直接关
      if (e.target && e.target.tagName === 'TEXTAREA') { e.target.blur(); return }
      controller.closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state.panelOpen])
  // 中栏接管开合：panelOpen ↔ html[data-dswfe-active]（useLayoutEffect：开/关都在绘制前生效）
  useLayoutEffect(() => {
    try {
      if (state.panelOpen) {
        for (const attr of PRC_OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
        document.documentElement.setAttribute(PRC_ACTIVE_ATTR, '')
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      } else {
        document.documentElement.removeAttribute(PRC_ACTIVE_ATTR)
      }
    } catch {}
  }, [state.panelOpen])
  // 点侧栏会话行自动关面板（自家入口子树豁免）
  useEffect(() => {
    const onClickRow = (e) => {
      if (!controller.getSnapshot().panelOpen) return
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('[' + ENTRY_ATTR + ']')) return
      if (target.closest(PRC_SIDEBAR_ROW_SELECTOR) || target.closest(PRC_SIDEBAR_COLUMN_SELECTOR)) controller.closePanel()
    }
    document.addEventListener('click', onClickRow, true)
    return () => document.removeEventListener('click', onClickRow, true)
  }, [controller])
  if (!state.panelOpen) return null
  const detail = state.editor ? h(EditorPane, { state, controller, t }) : h(DetailPane, { state, controller, t })
  return h('div', { className: 'dswfe-panel', 'data-dswfe-panel': '' },
    h(Toolbar, { state, controller, t }),
    state.error ? h('div', { className: 'dswfe-error' }, state.error) : null,
    state.lastError ? h('div', { className: 'dswfe-error' }, 'store: ' + state.lastError) : null,
    h('div', { className: 'dswfe-body' },
      state.view === 'exec' ? h(ExecView, { state, controller, t }) : h('div', { style: { display: 'contents' } }, h(ListPane, { state, controller, t }), detail)),
    state.dialog && state.dialog.type === 'create' ? h(CreateDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'copy' ? h(CopyDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'rename' ? h(RenameDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'confirm' ? h(ConfirmDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'import' ? h(ImportDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'settings' ? h(SettingsDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'ai' ? h(AiDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'newrun' ? h(NewRunDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'fileview' ? h(FileViewDialog, { state, controller, t }) : null,
    state.dialog && state.dialog.type === 'linkfiles' ? h(LinkFilesDialog, { state, controller, t }) : null,
    state.toast ? h('div', { className: 'dswfe-toast', 'data-kind': state.toast.kind }, state.toast.text) : null)
}

// ── 执行视图（v0.2）─────────────────────────────────────────────────────

const LINK_STATE_KEY = { running: 'linkRunning', done: 'linkDone', gate_failed: 'linkGateFailed', skipped: 'linkSkipped', failed: 'linkFailed', abandoned: 'linkAbandoned', awaiting_review: 'linkAwaitingReview', approved: 'linkApproved', rejected: 'linkRejected' }

const STATUS_KEY = { queued: 'statusQueued', running: 'statusRunning', paused: 'statusPaused', awaiting: 'statusAwaiting', awaiting_review: 'statusAwaitingReview', done: 'statusDone', stopped: 'statusStopped', failed: 'statusFailed' }

function StatusPill({ t, status }) {
  const key = STATUS_KEY[status] || 'status' + String(status || '')[0].toUpperCase() + String(status || '').slice(1)
  return h('span', { className: 'dswfe-pill', 'data-status': status }, t(key))
}

/** 每个环节的最新一次执行记录。 */
function latestAttempts(run) {
  const map = new Map()
  for (const t of run.trail || []) {
    const prev = map.get(t.linkId)
    if (!prev || t.startedAt >= prev.startedAt) {
      // 最新记录缺 sessionId（如 skip 记录）时继承上一次的，跳转会话不丢
      map.set(t.linkId, !t.sessionId && prev && prev.sessionId ? { ...t, sessionId: prev.sessionId } : t)
    }
  }
  return map
}

function runProgress(run) {
  const latest = latestAttempts(run)
  const total = new Set([...indexLinksOf(run).keys()]).size
  let done = 0
  for (const [linkId] of indexLinksOf(run)) {
    const st = latest.get(linkId) && latest.get(linkId).status
    if (st === 'done' || st === 'skipped') done++
  }
  return { done, total }
}
function indexLinksOf(run) {
  const phases = run.snapshot && Array.isArray(run.snapshot.phases) ? run.snapshot.phases : []
  const map = new Map()
  for (const ph of phases) for (const ln of (Array.isArray(ph.links) ? ph.links : [])) if (ln.id) map.set(ln.id, { phase: ph, link: ln })
  return map
}

// ── token 用量展示（v0.5.2）──────────────────────────────────────────────

/** 环节卡用量 = 环节执行 + 门禁评审两份合并（都缺返回 null）。 */
function linkUsage(attempt) {
  if (!attempt || (!attempt.usage && !attempt.gateUsage)) return null
  const sum = (a, b) => (a || 0) + (b || 0)
  const u = attempt.usage, g = attempt.gateUsage
  return {
    inputTokens: sum(u && u.inputTokens, g && g.inputTokens),
    outputTokens: sum(u && u.outputTokens, g && g.outputTokens),
    totalTokens: sum(u && u.totalTokens, g && g.totalTokens),
    calls: sum(u && u.calls, g && g.calls),
  }
}

/** 优先用宿主上报的 totalTokens，缺失时退回 input+output。 */
function usageTotalOf(u) {
  if (!u) return 0
  return u.totalTokens > 0 ? u.totalTokens : (u.inputTokens || 0) + (u.outputTokens || 0)
}

/** 1234 → 1.2k；670 → 670（去尾零）。 */
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/** react-dom：只为把问号气泡挂到 body（祖先带 opacity，就地渲染必然是半透明浅灰底）。 */
let __ReactDOM = null
try { __ReactDOM = require('react-dom') } catch {}
function portalHost() { return __ReactDOM && typeof __ReactDOM.createPortal === 'function' ? __ReactDOM : null }

/**
 * 字段说明问号：自绘气泡（原生 title 在这套壳里常被重渲染吞掉），
 * 提示用 position:fixed 的浮层按图标坐标定位：属性栏/画布栏都是滚动容器，::after 会被裁切或挤压。
 */
function Help({ text }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  if (!text) return null
  const W = 260
  const show = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    const estH = Math.max(1, Math.ceil([...String(text)].reduce((n, ch) => n + (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 11.5 : 6.4), 0) / (W - 20))) * 17 + 16
    // 弹窗里的气泡必须留在弹窗内：弹窗遮罩的 z-index 是 2147482900，气泡落在外层会被压暗、被弹窗切掉上半截。
    const dlgEl = el.closest('[role="dialog"], dialog, [class*="modal"]')
    const dlg = dlgEl ? dlgEl.getBoundingClientRect() : null
    const minL = dlg ? dlg.left + 10 : 8
    const maxR = dlg ? dlg.right - 10 : vw - 8
    const minT = dlg ? dlg.top + 10 : 8
    const maxB = dlg ? dlg.bottom - 10 : vh - 8
    let left
    let top
    if (dlg && r.right + 14 + W <= maxR) {
      // 右侧有地方就放右侧，不去盖下方的按钮和诊断区
      left = r.right + 14
      top = Math.max(minT, Math.min(r.top + r.height / 2 - estH / 2, maxB - estH))
    } else {
      left = Math.max(minL, Math.min(r.left - 6, maxR - W))
      top = r.bottom + 8
      if (top + estH > maxB) top = Math.max(minT, r.top - estH - 8)
    }
    setPos({ left, top })
  }
  const hide = () => setPos(null)
  const tip = pos ? h('span', { className: 'dswfe-tip', style: { left: pos.left + 'px', top: pos.top + 'px', width: W + 'px' } }, text) : null
  const host = tip ? portalHost() : null
  return h('span', {
    className: 'dswfe-help', ref, tabIndex: 0, role: 'note', 'aria-label': text,
    onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
  }, '?', tip ? (host ? host.createPortal(tip, document.body) : tip) : null)
}

/** 毫秒 → 「12 分 30 秒」；缺值/未知返回 unknown（默认 —）。 */
function fmtDuration(ms, unknown) {
  if (!Number.isFinite(ms) || ms < 0) return unknown || '—'
  const total = Math.round(ms / 1000)
  const hrs = Math.floor(total / 3600)
  const min = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (hrs > 0) return hrs + ' 小时 ' + min + ' 分'
  if (min > 0) return min + ' 分 ' + sec + ' 秒'
  return sec + ' 秒'
}

/** 环节耗时：结束时间 - 开始时间（老记录没有 finishedAt 时给 null）。 */
function attemptDuration(attempt) {
  if (!attempt || !attempt.startedAt) return null
  const end = attempt.finishedAt || (attempt.status === 'running' ? Date.now() : null)
  return end ? Math.max(0, end - attempt.startedAt) : null
}

/** 执行方式文案：AI 评审 / 人工评审 / 无需评审（结构页与概览共用）。 */
function execLabel(t, node) {
  const rt = (node && node.reviewType) || 'ai'
  if (rt === 'human') return t('execHuman')
  if (rt === 'none') return t('execNone')
  return t('execAI')
}

function UsageBadge({ t, usage }) {
  if (!usage || usage.calls <= 0) return null
  return h('span', {
    className: 'dswfe-badge',
    title: t('usageTitle', { input: fmtTokens(usage.inputTokens), output: fmtTokens(usage.outputTokens), calls: usage.calls }),
  }, '⚡ ' + fmtTokens(usageTotalOf(usage)))
}

function RunList({ state, controller, t }) {
  const runs = state.runs.list
  const running = (r) => ['queued', 'running', 'paused', 'awaiting'].includes(r.status)
  const elapsed = (r) => fmtDuration((r.finishedAt || (running(r) ? Date.now() : r.updatedAt)) - r.createdAt, t('durationUnknown'))
  const tokens = (r) => (r.usage && r.usage.calls > 0 ? fmtTokens(usageTotalOf(r.usage)) : '—')
  return h('div', { className: 'dswfe-runlist' },
    runs.length === 0
      ? h('div', { style: { padding: '16px 8px', color: 'var(--dsw-text-secondary, gray)', fontSize: 12 } }, t('noRuns'), h('div', { style: { marginTop: 4, opacity: .8 } }, t('noRunsHint')))
      : runs.map((r) => h('div', {
        key: r.id, className: 'dswfe-runrow', role: 'button', tabIndex: 0,
        'data-selected': state.runId === r.id ? 'true' : undefined,
        onClick: () => controller.selectRun(r.id),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); controller.selectRun(r.id) } },
      },
      h('div', { className: 'dswfe-runrow-top' },
        h('span', { className: 'dswfe-pill', 'data-status': r.status }, t('status' + r.status[0].toUpperCase() + r.status.slice(1))),
        h('span', { className: 'dswfe-runrow-name', title: r.displayName || r.processName }, r.displayName || r.processName || r.runName),
        h('button', {
          className: 'dswfe-mini dswfe-rundel', title: t('deleteRun'), 'aria-label': t('deleteRun'),
          onClick: (e) => {
            e.stopPropagation()
            // 壳层里 window.confirm 常被吞掉 → 用面板自己的确认框
            controller.setState({ dialog: { type: 'confirm', message: t('deleteRunConfirm'), danger: true, onYes: () => { controller.setState({ dialog: null }); void controller.deleteRun(r.id) } } })
          },
        }, '🗑')),
      r.request
        ? h('div', { className: 'dswfe-runrow-req', title: r.request }, '📝 ' + t('requestLabel') + ': ' + r.request)
        : null,
      h('div', { className: 'dswfe-runrow-meta' },
        h('span', null, t('progress', { done: r.doneLinks, total: r.totalLinks })),
        h('span', null, '⚡ ' + tokens(r)),
        h('span', null, t('durationTotal') + '：' + elapsed(r))))))
}

function RunLinkCard({ t, run, phase, link, attempt, controller, index }) {
  const st = attempt ? attempt.status : 'pending'
  const isCurrent = run.current && run.current.linkId === link.id && ['running', 'queued', 'awaiting'].includes(run.status)
  const rework = (run.rework && run.rework[link.id]) || 0
  const active = ['queued', 'running', 'awaiting', 'paused'].includes(run.status)
  const dur = attemptDuration(attempt)
  return h('div', { className: 'dswfe-linkcard', 'data-state': st },
    h('div', { className: 'dswfe-linktop' },
      h('span', { className: 'dswfe-badge' }, t('linkNo', { n: index })),
      h('span', { style: { fontWeight: 600 } }, link.name || ''),
      isCurrent ? h('span', { className: 'dswfe-badge', 'data-kind': 'warn' }, t('currentStep')) : null,
      h('span', { className: 'grow' }),
      attempt && attempt.attempt > 1 ? h('span', { style: { fontSize: 11, opacity: .7 } }, t('attemptN', { n: attempt.attempt })) : null,
      rework > 0 ? h('span', { style: { fontSize: 11, color: '#b8860b' } }, t('reworkN', { n: rework })) : null,
      attempt && attempt.gate && attempt.gate.score !== null && attempt.gate.score !== undefined
        ? h('span', { className: 'dswfe-badge', 'data-kind': attempt.gate.score >= (attempt.gate.minScore || 0) ? 'ok' : 'err', title: attempt.gate.reason },
          t('gateLabel') + ' ' + attempt.gate.score + ' / ' + (attempt.gate.minScore || 0)) : null,
      attempt && attempt.gate && attempt.gate.reason
        ? h('span', { style: { fontSize: 11, opacity: .65, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          '↳ ' + attempt.gate.reason) : null,
      h(UsageBadge, { t, usage: linkUsage(attempt) }),
      h('span', { style: { fontSize: 11, opacity: .75 } }, t(LINK_STATE_KEY[st] || 'linkPending')),
      h('span', { className: 'dswfe-linkdur', title: t('durationTotal') }, fmtDuration(dur, t('durationUnknown')))),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      attempt && attempt.sessionId ? h('button', { className: 'dswfe-mini', onClick: () => controller.openSession(attempt.sessionId) }, t('openSession')) : null,
      h('button', { className: 'dswfe-mini', onClick: () => controller.setState({ dialog: { type: 'linkfiles', runId: run.id, linkId: link.id, name: link.name || link.id } }) }, t('viewFiles')),
      !active && attempt ? h('button', { className: 'dswfe-mini', onClick: () => void controller.runAction('retry-link', { id: run.id, linkId: link.id }) }, t('retryLink')) : null,
      !active && st !== 'pending' ? h('button', { className: 'dswfe-mini', onClick: () => void controller.runAction('skip-link', { id: run.id, linkId: link.id }) }, t('skipLink')) : null))
}

/** 字节数可读化（产物大小）。 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + ' MB'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + ' KB'
  return Math.round(n) + ' B'
}

/** 文件修改时间 → HH:MM（产物列表用，区分是哪一轮写的）。 */
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

/** diffstat：+12 −3（git 风格带色）。 */
function DiffStat({ additions, deletions }) {
  if (!additions && !deletions) return null
  return h('span', { style: { fontFamily: 'var(--dsw-font-family-mono, monospace)', fontSize: 11, whiteSpace: 'nowrap' } },
    additions > 0 ? h('span', { style: { color: '#4a9a4a' } }, '+' + additions) : null,
    additions > 0 && deletions > 0 ? ' ' : null,
    deletions > 0 ? h('span', { style: { color: '#c75050' } }, '−' + deletions) : null)
}

/** diff 文本 → 按行着色（+/−/@@）。 */
function DiffView({ text }) {
  if (!text) return h('div', { style: { fontSize: 12, opacity: .6, padding: 8 } }, '—')
  return h('pre', { className: 'dswfe-pre', style: { margin: 0, fontSize: 12, lineHeight: 1.55, overflow: 'auto' } },
    text.split('\n').map((l, i) => {
      const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'
      return h('span', { key: i, style: {
        display: 'block',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        color: kind === 'add' ? '#4a9a4a' : kind === 'del' ? '#c75050' : kind === 'hunk' ? '#8080c0' : undefined,
        background: kind === 'add' ? 'rgba(74,154,74,.08)' : kind === 'del' ? 'rgba(199,80,80,.08)' : undefined,
      } }, l === '' ? ' ' : l)
    }))
}

/** 产物查看器：拉 /run-file（content 与 diff 一次拿全），变更/内容两个 tab。 */
function ArtifactViewer({ t, controller, runId, path }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('diff')
  useEffect(() => {
    let alive = true
    setFile(null)
    setError(null)
    setTab('diff')
    controller.loadArtifact(runId, path)
      .then((f) => { if (alive) setFile(f) })
      .catch((e) => { if (alive) setError(String(e && e.message || e)) })
    return () => { alive = false }
  }, [runId, path])
  if (error) return h('div', { className: 'dswfe-empty' }, error)
  if (!file) return h('div', { className: 'dswfe-empty' }, t('loading'))
  const showTab = file.diff ? tab : 'content'
  return h('div', null,
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' } },
      h('span', { className: 'dswfe-chip' }, file.path),
      file.size != null ? h('span', { className: 'dswfe-chip' }, fmtBytes(file.size)) : null,
      h(DiffStat, { additions: file.additions, deletions: file.deletions }),
      file.truncated ? h('span', { className: 'dswfe-badge', 'data-kind': 'warn' }, t('fileTruncated', { size: fmtBytes(1048576) })) : null,
      h('span', { style: { flex: 1 } }),
      h('button', { className: 'dswfe-mini', 'data-active': showTab === 'diff' || undefined, onClick: () => setTab('diff') }, t('diffLabel')),
      h('button', { className: 'dswfe-mini', 'data-active': showTab === 'content' || undefined, onClick: () => setTab('content') }, t('contentLabel'))),
    file.binary ? h('div', { className: 'dswfe-empty' }, t('fileBinary'))
      : showTab === 'diff' ? h(DiffView, { text: file.diff })
        : h('pre', { className: 'dswfe-pre', style: { margin: 0, maxHeight: '58vh', overflow: 'auto' } }, file.content))
}

/** 产物列表（看板）：按环节分组，同一路径跨尝试取最新一条记录。 */
function ArtifactList({ t, run, controller }) {
  const linkName = new Map()
  for (const ph of (run.snapshot && run.snapshot.phases) || []) {
    for (const ln of (ph && Array.isArray(ph.links) ? ph.links : [])) {
      if (ln && ln.id) linkName.set(ln.id, (ph.name ? ph.name + ' / ' : '') + (ln.name || ln.id))
    }
  }
  const latest = new Map() // path → { art, linkId }（trail 按时间序，后者覆盖）
  for (const a of run.trail || []) for (const art of a.artifacts || []) latest.set(art.path, { art, linkId: a.linkId })
  if (latest.size === 0) return h('div', { style: { fontSize: 12, opacity: .7, padding: '4px 2px' } }, t('artifactsNone'))
  const groups = new Map()
  for (const linkId of indexLinksOf(run).keys()) groups.set(linkId, [])
  for (const [path, v] of latest) {
    if (!groups.has(v.linkId)) groups.set(v.linkId, [])
    groups.get(v.linkId).push({ ...v.art, path })
  }
  const children = []
  for (const [linkId, arts] of groups) {
    if (!arts || arts.length === 0) continue
    children.push(h('div', { key: linkId, className: 'dswfe-artgroup' },
      h('div', { style: { fontSize: 11, opacity: .65, margin: '8px 0 2px' } }, linkName.get(linkId) || linkId),
      arts.map((a) => h('button', {
        key: a.path, className: 'dswfe-artrow', title: a.path,
        onClick: () => controller.setState({ dialog: { type: 'fileview', runId: run.id, path: a.path, name: a.name } }),
      },
      h('span', { style: { fontWeight: 500, whiteSpace: 'nowrap' } }, a.name),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: .7, fontSize: 12 } }, a.path),
      !a.exists ? h('span', { className: 'dswfe-badge', 'data-kind': 'err' }, t('artifactMissing')) : null,
      h(DiffStat, { additions: a.additions, deletions: a.deletions }),
      a.mtime ? h('span', { style: { fontSize: 11, opacity: .6, whiteSpace: 'nowrap' } }, fmtClock(a.mtime)) : null,
      a.exists && a.size != null ? h('span', { style: { fontSize: 11, opacity: .6, whiteSpace: 'nowrap' } }, fmtBytes(a.size)) : null))))
  }
  return h('div', { className: 'dswfe-artifacts' }, children)
}

/** 产物预览弹窗（看板产物列表点开）。 */
function FileViewDialog({ state, controller, t }) {
  const dlg = state.dialog
  return h(Modal, { title: t('fileViewTitle') + '：' + (dlg.name || dlg.path), onClose: () => controller.setState({ dialog: null }), width: 860 },
    h(ArtifactViewer, { t, controller, runId: dlg.runId, path: dlg.path }))
}

/** 路径 → 树：{ dirs: Map, files: [] }。 */
function buildFileTree(entries) {
  const root = { dirs: new Map(), files: [] }
  for (const e of entries) {
    const parts = String(e.path).split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      if (seg === '') continue
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] })
      node = node.dirs.get(seg)
    }
    node.files.push(e)
  }
  return root
}

/** 文件树渲染：目录恒展开，文件行带 diffstat，点击选中。 */
function FileTree({ t, entries, sel, onSelect }) {
  const render = (node, depth) => {
    const out = []
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(h('div', { key: 'd:' + name, style: { padding: '3px 4px', fontSize: 12, opacity: .75, paddingLeft: 4 + depth * 14 } }, '📁 ' + name))
      out.push(...render(child, depth + 1))
    }
    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(h('button', {
        key: f.path, className: 'dswfe-artrow', 'data-selected': sel === f.path || undefined,
        style: { paddingLeft: 4 + depth * 14, gap: 6 }, title: f.path, onClick: () => onSelect(f.path),
      },
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
      f.mtime ? h('span', { style: { fontSize: 11, opacity: .6, whiteSpace: 'nowrap' } }, fmtClock(f.mtime)) : null,
      h(DiffStat, { additions: f.additions, deletions: f.deletions }),
      !f.exists ? h('span', { className: 'dswfe-badge', 'data-kind': 'err' }, t('artifactMissing')) : null))
    }
    return out
  }
  return h('div', null, render(buildFileTree(entries), 0))
}

/** 环节产物弹窗：左侧该环节的文件树（同路径取最新一次尝试），右侧查看器。 */
function LinkFilesDialog({ state, controller, t }) {
  const dlg = state.dialog
  const [files, setFiles] = useState(null)
  const [sel, setSel] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    setFiles(null)
    setSel(null)
    setErr(null)
    controller.loadLinkFiles(dlg.runId, dlg.linkId)
      .then((list) => {
        if (!alive) return
        setFiles(list)
        const first = list.filter((f) => f.exists !== false)[0] || list[0]
        setSel(first ? first.path : null)
      })
      .catch((e) => { if (alive) { setErr(String(e && e.message || e)); setFiles([]) } })
    return () => { alive = false }
  }, [dlg.runId, dlg.linkId])
  const entries = files || []
  return h(Modal, { title: t('linkFilesTitle') + '：' + (dlg.name || dlg.linkId), onClose: () => controller.setState({ dialog: null }), width: 960 },
    h('div', { style: { display: 'flex', gap: 12, minHeight: 320 } },
      h('div', { style: { width: 280, flexShrink: 0, overflowY: 'auto', maxHeight: '62vh', borderRight: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', paddingRight: 8 } },
        files === null && !err ? h('div', { style: { fontSize: 12, opacity: .7, padding: 4 } }, t('loading'))
          : entries.length === 0 ? h('div', { style: { fontSize: 12, opacity: .7, padding: 4 } }, err || t('noFiles'))
            : h(FileTree, { t, entries, sel, onSelect: setSel })),
      h('div', { style: { flex: 1, minWidth: 0, overflowY: 'auto', maxHeight: '62vh' } },
        sel ? h(ArtifactViewer, { t, controller, runId: dlg.runId, path: sel })
          : h('div', { className: 'dswfe-empty' }, err || t('pickFile')))))
}

function RunBoard({ state, controller, t }) {
  const run = state.run
  if (state.runLoading) return h('div', { className: 'dswfe-board' }, t('loading'))
  if (!run) return h('div', { className: 'dswfe-empty' }, t('emptyRun'))
  const latest = latestAttempts(run)
  const phases = Array.isArray(run.snapshot && run.snapshot.phases) ? run.snapshot.phases : []
  const { done, total } = runProgress(run)
  const active = ['queued', 'running', 'awaiting', 'paused'].includes(run.status)
  const wfName = run.displayName || run.processName || run.processId
  const spanMs = (run.finishedAt || (active ? Date.now() : run.updatedAt)) - run.createdAt
  const children = [
    h('div', { className: 'dswfe-runhead' },
      h('h3', { className: 'dswfe-detail-title' }, wfName),
      h(StatusPill, { t, status: run.status }),
      h('span', { className: 'dswfe-count' }, t('progress', { done, total })),
      h('div', { className: 'dswfe-actions' },
        run.status === 'running' || run.status === 'queued' ? h('button', { className: 'dswfe-btn', onClick: () => void controller.runAction('pause', { id: run.id }) }, t('pause')) : null,
        run.status === 'paused' ? h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: () => void controller.runAction('resume', { id: run.id }) }, t('resume')) : null,
        active ? h('button', { className: 'dswfe-btn', 'data-danger': 'true', onClick: () => void controller.runAction('stop', { id: run.id }) }, t('stopRun')) : null)),
    h('div', { className: 'dswfe-chips' },
      h('span', { className: 'dswfe-chip' }, '⚡ ' + (run.usage && run.usage.calls > 0 ? fmtTokens(usageTotalOf(run.usage)) : '—')),
      h('span', { className: 'dswfe-chip' }, '▶ ' + t('startedAt') + ' ' + (run.createdAt ? new Date(run.createdAt).toLocaleString() : '—')),
      h('span', { className: 'dswfe-chip' }, '⏹ ' + t('endedAt') + ' ' + (run.finishedAt ? new Date(run.finishedAt).toLocaleString() : active ? '…' : '—')),
      h('span', { className: 'dswfe-chip' }, '⏱ ' + t('durationTotal') + ' ' + fmtDuration(spanMs, t('durationUnknown'))),
      h('span', { className: 'dswfe-chip' }, '💬 ' + t('sessionMode') + '：' + t(run.sessionMode === 'single' ? 'sessionSingle' : 'sessionMulti')),
      run.error ? h('span', { className: 'dswfe-badge', 'data-kind': 'err' }, t('runError') + ': ' + run.error) : null),
  ]
  if (run.userInput) children.push(h('div', { className: 'dswfe-kv', style: { background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))', borderRadius: 8, padding: '6px 10px' } }, h('b', null, '📌 ' + t('runUserInput') + '：'), h('span', { style: { whiteSpace: 'pre-wrap' } }, run.userInput)))
  children.push(h('div', { className: 'dswfe-sec' }, h(FlowGraph, { t, parsed: run.snapshot, run })))
  if (run.pendingBreak) {
    const humanBreak = run.pendingBreak.kind === 'human'
    children.push(h('div', { className: 'dswfe-break' },
      h('span', { style: { fontWeight: 600 } }, '⚠ ' + t(humanBreak ? 'humanReviewTitle' : 'breakTitle')),
      h('span', { style: { fontSize: 12 } },
        run.pendingBreak.linkId
        + (run.pendingBreak.gate && run.pendingBreak.gate.score !== null && run.pendingBreak.gate.score !== undefined
          ? ' · ' + t('gateLabel') + ' ' + run.pendingBreak.gate.score + ' / ' + (run.pendingBreak.gate.minScore || 0) : '')
        + ' · ' + (run.pendingBreak.reason || '')),
      h('div', { className: 'dswfe-actions' },
        h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: () => void controller.runAction('resolve-break', { id: run.id, decision: 'retry' }) }, t(humanBreak ? 'decisionReject' : 'decisionRetry')),
        h('button', { className: 'dswfe-btn', onClick: () => void controller.runAction('resolve-break', { id: run.id, decision: 'skip' }) }, t(humanBreak ? 'decisionApprove' : 'decisionSkip')),
        h('button', { className: 'dswfe-btn', 'data-danger': 'true', onClick: () => void controller.runAction('resolve-break', { id: run.id, decision: 'stop' }) }, t('decisionStop')))))
  }
  let seq = 0
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i]
    const links = Array.isArray(ph.links) ? ph.links : []
    children.push(h('div', { className: 'dswfe-phase', key: ph.id || i },
      h('div', { className: 'dswfe-phase-head' },
        h('span', { className: 'dswfe-badge' }, t('phaseNo', { n: i + 1 })),
        h('span', null, ph.name || ''),
        h('span', { className: 'dswfe-link-meta' }, links.length + ' ' + t('links'))),
      links.map((ln) => { seq += 1; return h(RunLinkCard, { key: ln.id, t, run, phase: ph, link: ln, attempt: latest.get(ln.id), controller, index: seq }) })))
  }
  return h('div', { className: 'dswfe-board' }, children)
}

function ExecView({ state, controller, t }) {
  return h('div', { style: { display: 'contents' } },
    h(RunList, { state, controller, t }),
    state.runId && (state.runLoading || state.run) ? h(RunBoard, { state, controller, t })
      : state.runId && state.runError
        ? h('div', { className: 'dswfe-board' },
          h('div', { className: 'dswfe-error' }, t('runLoadFailed') + '：' + state.runError),
          h('div', { className: 'dswfe-actions', style: { marginTop: 10 } },
            h('button', { className: 'dswfe-btn', 'data-primary': 'true', onClick: () => void controller.loadRun(state.runId) }, t('retryLoad')),
            h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ runId: null, run: undefined, runError: null }) }, t('cancel'))))
        : state.runId ? h('div', { className: 'dswfe-empty' }, t('loading')) : h('div', { className: 'dswfe-empty' }, t('emptyRun')))
}

function NewRunDialog({ state, controller, t }) {
  const dlg = state.dialog
  const [workspaces, setWorkspaces] = useState(null)
  const [ws, setWs] = useState('')
  const [req, setReq] = useState('')
  const [mode, setMode] = useState('single')
  useEffect(() => {
    api('/workspaces').then((d) => setWorkspaces(d.workspaces || [])).catch(() => setWorkspaces([]))
  }, [])
  useEffect(() => { if (!state.settings) void controller.loadSettings() }, [])
  const proc = state.processes.find((p) => p.id === dlg.processId)
  const [busy, setBusy] = useState(false)
  const reqOk = req.trim() !== ''
  return h(Modal, { title: t('runCreate') + '：' + (proc ? (proc.display_name || proc.name) : ''), onClose: () => controller.setState({ dialog: null }) },
    h('div', { className: 'dswfe-kv' }, h('b', null, t('name') + ':'), proc ? proc.relPath : '—'),
    h('label', { className: 'dswfe-field' }, t('runUserInput'),
      h('textarea', {
        value: req, placeholder: t('runUserInputPh'), spellCheck: false, rows: 4,
        style: { width: '100%', resize: 'vertical', fontFamily: 'var(--dsw-font-family, inherit)', fontSize: 13, lineHeight: 1.6, border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: 8, padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', boxSizing: 'border-box' },
        onChange: (e) => setReq(e.target.value),
      })),
    h('label', { className: 'dswfe-field' }, t('runWorkspace'),
      h('select', { value: ws, onChange: (e) => setWs(e.target.value) },
        workspaces === null ? h('option', { value: '' }, t('loading')) : [
          h('option', { key: '_', value: '' }, t('workspaceDefault')),
          workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title)),
        ])),
    h('label', { className: 'dswfe-field' }, h('span', { className: 'dswfe-field-label' }, t('sessionMode'), h(Help, { text: t('helpSessionMode') })),
      h('select', { value: mode, onChange: (e) => setMode(e.target.value) },
        h('option', { key: 'multi', value: 'multi' }, t('sessionMulti')),
        h('option', { key: 'single', value: 'single' }, t('sessionSingle')))),
    h('div', { style: { fontSize: 12, opacity: .7 } }, mode === 'single'
      ? '整条流程共用一个会话（门禁也在其中）：省 token，但上下文会持续累积。'
      : '每个环节开一个全新会话执行；用户需求只注入第一个环节，后续环节读上游产出文件；门禁由评审会话打分，不过按 on_gate_fail 流转，返工不超过 max_rework。'),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { className: 'dswfe-btn', onClick: () => controller.setState({ dialog: null }) }, t('cancel')),
      h('button', { className: 'dswfe-btn', 'data-primary': 'true', disabled: busy || !proc || !reqOk, onClick: async () => {
        setBusy(true)
        try { await controller.createRun({ processId: dlg.processId, workspaceId: ws || undefined, userInput: req.trim(), sessionMode: mode }) } catch (error) { controller.toast(String(error && error.message || error), 'err') } finally { setBusy(false) }
      } }, t('runCreate'))))
}

/**
 * 流程图可视化（v0.3）：工作流 YAML → 有向图 → 零依赖分层布局 → SVG 渲染。
 *
 * 建模对齐 ProcessFlowGraph 的视觉语言：
 * - START → 第一个环节 → … → END；on_success 实线（forward 灰 / goto 跳转绿），
 *   on_gate_fail 红色虚线 + 「门禁未过 → <id>」标签，break 不连线只在节点上标注，
 *   回边（指向更早环节）从节点上沿绕行，自环画右侧小环。
 * - 节点卡：序号徽标、环节名、executor/expert、门禁徽标（最低分数线）、返工上限。
 * - 运行态叠加：attempt 状态映射节点描边/徽标（当前橙、完成绿+实际门禁得分、
 *   门禁未过红、跳过灰虚、中断深灰）。
 *
 * 布局是纯函数（rank 用 forward 边最长路径，层内按声明序），可在 plain Node 下单测。
 */


const START_ID = '__start'
const END_ID = '__end'

/** 解析流转值（host validate.flowTarget 的客户端镜像）：'next'|'end'|'break'|{jump}。 */
function clientFlowTarget(value) {
  if (value === undefined || value === null || value === '') return null
  const v = String(value).trim()
  if (v === 'next' || v === 'end' || v === 'break') return v
  if (v.startsWith('goto:')) return { jump: v.slice(5).trim() }
  return { jump: v }
}

/**
 * 解析后的工作流对象 → 流程图模型。
 * @returns {{ nodes: Array, edges: Array, breaks: Array, warnings: string[] } | null}
 *  nodes: { id, no, name, phaseId, phaseName, executor, expert, gateMin, gateCount, maxRework, skills }
 *  edges: { from, to, kind: 'forward'|'jump'|'fail', label }
 *  breaks: { linkId, field, value }（break 不连线，节点上标注）
 */
function buildFlowModel(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.phases)) return null
  const nodes = []
  const byId = new Map()
  for (const ph of parsed.phases) {
    if (!ph || typeof ph !== 'object') continue
    const links = Array.isArray(ph.links) ? ph.links : []
    for (const ln of links) {
      if (!ln || typeof ln !== 'object' || !ln.id) continue
      const gates = Array.isArray(ln.gates) ? ln.gates.filter((g) => g && typeof g === 'object') : []
      const gateMin = gates.reduce((min, g) => (typeof g.min_score === 'number' ? Math.min(min, g.min_score) : min), Infinity)
      const node = {
        id: String(ln.id),
        no: nodes.length + 1,
        name: ln.name || ln.id,
        phaseId: ph.id || '',
        phaseName: ph.name || ph.id || '',
        executor: ln.executor || null,
        reviewType: ln.review_type || 'ai',
        expert: (ln.expert_name || ln.expert) || null,
        gateCount: gates.length,
        gateMin: Number.isFinite(gateMin) ? gateMin : null,
        maxRework: Number.isInteger(ln.max_rework) ? ln.max_rework : null,
        skills: Array.isArray(ln.skills) ? ln.skills : [],
        onSuccess: ln.on_success || 'next',
        onGateFail: ln.on_gate_fail == null ? null : String(ln.on_gate_fail),
      }
      nodes.push(node)
      byId.set(node.id, node)
    }
  }
  if (nodes.length === 0) return null

  const edges = []
  const breaks = []
  const warnings = []
  if (nodes.length > 0) edges.push({ from: START_ID, to: nodes[0].id, kind: 'forward', label: '' })
  const resolve = (value, fromNode) => {
    const t = clientFlowTarget(value)
    if (t === null) return null
    if (t === 'next' || t === 'end' || t === 'break') return t
    return byId.has(t.jump) ? t.jump : null
  }
  nodes.forEach((node, i) => {
    // on_success
    const ok = resolve(node.onSuccess)
    if (ok === 'next') {
      const nextNode = nodes[i + 1]
      if (nextNode) edges.push({ from: node.id, to: nextNode.id, kind: 'forward', label: '' })
      else edges.push({ from: node.id, to: END_ID, kind: 'forward', label: '' })
    } else if (ok === 'end') {
      edges.push({ from: node.id, to: END_ID, kind: 'forward', label: '' })
    } else if (typeof ok === 'string') {
      edges.push({ from: node.id, to: ok, kind: 'jump', label: node.onSuccess })
    } else {
      warnings.push(`环节 "${node.id}" 的 on_success 无法解析`)
    }
    // on_gate_fail（与成功策略不同才画；显式 break 才记标注，缺省不标）
    const gf = node.onGateFail == null ? null : resolve(node.onGateFail)
    if (node.onGateFail === 'break') {
      breaks.push({ linkId: node.id, field: 'on_gate_fail', value: 'break' })
    } else if (typeof gf === 'string' && gf !== ok) {
      edges.push({ from: node.id, to: gf, kind: 'fail', label: `门禁未过 → ${gf}` })
    }
  })
  return { nodes, edges, breaks, warnings }
}

// ── 布局（纯函数）────────────────────────────────────────────────────────

const FLOW_NODE_W = 196
const FLOW_NODE_H = 74
const FLOW_GAP_X = 80
const FLOW_GAP_Y = 42
const FLOW_PAD = 26
const LOOP_BACK_PAD = 64

/**
 * 分层布局：START=rank0；沿 forward/jump 前向边做最长路径分层；回边(to.rank≤from.rank)
 * 不参与分层、渲染为顶部绕行弧线。层内按声明序排布。
 * @returns {{ positions: Map, width: number, height: number, backEdges: Set<string>, loops: Set<string> }}
 *  positions: id → {x, y}（节点左上角；含 START/END 虚拟节点）
 */
function layoutFlowGraph(model) {
  const { nodes, edges } = model
  const positions = new Map()
  const backEdges = new Set()
  const loops = new Set()
  const meta = new Map() // id → { row, col, dir }（蛇形排布信息，边路由用）
  const n = nodes.length
  if (n === 0) return { positions, width: 200, height: 120, backEdges, loops, meta }

  // 蛇形排布：每行 K 个（3-5，按 n 取平方根级别），奇数行反向，图变紧凑可读
  const K = Math.max(3, Math.min(5, Math.ceil(Math.sqrt(n))))
  const rowH = FLOW_NODE_H + FLOW_GAP_Y * 2
  nodes.forEach((nd, i) => {
    const row = Math.floor(i / K)
    const colInRow = i % K
    const dir = row % 2 === 0 ? 1 : -1
    const col = dir === 1 ? colInRow : K - 1 - colInRow
    positions.set(nd.id, {
      x: FLOW_PAD + col * (FLOW_NODE_W + FLOW_GAP_X),
      y: FLOW_PAD + LOOP_BACK_PAD + row * rowH,
    })
    meta.set(nd.id, { row, col, dir })
  })
  const rows = Math.ceil(n / K)
  const first = nodes[0].id, last = nodes[n - 1].id
  const firstPos = positions.get(first), lastPos = positions.get(last)
  positions.set(START_ID, { x: firstPos.x, y: firstPos.y - 78 })
  positions.set(END_ID, { x: lastPos.x, y: lastPos.y + FLOW_NODE_H + 34 })
  for (const e of edges) {
    const key = e.from + '→' + e.to
    if (e.from === e.to) loops.add(key)
  }
  const width = FLOW_PAD * 2 + K * (FLOW_NODE_W + FLOW_GAP_X) - FLOW_GAP_X
  const height = FLOW_PAD * 2 + LOOP_BACK_PAD + rows * rowH + 60
  return { positions, width, height, backEdges, loops, meta }
}


// ── 流程图 SVG 组件（v0.3）──────────────────────────────────────────────

function flowPhaseColor(phaseId) {
  let h = 0
  for (let i = 0; i < String(phaseId || '').length; i++) h = (h * 31 + String(phaseId).charCodeAt(i)) >>> 0
  return 'hsl(' + (h % 360) + ' 45% 55%)'
}

function escXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * SVG 文本按估算宽度截断，超出补「…」。卡片宽度固定、角标文案随语言变长时用。
 */
function fitFlowText(text, maxPx, fontPx) {
  const src = String(text == null ? '' : text)
  const chWidth = (ch) => (ch.charCodeAt(0) > 0x2e80 ? fontPx : fontPx * 0.56)
  let total = 0
  for (const ch of src) total += chWidth(ch)
  if (total <= maxPx) return src
  let out = ''
  let acc = fontPx * 0.56
  for (const ch of src) {
    const w = chWidth(ch)
    if (acc + w > maxPx) break
    out += ch
    acc += w
  }
  return out + '…'
}

/**
 * 流程图 SVG。model/layout 来自 flow-model；runState 可选（运行态高亮）：
 * { latestByLink: Map<linkId, attempt>, currentLinkId, pendingLinkId }
 */
function FlowGraph({ t, parsed, run }) {
  const [zoom, setZoom] = useState(1)
  const wrapRef = useRef(null)
  const fittedRef = useRef(false)
  const model = useMemo(() => buildFlowModel(parsed), [parsed])
  const layout = useMemo(() => (model ? layoutFlowGraph(model) : null), [model])
  // 首屏自适应：整图铺满容器宽度（最多放大到 100%），之后用户手动缩放不被覆盖
  useEffect(() => {
    if (!layout || fittedRef.current || !wrapRef.current) return
    fittedRef.current = true
    const avail = wrapRef.current.clientWidth - 4
    if (layout.width > avail && avail > 100) setZoom(Math.max(0.3, avail / layout.width))
  }, [layout])
  const latest = useMemo(() => (run ? latestAttempts(run) : null), [run])
  if (!model || !layout) return h('div', { className: 'dswfe-empty' }, t('flowNoParsed'))

  const pos = layout.positions
  const nodeById = new Map([[START_ID, { id: START_ID, name: 'START', phaseName: '' }], [END_ID, { id: END_ID, name: 'END', phaseName: '' }], ...model.nodes.map((n) => [n.id, n])])
  const currentLinkId = run && run.current && run.current.linkId
  const stateOf = (linkId) => {
    if (!run) return null
    if (run.pendingBreak && run.pendingBreak.linkId === linkId) return 'awaiting'
    if (currentLinkId === linkId && ['running', 'queued', 'awaiting'].includes(run.status)) return 'current'
    const a = latest && latest.get(linkId)
    return a ? a.status : null
  }
  const STROKE = { forward: 'var(--dsw-text-secondary, #94a3b8)', jump: '#22c55e', fail: 'var(--dsw-alias-state-error, #ef4444)' }
  const edgePath = (e) => {
    const from = pos.get(e.from)
    const to = pos.get(e.to)
    if (!from || !to) return null
    const isLoop = layout.loops.has(e.from + '→' + e.to)
    if (e.from === START_ID) return { d: 'M' + (from.x + FLOW_NODE_W / 2) + ' ' + (from.y + 30) + ' L' + (to.x + FLOW_NODE_W / 2) + ' ' + to.y, label: null }
    if (e.to === END_ID) return { d: 'M' + (from.x + FLOW_NODE_W / 2) + ' ' + (from.y + FLOW_NODE_H) + ' L' + (to.x + FLOW_NODE_W / 2) + ' ' + to.y, label: null }
    if (isLoop) {
      const sx = from.x + FLOW_NODE_W, sy = from.y + 18
      return { d: 'M' + sx + ' ' + sy + ' C' + (sx + 46) + ' ' + sy + ' ' + (sx + 46) + ' ' + (sy + 30) + ' ' + sx + ' ' + (sy + 34), label: null }
    }
    const mf = layout.meta.get(e.from), mt = layout.meta.get(e.to)
    if (!mf || !mt) return null
    // 同行：顺向直线；逆向/跨列走节点上方弧线（含 fail 回边）
    if (mf.row === mt.row) {
      const toRight = mt.col > mf.col
      const inFlowDir = toRight === (mf.dir === 1)
      const sx = toRight ? from.x + FLOW_NODE_W : from.x
      const tx = toRight ? to.x : to.x + FLOW_NODE_W
      const y = from.y + FLOW_NODE_H / 2
      if (Math.abs(mt.col - mf.col) === 1 && inFlowDir) return { d: 'M' + sx + ' ' + y + ' L' + tx + ' ' + y, label: e.label || null }
      const ax = (sx + tx) / 2
      const asx = toRight ? sx - 12 : sx + 12
      const atx = toRight ? tx + 12 : tx - 12
      return { d: 'M' + asx + ' ' + (from.y) + ' C' + asx + ' ' + (from.y - 34) + ' ' + atx + ' ' + (to.y - 34) + ' ' + atx + ' ' + to.y, label: e.label || null, arcY: Math.min(from.y, to.y) - 24, ax }
    }
    // 相邻行的同列：垂直直落
    if (mt.row === mf.row + 1 && mt.col === mf.col) {
      return { d: 'M' + (from.x + FLOW_NODE_W / 2) + ' ' + (from.y + FLOW_NODE_H) + ' L' + (to.x + FLOW_NODE_W / 2) + ' ' + to.y, label: e.label || null }
    }
    // 跨行任意：走两行之间走廊的正交折线（出边 → 横移 → 进边），不斜穿、不压节点
    const sx = from.x + FLOW_NODE_W / 2
    const tx = to.x + FLOW_NODE_W / 2
    if (mt.row > mf.row) {
      const sy = from.y + FLOW_NODE_H
      const laneY = from.y + FLOW_NODE_H + FLOW_GAP_Y
      return { d: 'M' + sx + ' ' + sy + ' L' + sx + ' ' + laneY + ' L' + tx + ' ' + laneY + ' L' + tx + ' ' + to.y, label: e.label || null }
    }
    // 回边（回到更早的行）：从源顶边偏左出线、走走廊横移、进目标底边偏右，避免与同列垂直前向边重叠
    const bx = from.x + 26
    const btx = to.x + 40
    const laneY = from.y - FLOW_GAP_Y
    return { d: 'M' + bx + ' ' + from.y + ' L' + bx + ' ' + laneY + ' L' + btx + ' ' + laneY + ' L' + btx + ' ' + (to.y + FLOW_NODE_H), label: e.label || null }
  }

  const nodeSvg = (id) => {
    const p = pos.get(id)
    if (!p) return null
    if (id === START_ID || id === END_ID) {
      const isStart = id === START_ID
      return h('g', { key: id },
        h('rect', { x: p.x, y: p.y, width: FLOW_NODE_W, height: 30, rx: 15, fill: 'var(--dsw-alias-bg-layer-1, transparent)', stroke: 'var(--dsw-alias-border-l2, rgba(128,128,128,.4))' }),
        h('text', { x: p.x + FLOW_NODE_W / 2, y: p.y + 20, textAnchor: 'middle', fontSize: 12, fontWeight: 700, fill: 'var(--dsw-text-secondary, gray)', style: { fontFamily: 'monospace', letterSpacing: 2 } }, isStart ? '▶ ' + t('flowStartLabel') : '■ ' + t('flowEndLabel')))
    }
    const node = nodeById.get(id)
    const st = stateOf(id)
    const att = run && latest && latest.get(id)
    const border = st === 'current' ? '#d9822b'
      : st === 'done' || st === 'skipped' ? '#2e9e5b'
        : st === 'gate_failed' || st === 'awaiting' ? 'var(--dsw-alias-state-error, #ef4444)'
          : st === 'failed' ? 'var(--dsw-alias-state-error, #ef4444)' : 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))'
    // 复核方式放在「门禁」左边（三选一：AI 评审 / 人工评审 / 无需评审）
    const reviewLabel = node.reviewType === 'human' ? t('flowReviewHuman')
      : node.reviewType === 'none' ? t('flowReviewNone') : t('flowReviewAi')
    const badge = [reviewLabel]
    if (node.gateCount > 0) badge.push(t('flowGate', { min: node.gateMin === null ? '?' : node.gateMin }))
    else badge.push(t('flowNoGate'))
    if (node.maxRework !== null) badge.push(t('flowRework', { n: node.maxRework }))
    let runBadge = null
    let runBadgeW = 0
    if (att && att.gate && att.gate.score !== null && att.gate.score !== undefined) {
      runBadge = t('flowScore', { score: String(att.gate.score) })
      // 角标占位宽度：中文/全角按字号 10px，西文数字按 5.6px（与 fitFlowText 的估算口径一致）
      for (const ch of runBadge) runBadgeW += ch.charCodeAt(0) > 0xff ? 10 : 5.6
    }
    // executor 恒为 agent，不再是可读信息（早前明确要求不在图上显示），只留专家名
    const meta = [node.expert].filter(Boolean).join(' · ')
    const w = FLOW_NODE_W, hgt = FLOW_NODE_H
    return h('g', { key: id },
      h('rect', { x: p.x + 3, y: p.y + 6, width: 6, height: hgt - 12, rx: 3, fill: flowPhaseColor(node.phaseId) }),
      h('rect', { x: p.x, y: p.y, width: w, height: hgt, rx: 10, fill: 'var(--dsw-alias-bg-layer-1, #fff)', stroke: border, strokeWidth: st === 'current' ? 2.5 : 1.2 }),
      h('rect', { x: p.x - 9, y: p.y - 9, width: 22, height: 18, rx: 9, fill: 'var(--dsw-alias-bg-layer-2, #f1f5f9)', stroke: 'var(--dsw-alias-border-l1, rgba(128,128,128,.2))' }),
      h('text', { x: p.x + 2, y: p.y + 4, textAnchor: 'middle', fontSize: 10, fontWeight: 700, fill: 'var(--dsw-text-secondary, gray)', style: { fontFamily: 'monospace' } }, String(node.no).padStart(2, '0')),
      h('text', { x: p.x + 14, y: p.y + 24, fontSize: 13, fontWeight: 600, fill: 'var(--dsw-alias-label-primary, currentColor)' }, escXml(node.name.slice(0, 16))),
      h('text', { x: p.x + 14, y: p.y + 41, fontSize: 10, fill: 'var(--dsw-text-secondary, gray)' }, escXml((meta || node.phaseName || '').slice(0, 26))),
      h('text', { x: p.x + 14, y: p.y + hgt - 10, fontSize: 10, fill: node.gateCount > 0 ? '#b8860b' : 'var(--dsw-text-secondary, gray)' }, escXml(fitFlowText(badge.join('·'), w - 14 - (runBadge ? runBadgeW + 22 : 12), 10))),
      runBadge ? h('text', { x: p.x + w - 12, y: p.y + hgt - 10, textAnchor: 'end', fontSize: 10, fontWeight: 700, fill: '#2e9e5b' }, runBadge) : null,
      st === 'current' ? h('circle', { cx: p.x + w - 12, cy: p.y + 12, r: 5, fill: '#d9822b' }) : null,
      st === 'done' ? h('circle', { cx: p.x + w - 12, cy: p.y + 12, r: 5, fill: '#2e9e5b' }) : null,
      (st === 'gate_failed' || st === 'awaiting' || st === 'failed') ? h('circle', { cx: p.x + w - 12, cy: p.y + 12, r: 5, fill: 'var(--dsw-alias-state-error, #ef4444)' }) : null)
  }

  const edgeSvgs = []
  for (const e of model.edges) {
    const path = edgePath(e)
    if (!path) continue
    const color = e.kind === 'fail' ? STROKE.fail : e.kind === 'jump' ? STROKE.jump : STROKE.forward
    const dashed = e.kind === 'fail' ? '6,4' : undefined
    edgeSvgs.push(h('path', { key: e.from + '→' + e.to + e.kind, d: path.d, fill: 'none', stroke: color, strokeWidth: e.kind === 'fail' ? 1.8 : 1.4, strokeDasharray: dashed, markerEnd: 'url(#dswfe-arrow-' + (e.kind === 'fail' ? 'f' : e.kind === 'jump' ? 'j' : 'n') + ')' }))
  }

  return h('div', null,
    h('div', { className: 'dswfe-flowlegend' },
      h('span', null, h('span', { className: 'sw fwd' }), t('flowLegendForward')),
      h('span', null, h('span', { className: 'sw jump' }), t('flowLegendJump')),
      h('span', null, h('span', { className: 'sw fail' }), t('flowLegendFail')),
      h('span', null, t('flowLegendBreak')),
      h('span', { style: { marginLeft: 'auto' } },
        h('button', { className: 'dswfe-mini', onClick: () => setZoom(Math.max(0.5, zoom - 0.2)) }, '−'),
        h('span', { style: { margin: '0 6px' } }, Math.round(zoom * 100) + '%'),
        h('button', { className: 'dswfe-mini', onClick: () => setZoom(Math.min(2, zoom + 0.2)) }, '+'))),
    h('div', { className: 'dswfe-flowwrap', ref: wrapRef },
      h('svg', { width: layout.width * zoom, height: layout.height * zoom, viewBox: '0 0 ' + layout.width + ' ' + layout.height },
        h('defs', null,
          h('marker', { id: 'dswfe-arrow-n', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--dsw-text-secondary, #94a3b8)' })),
          h('marker', { id: 'dswfe-arrow-j', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M0 0L10 5L0 10z', fill: '#22c55e' })),
          h('marker', { id: 'dswfe-arrow-f', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M0 0L10 5L0 10z', fill: 'var(--dsw-alias-state-error, #ef4444)' }))),
        edgeSvgs,
        [START_ID, ...model.nodes.map((n) => n.id), END_ID].map((id) => nodeSvg(id)))))
}

function FlowTab({ t, parsed }) {
  return h('div', null, h(FlowGraph, { t, parsed }))
}

// ── 挂载 ─────────────────────────────────────────────────────────────────

const name = CLIENT_NAME
const inject = ['slots', 'locale']

// （v0.4 起 shell.overlay slot 已移除：全屏 overlay 盖住侧栏观感差，改走 mountPrcView 中栏接管。）

let ReactGlobal = null
try { ReactGlobal = require('react') } catch {}

/** 同页重复 apply 防护：上一次挂载的 teardown（apply 内赋值）。 */
let activeApplyTeardown = null

/** 中栏接管视图（apply 内赋值；openPanel 的兜底 ensure 也会用到）。 */
let prcView = null

/**
 * 中栏接管视图（taskboard board-mount 同款）：容器 div 追加为会话列末尾子节点
 * （React shell 不管理它），ProcessPanel 常驻其中、关闭时渲染 null；开合由
 * html[data-dswfe-active] 属性驱动（CSS 隐藏列内兄弟，侧栏保持可见）。
 * ensure(force)：force=true 时壳层退化兜底——容器挂 body 退回全屏浮层。
 */
function mountPrcView(controller, t) {
  const COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
  let container = null
  let root = null
  const unplace = () => {
    try { if (root) root.unmount() } catch {}
    try { if (container) container.remove() } catch {}
    root = null; container = null
  }
  const place = (host, fallback) => {
    container = document.createElement('div')
    container.className = 'dswfe-view'
    container.setAttribute('data-dswfe-view', '')
    if (fallback) container.setAttribute('data-dswfe-fallback', '')
    host.appendChild(container)
    root = require('react-dom/client').createRoot(container)
    root.render(h(ProcessPanel, { controller, t, slotProps: null }))
  }
  const ensure = (force) => {
    if (container && container.isConnected) return
    const column = document.querySelector(COLUMN_SELECTOR)
    if (column) { unplace(); place(column, false) }
    else if (force && document.body) { unplace(); place(document.body, true) }
  }
  const tryPlace = () => { ensure(false) }
  const waitObserver = new MutationObserver(tryPlace)
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const retry = setInterval(tryPlace, 2000)
  tryPlace()
  return {
    ensure,
    dispose() {
      clearInterval(retry)
      waitObserver.disconnect()
      unplace()
      try { document.documentElement.removeAttribute(PRC_ACTIVE_ATTR) } catch {}
    },
  }
}

const moduleExports = {
  name,
  inject,
  __internals: { Controller, filterProcesses, ZH, EN, AI_PROMPT, colorizeLine, buildFlowModel, layoutFlowGraph, clientFlowTarget },
  __boot(container, opts = {}) {
    ensureStyles()
    const t = makeT(null)
    const controller = new Controller()
    controller.t = t
    if (opts.autostart !== false) controller.start()
    if (opts.open !== false) controller.openPanel()
    const root = require('react-dom/client').createRoot(container)
    root.render(h(ProcessPanel, { controller, t, slotProps: null }))
    return { controller, root }
  },
  apply(ctx) {
    ensureStyles()
    let t = makeT(null)
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) t = makeT(bound)
      }
    } catch (e) { try { console.error('[dsh-workflow-execute] locale init:', e) } catch {} }
    const controller = new Controller()
    controller.t = t
    controller.start()
    try {
      const host = globalThis.location && globalThis.location.hostname
      if (host === 'localhost' || host === '127.0.0.1') window.__prc = controller
    } catch {}
    // 会话服务：动态 inject（客户端 ctx 支持；缺席时「打开会话」降级提示）
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sessions'], (scope) => {
          const svc = scope && scope.sessions
          if (svc && typeof svc.open === 'function') controller.sessionsSvc = svc
        })
        // dsh 0.1.7+: sessions.open() 被移除，会话导航改走
        // uiWorkspace.openSession()。归一成 { open(id) } 面孔，调用点不变。
        ctx.inject(['uiWorkspace'], (scope) => {
          const svc = scope && scope.uiWorkspace
          const cur = controller.sessionsSvc
          if (svc && typeof svc.openSession === 'function' && !(cur && typeof cur.open === 'function')) {
            controller.sessionsSvc = { open: (id) => svc.openSession(id) }
          }
        })
      }
    } catch (e) { console.error('[dsh-workflow-execute] sessions inject:', e) }
    // 同页重复 apply（重建/热重载）：先拆掉上一次挂载，避免残留失效的入口行
    if (typeof activeApplyTeardown === 'function') { try { activeApplyTeardown() } catch {} activeApplyTeardown = null }
    const disposers = []
    try { disposers.push(mountSidebarEntry(controller, t)) } catch (e) { console.error('[dsh-workflow-execute] sidebar mount:', e) }
    try { prcView = mountPrcView(controller, t); disposers.push(() => prcView && prcView.dispose()) } catch (e) { console.error('[dsh-workflow-execute] view mount:', e) }
    // 与其他面板互斥
    const onActivate = (event) => { if (event.detail !== PANEL_NAME && controller.getSnapshot().panelOpen) controller.closePanel() }
    document.addEventListener(ACTIVATE_EVENT, onActivate)
    const teardown = () => {
      document.removeEventListener(ACTIVATE_EVENT, onActivate)
      if (prcView) { try { prcView.dispose() } catch {} prcView = null }
      for (const d of disposers) { try { d() } catch {} }
      controller.dispose()
    }
    activeApplyTeardown = teardown
    ctx.effect(() => teardown, 'dsh-workflow-execute: client mount')
  },
}

// kit 内联（构建期注入到同一 factory 作用域的 var PluginKit；plain Node 测试下缺失 → AI 对话框降级提示）
function getKit() {
  try { return typeof PluginKit !== 'undefined' ? PluginKit : null } catch { return null }
}

module.exports = moduleExports
