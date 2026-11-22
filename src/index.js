'use strict'

/**
 * dsh-workflow-execute — Host half（工作流管理）。
 *
 * 把「工作流」（Process：多阶段·多环节 agent 工作流模板）接进 dsh：
 * - 存储：我的库 ~/.ntd/processes（默认根，可改）+ 内置库 ~/.ntd/bundled/processes（只读），
 *   fs.watch 实时同步；根目录可在设置里改（dsh settings 服务，缺席时退回 JSON 文件）。
 * - 路由：/dsh-workflow-execute/*（JSON + SSE），供浏览器半边使用。
 * - 工具：workflow_list / workflow_get / workflow_validate / workflow_save（tools 服务在时注册）。
 * - 提示：systemPrompt 段落（服务在时注册）。
 * - AI 生成：kit 宿主执行器（agents 服务在时可用）。
 *
 * 零 @deepseek-ai/dsh-* 运行时依赖：所有宿主能力都走 ctx.* 服务；schemastery 沿
 * dsh 全局安装的副本加载（settings 服务要求它的 schema 形状）。
 */

const fsP = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')
const { createShareRunJob } = require('@weibaohui/dsh-plugin-kit')
const { ProcessStore, StoreError } = require('./store.js')
const { RunStore } = require('./runs.js')
const { ExecutionService } = require('./execution.js')
const { parseProcessYaml, validateProcess } = require('./validate.js')
const { registerRoutes } = require('./routes.js')
const { registerTools } = require('./tools.js')
const { SECTION_NAME, SECTION_ORDER, PROCESS_PROTOCOL } = require('./prompt.js')

const SETTINGS_NS = 'dsh-workflow-execute'

function loadSchemastery() {
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    try { return createRequire(hostCopy)(hostCopy) } catch { /* 下一个候选 */ }
  }
  try { return require('@deepseek-ai/schemastery') } catch { return null }
}

function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }
/** 工作流库根（rjWorkflow）：新名 RJ_WORKFLOW_HOME，旧 NTD_HOME 仍认（迁移兼容）。 */
function rjWorkflowHome() {
  const raw = process.env.RJ_WORKFLOW_HOME || process.env.NTD_HOME
  return raw ? resolve(raw) : join(homedir(), '.rjWorkflow')
}
/** 旧版根目录（~/.ntd），仅用于首次迁移探测。 */
function legacyNtdHome() { return process.env.NTD_HOME ? resolve(process.env.NTD_HOME) : join(homedir(), '.ntd') }

function defaultSettings() {
  return {
    userRoot: join(rjWorkflowHome(), 'workflows'),
    bundledRoot: join(rjWorkflowHome(), 'bundled', 'workflows'),
    maxDepth: 3,
  }
}

/**
 * 库目录迁移：新根不存在、旧 ~/.ntd/processes 有内容时复制过去（只复制，不动旧库）。
 * 返回是否发生过迁移，调用方据此决定是否重扫。
 */
async function migrateLegacyRoots(settings, logger) {
  const targets = [
    { to: settings.userRoot, from: join(legacyNtdHome(), 'processes') },
    { to: settings.bundledRoot, from: join(legacyNtdHome(), 'bundled', 'processes') },
  ]
  let migrated = false
  for (const { to, from } of targets) {
    if (to === from) continue
    try {
      const exists = await fsP.stat(to).then(() => true).catch(() => false)
      if (exists) continue
      const legacy = await fsP.stat(from).then(() => true).catch(() => false)
      if (!legacy) continue
      await fsP.mkdir(join(to, '..'), { recursive: true })
      await fsP.cp(from, to, { recursive: true })
      migrated = true
      logger.info && logger.info(`dsh-workflow-execute: 已把 ${from} 复制到 ${to}`)
    } catch (e) {
      logger.warn && logger.warn(`dsh-workflow-execute: 迁移 ${from} → ${to} 失败：${e && e.message}`)
    }
  }
  return migrated
}

function sanitizeSettings(patch, base) {
  const next = { ...base }
  if (patch && typeof patch === 'object') {
    if (typeof patch.userRoot === 'string' && patch.userRoot.trim() !== '') next.userRoot = expandHome(patch.userRoot.trim())
    if (typeof patch.bundledRoot === 'string' && patch.bundledRoot.trim() !== '') next.bundledRoot = expandHome(patch.bundledRoot.trim())
    if (Number.isInteger(patch.maxDepth) && patch.maxDepth >= 1 && patch.maxDepth <= 6) next.maxDepth = patch.maxDepth
  }
  return next
}

