'use strict'

/**
 * dsh-workflow-execute — 产物目录归档。
 *
 * 工作流的产物路径是固定的相对路径（如 workflow/bugfix/verify-plan.md），
 * 第二次执行会覆盖同名文件、并留下上一轮多出来的文件。所以每次运行开始时
 * 先把产物目录整份复制到该目录下的 .history/<runId>/，历史留档、当前目录干净。
 */

const fsP = require('node:fs/promises')
const path = require('node:path')

/** 历史目录名（放在产物目录内部，归档时跳过自身）。 */
const HISTORY_DIR = '.history'

/** 快照里的产物路径 → 去重后的产物目录（posix 风格相对路径）。 */
function artifactDirs(snapshot) {
  const dirs = new Set()
  const phases = snapshot && Array.isArray(snapshot.phases) ? snapshot.phases : []
  for (const ph of phases) {
    for (const ln of (ph && Array.isArray(ph.links) ? ph.links : [])) {
      const list = ln && Array.isArray(ln.expected_artifacts) ? ln.expected_artifacts : []
      for (const a of list) {
        const p = typeof a === 'string' ? a : a && a.path
        if (!p || typeof p !== 'string') continue
        const dir = path.posix.dirname(String(p).replace(/\\/g, '/'))
        if (!dir || dir === '.' || dir === '/' || dir.startsWith('..')) continue
        dirs.add(dir)
      }
    }
  }
  // 只要最外层目录：已经整份归档 workflow/bugfix 时，不必再单独归档它下面的子目录
  const all = [...dirs]
  return all.filter((d) => !all.some((o) => o !== d && d.startsWith(o + '/')))
}

/** 递归列出目录下的文件（相对路径，posix 分隔），跳过顶层 .history。 */
async function listFiles(root, rel = '') {
  const out = []
  const entries = await fsP.readdir(path.join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    const next = rel ? rel + '/' + e.name : e.name
    if (!rel && e.name === HISTORY_DIR) continue
    if (e.isDirectory()) out.push(...await listFiles(root, next))
    else if (e.isFile()) out.push(next)
  }
  return out
}

/**
 * 把快照里声明的产物目录归档到 <产物目录>/.history/<runId>/。
 * 返回已归档的相对目录（无内容 / 已归档过时返回空数组，绝不覆盖已有历史）。
 */
async function archiveArtifacts({ cwd, snapshot, runId, logger }) {
  if (!cwd || !runId) return []
  const done = []
  for (const rel of artifactDirs(snapshot)) {
    const src = path.resolve(cwd, rel)
    let stat
    try { stat = await fsP.stat(src) } catch { continue }
    if (!stat.isDirectory()) continue
    const files = await listFiles(src)
    if (files.length === 0) continue
    const dest = path.join(src, HISTORY_DIR, String(runId))
    let exists = true
    try { await fsP.stat(dest) } catch { exists = false }
    if (exists) continue
    for (const f of files) {
      const to = path.join(dest, f)
      await fsP.mkdir(path.dirname(to), { recursive: true })
      await fsP.copyFile(path.join(src, f), to)
    }
    const relDone = rel + '/' + HISTORY_DIR + '/' + runId
    done.push(relDone)
    if (logger && typeof logger.info === 'function') logger.info(`[dsh-workflow-execute] 旧产物已归档到 ${relDone}`)
  }
  return done
}

module.exports = { archiveArtifacts, artifactDirs, HISTORY_DIR }
