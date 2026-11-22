'use strict'

/**
 * dsh-workflow-execute — 执行驱动（v0.2）。
 *
 * 发起运行 = 冻结工作流快照 + 建台账；驱动循环逐环节开全新 dsh 会话（可绑工作区/
 * 指定模型），环节完成后代码层跑门禁（ai_criteria_review 裁判会话对照 min_score），
 * 不过按 on_gate_fail 流转（break → awaiting 等人裁决；<id>/goto:<id> 回跳），
 * max_rework 由代码计数封顶，max_step_executions 全程步数上限。
 * 人可暂停/继续/停止/裁决 break（重试本环节=清零返工、跳过本环节、中止运行）。
 *
 * 会话创建沿 dsh-tasks / dsh-plugin-kit 的成熟路径（agents.create + standard
 * preset + whenIdle + 事件泵收尾部输出），裁判用独立短会话。
 */

const { randomUUID } = require('node:crypto')
const { makeAttempt, parseFlow, indexLinks, nextLinkAfter, firstLinkId, runSummary } = require('./runs.js')
const { collectWriteOps, resolveArtifactEntries } = require('./artifacts.js')
const { archiveArtifacts } = require('./archive.js')

const OUTPUT_TAIL_CAP = 8 * 1024

/** 会话事件列表：0.1.5 起 snapshotEvents()（events 属性移除）；更早是 session.log / session.events 数组。 */
function sessionEventList(agent) {
  try {
    const ses = agent && agent.session
    if (ses && typeof ses.snapshotEvents === 'function') return ses.snapshotEvents() || []
    if (Array.isArray(ses && ses.log)) return ses.log
    if (Array.isArray(ses && ses.events)) return ses.events
  } catch { /* 会话对象缺席 */ }
  return []
}
const PUMP_MS = 500
const TOUCH_THROTTLE_MS = 1500
const JUDGE_TIMEOUT_MS = 180000


/** 门禁评审输出 → {score, reason}；解析失败按 0 分（fail-safe 走返工/裁决路径）。 */
function parseJudgeOutput(text) {
  const s = String(text || '')
  const fenced = s.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : s
  const brace = candidate.lastIndexOf('{')
  if (brace >= 0) {
    const end = candidate.indexOf('}', brace)
    if (end > brace) {
      try {
        const j = JSON.parse(candidate.slice(brace, end + 1))
        const score = Math.max(0, Math.min(100, Math.round(Number(j.score))))
        if (Number.isFinite(score)) return { score, reason: String(j.reason || '').slice(0, 300) }
      } catch { /* 落到默认 */ }
    }
  }
  return { score: 0, reason: '评审输出无法解析，按不通过处理' }
}

/**
 * 会话事件 → token 用量合计：assistant/message 事件逐步累加 usage
 * （宿主 ≥0.1.5 在事件 data 上携带该步 {inputTokens,outputTokens,totalTokens}；
 * 每步 inputTokens 含该步全量 prompt，逐步求和 = API 实际计费口径）。
 * 会话没有 usage 记录（旧宿主/适配器未上报）时返回 undefined。
 */
function sumUsage(agent, firstSeq) {
  let found = false
  const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }
  for (const ev of sessionEventList(agent)) {
    if (!ev || ev.seq < firstSeq) continue
    const u = ev.type === 'assistant/message' && ev.data ? ev.data.usage : undefined
    if (!u || typeof u !== 'object') continue
    found = true
    total.inputTokens += Number(u.inputTokens) || 0
    total.outputTokens += Number(u.outputTokens) || 0
    total.totalTokens += Number(u.totalTokens) || 0
    total.calls += 1
  }
  return found ? total : undefined
}

/** 两份用量合并成新对象（a 可为 undefined）——运行合计 = 已累计 + 本次增量。 */
function addUsage(a, b) {
  const base = a || { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }
  return {
    inputTokens: base.inputTokens + b.inputTokens,
    outputTokens: base.outputTokens + b.outputTokens,
    totalTokens: base.totalTokens + b.totalTokens,
    calls: base.calls + b.calls,
  }
}

/**
 * 会话这一轮是怎么结束的：completed 正常结束，aborted = 用户点了终止，error = 会话出错。
 * 只有 completed 才算「环节跑完了」，其余都不能往下流转。
 */
function turnEndKind(events, fromSeq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.seq < fromSeq) continue
    if (ev.type === 'turn/end') {
      const reason = ev.data && ev.data.reason
      return (reason && reason.kind) || 'unknown'
    }
  }
  return undefined
}

/** 环节被中断（用户终止或会话出错）：不进门禁、不流转，整条运行停下。 */
class LinkInterrupted extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinkInterrupted'
  }
}

