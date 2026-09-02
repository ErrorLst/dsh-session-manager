// dsh-session-manager —— Node half（宿主侧）。
//
// 职责：
//   1. 经 ctx.webServer 挂 HTTP API（同 dsh-notes / dsh-deepseek-quota 通道）：
//        GET  /api/dsh-session-manager            -> { ok, config, stats, sessions }
//      全量会话快照 + 阈值配置 + 统计（总数 / 总大小 / 已逾期货），供设置页与
//      启动弹窗使用。
//        POST /api/dsh-session-manager            -> { action, … }
//      动作：
//        delete          删除一个「冷」会话（非打开中、非运行中）的全部持久化
//                        工件 —— JSONL 日志文件 + 空会话目录；成功后 emits
//                        `api-session/removed`，让 Web 端会话列表即时移除该行。
//        delete-expired  手动批量删除：删除「最近更新」早于 maxAgeDays 天的所有
//                        会话（跳过打开中 / 运行中 / 子代理），返回删除与跳过统计。
//        set-config      保存阈值配置（设置页编辑，立即生效）。
//        reset-config    恢复基线（= 包内 config.json 的出厂值）。
//   2. 不做任何启动时自动删除；阈值告警只统计，弹窗由浏览器端渲染。
//
// 配置优先级：storage 域（~/.dsh/storages/dsh_session_manager.json，设置页写入，
// 立即生效）> 包内 config.json（出厂基线，仅首次/未保存在 UI 时使用）。
//
// 隔离边界：只删除主机会话持久化层拥有的工件（通过 sessionPersistence.locate
// 取得路径），绝不触碰工作区文件、附件等其他目录；删除前校验会话不在
// SessionStore 里（无 live 写入者）且没有运行中的 Agent。
//
// 说明：DSH 当前版本没有官方“删除会话”API（session-controller 只暴露
// list/search/create/…/cancel），因此删除直接作用于
// @deepseek-ai/dsh-session-persistence-jsonl 的日志工件；session-query SQLite
// 索引在下次 reconcile（任何一次搜索/观察时）会自动清除被删会话的行。

