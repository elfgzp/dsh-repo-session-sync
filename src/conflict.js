/**
 * 冲突判定 —— 「绝不静默覆盖」的实现。
 *
 * ## 核心不变量
 *
 * 本模块**永远不会**把一个「两端都推进过」的会话判定为单边胜出。
 * 唯一允许的结果是 `keep-both`（双份保留）或 `refuse`（拒绝并报告）。
 *
 * 这不是保守，而是语义上的必然：两条分叉代表两段**真实发生过**的对话历史。
 * 没有算法能判断哪条「正确」，因为两条都真实。合并出一条 DSH 从未产生过的
 * 事件序列，等于伪造历史。所以只有用户能决定，我们只负责不丢数据、并把
 * 选择权交出去。
 *
 * ## 判定键：逻辑指纹，不是字节指纹
 *
 * **为什么不能用 `contentHash`（字节 sha256）判重？**
 *
 * 下行到另一台机器时必须重写 header 的 `cwd`（B 机的仓库路径和 A 机不同，
 * 且 DSH 的 `attachSession` 会硬校验 cwd 必须等于本机 workspace 的真实路径）。
 * 一旦重写 cwd，字节就变了，字节指纹也变了。
 *
 * 于是 A→B→A 这样一次完整往返后，A 机看到回来的会话「字节指纹不一致」，
 * 会误判为分叉。**这不是假想的场景，是每次跨机同步都会发生的。**
 *
 * 所以判重键用**逻辑指纹**：header 去掉机器相关字段（cwd）+ 全部事件的
 * (type, seq, data) 规范化序列。它表达的是「这段对话是不是同一段对话」，
 * 与它落盘在哪台机器、路径怎么写无关。
 *
 * 实测验证（同一会话，两个不同 cwd）：
 * ```
 * 字节相同?      false   （cwd 不同 → 字节必然不同）
 * 字节指纹相同?  false
 * 逻辑指纹相同?  true    ← 正确判重
 * ```
 *
 * ## 三种输入形态
 *
 *   1. **本机独有**：远端没有这个会话 → 无冲突，上行即可
 *   2. **远端独有**：本机没有 → 无冲突，下行即可
 *   3. **两端都有**：比较逻辑指纹，分「相同 / 一方是另一方前缀 / 真分叉」
 *
 * 第 3 种里的「前缀」情形是关键：远端 N 条、本机 N+M 条且前 N 条完全一致，
 * 说明本机只是多接了 M 条 —— 这是**正常的增量**，不是冲突。反向亦然。
 *
 * @module dsh-repo-session-sync/conflict
 */

import { createHash } from 'node:crypto'

import { ERROR_CODES, SyncError } from './errors.js'

// ─────────────────────────────────────────────────────────────
// 逻辑指纹
// ─────────────────────────────────────────────────────────────

/**
 * header 里**与机器相关、跨机必然不同**的字段。
 *
 * `cwd` 是唯一一个我们必须知道的可变字段（下行时要重写）。
 * 其余字段目前都稳定，但集中列在这里，将来发现新的可变量只改一处。
 */
const MACHINE_DEPENDENT_HEADER_FIELDS = Object.freeze(['cwd'])

/**
 * 计算一个会话的**逻辑指纹**：同一段对话在任何机器上都得到同一个值。
 *
 * 输入可以是已经解析好的 `{header, events}`，也可以是原始事件数组
 * （第一个元素被当作 header，如果它有 `type === 'session'`）。
 *
 * @param {{header?: object, events?: object[]}|object[]} session 会话数据
 * @returns {string} 逻辑指纹（sha256 十六进制）
 * @throws {SyncError} 输入结构不可识别
 */
export function logicalFingerprint(session) {
  let header
  let events

  if (Array.isArray(session)) {
    if (session.length === 0) {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, '计算逻辑指纹需要至少一个事件或 header。')
    }
    if (session[0]?.type === 'session') {
      header = session[0]
      events = session.slice(1)
    } else {
      header = null
      events = session
    }
  } else if (session !== null && typeof session === 'object') {
    header = session.header ?? null
    events = session.events
  } else {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, '逻辑指纹的输入必须是会话对象或事件数组。')
  }

  if (!Array.isArray(events)) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, '会话缺少 events 数组，无法计算逻辑指纹。')
  }

  const stableHeader =
    header === null || header === undefined
      ? null
      : stripMachineDependentFields(header)

  // 规范化事件：只保留对话语义相关的部分。
  // `time` 保留（它参与排序语义），但它是同一个会话自身的时间，跨机不变。
  const normalizedEvents = events.map((event) => ({
    type: event?.type ?? null,
    seq: event?.seq ?? null,
    data: event?.data ?? null,
    // surfaceOp / sourceEventSeqs 影响事件的呈现，属于内容的一部分，保留
    ...(event?.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event?.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: event.sourceEventSeqs }),
  }))

  const canonical = canonicalJson({ header: stableHeader, events: normalizedEvents })
  return createHash('sha256').update(canonical).digest('hex')
}