class ExecutionService {
  /**
   * @param {object} deps
   * @param {object} deps.ctx 宿主上下文（agents / agentDefaultModel / workspaceRegistry）
   * @param {import('./runs.js').RunStore} deps.runs
   * @param {{get: Function}} deps.settings
   * @param {object} [deps.logger]
   */
  constructor({ ctx, runs, settings, logger }) {
    this.ctx = ctx
    this.runs = runs
    this.settings = settings
    this.logger = logger || console
    this.active = new Map() // runId → driveLoop promise
    this.runSessions = new Map() // runId → { agent, sessionId }（sessionMode='single' 复用）
    const parsed = Number.parseInt(process.env.DSH_WORKFLOW_EXECUTE_MAX_CONCURRENT ?? '', 10)
    this.maxConcurrent = Number.isInteger(parsed) && parsed >= 1 ? parsed : 2
    this.disposed = false
  }

  /** 宿主卸载/重启时置位：延迟 tick 与在飞收尾不得再碰 ctx。 */
  dispose() { this.disposed = true }

  /** 容量允许时从队列拉起运行；在 run 收尾后也要再 tick 一次。 */
  tick() {
    if (this.disposed) return
    let agents
    try { agents = this.ctx.agents } catch { return } // ctx 已失效（宿主重启后残留 tick）：静默退出，绝不抛——这里抛错=整个 web 启动失败
    if (!agents) return
    const queued = this.runs.byStatus('queued')
    for (const run of queued) {
      if (this.active.size >= this.maxConcurrent) break
      if (this.active.has(run.id)) continue
      run.status = 'running'
      run.startedAt = run.startedAt || Date.now()
      this.runs.touch(run)
      const p = this.driveLoop(run).catch((e) => {
        this.logger.warn && this.logger.warn(`dsh-workflow-execute: run ${run.id} crashed: ${e && e.stack || e}`)
        if (run.status === 'running') this.failRun(run, 'crashed', String(e && e.message || e))
      }).finally(() => { this.active.delete(run.id); this.tick() })
      this.active.set(run.id, p)
    }
  }

  // ── 运行循环 ──────────────────────────────────────────────────────────