import { readFileSync } from 'node:fs'
import { rm, rmdir, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-session-manager'
export const inject = ['webServer', 'sessions', 'sessionPersistence', 'agents', 'storageDomain']

const ROUTE_PATH = '/api/dsh-session-manager'
const PRUNE_PROGRESS_PATH = '/api/dsh-session-manager/prune'
const SUMMARY_PATH = '/api/dsh-session-manager/summary'
const DAY_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024
const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_MAX_TOTAL_SIZE_MB = 1024
/** storage 域名（UNIT_NAME_RE: /^[a-z][a-z0-9_]*$/，不能用连字符）。 */
const CONFIG_DOMAIN = 'dsh_session_manager'

/* ------------------------------------------------------------------ */
/* 配置                                                                 */
/*   maxAgeDays:     批量删除阈值「最近更新早于该天数」                     */
/*   maxSessions:    总会话数量告警上限（0 = 不检查）                      */
/*   maxTotalSizeMB: 总会话日志大小告警上限（0 = 不检查）                  */
/* ------------------------------------------------------------------ */

/** dsh alpha.4 兼容的事件读取：Session#snapshotEvents()（冻结缓存数组）优先，
 * alpha.3 回退 .events。两版都无法读取时返回空数组（调用方语义与旧版
 * session.events ?? [] 一致）。 */
function eventsOf(session) {
  if (session == null) return []
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : (session.events ?? [])
}

function sanitizeConfig(value) {
  const src = value !== null && typeof value === 'object' ? value : {}
  return {
    maxAgeDays: Number.isFinite(src.maxAgeDays) && src.maxAgeDays >= 1 && src.maxAgeDays <= 36500
      ? src.maxAgeDays
      : DEFAULT_MAX_AGE_DAYS,
    maxSessions: Number.isFinite(src.maxSessions) && src.maxSessions >= 0 && src.maxSessions <= 100000
      ? src.maxSessions
      : DEFAULT_MAX_SESSIONS,
    maxTotalSizeMB: Number.isFinite(src.maxTotalSizeMB) && src.maxTotalSizeMB >= 0 && src.maxTotalSizeMB <= 1000000
      ? src.maxTotalSizeMB
      : DEFAULT_MAX_TOTAL_SIZE_MB,
  }
}

function baselineConfig() {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
  try {
    return sanitizeConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return sanitizeConfig(null)
  }
}

/** 鸭子类型 schema：数据全部由本插件写入，透传即可；null 是「从未写入」哨兵。 */
const passthroughSchema = {
  parse(value) {
    if (value === null) throw new Error('null not allowed')
    return value
  },
  safeParse(value) {
    return value === null ? { success: false } : { success: true, data: value }
  },
}

const configDomainSpec = {
  name: CONFIG_DOMAIN,
  version: 1,
  global: { schema: passthroughSchema, initial: baselineConfig() },
  tables: {},
}

/** 单字段校验：非法输入抛错（由调用方映射为 bad-config）。 */
function normalizeConfigField(value, min, max) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('bad-config')
  }
  return value
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function displayTitleOf(title, cwd, id) {
  if (typeof title === 'string' && title.trim() !== '') return title
  if (typeof cwd === 'string' && cwd !== '') {
    const base = basename(cwd.replace(/[\\/]+$/, ''))
    if (base !== '') return base
  }
  return id
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const webServer = ctx.webServer
  const sessions = ctx.sessions
  const sessionPersistence = ctx.sessionPersistence
  const agents = ctx.agents
  const storageDomain = ctx.storageDomain

  // 配置域：打开失败时回落 config.json 基线（设置页只读基线，set-config 报错）
  const domainPromise = storageDomain.open(configDomainSpec).catch((error) => {
    ctx.logger.warn(`[dsh-session-manager] failed to open config domain: ${String(error)}`)
    return null
  })
  ctx.effect(() => () => {
    void domainPromise.then((domain) => {
      if (domain !== null) return domain.close()
    })
  })

  async function requireDomain() {
    const domain = await domainPromise
    if (domain === null) throw new Error('storage-unavailable')
    return domain
  }

  async function currentConfig() {
    try {
      const domain = await requireDomain()
      return sanitizeConfig(domain.global.get())
    } catch {
      return baselineConfig()
    }
  }

  async function saveConfig(patch) {
    const domain = await requireDomain()
    const current = sanitizeConfig(domain.global.get())
    const next = sanitizeConfig({
      maxAgeDays: normalizeConfigField(patch.maxAgeDays, 1, 36500) ?? current.maxAgeDays,
      maxSessions: normalizeConfigField(patch.maxSessions, 0, 100000) ?? current.maxSessions,
      maxTotalSizeMB: normalizeConfigField(patch.maxTotalSizeMB, 0, 1000000) ?? current.maxTotalSizeMB,
    })
    await domain.global.set(next)
    return sanitizeConfig(domain.global.get())
  }

  async function resetConfig() {
    const domain = await requireDomain()
    await domain.global.set(baselineConfig())
    return sanitizeConfig(domain.global.get())
  }

  // 所有删除串行执行：避免批量删除与手动删除交叉读-删同名工件
  let chain = Promise.resolve()
  function enqueue(job) {
    const result = chain.then(job)
    chain = result.then(() => {}, () => {})
    return result
  }

  // 批量删除进度状态（GET /api/dsh-session-manager/prune 轮询读取）
  const pruneState = {
    running: false,
    total: 0,
    done: 0,
    deleted: 0,
    failed: 0,
    currentId: null,
    startedAt: 0,
    finishedAt: 0,
  }
  let prunePending = false

  /** 持久化头里的 `title` 投影值（缓存有则读，无则 undefined）。 */
  function titleOf(live, header) {
    try {
      if (live !== undefined) {
        const block = ctx.get('sessionProjections')?.cachedSnapshot(live)
        return typeof block?.values?.title === 'string' ? block.values.title : undefined
      }
      // dsh alpha.4：cachedSnapshot 需要第二个参数（继承前缀长度），且检查点
      // 按真实继承数写入——seeded 会话永远命中不了，保守跳过（与官方
      // session-controller 的 cold 读取一致）。alpha.3 头没有 isSeeded 字段，
      // 走旧签名。
      if (Object.hasOwn(header, 'isSeeded')) {
        if (header.isSeeded === true) return undefined
        const block = ctx.get('sessionProjectionCache')?.cachedSnapshot(header, 0)
        return typeof block?.values?.title === 'string' ? block.values.title : undefined
      }
      const block = ctx.get('sessionProjectionCache')?.cachedSnapshot(header)
      return typeof block?.values?.title === 'string' ? block.values.title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 完整会话快照：持久化头（sessionPersistence.list）+ live 补充（尚未落盘的
   * 空会话也要可见）。冷会话的 updatedAt = 日志工件 mtime（最后写入时间），
   * live 会话 = 最后一条事件时间。
   */
  async function snapshotSessions() {
    const persistedHeaders = await sessionPersistence.list()
    const liveSessions = sessions.list()
    const liveById = new Map(liveSessions.map((s) => [s.id, s]))

    const rows = []
    const seen = new Set()
    for (const header of persistedHeaders) {
      seen.add(header.id)
      const live = liveById.get(header.id)
      const location = sessionPersistence.locate(header)
      let updatedAt = header.createdAt
      let sizeBytes = 0
      let artifactOk = location !== undefined
      if (live !== undefined) {
        const liveEvents = eventsOf(live)
        const last = liveEvents[liveEvents.length - 1]
        updatedAt = typeof last?.time === 'number' ? last.time : live.header.createdAt
        sizeBytes = 0
      } else if (location !== undefined) {
        try {
          const stats = await stat(location.path)
          updatedAt = stats.mtimeMs
          sizeBytes = stats.size
        } catch {
          artifactOk = false
        }
      }
      const title = titleOf(live, header)
      rows.push({
        id: header.id,
        title,
        displayTitle: displayTitleOf(title, header.cwd, header.id),
        createdAt: header.createdAt,
        updatedAt,
        sizeBytes,
        cwd: header.cwd,
        parentId: header.parentSession,
        origin: header.origin,
        live: live !== undefined,
        running: live !== undefined && agents.get(header.id)?.status === 'running',
        artifact: artifactOk,
      })
    }

    // live 但未落盘（刚创建还没有事件）：同样展示
    for (const session of liveSessions) {
      if (seen.has(session.id)) continue
      const sessionEvents = eventsOf(session)
      const last = sessionEvents[sessionEvents.length - 1]
      const title = titleOf(session, session.header)
      rows.push({
        id: session.id,
        title,
        displayTitle: displayTitleOf(title, session.header.cwd, session.id),
        createdAt: session.header.createdAt,
        updatedAt: typeof last?.time === 'number' ? last.time : session.header.createdAt,
        sizeBytes: 0,
        cwd: session.header.cwd,
        parentId: session.header.parentSession,
        origin: session.header.origin,
        live: true,
        running: agents.get(session.id)?.status === 'running',
        artifact: true,
      })
    }

    rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return rows
  }

  /** 阈值统计（总数/总大小/逾期货）：全量接口与 summary 接口共用。 */
  function statsOf(sessionsList, config) {
    const cutoff = Date.now() - config.maxAgeDays * DAY_MS
    const totalSizeBytes = sessionsList.reduce((sum, row) => sum + (row.sizeBytes || 0), 0)
    const eligibleExpired = sessionsList.filter((row) =>
      row.origin !== 'subagent'
      && !row.live
      && !row.running
      && row.artifact
      && row.updatedAt < cutoff,
    ).length
    return {
      count: sessionsList.length,
      totalSizeBytes,
      eligibleExpired,
      cutoffAt: cutoff,
    }
  }

  /**
   * 删除一个会话的持久化工件。仅限「冷」会话：
   *   - live（SessionStore 中仍在挂载，例如当前打开/最近打开过）→ session-live
   *   - 运行中的 Agent → session-running
   * 删除 = unlink JSONL 工件 + 尝试移除（已空的）会话目录；任何非预期失败
   * 逐项报告，不中断。
   */
  async function removeSession(id) {
    const live = sessions.get(id)
    if (live !== undefined) {
      const agent = agents.get(id)
      if (agent?.status === 'running') return { error: 'session-running', id }
      return { error: 'session-live', id }
    }
    const headers = await sessionPersistence.list()
    const header = headers.find((h) => h.id === id)
    if (header === undefined) return { error: 'not-found', id }
    const location = sessionPersistence.locate(header)
    if (location === undefined) return { error: 'no-location', id }
    const dir = dirname(location.path)
    try {
      await rm(location.path, { force: true })
    } catch (error) {
      return { error: 'delete-failed', id, message: String(error) }
    }
    // 会话目录可能还有其它工件；只移除空目录，绝不递归删除
    try {
      await rmdir(dir)
    } catch {
      /* 目录非空/被占用：保留，无害 */
    }
    try {
      ctx.emit('api-session/removed', id)
    } catch {
      /* 通知失败不影响删除结果；Web 端下次 list 也会移除该行 */
    }
    return { ok: true, id, dir }
  }

  /**
   * 手动批量删除：删除「最近更新」早于 maxAgeDays 天的会话。
   * 跳过：live（打开中）、running（运行中）、子代理会话（origin: subagent）、
   * 工件缺失的会话。删除进度写入 pruneState（每删一个更新），供进度接口轮询。
   * 已在进行中的批量删除拒绝重复启动（error: prune-running）。
   */
  async function pruneExpired() {
    if (pruneState.running) {
      const error = new Error('prune-running')
      error.code = 'prune-running'
      throw error
    }
    // 先同步置位，避免排队任务在第一个 await 前重入
    Object.assign(pruneState, {
      running: true,
      total: 0,
      done: 0,
      deleted: 0,
      failed: 0,
      currentId: null,
      startedAt: Date.now(),
      finishedAt: 0,
    })
    let result
    const failures = []
    try {
      const config = await currentConfig()
      const cutoff = Date.now() - config.maxAgeDays * DAY_MS
      const rows = await snapshotSessions()
      const candidates = rows.filter((row) =>
        row.origin !== 'subagent'
        && row.updatedAt < cutoff,
      )
      const deletable = candidates.filter((row) => !row.live && !row.running && row.artifact)
      const skipped = {
        live: candidates.filter((row) => row.live && !row.running).length,
        running: candidates.filter((row) => row.running).length,
        subagent: rows.filter((row) => row.origin === 'subagent' && row.updatedAt < cutoff).length,
        missing: candidates.filter((row) => !row.live && !row.running && !row.artifact).length,
      }
      pruneState.total = deletable.length
      for (const row of deletable) {
        pruneState.currentId = row.id
        const removal = await removeSession(row.id)
        pruneState.done += 1
        if (removal.ok === true) pruneState.deleted += 1
        else {
          pruneState.failed += 1
          failures.push({ id: row.id, error: removal.error })
        }
        pruneState.currentId = null
      }
      result = {
        deleted: pruneState.deleted,
        failed: failures.length,
        scanned: rows.length,
        eligible: candidates.length,
        skipped,
        failures,
        cutoffAt: cutoff,
        maxAgeDays: config.maxAgeDays,
      }
    } finally {
      pruneState.running = false
      pruneState.currentId = null
      pruneState.finishedAt = Date.now()
    }
    return result
  }

  // 串行化所有写操作（手动删除 / 批量删除各自独立串行，跨请求也串行）
  const deleteSession = (id) => enqueue(() => removeSession(id))
  const runPrune = () => {
    if (prunePending || pruneState.running) {
      return Promise.reject(Object.assign(new Error('prune-running'), { code: 'prune-running' }))
    }
    prunePending = true
    return enqueue(async () => {
      prunePending = false
      return pruneExpired()
    })
  }

  /* ---------- HTTP ---------- */
  // 轻量摘要接口：config + stats（无会话行），供启动弹窗与缓存后台核实使用。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: SUMMARY_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'METHOD' })
            return
          }
          try {
            const config = await currentConfig()
            const sessionsList = await snapshotSessions()
            sendJson(res, 200, { ok: true, config, stats: statsOf(sessionsList, config) })
          } catch (error) {
            ctx.logger.warn(`[dsh-session-manager] summary failed: ${String(error)}`)
            sendJson(res, 503, { ok: false, error: 'summary-failed' })
          }
        },
      }),
    'dsh-session-manager: summary route',
  )

  // 进度接口：批量删除进行中时的轻量轮询（不列举会话）
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: PRUNE_PROGRESS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'METHOD' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            prune: {
              running: pruneState.running,
              total: pruneState.total,
              done: pruneState.done,
              deleted: pruneState.deleted,
              failed: pruneState.failed,
              currentId: pruneState.currentId,
              startedAt: pruneState.startedAt,
              finishedAt: pruneState.finishedAt,
            },
          })
        },
      }),
    'dsh-session-manager: prune progress route',
  )

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            try {
              const config = await currentConfig()
              const sessionsList = await snapshotSessions()
              sendJson(res, 200, {
                ok: true,
                config,
                stats: statsOf(sessionsList, config),
                sessions: sessionsList,
              })
            } catch (error) {
              ctx.logger.warn(`[dsh-session-manager] list failed: ${String(error)}`)
              sendJson(res, 503, { ok: false, error: 'list-failed' })
            }
            return
          }

          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'METHOD' })
            return
          }

          let body
          try {
            body = await readJson(req)
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          const action = typeof body?.action === 'string' ? body.action : ''

          try {
            if (action === 'delete') {
              if (typeof body.id !== 'string' || body.id === '') {
                sendJson(res, 400, { ok: false, error: 'bad-args' })
                return
              }
              const result = await deleteSession(body.id)
              if (result.error !== undefined) {
                sendJson(res, result.error === 'not-found' ? 404 : 409, { ok: false, ...result })
                return
              }
              sendJson(res, 200, { ok: true, id: result.id })
              return
            }

            if (action === 'delete-expired') {
              try {
                const result = await runPrune()
                sendJson(res, 200, { ok: true, result })
              } catch (error) {
                sendJson(res, error?.code === 'prune-running' ? 409 : 503, {
                  ok: false,
                  error: error?.code === 'prune-running' ? 'prune-running' : 'action-failed',
                })
              }
              return
            }

            if (action === 'set-config') {
              try {
                const config = await saveConfig(body)
                sendJson(res, 200, { ok: true, config })
              } catch (error) {
                sendJson(res, error instanceof Error && error.message === 'bad-config' ? 400 : 503, {
                  ok: false,
                  error: error instanceof Error && error.message === 'bad-config' ? 'bad-config' : 'storage-unavailable',
                })
              }
              return
            }

            if (action === 'reset-config') {
              try {
                const config = await resetConfig()
                sendJson(res, 200, { ok: true, config })
              } catch {
                sendJson(res, 503, { ok: false, error: 'storage-unavailable' })
              }
              return
            }

            sendJson(res, 400, { ok: false, error: 'bad-args' })
          } catch (error) {
            ctx.logger.warn(`[dsh-session-manager] action '${action}' failed: ${String(error)}`)
            sendJson(res, 503, { ok: false, error: 'action-failed' })
          }
        },
      }),
    'dsh-session-manager: route',
  )
}