/** 去掉 header 里的机器相关字段。 */
function stripMachineDependentFields(header) {
  /** @type {Record<string, unknown>} */
  const copy = {}
  for (const [key, value] of Object.entries(header)) {
    if (MACHINE_DEPENDENT_HEADER_FIELDS.includes(key)) continue
    copy[key] = value
  }
  return copy
}

/**
 * 稳定序列化：对象键按字典序排列，保证同一内容永远得到同一字符串。
 *
 * `JSON.stringify` 的键序依赖对象插入顺序，两个逻辑相同但构造顺序不同的
 * 对象会得到不同字符串 —— 那会让指纹失效，所以必须自己规范化。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value))
}

/** 递归排序对象键；数组保持原序（顺序有语义）。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortDeep(/** @type {Record<string, unknown>} */ (value)[key])
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 比较
// ─────────────────────────────────────────────────────────────

/**
 * 两个会话之间的包含关系。
 *
 * @param {{events: object[], fingerprint?: string}} a
 * @param {{events: object[], fingerprint?: string}} b
 * @returns {'identical'|'a-extends-b'|'b-extends-a'|'diverged'}
 *   - `identical`    逻辑内容完全相同
 *   - `a-extends-b`  a 是在 b 的基础上追加（b 是 a 的真前缀）
 *   - `b-extends-a`  b 是在 a 的基础上追加
 *   - `diverged`     真分叉
 */
export function compareSessions(a, b) {
  const aEvents = Array.isArray(a?.events) ? a.events : []
  const bEvents = Array.isArray(b?.events) ? b.events : []

  const fpA = a?.fingerprint ?? safeFingerprint(a)
  const fpB = b?.fingerprint ?? safeFingerprint(b)
  if (fpA !== null && fpA === fpB) return 'identical'

  const common = Math.min(aEvents.length, bEvents.length)
  for (let i = 0; i < common; i++) {
    if (!eventsEqual(aEvents[i], bEvents[i])) return 'diverged'
  }

  if (aEvents.length === bEvents.length) return 'identical'
  return aEvents.length > bEvents.length ? 'a-extends-b' : 'b-extends-a'
}

/** 两个事件在逻辑上是否相同（忽略与落盘机器相关的差异）。 */
function eventsEqual(x, y) {
  return canonicalJson({
    type: x?.type ?? null,
    seq: x?.seq ?? null,
    data: x?.data ?? null,
    surfaceOp: x?.surfaceOp ?? null,
    sourceEventSeqs: x?.sourceEventSeqs ?? null,
  }) ===
    canonicalJson({
      type: y?.type ?? null,
      seq: y?.seq ?? null,
      data: y?.data ?? null,
      surfaceOp: y?.surfaceOp ?? null,
      sourceEventSeqs: y?.sourceEventSeqs ?? null,
    })
}

