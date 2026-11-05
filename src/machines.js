/**
 * dsh-repo-session-sync — 机器配置（machine configuration）。
 *
 * ## 这个模块为什么存在
 *
 * 用户的原话里有一句「参考 remote 方式配置好机器」。它的实质诉求不是
 * 「照抄 dsh-remote 的代码」，而是：**换一台机器时，我不用重新填写一遍
 * 主机地址、用户名、端口、私钥——因为我已经有 `~/.ssh/config` 了。**
 *
 * 我们调研了 `dsh-remote`（它把 `~/.ssh/config` 作为连接四字段的唯一来源，
 * 并在文件里写带 `# dsh-remote: managed` 标记的受管块）。结论：
 *
 *   - **`~/.ssh/config` 是用户已经维护好的机器清单，我们只读它，不抢所有权。**
 *     默认路径下我们**一行都不写**。用户已有的 Host 别名直接拿来用。
 *   - **只有在用户显式要求「新建一台 ssh 配置里还没有的机器」时才写入**，
 *     并且写入严格遵循"受管块"约定：只动自己标记的块，绝不碰用户手写的块，
 *     无标记的同名块一律报冲突、原文一字不改。
 *   - **注册表只存 `{ id, alias, label }`，不复制 host/user/port/私钥。**
 *     连接四字段的唯一真相永远是 `~/.ssh/config`，我们不做第二份副本，
 *     也就不会出现"两边不一致"的经典 bug，同时也不给凭据任何落盘机会。
 *
 * ## 为什么不自己解析 ssh config
 *
 * dsh-remote 自己写了 779 行解析器（`Include`、`Match`、通配符、`ProxyJump`、
 * 行续接、`%n` 展开……），因为它需要**枚举**主机给 UI 列表用。
 *
 * 我们只枚举 Host **名**（这只需要很小的一段解析），而真正"一个别名最终连到
 * 哪里"交给 OpenSSH 自己算：`ssh -G <alias>` 会打印出生效后的全部配置，
 * 不建立任何连接，`Include`/`Match`/通配符全都天然正确。
 * **不要重新实现 OpenSSH 的语义——那是无穷无尽的兼容性泥潭。**
 *
 * ## 安全边界
 *
 *   - 不打开、不读取、不复制任何私钥文件内容（`identityFile` 只作为**路径**出现）。
 *   - 不回传任何凭据；`ssh -G` 的输出在返回给界面前会被白名单裁剪。
 *   - 写入前一律做别名合法性校验，拒绝可能造成配置注入的字符。
 *   - 所有函数把文件系统操作作为可注入参数，便于在临时目录里做单元测试，
 *     测试永远不会碰到用户真实的 `~/.ssh/config`。
 *
 * @module dsh-repo-session-sync/machines
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

// ─────────────────────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用户 ssh 配置文件的位置。
 *
 * 支持 `DSH_SSH_CONFIG` 覆盖：一是为了测试能指向临时文件，二是让把家目录
 * 隔离起来的部署（容器、CI）也能用。**不要**在别处硬编码这个路径。
 *
 * @returns {string} 绝对路径。
 */
export function sshConfigPath() {
  const override = process.env.DSH_SSH_CONFIG
  if (override && String(override).trim()) return path.resolve(String(override).trim())
  return path.join(homedir(), '.ssh', 'config')
}

/** `Include` 相对路径的基准目录（ssh_config(5) 规定是 `~/.ssh`）。 */
export function sshConfigDir() {
  const override = process.env.DSH_SSH_CONFIG
  if (override && String(override).trim()) return path.dirname(path.resolve(String(override).trim()))
  return path.join(homedir(), '.ssh')
}

// ─────────────────────────────────────────────────────────────────────────────
// 受管块标记
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 标记注释：紧挨着 `Host` 行上方，表示这个块由本插件拥有。
 *
 * **故意与 dsh-remote 的 `# dsh-remote: managed` 不同。** 两个插件各用自己的
 * 标记，才能互相把对方的块识别成"不是我的"，从而都不去动它。若共用同一个
 * 标记，双方都会认为对方的块属于自己并试图改写——那是灾难。
 */
export const MANAGED_MARK = '# dsh-repo-session-sync: managed'

/** 受管块里由本插件重写的参数（小写）。块内其余行一律保留。 */
const MANAGED_PARAMS = new Set(['hostname', 'user', 'port', 'identityfile'])

/** 解析器关心的参数（小写）。 */
const KNOWN_PARAMS = new Set([
  'hostname', 'user', 'port', 'identityfile',
  'proxyjump', 'proxycommand', 'identitiesonly', 'identityagent',
])