  async driveLoop(run) {
    const snap = run.snapshot
    let cursor = run.current && run.current.linkId && indexLinks(snap).map.has(run.current.linkId)
      ? run.current.linkId
      : firstLinkId(snap)
    if (!cursor) { this.finishRun(run, 'done', '工作流没有环节'); return }
    run.current = { phaseId: undefined, linkId: cursor, attempt: (run.rework[cursor] || 0) + 1 }
    this.runs.touch(run)

    if (run.status !== 'running') { this.settleTrail(run); return }

    // 每次运行只归档一次：把上一轮留下的产物整份复制到 <产物目录>/.history/<runId>/，
    // 否则本轮同名文件会覆盖上一轮，留下的旧文件又会被当成本次产物。
    if (!run.archiveDone) {
      run.archiveDone = true
      try {
        const archived = await archiveArtifacts({ cwd: this.runCwd(run), snapshot: snap, runId: run.id, logger: this.logger })
        if (archived.length > 0) run.artifactArchive = archived
      } catch (error) {
        if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(`[dsh-workflow-execute] ${run.id} 归档旧产物失败：${String(error && error.message || error)}`)
      }
      this.runs.touch(run)
    }

    for (;;) {
      if (run.status !== 'running') { this.settleTrail(run); return }
      const { map } = indexLinks(snap)
      const entry = map.get(cursor)
      if (!entry) { this.failRun(run, 'bad_flow', `环节 "${cursor}" 在快照中不存在`); return }

      const maxRework = Number.isInteger(entry.link.max_rework) && entry.link.max_rework >= 0 ? entry.link.max_rework : 3
      const rework = run.rework[cursor] || 0
      if (rework > maxRework) {
        this.awaitBreak(run, cursor, { name: '返工上限', score: null, minScore: null, reason: '触发' },
          `环节 "${cursor}" 超过 max_rework=${maxRework}`)
        return
      }
      if (run.limits.maxStepExecutions !== null && run.limits.maxStepExecutions !== undefined
        && run.stepCount >= run.limits.maxStepExecutions) {
        this.failRun(run, 'capped_step', `达到步数上限 max_step_executions=${run.limits.maxStepExecutions}`)
        return
      }

      run.current = { phaseId: entry.phase.id, linkId: cursor, attempt: rework + 1 }
      const attempt = makeAttempt(entry.phase.id || entry.phase.name, cursor, rework + 1)
      run.trail.push(attempt)
      run.stepCount += 1
      this.runs.touch(run)

      try {
        const output = await this.runLinkSession(run, entry, attempt)
        // ── 人工审核（review_type: human）：不做 AI 评分，环节做完了等人验收，
        //    验收通过后由 actionResolveBreak 按 on_success 流转 ──
        if ((entry.link.review_type || 'ai') === 'human') {
          attempt.status = 'awaiting_review'
          attempt.finishedAt = Date.now()
          this.runs.touch(run)
          this.awaitBreak(run, cursor, { name: '人工审核', score: null, minScore: null, reason: '等待人工审核' },
            'review_type: human', 'human')
          return
        }
        // ── 门禁（全部通过才算过；取最严一分）──
        const gates = Array.isArray(entry.link.gates) ? entry.link.gates : []
        let failedGate = null
        for (const gate of gates) {
          if (!gate || typeof gate !== 'object') continue
          const judge = await this.judgeGate(run, entry, gate, output)
          if (judge.usage) {
            attempt.gateUsage = addUsage(attempt.gateUsage, judge.usage)
            run.usage = addUsage(run.usage, judge.usage)
          }
          if (!attempt.gate || (judge.score < (attempt.gate.score ?? 101))) attempt.gate = { name: gate.name || gate.type || 'gate', score: judge.score, minScore: gate.min_score ?? 0, reason: judge.reason }
          const min = typeof gate.min_score === 'number' ? gate.min_score : 0
          if (judge.score < min) { failedGate = { gate: { name: gate.name || gate.type || 'gate', score: judge.score, minScore: min, reason: judge.reason }, linkId: cursor }; break }
        }
        if (failedGate) {
          attempt.status = 'gate_failed'
          attempt.finishedAt = Date.now()
          attempt.gate = failedGate.gate
          run.rework[cursor] = (run.rework[cursor] || 0) + 1
          const route = parseFlow(entry.link.on_gate_fail) || { jump: cursor }
          if (route === 'break') {
            this.awaitBreak(run, cursor, failedGate.gate, 'on_gate_fail: break')
            return
          }
          cursor = route === 'next' ? (nextLinkAfter(snap, cursor) || cursor) : route.jump
          run.current = { phaseId: undefined, linkId: cursor, attempt: (run.rework[cursor] || 0) + 1 }
          this.runs.touch(run)
          continue
        }
        attempt.status = 'done'
        attempt.finishedAt = Date.now()
        this.runs.touch(run)

        // ── 成功流转 ──
        const route = parseFlow(entry.link.on_success) || 'next'
        if (route === 'end') { this.finishRun(run, 'done'); return }
        if (route === 'break') { this.awaitBreak(run, cursor, null, 'on_success: break'); return }
        cursor = route === 'next' ? nextLinkAfter(snap, cursor) : route.jump
        if (!cursor || !map.has(cursor)) {
          if (route === 'next') { this.finishRun(run, 'done'); return }
          this.failRun(run, 'bad_flow', `流转目标 "${route.jump}" 不存在`)
          return
        }
        run.current = { phaseId: undefined, linkId: cursor, attempt: (run.rework[cursor] || 0) + 1 }
        this.runs.touch(run)
      } catch (error) {
        attempt.status = 'failed'
        attempt.finishedAt = Date.now()
        attempt.error = String(error && error.message || error)
        this.settleTrail(run)
        this.runs.touch(run)
        // 中断（用户终止/会话出错）时运行已被置为 stopped，不再改写成 failed
        if (error instanceof LinkInterrupted) return
        this.failRun(run, 'link_failed', `环节 "${cursor}" 执行失败：${attempt.error}`)
        return
      }
    }
  }

  settleTrail(run) {
    for (const t of run.trail) if (t.status === 'running') { t.status = 'abandoned'; t.finishedAt = Date.now() }
  }

  finishRun(run, status, note) {
    this.settleTrail(run)
    run.status = status
    run.finishedAt = Date.now()
    run.current = null
    if (note) run.error = note
    this.runSessions.delete(run.id)
    this.runs.touch(run)
  }

  failRun(run, code, message) { this.finishRun(run, 'failed', message) }

  awaitBreak(run, linkId, gate, reason, kind = 'gate') {
    this.settleTrail(run)
    run.status = 'awaiting'
    run.pendingBreak = { linkId, gate, reason, kind, at: Date.now() }
    this.runs.touch(run)
  }

  // ── 会话驱动 ──────────────────────────────────────────────────────────