/** 算指纹但把异常吞成 null —— 比较函数不该因为输入不完整就炸。 */
function safeFingerprint(session) {
  try {
    return logicalFingerprint(session)
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────

/**
 * 冲突判定的结果类别。
 *
 * @typedef {object} ConflictDecision
 * @property {'local-wins'|'remote-wins'|'keep-both'|'refuse'|'no-conflict'} kind
 * @property {string} reason 稳定短码（测试与日志断言用）
 * @property {string} [detail] 给人看的解释
 */

/**
 * 判定一个会话对（本机 vs 远端）该怎么处理。
 *
 * **本函数保证：只要两端都推进过且内容不可包含，返回值就绝不可能是
 * `local-wins` 或 `remote-wins`。** 它只会在 `keep-both` / `refuse` 之间选。
 *
 * @param {{local?: object|null, remote?: object|null, binding?: object}} input
 *   两边的会话快照，各含 `events`（以及可选的 `fingerprint`/`sessionId`）。
 *   `local` 为 null 表示本机没有；`remote` 为 null 表示远端没有。
 * @returns {ConflictDecision}
 */
export function decideConflict(input) {
  const { local = null, remote = null } = input ?? {}

  // ── 只有一边有：无冲突 ──
  if (local === null && remote === null) {
    return {
      kind: 'no-conflict',
      reason: 'both-absent',
      detail: '两边都没有这个会话，无需处理。',
    }
  }
  if (local === null) {
    return {
      kind: 'no-conflict',
      reason: 'local-absent',
      detail: '本机没有这个会话，可以直接下行。',
    }
  }
  if (remote === null) {
    return {
      kind: 'no-conflict',
      reason: 'remote-absent',
      detail: '远端没有这个会话，可以直接上行。',
    }
  }

  // ── 两边都有：比较内容 ──
  let relation
  try {
    relation = compareSessions(local, remote)
  } catch (cause) {
    // 比不出来就当作分叉处理 —— 保守方向是「不动数据」
    return {
      kind: 'refuse',
      reason: 'incomparable',
      detail: `无法比较两边内容（${cause?.message ?? cause}），为安全起见不做任何写入。`,
    }
  }

  if (relation === 'identical') {
    return {
      kind: 'no-conflict',
      reason: 'identical',
      detail: '两边内容一致，无需同步。',
    }
  }

  if (relation === 'a-extends-b') {
    // 本机更全：远端是旧版本，正常上行即可
    return {
      kind: 'no-conflict',
      reason: 'remote-behind',
      detail: '本机比远端多出后续事件，属于正常增量，可以直接上行。',
    }
  }

  if (relation === 'b-extends-a') {
    // 远端更全：本机是旧版本，正常下行即可
    return {
      kind: 'no-conflict',
      reason: 'local-behind',
      detail: '远端比本机多出后续事件，属于正常增量，可以直接下行。',
    }
  }

  // ── 真分叉：绝不单边胜出 ──
  const localCount = Array.isArray(local?.events) ? local.events.length : 0
  const remoteCount = Array.isArray(remote?.events) ? remote.events.length : 0

  return {
    kind: 'keep-both',
    reason: 'diverged',
    detail:
      `两端都改动了这个会话且内容不同（本机 ${localCount} 条事件，远端 ${remoteCount} 条）。` +
      '两条都是真实发生过的对话历史，无法自动判断该保留哪一条，因此两份都会保留，' +
      '远端那份会另存为独立会话。请自行决定使用哪一份。',
  }
}

/**
 * 创建冲突判定器（`deps.js` 期望的 `ConflictResolver` 形状）。
 *
 * @param {{ store?: object, paths?: object, log?: {info:Function, warn:Function, error:Function} }} [context]
 * @returns {{decide: typeof decideConflict, logicalFingerprint: typeof logicalFingerprint, compareSessions: typeof compareSessions}}
 */
export function createConflictResolver(context = {}) {
  const log = context.log ?? { info() {}, warn() {}, error() {} }

  return {
    /**
     * 判定一个会话对。签名对齐 `engine.js` 的 `ConflictResolver`。
     *
     * @param {{local: object|null, remote: object|null, binding: object}} input
     * @returns {ConflictDecision}
     */
    decide(input) {
      const decision = decideConflict(input)
      if (decision.kind === 'keep-both' || decision.kind === 'refuse') {
        log.warn('conflict.decision', {
          sessionId: input?.local?.sessionId ?? input?.remote?.sessionId ?? null,
          kind: decision.kind,
          reason: decision.reason,
        })
      }
      return decision
    },
    logicalFingerprint,
    compareSessions,
  }
}

/**
 * 为一个分叉生成「另存为」的新 session id。
 *
 * 规则：保留原 id 的可读部分 + 冲突标记 + 稳定后缀。后缀由**两端内容**
 * 共同决定，所以同一次冲突重复处理会得到同一个 id（幂等），不会越存越多。
 *
 * 必须是合法单段名：只含 `[A-Za-z0-9._-]`。
 *
 * @param {string} sessionId 原会话 id
 * @param {{localFingerprint?: string, remoteFingerprint?: string, timestamp?: number}} parts
 * @returns {string}
 */
export function conflictSessionId(sessionId, parts = {}) {
  const base = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)
  const seed = `${parts.localFingerprint ?? ''}|${parts.remoteFingerprint ?? ''}`
  const suffix = createHash('sha256').update(seed).digest('hex').slice(0, 12)
  return `${base}.conflict-${suffix}`
}

export default createConflictResolver