// ─────────────────────────────────────────────────────────────────────────────
// 低级文本工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把反斜杠续行合并成一行。
 *
 * ssh_config(5) 允许一行用 `\` 续到下一行。不合并的话，续行里的参数会
 * 被当成独立的垃圾行丢掉。
 *
 * @param {string} text - 原始配置文本。
 * @returns {string[]} 合并后的行数组。
 */
export function joinContinuations(text) {
  const lines = []
  let pending = ''
  for (const raw of String(text ?? '').split('\n')) {
    const line = pending + raw
    // 行尾单个反斜杠 = 续行；两个反斜杠是转义的字面反斜杠，不算续行。
    if (/\\\s*$/.test(line) && !/\\\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, ' ') + ' '
      continue
    }
    pending = ''
    lines.push(line)
  }
  if (pending) lines.push(pending)
  return lines
}

/** 去掉一层成对引号。 */
function stripQuotes(s) {
  return String(s ?? '').replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')
}

/**
 * 按空白切分参数值，保留引号内的空格。
 *
 * @param {string} value - 例如 `alpha "beta gamma"`。
 * @returns {string[]} `['alpha', 'beta gamma']`。
 */
export function splitValue(value) {
  return (String(value ?? '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(stripQuotes)
    .filter((token) => token !== '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析配置文本里的 Host 块。
 *
 * 只保留我们能理解的参数；重复参数按 OpenSSH 的"第一个生效"处理。
 *
 * @param {string} text - 配置文本。
 * @returns {Array<{patterns: string[], values: Record<string, string|number>, line: number}>}
 */
export function parseHostBlocks(text) {
  const blocks = []
  let current = null
  const lines = joinContinuations(text)
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] ?? '').trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      current = { patterns: splitValue(value), values: {}, line: i + 1 }
      blocks.push(current)
      continue
    }
    if (!current || !KNOWN_PARAMS.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(current.values, key)) continue
    current.values[key] = key === 'port' ? (Number(value) || value) : stripQuotes(value)
  }
  return blocks
}

/** 通配符模式转正则（`*` 与 `?`，大小写不敏感，与 OpenSSH 一致）。 */
function globRegex(pattern) {
  let re = ''
  for (const ch of String(pattern ?? '')) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/** 单个模式是否匹配名字。 */
export function globMatch(pattern, value) {
  return globRegex(pattern).test(String(value ?? ''))
}

/**
 * 一个 Host 模式列表是否适用于某个名字。
 *
 * 规则与 ssh_config(5) 一致：**任一**正向模式命中，且**没有**被 `!` 否定模式排除。
 *
 * @param {string[]|string} patterns - 模式列表或模式串。
 * @param {string} name - 待匹配的主机名/别名。
 * @returns {boolean}
 */
export function hostBlockMatches(patterns, name) {
  const list = Array.isArray(patterns) ? patterns : splitValue(patterns)
  const negative = list.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  const positive = list.filter((p) => !p.startsWith('!'))
  if (negative.some((p) => globMatch(p, name))) return false
  return positive.some((p) => globMatch(p, name))
}

/**
 * 判断一个别名是否是"具体的"主机名——可以安全地拿去展示与连接。
 *
 * 通配符模式（`Host *`、`Host *.example.com`）、否定模式（`!x`）、
 * 以及带多个名字的块（`Host a b`）都不是"一台机器"，从候选列表里排除。
 *
 * @param {string} alias
 * @returns {boolean}
 */
export function isConcreteAlias(alias) {
  const s = String(alias ?? '').trim()
  if (!s) return false
  return !/[*?!,]/.test(s) && !/\s/.test(s)
}

/**
 * 列出配置里所有**具体的** Host 别名（不含 `Include` 展开）。
 *
 * 这是设置页"从 ssh 配置导入机器"下拉框的数据来源。
 * **只返回名字**——不回传 host/user/port/密钥，避免凭据与内网拓扑出现在页面上。
 *
 * @param {string} text - 配置文本。
 * @returns {string[]} 去重并排序的别名列表。
 */
export function listHostAliases(text) {
  const seen = new Set()
  const out = []
  for (const block of parseHostBlocks(text)) {
    for (const pattern of block.patterns) {
      if (!isConcreteAlias(pattern)) continue
      if (seen.has(pattern)) continue
      seen.add(pattern)
      out.push(pattern)
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ─────────────────────────────────────────────────────────────────────────────
// Include 展开
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读取配置文件，并把 `Include` 指令就地展开。
 *
 * 相对路径先按 `~/.ssh` 解析（ssh_config(5) 的规定），找不到再按包含它的
 * 文件所在目录解析——真实世界两种写法都有。读不到或被 cycle 引用时跳过，
 * 一行坏配置不该让整份文件失效。
 *
 * @param {string} [filePath] - 配置文件路径，默认 {@link sshConfigPath}。
 * @param {object} [io] - 可注入的文件系统钩子（测试用）。
 * @param {(p: string) => string} [io.readFile]
 * @param {(p: string) => boolean} [io.exists]
 * @param {(p: string) => string[]} [io.listDir]
 * @param {number} [io.maxDepth] - 最大递归深度，默认 3。
 * @returns {string} 展开后的文本；文件不存在时返回空串。
 */
export function loadExpandedConfigText(filePath = sshConfigPath(), io = {}) {
  const readFile = io.readFile || ((p) => readFileSync(p, 'utf8'))
  const listDir = io.listDir || ((p) => readdirSync(p))
  return expandFile(filePath, {
    readFile,
    listDir,
    maxDepth: io.maxDepth ?? 3,
    depth: 0,
    seen: new Set(),
  })
}

/** 递归展开单个文件的 `Include`。 */
function expandFile(file, state) {
  let text
  try {
    text = state.readFile(file)
  } catch {
    return '' // 文件不存在 / 无权限：不是错误，只是没有内容。
  }
  if (typeof text !== 'string') return ''
  if (state.depth >= state.maxDepth) return text
  const out = []
  for (const line of joinContinuations(text)) {
    const patterns = matchInclude(line)
    if (!patterns) {
      out.push(line)
      continue
    }
    for (const pattern of patterns) {
      for (const included of expandIncludePath(pattern, path.dirname(file), state.listDir)) {
        const key = path.resolve(included)
        if (state.seen.has(key)) continue
        state.seen.add(key)
        const child = expandFile(included, { ...state, depth: state.depth + 1 })
        if (child.trim()) out.push(child)
      }
    }
  }
  return out.join('\n')
}

/** 提取 `Include <pattern> [...]` 的模式列表，不是 Include 行则返回 null。 */
function matchInclude(line) {
  const m = String(line ?? '').match(/^\s*include\s+(.+?)\s*$/i)
  if (!m) return null
  return splitValue(m[1])
}

/** 把一个 include 模式展开成具体文件路径列表。 */
function expandIncludePath(pattern, callerDir, listDir) {
  const raw = String(pattern ?? '').trim()
  if (!raw) return []

  // 确定基准目录：以 ~/ 或绝对路径开头时直接解析，否则先试 ~/.ssh 再试调用方目录。
  let candidates = []
  if (/^~[/\\]/.test(raw)) {
    candidates = [path.join(homedir(), raw.slice(2))]
  } else if (path.isAbsolute(raw)) {
    candidates = [raw]
  } else {
    candidates = [path.join(sshConfigDir(), raw), path.join(callerDir, raw)]
  }

  const out = []
  const seen = new Set()
  for (const base of candidates) {
    for (const hit of globFiles(base, listDir)) {
      const key = path.resolve(hit)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
    }
    // 第一个能命中的基准目录就算数，避免同一文件被两个基准重复包含。
    if (out.length) break
  }
  return out
}

/** 对可能含 `*` 的路径做 glob（只支持单层目录内的文件名通配）。 */
function globFiles(target, listDir) {
  if (!/[*?]/.test(target)) {
    try {
      return [target] // 交给调用方的 readFile 去判断存在性
    } catch {
      return []
    }
  }
  const dir = path.dirname(target)
  const namePart = path.basename(target)
  let entries
  try {
    entries = listDir(dir)
  } catch {
    return []
  }
  const re = globRegex(namePart)
  return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e)).sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 别名解析（交给 OpenSSH）
// ─────────────────────────────────────────────────────────────────────────────

/** `ssh -G` 输出里我们允许回传给界面的字段白名单（小写）。 */
const SSH_G_WHITELIST = new Set(['hostname', 'user', 'port', 'proxyjump'])

/**
 * 解析 `ssh -G <alias>` 的输出。
 *
 * `ssh -G` 打印的是**生效后**的配置，且不建立任何连接——这是让 OpenSSH 自己
 * 算 `Include`/`Match`/通配符/默认值的方式，比自己实现一遍可靠得多。
 *
 * 输出被裁剪成白名单：**`identityfile` 不返回**。虽然它只是路径不是密钥内容，
 * 但私钥路径属于本机隐私，界面上没有它的用途。
 *
 * @param {string} stdout - `ssh -G` 的标准输出。
 * @returns {{hostName: string, user: string, port: number, proxyJump: string}}
 */
export function parseSshGOutput(stdout) {
  const out = { hostName: '', user: '', port: 0, proxyJump: '' }
  for (const raw of String(stdout ?? '').split('\n')) {
    const m = raw.trim().match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (!SSH_G_WHITELIST.has(key)) continue
    const value = String(m[2] ?? '').trim()
    if (!value) continue
    if (key === 'hostname' && !out.hostName) out.hostName = value
    else if (key === 'user' && !out.user) out.user = value
    else if (key === 'port' && !out.port) out.port = Number(value) || 0
    else if (key === 'proxyjump' && !out.proxyJump) out.proxyJump = value === 'none' ? '' : value
  }
  return out
}

/**
 * 用 OpenSSH 解析一个别名的实际连接参数。
 *
 * 失败时**不抛异常**，而是返回 `{ ok: false, error }`——机器配置是 UI 的
 * 一部分，一个坏掉的 ssh 配置不该让整个设置页白屏。
 *
 * @param {string} alias - ssh config 里的 Host 别名。
 * @param {object} [opts]
 * @param {string} [opts.sshBinary] - ssh 可执行文件，默认 `ssh`。
 * @param {number} [opts.timeoutMs] - 超时，默认 5000。
 * @param {(args: string[]) => Promise<{stdout: string, stderr: string}>} [opts.run]
 *   可注入的执行器（测试用），默认真的去 spawn `ssh -G`。
 * @returns {Promise<{ok: boolean, alias: string, hostName: string, user: string,
 *   port: number, proxyJump: string, error?: string}>}
 */
export async function resolveSshAlias(alias, opts = {}) {
  const name = String(alias ?? '').trim()
  const empty = { ok: false, alias: name, hostName: '', user: '', port: 0, proxyJump: '' }

  if (!name) {
    return { ...empty, error: '别名是空的，没法解析。请选一个 ssh 配置里的 Host 名字。' }
  }
  if (!isConcreteAlias(name)) {
    return {
      ...empty,
      error: `「${name}」是一个通配模式，不是一台具体的机器。请在 ssh 配置里给它写一个具体的 Host 名字。`,
    }
  }

  const run = opts.run || defaultRunSshG(opts)
  try {
    const { stdout } = await run(['-G', name])
    const parsed = parseSshGOutput(stdout)
    return { ok: true, alias: name, ...parsed }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim()
    return {
      ...empty,
      error: detail
        ? `用 ssh 解析「${name}」失败：${detail}`
        : `用 ssh 解析「${name}」失败。请确认这台机器已经写进 ~/.ssh/config，并且 ssh 命令可用。`,
    }
  }
}

/** 默认执行器：真的 spawn `ssh -G`。 */
function defaultRunSshG(opts) {
  const sshBinary = opts.sshBinary || 'ssh'
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 5000
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        sshBinary,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        // `ssh -G` 在标准错误里会抱怨没有终端，但那不影响 stdout，因此：
        // 只要退出码是 0 就当作成功。
        (error, stdout, stderr) => {
          if (error) {
            const e = new Error(error.message)
            e.stderr = stderr
            reject(e)
            return
          }
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        },
      )
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 连通性探测
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 探测一台机器是否可达（只做 SSH 握手，不在远端执行任何东西）。
 *
 * 用 `ssh -o BatchMode=yes -o ConnectTimeout=<n> <alias> true`：
 *   - `BatchMode=yes` 保证**不会弹密码提示、不会卡住等输入**；
 *   - 远端的 `true` 是空操作，不产生任何副作用。
 *
 * @param {string} alias
 * @param {object} [opts]
 * @param {string} [opts.sshBinary] - 默认 `ssh`。
 * @param {number} [opts.timeoutMs] - 默认 10000。
 * @param {(args: string[]) => Promise<void>} [opts.run] - 可注入（测试用）。
 * @returns {Promise<{ok: boolean, message: string}>} 可直接展示的中文结果。
 */
export async function probeSshAlias(alias, opts = {}) {
  const name = String(alias ?? '').trim()
  if (!isConcreteAlias(name)) {
    return { ok: false, message: `「${name}」不是一台具体的机器，没法探测。` }
  }

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000
  const sshBinary = opts.sshBinary || 'ssh'
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    name,
    'true',
  ]

  const run = opts.run || (() => new Promise((resolve, reject) => {
    execFile(sshBinary, args, { timeout: timeoutMs + 2000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const e = new Error(error.message)
        e.stderr = stderr
        reject(e)
        return
      }
      resolve()
    })
  }))

  try {
    await run(args)
    return { ok: true, message: `连接「${name}」成功。` }
  } catch (error) {
    const raw = String(error?.stderr || error?.message || '')
    return { ok: false, message: explainSshFailure(name, raw) }
  }
}

/**
 * 把 ssh 的英文报错翻译成可操作的中文提示。
 *
 * 这是「错误文案」要求的落点：用户不应该看到 `Permission denied (publickey).`
 * 这种裸栈，而应该看到"下一步该做什么"。
 *
 * @param {string} alias - 出问题的别名。
 * @param {string} raw - ssh 的原始报错。
 * @returns {string} 中文、可操作的提示。
 */
export function explainSshFailure(alias, raw) {
  const text = String(raw ?? '')
  const name = String(alias ?? '').trim() || '这台机器'

  if (/Permission denied \(publickey/i.test(text)) {
    return `连不上「${name}」：公钥认证被拒绝。请确认这台机器的公钥已经加到远端（把 ~/.ssh/id_*.pub 的内容追加到远端的 ~/.ssh/authorized_keys），或该机器的 ssh-agent 里有可用的密钥。`
  }
  if (/Permission denied/i.test(text)) {
    return `连不上「${name}」：认证失败。请检查 ~/.ssh/config 里这台机器的 User 是否正确，以及私钥是否可用。`
  }
  if (/Host key verification failed/i.test(text)) {
    return `连不上「${name}」：主机指纹校验失败。如果这是第一次连接，请先在终端里手动 \`ssh ${name}\` 确认一次指纹；如果指纹不该变，说明可能有人在中间，先别连。`
  }
  if (/Could not resolve hostname/i.test(text)) {
    return `连不上「${name}」：主机名解析不了。请检查 ~/.ssh/config 里这个 Host 的 HostName 是否写对了，以及本机 DNS / 网络是否正常。`
  }
  if (/Connection timed out|Connection refused|Operation timed out/i.test(text)) {
    return `连不上「${name}」：网络不通（超时或被拒）。请确认这台机器在线、端口正确，以及是否需要先连 VPN 或经过跳板机（ProxyJump）。`
  }
  if (/No such file or directory/i.test(text) && /config/i.test(text)) {
    return `没有找到 ssh 配置文件（~/.ssh/config）。你可以先在终端里为「${name}」写一个 Host 段，再回来刷新。`
  }
  if (/not found|command not found|ENOENT/i.test(text)) {
    return '找不到 ssh 命令。请确认本机装了 OpenSSH 客户端，并且 ssh 在 PATH 里。'
  }
  const trimmed = text.trim().split('\n').filter(Boolean).slice(-1)[0] || '未知原因'
  return `连不上「${name}」：${trimmed}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 读原始文件（写入目标只有一个文件，不做 Include 展开）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读原始配置文本。写入时只能针对**一个**文件，因此这里**不展开** `Include`。
 *
 * @param {string} [filePath]
 * @returns {string} 文件内容；不存在或读不到时返回空串。
 */
export function readRawSshConfig(filePath = sshConfigPath()) {
  try {
    const text = readFileSync(filePath, 'utf8')
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 受管块：写入
// ─────────────────────────────────────────────────────────────────────────────

/** 值里含空白或 `#` 时加引号，避免被解析成多个 token 或注释。 */
function quoteCfg(value) {
  const s = String(value ?? '')
  return /[\s#]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** 计算一个受管块需要携带的值（空串表示省略该行）。 */
function desiredValues(fields) {
  const alias = String(fields?.alias ?? '').trim()
  const hostName = String(fields?.hostName ?? '').trim()
  const port = Number(fields?.port) || 0
  return {
    // HostName 与别名相同时省略：`Host foo` 后跟 `HostName foo` 是纯噪音。
    hostname: hostName && hostName !== alias ? hostName : '',
    user: String(fields?.user ?? '').trim(),
    // 22 是默认值，写出来只是噪音。
    port: port && port !== 22 ? String(port) : '',
    identityfile: String(fields?.identityFile ?? '').trim(),
  }
}

/** 渲染受管块里由我们拥有的那几行。 */
function desiredLines(fields) {
  const want = desiredValues(fields)
  const out = []
  if (want.hostname) out.push(`  HostName ${quoteCfg(want.hostname)}`)
  if (want.user) out.push(`  User ${quoteCfg(want.user)}`)
  if (want.port) out.push(`  Port ${want.port}`)
  if (want.identityfile) out.push(`  IdentityFile ${quoteCfg(want.identityfile)}`)
  return out
}

/**
 * 在原始配置行里定位 `alias` 的**受管**块。
 *
 * 标记必须是 Host 行上方**最近的**非空行；没有标记但点名了 alias 的块是
 * 用户的，不是我们的。
 */
function locateManagedBlock(lines, alias) {
  const wanted = alias.toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const m = String(lines[i] ?? '').match(/^\s*host\s+(.+?)\s*$/i)
    if (!m) continue
    const names = splitValue(m[1]).map((p) => p.toLowerCase())
    if (!names.includes(wanted)) continue
    let j = i - 1
    while (j >= 0 && String(lines[j] ?? '').trim() === '') j -= 1
    if (j < 0 || String(lines[j] ?? '').trim().toLowerCase() !== MANAGED_MARK) continue
    // 块的结束位置是下一个 Host / Match 行（或文件末尾）。
    let end = lines.length
    for (let k = i + 1; k < lines.length; k += 1) {
      if (/^\s*(host|match)\s/i.test(String(lines[k] ?? ''))) {
        end = k
        break
      }
    }
    return { markerLine: j, hostLine: i, end }
  }
  return null
}

/** 是否存在一个**无标记**的块点名了 alias（那就是用户手写的）。 */
function hasUnmanagedConflict(lines, alias) {
  const wanted = alias.toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const m = String(lines[i] ?? '').match(/^\s*host\s+(.+?)\s*$/i)
    if (!m) continue
    const names = splitValue(m[1]).map((p) => p.toLowerCase())
    if (!names.includes(wanted)) continue
    let j = i - 1
    while (j >= 0 && String(lines[j] ?? '').trim() === '') j -= 1
    if (j >= 0 && String(lines[j] ?? '').trim().toLowerCase() === MANAGED_MARK) continue // 是我们的
    return true
  }
  return false
}