  buildLinkPrompt(run, entry) {
    const { link, phase } = entry
    // 用户输入只给链路起点环节（回跳到起点也算）：下游环节的输入是上游产出，见下方 upstreamBlock
    const isStartLink = !!link && link.id === firstLinkId(run.snapshot)
    const userBlock = isStartLink && run.userInput
      ? ['【本次运行的用户需求】（这是用户这次真正要处理的事，本环节负责把它落成结论）', run.userInput, ''].join('\n')
      : ''
    // 产物名可留空：回退到路径里的文件名，再不行用环节名——不逼用户给每条产物起名
    const artifactLabel = (a) => {
      const p = a && a.path ? String(a.path) : ''
      const named = a && a.name ? String(a.name) : ''
      if (named) return p ? named + '（' + p + '）' : named
      const base = p ? p.split(/[\\/]/).pop() : ''
      const label = base || (link.name || link.id) + '（本环节产物）'
      return p ? label + '（' + p + '）' : label
    }
    const artifacts = Array.isArray(link.expected_artifacts) && link.expected_artifacts.length > 0
      ? link.expected_artifacts.map((a) => '- ' + artifactLabel(a)).join('\n')
      : '（本环节未声明产物）'
    // 上游产出：取 trail 里当前 attempt 之前、最近一条「别的环节」的尝试（跨阶段不重置）。
    // 同一环节的上次失败不进这里，而由 reworkBlock 单独说明，避免两处重复。
    const prevAttempts = Array.isArray(run.trail) ? run.trail.slice(0, -1) : []
    const prev = prevAttempts.slice().reverse().find((t) => t && t.linkId !== link.id)
    const linkNameOf = (id) => {
      const m = indexLinks(run.snapshot).map.get(id)
      return (m && m.link && (m.link.name || m.link.id)) || id
    }
    let upstreamBlock = ''
    if (prev) {
      const min = prev.gate && typeof prev.gate.minScore === 'number' ? prev.gate.minScore : 0
      // 未通过时把评审原话带过去：回跳目标（如 goto:verify-01）只能看到「未通过 + 分数」是不够的
      const prevPassed = prev.gate && typeof prev.gate.score === 'number' ? prev.gate.score >= min : null
      const gateInfo = prevPassed === null
        ? ''
        : `，门禁「${prev.gate.name || '门禁'}」${prev.gate.score}/${min}${prevPassed ? '（通过）' : '（未通过）'}`
          + (prevPassed ? '' : (prev.gate.reason ? ` —— 评审意见：${prev.gate.reason}` : ' —— 评审意见未记录'))
      const files = Array.isArray(prev.artifacts) && prev.artifacts.length
        ? prev.artifacts.map((a) => '- ' + (a.path || a.name || '(未命名)')
          + (a.exists ? '' : '（文件不存在）')
          + (typeof a.additions === 'number' ? `  +${a.additions}/-${a.deletions || 0}` : '')).join('\n')
        : '（本环节未写入文件）'
      upstreamBlock = [
        `【上游环节产出】来自 ${prev.linkId}《${linkNameOf(prev.linkId)}》，状态 ${prev.status}${gateInfo}`,
        '产物文件：',
        files,
        '上游输出原文（可能因引擎上限被截断，需要完整内容请直接打开上面的文件）：',
        prev.outputTail && String(prev.outputTail).trim() !== '' ? String(prev.outputTail) : '（无文字输出）',
        '',
      ].join('\n')
    }
    // 返工提示：本环节此前没过，附上次门禁原话，避免盲目重跑同一条指令
    const reworkNo = run.rework && Number(run.rework[link.id]) ? Number(run.rework[link.id]) : 0
    const lastFail = prevAttempts.slice().reverse()
      .find((t) => t && t.linkId === link.id && t.gate && t.gate.reason)
    const reworkBlock = reworkNo > 0
      ? [
        `【本次是返工（本环节第 ${reworkNo + 1} 次执行）】`,
        lastFail
          ? `上次未通过：门禁「${lastFail.gate.name || '门禁'}」${lastFail.gate.score}/${typeof lastFail.gate.minScore === 'number' ? lastFail.gate.minScore : 0} —— ${lastFail.gate.reason}`
          : '上次未通过，原因未记录',
        '先针对上面这条原因修复，再重做本环节；之前已经做对的部分不要推翻重来。',
        '',
      ].join('\n')
      : ''
    return [
      userBlock,
      `你正在执行工作流「${run.displayName || run.processName}」的一个环节，只做本环节的事，不要越界到其他环节。`,
      `环节：${phase && phase.name ? `${phase.name} / ` : ''}${link.name || link.id}（id=${link.id}）`,
      link.expert_name || link.expert ? `建议以专家「${link.expert_name || link.expert}」的标准与视角执行。` : '',
      Array.isArray(link.skills) && link.skills.length ? `可用技能：${link.skills.join(', ')}` : '',
      '',
      upstreamBlock,
      reworkBlock,
      '【环节指令】',
      link.prompt || '（无指令，请根据环节名合理执行）',
      '',
      '【期望产物】',
      artifacts,
      link.acceptance_criteria ? `【环节验收标准】\n${link.acceptance_criteria}` : '',
      '',
      '完成后：在回答末尾输出执行报告，固定四段——①改动或结论（带文件路径与 文件:行）②验证方式与结果（命令 + 输出摘要）③遗留与未验证项④下一环节须知。门禁评审只看得到这段输出，证据必须写在这里。',
    ].filter((x) => x !== '').join('\n')
  }