function expandHome(p) {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

module.exports = {
  name: 'dsh-workflow-execute',
  // 静态注入（系列惯例）：apply 在这些服务就绪后才运行。动态 ctx.inject(['settings'])
  // 在 apply 内不触发（hermes-loop 记录的平台坑），所以全部静态声明。
  inject: ['webServer', 'tools', 'systemPrompt', 'settings', 'agents', 'agentDefaultModel', 'sessions', 'workspaceRegistry', 'llm', 'skills', 'connection'],
  __test: { defaultSettings, sanitizeSettings, expandHome, migrateLegacyRoots },

  apply(ctx, rawConfig) {
    const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
    const logger = ctx.logger || console
    const Schema = loadSchemastery()

    // ── 设置：dsh settings 服务优先，缺席退回 JSON 文件 ──
    const base = sanitizeSettings(config, defaultSettings())
    const fallbackFile = join(dshHome(), 'dsh-workflow-execute', 'settings.json')
    let fileOverrides = {}
    let settingsScope = null
    const settingsSvc = ctx.settings
    if (Schema && settingsSvc && typeof settingsSvc.register === 'function') {
      try {
        settingsScope = settingsSvc.register(SETTINGS_NS, Schema.object({
          userRoot: Schema.string(),
          bundledRoot: Schema.string(),
          maxDepth: Schema.number(),
        }), { base })
      } catch (e) { logger.warn && logger.warn(`dsh-workflow-execute: settings register: ${e && e.message}`) }
    }
    const fileLoaded = fsP.readFile(fallbackFile, 'utf8').then((raw) => { fileOverrides = JSON.parse(raw) || {} }).catch(() => {})
    const settings = {
      get() {
        if (settingsScope && typeof settingsScope.get === 'function') {
          const v = settingsScope.get()
          if (v && typeof v === 'object') return sanitizeSettings(v, base)
        }
        return sanitizeSettings(fileOverrides, base)
      },
      async set(patch) {
        const cur = settings.get()
        const next = sanitizeSettings(patch, cur)
        if (process.env.DSH_WORKFLOW_EXECUTE_SETTINGS_DEBUG) console.error(`[dsh-workflow-execute][set] caller=${String(new Error().stack).split(String.fromCharCode(10))[2]} patch=${JSON.stringify(patch)} cur=${JSON.stringify(cur)} next=${JSON.stringify(next)}`)
        if (settingsScope) {
          if (typeof settingsScope.replace === 'function') await settingsScope.replace(next)
          else if (typeof settingsScope.update === 'function') await settingsScope.update(next)
          if (process.env.DSH_WORKFLOW_EXECUTE_SETTINGS_DEBUG) console.error(`[dsh-workflow-execute][set] after replace scope.get=${JSON.stringify((() => { try { return settingsScope.get() } catch (e) { return String(e) } })())}`)
        } else {
          fileOverrides = next
          await fsP.mkdir(join(fallbackFile, '..'), { recursive: true })
          await fsP.writeFile(fallbackFile, JSON.stringify(next, null, 2), 'utf8')
        }
        return settings.get()
      },
    }

    // ── 存储 ──
    const store = new ProcessStore({
      roots: () => { const s = settings.get(); return { user: s.userRoot, bundled: s.bundledRoot } },
      options: () => ({ maxDepth: settings.get().maxDepth }),
      logger,
    })
    void fileLoaded
      .then(() => migrateLegacyRoots(settings.get(), logger))
      .then(() => { store.startWatch(); return store.load() })

    // ── 运行台账 + 执行驱动（v0.2）──
    const runs = new RunStore(join(dshHome(), 'dsh-workflow-execute', 'runs.json'), logger)
    const execution = new ExecutionService({ ctx, runs, settings, logger })
    ctx.effect(() => () => { execution.dispose(); store.dispose() }, 'dsh-workflow-execute: store+execution dispose')
    ctx.effect(() => () => { /* runs 的 persist 定时器 unref，无需显式清理 */ }, 'dsh-workflow-execute: runs')
    void runs.load().then(() => execution.tick())
    const createRun = async ({ processId, workspaceId, model, provider, userInput, sessionMode }) => {
      if (runs.byStatus('queued', 'running').length >= 20) throw new StoreError('invalid_input', '排队/运行中的运行过多（上限 20）')
      const item = await store.get(processId)
      const parsed = parseProcessYaml(item.yaml)
      const result = validateProcess(parsed)
      if (result.errors.length > 0) {
        throw new StoreError('invalid', '工作流有校验错误，不能发起运行', { diagnostics: { errors: result.errors, warnings: result.warnings } })
      }
      const snapshot = parsed.data
      const { map } = require('./runs.js').indexLinks(snapshot)
      if (map.size === 0) throw new StoreError('invalid', '工作流没有任何环节，无法运行')
      const run = runs.create({
        processId, workspaceId, model, provider, userInput,
        sessionMode: sessionMode === 'multi' ? 'multi' : 'single',
        processName: result.meta.name || item.meta.name,
        displayName: result.meta.display_name || result.meta.name || item.meta.name,
        snapshotYaml: item.yaml, snapshot,
      })
      execution.tick()
      return run
    }

    // ── AI 生成（kit 宿主执行器：同进程 agents 会话，输出流式可见）──
    const jobs = new Map()
    const runAi = (prompt) => {
      const dir = settings.get().userRoot
      const svc = ctx.agents && ctx.agentDefaultModel ? { agents: ctx.agents, agentDefaultModel: ctx.agentDefaultModel, sessions: ctx.sessions } : undefined
      const job = createShareRunJob({ prompt, dir, jobs, logger, services: svc })
      // 任务表只留最近 50 条
      if (jobs.size > 50) { const oldest = jobs.keys().next().value; jobs.delete(oldest) }
      return job
    }

    // ── 路由 ──
    ctx.effect(() => registerRoutes(ctx, { store, settings, jobs, runAi, runs, execution, createRun, logger }), 'dsh-workflow-execute: routes')

    // ── 工具 / 提示词 ──
    ctx.effect(() => {
      const disposers = registerTools(ctx.tools, { store })
      return () => { for (const d of disposers) { try { d() } catch {} } }
    }, 'dsh-workflow-execute: tools')
    ctx.effect(() => ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROCESS_PROTOCOL }), 'dsh-workflow-execute: protocol section')
  },
}