/**
 * 校验一个别名能否安全地写进配置。
 *
 * 拒绝空白与通配/否定字符——它们要么破坏 Host 行语法，要么让"这台机器"
 * 变成一组机器，都不是我们想要的。
 *
 * @param {string} alias
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateAlias(alias) {
  const name = String(alias ?? '').trim()
  if (!name) return { ok: false, reason: '机器名不能为空。' }
  if (/\s/.test(name)) return { ok: false, reason: '机器名不能包含空格。' }
  if (/[*?!,]/.test(name)) {
    return { ok: false, reason: '机器名不能包含 * ? ! , 这些字符（它们表示通配或多选，不是一台具体的机器）。' }
  }
  if (name.startsWith('-')) return { ok: false, reason: '机器名不能以 - 开头（会被 ssh 当成命令行选项）。' }
  if (name.length > 255) return { ok: false, reason: '机器名太长了（超过 255 个字符）。' }
  return { ok: true }
}

/**
 * 插入或刷新一台机器的受管 Host 块。
 *
 * 三种结果：
 *   - `appended` / `updated` / `unchanged` —— 成功，返回新的完整文本；
 *   - `conflict` —— 已存在一个**用户手写**的同名块，**原文一字不改**地返回；
 *   - `invalid` —— 别名不合法，**原文一字不改**地返回。
 *
 * 无论哪种情况都返回 `text`：调用方永远用返回值去写盘，就不会出现
 * "出错却把文件写坏了"的情况。
 *
 * @param {string} rawText - 原始配置文本（空串表示文件不存在）。
 * @param {{alias: string, hostName?: string, user?: string, port?: number|string, identityFile?: string}} fields
 * @returns {{status: 'appended'|'updated'|'unchanged'|'conflict'|'invalid', text: string, reason?: string}}
 */