  /** 运行绑定的工作区（未绑定时 undefined）。 */
  workspaceOf(run) {
    return run.workspaceId && this.ctx.workspaceRegistry
      ? this.ctx.workspaceRegistry.get(run.workspaceId)
      : undefined
  }

  /** 运行工作目录：绑定工作区路径，没有绑定分区就用用户库根目录。 */
  runCwd(run) {
    const workspace = this.workspaceOf(run)
    return workspace ? workspace.path : this.settings.get().userRoot
  }

  /** 会话模式：single=整条流程共用一个会话（含门禁评审）；multi=每环节一个、门禁独立会话。 */
  sessionMode(run) {
    return run && run.sessionMode === 'single' ? 'single' : 'multi'
  }

  /**
   * 取本次环节/门禁要用的会话。
   * multi：每次新建（原行为）。single：复用本运行的第一个会话，门禁也用它。
   */
  /**
   * 单会话模式下复用的会话是否还能写：宿主把会话从 SessionStore 摘掉后，
   * 再 append 会抛 `session "…" cannot append outside a SessionStore`。
   */
  isSessionLive(entry) {
    if (!entry || !entry.sessionId) return false
    const store = this.ctx && this.ctx.sessions
    if (!store || typeof store.get !== 'function') return !!entry.agent
    try {
      const live = store.get(entry.sessionId)
      if (!live) return false
      return !entry.agent || entry.agent.session === live
    } catch {
      return false
    }
  }

  async getSession({ run, title, withTools = true }) {
    if (this.sessionMode(run) !== 'single') return this.createSession({ run, title, withTools })
    const cached = this.runSessions.get(run.id)
    if (cached && this.isSessionLive(cached)) return cached
    if (cached) {
      this.runSessions.delete(run.id)
      this.logger.warn && this.logger.warn(`[dsh-workflow-execute] ${run.id} 单会话 ${cached.sessionId} 已失效，本环节起改用新会话（上下文不再连续）`)
    }
    const made = await this.createSession({ run, title, withTools })
    this.runSessions.set(run.id, made)
    return made
  }