export function upsertManagedHostBlock(rawText, fields) {
  const text = String(rawText ?? '')
  const alias = String(fields?.alias ?? '').trim()

  const valid = validateAlias(alias)
  if (!valid.ok) return { status: 'invalid', text, reason: valid.reason }

  const lines = text.split('\n')
  if (hasUnmanagedConflict(lines, alias)) {
    return {
      status: 'conflict',
      text,
      reason: `~/.ssh/config 里已经有一个你手写的「${alias}」Host 块。我们不会改它——请直接使用这个已有的配置，或者换一个机器名。`,
    }
  }

  const want = desiredValues({ ...fields, alias })
  const found = locateManagedBlock(lines, alias)

  if (!found) {
    const block = [MANAGED_MARK, `Host ${alias}`, ...desiredLines({ ...fields, alias })]
    const trimmedEnd = text.replace(/\s+$/, '')
    const prefix = trimmedEnd === '' ? '' : trimmedEnd + '\n\n'
    return { status: 'appended', text: prefix + block.join('\n') + '\n' }
  }

  // 先看现有块是否已经一致：一致就不写盘，免得白白改变文件 mtime。
  const body = lines.slice(found.hostLine + 1, found.end)
  const current = {}
  for (const line of body) {
    const m = String(line).match(/^\s*(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (!MANAGED_PARAMS.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(current, key)) continue
    current[key] = stripQuotes(m[2].trim())
  }
  const same = ['hostname', 'user', 'port', 'identityfile']
    .every((k) => String(current[k] ?? '') === String(want[k] ?? ''))
  if (same) return { status: 'unchanged', text }

  // 只重写我们拥有的四个参数；块内用户自己加的行（ForwardAgent、注释…）保留。
  const kept = body.filter((line) => {
    const m = String(line).match(/^\s*(\S+)\s/)
    return !m || !MANAGED_PARAMS.has(m[1].toLowerCase())
  })
  const next = [
    ...lines.slice(0, found.hostLine + 1),
    ...desiredLines({ ...fields, alias }),
    ...kept,
    ...lines.slice(found.end),
  ]
  return { status: 'updated', text: next.join('\n') }
}

/**
 * 删除一台机器的受管 Host 块。
 *
 * 只删带我们标记的块。用户手写的块**永远不会**被删除——那是他们自己的
 * ssh 通道，不是我们的插件状态。
 *
 * @param {string} rawText
 * @param {string} alias
 * @returns {{status: 'removed'|'absent', text: string}}
 */
export function removeManagedHostBlock(rawText, alias) {
  const text = String(rawText ?? '')
  const name = String(alias ?? '').trim()
  if (!name) return { status: 'absent', text }

  const lines = text.split('\n')
  const found = locateManagedBlock(lines, name)
  if (!found) return { status: 'absent', text }

  let start = found.markerLine
  while (start > 0 && String(lines[start - 1] ?? '').trim() === '') start -= 1
  const next = [...lines.slice(0, start), ...lines.slice(found.end)]
  return { status: 'removed', text: next.join('\n') }
}

/**
 * 写回 ssh 配置文件。
 *
 * 目录 `0700`、文件 `0600`——OpenSSH 对配置的要求，宽权限会被 ssh 警告甚至拒绝。
 * Windows 上没有 POSIX 权限位，跳过。
 *
 * @param {string} text - 完整配置文本。
 * @param {string} [filePath]
 * @param {object} [io] - 可注入钩子（测试用）。
 */
export function writeSshConfig(text, filePath = sshConfigPath(), io = {}) {
  const mkdir = io.mkdir || ((p) => mkdirSync(p, { recursive: true }))
  const write = io.write || ((p, data) => writeFileSync(p, data, 'utf8'))
  const chmod = io.chmod || ((p, mode) => {
    try { chmodSync(p, mode) } catch { /* 有的文件系统没有权限位 */ }
  })
  mkdir(path.dirname(filePath))
  write(filePath, String(text))
  if (process.platform !== 'win32') {
    chmod(path.dirname(filePath), 0o700)
    chmod(filePath, 0o600)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 机器注册表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 注册表里一条机器记录的形状。
 *
 * **刻意只有三个字段**：`id`、`alias`、`label`。
 * 不存 host/user/port/私钥——那些唯一真相在 `~/.ssh/config`。
 * 不存密码——认证完全交给用户已有的 ssh-agent / keychain。
 *
 * @typedef {object} MachineRecord
 * @property {string} id    - 稳定标识（创建时生成，改名不变）。
 * @property {string} alias - `~/.ssh/config` 里的 Host 别名。
 * @property {string} label - 界面上显示的名字（默认等于 alias，用户可改）。
 */

/**
 * 校验并规范化一条机器记录。
 *
 * @param {object} record
 * @returns {{ok: boolean, record?: MachineRecord, reason?: string}}
 */
export function normalizeMachineRecord(record) {
  const alias = String(record?.alias ?? '').trim()
  const valid = validateAlias(alias)
  if (!valid.ok) return { ok: false, reason: valid.reason }

  const id = String(record?.id ?? '').trim() || createMachineId()
  const label = String(record?.label ?? '').trim() || alias
  return { ok: true, record: { id, alias, label } }
}

/**
 * 生成一个机器 id。
 *
 * 用时间戳 + 随机后缀，不依赖 uuid 包（这个模块要保持零依赖）。
 *
 * @returns {string}
 */
export function createMachineId() {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `m_${stamp}_${rand}`
}

/**
 * 从注册表文件内容里读出机器列表。
 *
 * 容错：文件不存在、JSON 坏掉、字段缺失都返回空数组，不抛异常。
 * 坏的记录被**丢弃并告知**，而不是让整个设置页打不开。
 *
 * @param {string} text - 注册表文件内容。
 * @returns {{machines: MachineRecord[], dropped: number}}
 */
export function parseMachineRegistry(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return { machines: [], dropped: 0 }
  }
  const raw = Array.isArray(parsed?.machines) ? parsed.machines : []
  const machines = []
  const seenId = new Set()
  const seenAlias = new Set()
  let dropped = 0

  for (const item of raw) {
    const normalized = normalizeMachineRecord(item)
    if (!normalized.ok) {
      dropped += 1
      continue
    }
    const rec = normalized.record
    // 重复 id 或重复 alias 都是坏数据，只留第一条。
    if (seenId.has(rec.id) || seenAlias.has(rec.alias)) {
      dropped += 1
      continue
    }
    seenId.add(rec.id)
    seenAlias.add(rec.alias)
    machines.push(rec)
  }
  return { machines, dropped }
}

/**
 * 序列化注册表。
 *
 * 固定 2 空格缩进 + 结尾换行：这个文件会被用户（和 git diff）看到，
 * 可读性比体积重要。
 *
 * @param {MachineRecord[]} machines
 * @returns {string}
 */
export function serializeMachineRegistry(machines) {
  const list = Array.isArray(machines) ? machines : []
  return JSON.stringify({ version: 1, machines: list }, null, 2) + '\n'
}

/**
 * 往列表里加一台机器。
 *
 * 别名重复时返回错误而不是静默覆盖——两台机器指向同一个 ssh 别名是没有意义的，
 * 而且静默覆盖会让用户以为"加成功了"，实际却丢了原来那条。
 *
 * @param {MachineRecord[]} machines
 * @param {object} record
 * @returns {{ok: boolean, machines: MachineRecord[], reason?: string}}
 */
export function addMachine(machines, record) {
  const list = Array.isArray(machines) ? machines.slice() : []
  const normalized = normalizeMachineRecord(record)
  if (!normalized.ok) return { ok: false, machines: list, reason: normalized.reason }

  const rec = normalized.record
  if (list.some((m) => m.alias === rec.alias)) {
    return {
      ok: false,
      machines: list,
      reason: `「${rec.alias}」已经在机器列表里了，不用重复添加。`,
    }
  }
  if (list.some((m) => m.id === rec.id)) {
    return { ok: false, machines: list, reason: '机器 id 冲突了，请重试一次。' }
  }
  return { ok: true, machines: [...list, rec] }
}

/**
 * 更新一台机器的显示名。
 *
 * **别名不允许改**：别名是 `~/.ssh/config` 里的 Host 名字，改名等于换机器。
 * 想换别名的正确操作是删掉再新增。这样约束能防止"改了名字但其实还连着
 * 旧配置"的隐蔽错误。
 *
 * @param {MachineRecord[]} machines
 * @param {string} id
 * @param {{label?: string}} patch
 * @returns {{ok: boolean, machines: MachineRecord[], reason?: string}}
 */
export function updateMachine(machines, id, patch) {
  const list = Array.isArray(machines) ? machines.slice() : []
  const index = list.findIndex((m) => m.id === id)
  if (index < 0) {
    return { ok: false, machines: list, reason: '找不到这台机器，它可能已经被删掉了。刷新一下再试。' }
  }
  if (Object.prototype.hasOwnProperty.call(patch ?? {}, 'alias')) {
    return {
      ok: false,
      machines: list,
      reason: '机器别名对应 ~/.ssh/config 里的 Host 名字，不能直接改。要换机器请先删除再新增。',
    }
  }
  const nextLabel = String(patch?.label ?? '').trim() || list[index].alias
  const next = list.slice()
  next[index] = { ...list[index], label: nextLabel }
  return { ok: true, machines: next }
}

/**
 * 从列表里删掉一台机器。
 *
 * 只影响注册表；`~/.ssh/config` 里的 Host 块**不动**（那是用户的 ssh 通道）。
 *
 * @param {MachineRecord[]} machines
 * @param {string} id
 * @returns {{ok: boolean, machines: MachineRecord[], removed?: MachineRecord, reason?: string}}
 */
export function removeMachine(machines, id) {
  const list = Array.isArray(machines) ? machines.slice() : []
  const index = list.findIndex((m) => m.id === id)
  if (index < 0) {
    return { ok: false, machines: list, reason: '找不到这台机器，它可能已经被删掉了。' }
  }
  const removed = list[index]
  return { ok: true, machines: [...list.slice(0, index), ...list.slice(index + 1)], removed }
}

// ─────────────────────────────────────────────────────────────────────────────
// 面向 UI 的高层动作
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 概览：把「ssh 配置里有哪些机器」和「注册表里已经用了哪些」合成一份界面数据。
 *
 * 这是设置页"机器"一节唯一需要的数据。返回的每一项都带 `inUse`，
 * 页面据此决定是显示「添加」还是「已添加」。
 *
 * @param {object} input
 * @param {string} input.configText - 已展开 Include 的 ssh 配置文本。
 * @param {MachineRecord[]} input.machines - 注册表里的机器。
 * @returns {{available: Array<{alias: string, inUse: boolean}>, machines: MachineRecord[], configFound: boolean}}
 */
export function buildMachineOverview({ configText = '', machines = [] } = {}) {
  const list = Array.isArray(machines) ? machines : []
  const usedAliases = new Set(list.map((m) => m.alias))
  const aliases = listHostAliases(configText)
  return {
    configFound: String(configText ?? '').trim() !== '',
    available: aliases.map((alias) => ({ alias, inUse: usedAliases.has(alias) })),
    machines: list,
  }
}

/**
 * 新增一台机器的完整流程（读文件 → 造受管块 → 写回）。
 *
 * 这是唯一会**写** `~/.ssh/config` 的入口，且只在用户明确点击
 * 「新建一台机器」时被调用。只想用已有 Host 的用户永远走不到这里。
 *
 * 每一步失败都返回中文原因，不抛异常。
 *
 * @param {object} input
 * @param {object} input.fields - `{alias, hostName, user, port, identityFile}`。
 * @param {string} [input.filePath] - 配置文件路径，默认 {@link sshConfigPath}。
 * @param {object} [input.io] - 可注入的文件系统钩子（测试用）。
 * @returns {{ok: boolean, status: string, message: string, text?: string}}
 */
export function createMachineInSshConfig({ fields, filePath, io = {} } = {}) {
  const target = filePath || sshConfigPath()
  const alias = String(fields?.alias ?? '').trim()

  const valid = validateAlias(alias)
  if (!valid.ok) return { ok: false, status: 'invalid', message: valid.reason }

  let raw = ''
  try {
    raw = io.read ? io.read(target) : readRawSshConfig(target)
  } catch (error) {
    return {
      ok: false,
      status: 'read-failed',
      message: `读不了 ssh 配置文件（${target}）：${String(error?.message ?? error)}`,
    }
  }

  const result = upsertManagedHostBlock(raw, fields)
  if (result.status === 'conflict') {
    return { ok: false, status: 'conflict', message: result.reason }
  }
  if (result.status === 'invalid') {
    return { ok: false, status: 'invalid', message: result.reason }
  }
  if (result.status === 'unchanged') {
    return { ok: true, status: 'unchanged', message: `「${alias}」的配置已经是最新的了。`, text: result.text }
  }

  try {
    if (io.write) io.write(target, result.text)
    else writeSshConfig(result.text, target)
  } catch (error) {
    return {
      ok: false,
      status: 'write-failed',
      message: `写 ssh 配置文件失败（${target}）：${String(error?.message ?? error)}。请检查文件权限。`,
    }
  }

  return {
    ok: true,
    status: result.status,
    message: result.status === 'appended'
      ? `已在 ~/.ssh/config 里为「${alias}」写入配置。`
      : `已更新 ~/.ssh/config 里「${alias}」的配置。`,
    text: result.text,
  }
}

/**
 * 删除一台机器的受管块（只在用户显式要求「也从 ssh 配置里删掉」时调用）。
 *
 * 默认删除机器**不**走这里——注册表删除就够，用户手写的 ssh 配置不该被动。
 *
 * @param {object} input
 * @param {string} input.alias
 * @param {string} [input.filePath]
 * @param {object} [input.io]
 * @returns {{ok: boolean, status: string, message: string}}
 */
export function removeMachineFromSshConfig({ alias, filePath, io = {} } = {}) {
  const target = filePath || sshConfigPath()
  const name = String(alias ?? '').trim()
  if (!name) return { ok: false, status: 'invalid', message: '机器名是空的，没法删除。' }

  let raw = ''
  try {
    raw = io.read ? io.read(target) : readRawSshConfig(target)
  } catch (error) {
    return {
      ok: false,
      status: 'read-failed',
      message: `读不了 ssh 配置文件（${target}）：${String(error?.message ?? error)}`,
    }
  }

  const result = removeManagedHostBlock(raw, name)
  if (result.status === 'absent') {
    return {
      ok: true,
      status: 'absent',
      message: `~/.ssh/config 里没有找到本插件为「${name}」写的配置（你手写的块我们不会动）。`,
    }
  }

  try {
    if (io.write) io.write(target, result.text)
    else writeSshConfig(result.text, target)
  } catch (error) {
    return {
      ok: false,
      status: 'write-failed',
      message: `写 ssh 配置文件失败（${target}）：${String(error?.message ?? error)}。请检查文件权限。`,
    }
  }

  return { ok: true, status: 'removed', message: `已从 ~/.ssh/config 里删除本插件为「${name}」写的配置。` }
}