  async createSession({ run, title, withTools = true }) {
    const selection = run.model
      ? { provider: run.provider, model: run.model }
      : this.ctx.agentDefaultModel.currentSelection()
    const sessionId = 'session-' + randomUUID()
    const workspace = this.workspaceOf(run)
    if (run.workspaceId && !workspace) throw new Error(`workspace '${run.workspaceId}' not found`)
    // 分区归属的判定是「会话 header.cwd === 分区路径」严格相等（dsh-workspace 的 attachSession /
    // candidateMatches），所以会话头直接用分区路径；没有绑定分区时用用户库根目录。
    const cwd = workspace ? workspace.path : this.settings.get().userRoot
    const { agent } = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      // 关键：meta.agentPreset 只是会话头标签、不带任何工具——必须在 setup 里 mount
      // 部署默认预设（web 网关/dsh-tasks/dsh-kb 同款），否则会话零工具，
      // 模型只会干说「我无法执行」（真机抓过，见 dsh-kb v0.2 踩坑实录①）。
      setup: async (agentCtx) => {
        try {
          const presets = typeof this.ctx.get === 'function' ? this.ctx.get('agentPresets') : undefined
          if (withTools && presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
            const resolved = await presets.resolve(undefined)
            if (resolved && resolved.id) await presets.mount(agentCtx, resolved.id)
            this.logger.info && this.logger.info(`[dsh-workflow-execute] preset mounted: ${resolved && resolved.id}`)
          }
          if (withTools) {
            // 无人值守要写产物文件：沙箱 workspace-write + 审批 never（dsh-kb 同款旋钮）
            agentCtx.session.append('sandbox/mode', { mode: 'workspace-write' })
            agentCtx.session.append('approval/policy', { policy: 'never' })
          }
        } catch (e) { console.error(`[dsh-workflow-execute] setup 失败（会话将继续但可能无工具）: ${e && e.stack || e}`) }
      },
    })
    if (workspace && typeof workspace.attachSession === 'function') {
      try {
        await workspace.attachSession(sessionId)
      } catch (e) {
        // 分区归属的判定是「会话 header 的 cwd === 分区路径」（dsh-workspace 的 attachSession /
        // candidateMatches 都做严格相等）。上面已按分区路径建会话，正常应当挂得上；
        // 挂不上只会是路径形态不一致（盘符大小写、符号链接、8.3 短名）这类原因。
        // 这里只记录原因，不阻塞执行（会话会独立成一个项目分组，界面上不属于所选分区）。
        this.logger.warn && this.logger.warn(
          `[dsh-workflow-execute] ${run.id} 会话 ${sessionId} 未能归入分区 ${workspace.path}：${(e && e.message) || e}`,
        )
      }
    }
    try {
      agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    } catch { /* 标题失败非致命 */ }
    // 等会话运行时启动完成（kit 同款）：立刻 followup 会丢消息（会话零事件、空转完成）
    await agent.whenIdle()
    return { agent, sessionId }
  }

  /** 执行一个环节：开会话 → followup → 事件泵收尾部 → whenIdle → 汇总报告文本。 */
  async runLinkSession(run, entry, attempt) {
    const prompt = this.buildLinkPrompt(run, entry)
    const { agent, sessionId } = await this.getSession({
      run,
      // 会话标题带运行名（工作流名 · 需求摘要）：同工作流多次运行的同名环节在会话列表里也能分开
      title: `${run.runName || run.displayName || run.processName} · ${entry.link.name || entry.link.id}`,
    })
    attempt.sessionId = sessionId
    this.runs.touch(run)

    let tail = ''
    let lastTouch = 0
    const firstSeq = agent.session.seq
    const seen = new Set()
    let cancelSent = false
    const liveLine = (text) => { tail = (tail + text).slice(-OUTPUT_TAIL_CAP) }
    const eventList = () => sessionEventList(agent)
    const pump = () => {
      // 面板上点了停止：立刻打断当前会话，不等它自己跑完
      if (!cancelSent && run.status !== 'running') {
        cancelSent = true
        try { if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' }) } catch { /* 会话可能已空闲 */ }
      }
      let changed = false
      for (const ev of eventList()) {
        if (ev.seq < firstSeq || seen.has(ev.seq)) continue
        seen.add(ev.seq)
        const d = ev.data || {}
        if (ev.type === 'assistant/chunk' && d.chunk && typeof d.chunk.text === 'string' && (d.chunk.type === 'text-delta' || d.chunk.type === 'text')) { liveLine(d.chunk.text); changed = true }
        else if (ev.type === 'tool/call') { liveLine(`\n[tool] ${String(d.name || '')} `); changed = true }
      }
      if (changed && Date.now() - lastTouch > TOUCH_THROTTLE_MS) { lastTouch = Date.now(); attempt.outputTail = tail; this.runs.touch(run) }
    }
    const timer = setInterval(pump, PUMP_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      // v3 裸包装 {kind:'plugin', plugin:…} 在 format v4 宿主写路径抛 SessionFormatError
      // （同 dsh-kb#1），必须用生产者自有写法 kind:'plugin:<名>'
      agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin:dsh-workflow-execute' } })
      await agent.whenIdle()
    } finally {
      clearInterval(timer)
      pump()
    }
    let output = tail.trim()
    if (output === '') {
      // 兜底：从最终 assistant 消息提取可见文本（kit 同款）
      const list = eventList()
      for (let i = list.length - 1; i >= 0; i--) {
        const ev = list[i]
        const msg = ev && ev.type === 'assistant/message' && ev.data ? ev.data.message : undefined
        if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
          const text = msg.content.filter((b) => b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string').map((b) => b.text).join('')
          if (text.trim() !== '') { output = text; break }
        }
      }
    }
    try { if (this.ctx.sessions && typeof this.ctx.sessions.flush === 'function') await this.ctx.sessions.flush(agent.session) } catch { /* 刷盘失败不致命 */ }

    // 这一轮是怎么结束的：用户点了终止（turn/end.kind = aborted）或会话出错（error）时，
    // 不能当成「环节跑完了」继续走门禁/流转——那会带着半截产物进入下一环节。
    const endKind = turnEndKind(eventList(), firstSeq)
    const stopped = run.status !== 'running'
    if (stopped || endKind === 'aborted' || endKind === 'error') {
      attempt.outputTail = output.slice(-OUTPUT_TAIL_CAP)
      attempt.status = 'failed'
      attempt.finishedAt = Date.now()
      attempt.error = stopped ? '已停止运行，本环节作废' : `会话被中断（${endKind}），本环节作废`
      this.runs.touch(run)
      if (run.status === 'running') this.finishRun(run, 'stopped', attempt.error)
      throw new LinkInterrupted(attempt.error)
    }

    attempt.outputTail = output.slice(-OUTPUT_TAIL_CAP)
    // 环节 token 用量：全新会话 → 会话内逐步 usage 求和即本环节消耗
    const usage = sumUsage(agent, firstSeq)
    if (usage) {
      attempt.usage = usage
      run.usage = addUsage(run.usage, usage)
    }
    // 产物收集：只认会话里真实的写文件操作（write/edit 结果 meta.diffs、str-replace-editor
    // 调用参数），按路径累计 +n/-n 与 diff；逐个 stat 出存在性
    try {
      attempt.artifacts = await resolveArtifactEntries({ cwd: this.runCwd(run), written: collectWriteOps(eventList(), firstSeq) })
    } catch { /* stat 失败不致命：产物列表留空 */ }
    return output
  }

  /** 评审超时（毫秒）：gate.timeout_ms > limits.judge_timeout_ms > 默认 180s。 */
  judgeTimeoutMs(run, gate) {
    const limits = (run && run.snapshot && run.snapshot.limits) || {}
    const pick = (v) => (Number.isFinite(Number(v)) && Number(v) >= 5000 ? Number(v) : null)
    return pick(gate && gate.timeout_ms) ?? pick(limits.judge_timeout_ms) ?? JUDGE_TIMEOUT_MS
  }

  /** 门禁裁判：独立短会话按 ai_criteria_review 打分。 */
  async judgeGate(run, entry, gate, output) {
    const type = gate.type || 'ai_criteria_review'
    // 评审口径：gate.review_prompt 优先于 link.review_prompt（该字段此前只落盘、从未生效）
    const reviewPrompt = (gate && typeof gate.review_prompt === 'string' && gate.review_prompt.trim())
      || (entry.link && typeof entry.link.review_prompt === 'string' && entry.link.review_prompt.trim())
      || ''
    const prompt = [
      '你是工作流门禁评审员。对下面这次环节执行打分，只输出一个 JSON 对象：{"score": 0-100整数, "reason": "一句话理由"}。',
      `门禁：${gate.name || '(未命名)'}（评审方式 ${type}）；通过分数线：${typeof gate.min_score === 'number' ? gate.min_score : 0}。`,
      reviewPrompt ? `【评审口径】
${reviewPrompt}` : '',
      entry.link && entry.link.acceptance_criteria ? `【本环节验收标准】\n${entry.link.acceptance_criteria}` : '',
      '',
      `【环节指令】\n${entry.link.prompt || '(空)'}`,
      `【执行报告】\n${output || '(无输出)'}`,
    ].join('\n')
    try {
      const { agent } = await this.getSession({ run, title: `门禁评审 · ${run.runName || run.displayName || run.processName} · ${gate.name || gate.type}`, withTools: false })
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      const eventList = () => sessionEventList(agent)
      agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin:dsh-workflow-execute' } })
      const idle = agent.whenIdle()
      const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), this.judgeTimeoutMs(run, gate)))
      const outcome = await Promise.race([idle.then(() => 'done'), timer])
      const usage = sumUsage(agent, firstSeq)
      if (outcome !== 'done') return { score: 0, reason: '评审超时，按不通过处理', usage }
      const list = eventList()
      let text = ''
      for (let i = list.length - 1; i >= 0; i--) {
        const ev = list[i]
        if (ev.seq < firstSeq) continue
        const msg = ev && ev.type === 'assistant/message' && ev.data ? ev.data.message : undefined
        if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
          text = msg.content.filter((b) => b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string').map((b) => b.text).join('')
          if (text.trim() !== '') break
        }
      }
      return { ...parseJudgeOutput(text), usage }
    } catch (error) {
      return { score: 0, reason: `评审会话失败：${String(error && error.message || error)}` }
    }
  }

  // ── 人的操作 ──────────────────────────────────────────────────────────

  actionPause(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (run.status !== 'running' && run.status !== 'queued') throw new Error('Error: invalid_transition: 只能暂停运行中/排队中的运行')
    run.status = 'paused'
    this.runs.touch(run)
    return run
  }

  actionResume(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (run.status !== 'paused') throw new Error('Error: invalid_transition: 只能继续已暂停的运行')
    run.status = 'queued'
    run.error = undefined
    this.runs.touch(run)
    this.tick()
    return run
  }

  actionStop(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (['done', 'stopped', 'failed'].includes(run.status)) throw new Error('Error: invalid_transition: 运行已结束')
    // 先打断正在跑的那一轮会话（否则环节会跑完再停，白烧一次 token）
    const cached = this.runSessions.get(run.id)
    if (cached && cached.agent && typeof cached.agent.cancel === 'function') {
      try { cached.agent.cancel({ kind: 'user' }) } catch { /* 会话已空闲 */ }
    }
    this.finishRun(run, 'stopped')
    this.tick()
    return run
  }

  /** break 裁决：retry（清零返工重跑本环节）/ skip（视为通过，按 on_success 走）/ stop。 */
  actionResolveBreak(id, decision) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (run.status !== 'awaiting' || !run.pendingBreak) throw new Error('Error: invalid_transition: 运行不在等待裁决状态')
    const linkId = run.pendingBreak.linkId
    const kind = run.pendingBreak.kind || 'gate'
    // 人工审核（review_type: human）的裁决：通过 = 把该次尝试标记 approved 后按 on_success 走；
    // 打回 = 清零返工重跑本环节。人工通过不补 skipped 记录——那不是「跳过环节」。
    const markAwaitingReview = (status) => {
      for (let i = run.trail.length - 1; i >= 0; i--) {
        const t = run.trail[i]
        if (t.linkId === linkId && t.status === 'awaiting_review') { t.status = status; t.finishedAt = Date.now(); return }
      }
    }
    if (decision === 'stop') { run.pendingBreak = null; this.finishRun(run, 'stopped'); this.tick(); return run }
    run.pendingBreak = null
    if (decision === 'retry') {
      if (kind === 'human') markAwaitingReview('rejected')
      run.rework[linkId] = 0
      run.current = { phaseId: undefined, linkId, attempt: 1 }
    } else if (decision === 'skip') {
      const { map } = indexLinks(run.snapshot)
      const entry = map.get(linkId)
      if (kind === 'human') markAwaitingReview('approved')
      else run.trail.push(makeAttempt(entry ? entry.phase.id : undefined, linkId, (run.rework[linkId] || 0) + 1, { status: 'skipped', finishedAt: Date.now() }))
      const route = parseFlow(entry && entry.link.on_success) || 'next'
      const next = route === 'next' ? nextLinkAfter(run.snapshot, linkId) : route === 'end' ? null : route.jump
      if (!next) { this.finishRun(run, 'done'); this.tick(); return run }
      run.current = { phaseId: undefined, linkId: next, attempt: (run.rework[next] || 0) + 1 }
    } else {
      throw new Error('Error: invalid_input: decision 必须是 retry | skip | stop')
    }
    run.status = 'queued'
    this.runs.touch(run)
    this.tick()
    return run
  }

  /** 跳过某个环节（仅暂停/等待裁决/失败态可用）；retryLink 重跑某环节。 */
  actionSkipLink(id, linkId) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (run.status === 'running') throw new Error('Error: invalid_transition: 运行中请先暂停')
    const { map } = indexLinks(run.snapshot)
    const entry = map.get(linkId)
    if (!entry) throw new Error('Error: invalid_input: 环节不存在')
    run.trail.push(makeAttempt(entry.phase.id, linkId, (run.rework[linkId] || 0) + 1, { status: 'skipped', finishedAt: Date.now() }))
    const route = parseFlow(entry.link.on_success) || 'next'
    const next = route === 'next' ? nextLinkAfter(run.snapshot, linkId) : route === 'end' ? null : route.jump
    if (!next) { this.finishRun(run, 'done'); this.tick(); return run }
    run.current = { phaseId: undefined, linkId: next, attempt: (run.rework[next] || 0) + 1 }
    if (run.status !== 'queued') run.status = 'queued'
    this.runs.touch(run)
    this.tick()
    return run
  }

  actionRetryLink(id, linkId) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`Error: not_found: ${id}`)
    if (run.status === 'running') throw new Error('Error: invalid_transition: 运行中请先暂停')
    const { map } = indexLinks(run.snapshot)
    if (!map.has(linkId)) throw new Error('Error: invalid_input: 环节不存在')
    run.rework[linkId] = 0
    run.current = { phaseId: undefined, linkId, attempt: 1 }
    run.status = 'queued'
    run.error = undefined
    this.runs.touch(run)
    this.tick()
    return run
  }
}

module.exports = { ExecutionService, parseJudgeOutput, sumUsage, addUsage, runSummary }
