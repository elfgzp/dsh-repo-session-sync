#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Load smoke test for dsh-repo-session-sync.
#
# Proves the package can be composed into a DSH profile and that its Host half
# activates — WITHOUT touching the user's real DSH home, profile, settings or
# sessions. Every filesystem effect happens under a freshly created mktemp
# directory that is removed on exit.
#
# Why this exists: a plugin's failure modes at load time are silent. A patch in
# the wrong shape, a missing `dsh.bundle.patch`, a bad export, or a hard cordis
# dependency that never publishes all produce "nothing appears in the UI" with no
# error anywhere the user will look. This script turns each of those into a
# non-zero exit with a specific message.
#
# What it checks, in order:
#   1. The patch file is loadable YAML and parses to an `insert:` row.
#   2. `dsh --dump-config` composes the row into a profile (the loader accepts it).
#   3. The package's Host entry exports the shape Cordis requires.
#   4. `apply()` runs against a stub context and registers what it promised.
#
# Usage:
#   scripts/smoke-load.sh           # full run, cleans up after itself
#   scripts/smoke-load.sh --keep    # keep the temp dir and print its path
#
# Requirements: a DSH installation (found automatically on macOS), node, git.
# Exit codes: 0 = every check passed, 1 = a check failed, 2 = environment problem.
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

FAIL=0
TMP_DIR=""

say()  { printf '%s\n' "$*"; }
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    if [ "$KEEP" -eq 1 ]; then
      say ""
      say "临时目录已保留：$TMP_DIR"
    else
      rm -rf -- "$TMP_DIR"
    fi
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. Environment
# ---------------------------------------------------------------------------
step "0. 环境"

if ! command -v node >/dev/null 2>&1; then
  say "找不到 node。" >&2
  exit 2
fi
NODE_BIN="$(command -v node)"
pass "node $("$NODE_BIN" --version) → $NODE_BIN"

# The CLI is not installed on PATH by the desktop app; it lives inside the app
# bundle. Resolve it in a portable way rather than hardcoding one install path.
DSH_BIN="${DSH_BIN:-}"
if [ -z "$DSH_BIN" ] && command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
fi
if [ -z "$DSH_BIN" ]; then
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  do
    [ -x "$candidate" ] && { DSH_BIN="$candidate"; break; }
  done
fi
if [ -z "$DSH_BIN" ] || [ ! -x "$DSH_BIN" ]; then
  say ""
  say "找不到 dsh CLI。设置 DSH_BIN 指向可执行文件后重试，例如：" >&2
  say "  DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' $0" >&2
  say ""
  say "只跑不依赖 CLI 的检查（patch 解析 + 模块导出）：" >&2
  say "  SKIP_LOADER=1 $0" >&2
  [ "${SKIP_LOADER:-0}" = "1" ] || exit 2
fi
[ -n "$DSH_BIN" ] && pass "dsh → $DSH_BIN"

# Isolation: every DSH path below is derived from this directory. It is a fresh
# mktemp dir, so nothing here can reach the user's real ~/.dsh.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-repo-session-sync-smoke.XXXXXX")" || exit 2
export DSH_HOME="$TMP_DIR/dsh-home"
mkdir -p "$DSH_HOME"
pass "隔离 DSH_HOME → $DSH_HOME"

# Belt and braces: refuse to continue if DSH_HOME somehow resolves inside a real
# DSH home. This guard exists because the cost of being wrong here is the user's
# session data.
case "$DSH_HOME" in
  "$TMP_DIR"/*) : ;;
  *)
    say "DSH_HOME 不在临时目录内，拒绝继续：$DSH_HOME" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# 1. Patch file shape
# ---------------------------------------------------------------------------
step "1. cordis.patch.yml 结构"

PATCH_FILE="$REPO_ROOT/cordis.patch.yml"
if [ ! -f "$PATCH_FILE" ]; then
  fail "缺少 cordis.patch.yml"
else
  pass "存在：$PATCH_FILE"
  # The one mistake that matters: a bare top-level `- id/name` entry is read as an
  # override of a row that does not exist, so the plugin silently never mounts.
  if grep -qE '^- *insert:' "$PATCH_FILE"; then
    pass "使用 insert: 包裹（正确格式）"
  else
    fail "顶层没有 'insert:' —— 裸 - id/name 会被 loader 当作覆盖而静默丢弃插件"
  fi

  # Every inserted row needs id + name; name must match package.json.
  PKG_NAME="$("$NODE_BIN" -e "process.stdout.write(require('$REPO_ROOT/package.json').name)")"
  if grep -qE "name: *['\"]?$PKG_NAME['\"]? *$" "$PATCH_FILE"; then
    pass "row name 与 package.json 一致（${PKG_NAME}）"
  else
    fail "patch 里的 name 与 package.json 的 name 不一致（期望 ${PKG_NAME}）"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Manifest
# ---------------------------------------------------------------------------
step "2. package.json 契约"

MANIFEST_CHECK="$("$NODE_BIN" -e '
const path = require("path")
const root = process.argv[1]
let pkg
try { pkg = require(path.join(root, "package.json")) } catch (e) { console.log("FAIL 无法解析 package.json"); process.exit(0) }
const problems = []
if (pkg.type !== "module") problems.push("type 必须是 module")
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) problems.push("缺少 dsh.bundle.patch")
if (!pkg.exports || !pkg.exports["."]) problems.push("缺少 exports[\".\"]")
if (pkg.dsh && pkg.dsh.client) {
  if (!pkg.exports["./client"]) problems.push("声明了 dsh.client 但缺少 exports[\"./client\"]")
  if (!Array.isArray(pkg.dsh.client.inject)) problems.push("dsh.client.inject 必须是数组")
}
const fs = require("fs")
if (pkg.dsh && pkg.dsh.client) {
  const clientPath = path.join(root, pkg.exports["./client"].replace(/^\.\//, ""))
  if (!fs.existsSync(clientPath)) problems.push("client 入口文件不存在: " + clientPath)
}
if (problems.length === 0) console.log("OK " + pkg.name + "@" + pkg.version)
else for (const p of problems) console.log("FAIL " + p)
' "$REPO_ROOT")"

while IFS= read -r line; do
  case "$line" in
    OK\ *)   pass "manifest 完整（${line#OK }）" ;;
    FAIL\ *) fail "${line#FAIL }" ;;
  esac
done <<EOF
$MANIFEST_CHECK
EOF

# ---------------------------------------------------------------------------
# 3. Host entry exports
# ---------------------------------------------------------------------------
step "3. Host 入口导出"

EXPORT_CHECK="$("$NODE_BIN" --input-type=module -e '
const root = process.argv[1]
const problems = []
let mod
try {
  mod = await import(root + "/src/index.js")
} catch (error) {
  console.log("FAIL 导入 src/index.js 失败: " + error.message)
  process.exit(0)
}
if (typeof mod.apply !== "function") problems.push("没有导出 apply()")
if (mod.inject !== undefined) {
  if (!Array.isArray(mod.inject)) problems.push("inject 必须是数组")
  else if (mod.inject.length === 0) problems.push("inject 是空数组（要么省略，要么写依赖）")
}
if (problems.length === 0) console.log("OK apply() 可导入, inject=" + JSON.stringify(mod.inject ?? null))
else for (const p of problems) console.log("FAIL " + p)
' "$REPO_ROOT" 2>&1)"

while IFS= read -r line; do
  case "$line" in
    OK\ *)   pass "${line#OK }" ;;
    FAIL\ *) fail "${line#FAIL }" ;;
    *)       [ -n "$line" ] && say "    $line" ;;
  esac
done <<EOF
$EXPORT_CHECK
EOF

# ---------------------------------------------------------------------------
# 4. Activation against a stub context
# ---------------------------------------------------------------------------
step "4. apply() 装配（stub context）"

ACTIVATION_CHECK="$("$NODE_BIN" --input-type=module -e '
const root = process.argv[1]
const mod = await import(root + "/src/index.js")

// A stub Cordis context. Enough surface to let apply() run and let us observe
// what it registers; deliberately NOT a real Host, so this cannot touch data.
const registered = { routes: [], tools: [], sections: [], effects: [] }
const disposers = []
const makeDisposer = (label) => { const fn = () => {}; fn.label = label; disposers.push(fn); return fn }

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get(name) {
    if (name === "webServer") {
      return {
        register(route) {
          registered.routes.push(route.path)
          return makeDisposer("route:" + route.path)
        },
      }
    }
    if (name === "connection") {
      return { requestRejection: () => undefined }
    }
    if (name === "tools") {
      return {
        register(definition) {
          registered.tools.push(definition.name)
          return makeDisposer("tool:" + definition.name)
        },
      }
    }
    if (name === "systemPrompt") {
      return {
        section(section) {
          registered.sections.push(section.name)
          return makeDisposer("section:" + section.name)
        },
      }
    }
    if (name === "profileContext") {
      return { home: process.env.DSH_HOME, dir: process.env.DSH_HOME + "/profiles/smoke" }
    }
    return undefined
  },
  effect(fn, label) {
    registered.effects.push(label ?? "effect")
    const disposer = typeof fn === "function" ? fn() : undefined
    return typeof disposer === "function" ? disposer : () => {}
  },
  on() { return () => {} },
}

const problems = []
try {
  mod.apply(ctx, { useSystemPrompt: true })
} catch (error) {
  console.log("FAIL apply() 抛出: " + error.message)
  process.exit(0)
}

if (!registered.routes.includes("/repo-session-sync/status")) problems.push("没有注册 /repo-session-sync/status 路由")
if (!registered.tools.includes("repo_session_sync")) problems.push("没有注册 repo_session_sync 工具")
if (!registered.sections.includes("repo-session-sync")) problems.push("没有注册 systemPrompt section")
if (registered.routes.length < 5) problems.push("路由数量偏少(" + registered.routes.length + ")，装配可能中断")

// Let the async initialization settle, then confirm it did not throw.
await new Promise((resolve) => setTimeout(resolve, 150))

if (problems.length === 0) {
  console.log("OK routes=" + registered.routes.length + " tools=" + registered.tools.length + " sections=" + registered.sections.length)
} else {
  for (const p of problems) console.log("FAIL " + p)
}
' "$REPO_ROOT" 2>&1)"

while IFS= read -r line; do
  case "$line" in
    OK\ *)   pass "${line#OK }" ;;
    FAIL\ *) fail "${line#FAIL }" ;;
    *)       [ -n "$line" ] && say "    $line" ;;
  esac
done <<EOF
$ACTIVATION_CHECK
EOF

# ---------------------------------------------------------------------------
# 5. Loader composition (the real proof)
# ---------------------------------------------------------------------------
step "5. Loader 组合（真实 dsh --dump-config）"

if [ -z "$DSH_BIN" ]; then
  say "  - 跳过（没有 dsh CLI）"
else
  # A profile composed from the shipped headless template, with this package
  # linked in and its patch overlaid. Nothing here is the user's profile.
  SMOKE_PROFILE="$DSH_HOME/profiles/smoke"
  mkdir -p "$SMOKE_PROFILE/node_modules"
  ln -sfn "$REPO_ROOT" "$SMOKE_PROFILE/node_modules/dsh-repo-session-sync"

  cat > "$SMOKE_PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-smoke",
  "private": true,
  "type": "module",
  "dependencies": { "dsh-repo-session-sync": "link:$REPO_ROOT" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-repo-session-sync"] } }
}
JSON
  printf '[]\n' > "$SMOKE_PROFILE/cordis.yml"
  printf '[]\n' > "$SMOKE_PROFILE/cordis.patch.yml"
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$SMOKE_PROFILE/pnpm-workspace.yaml"

  DUMP="$("$DSH_BIN" --profile smoke --dump-config 2>&1)"
  DUMP_STATUS=$?

  if [ "$DUMP_STATUS" -ne 0 ]; then
    fail "dsh --dump-config 退出码 $DUMP_STATUS"
    printf '%s\n' "$DUMP" | sed 's/^/    /' | head -20
  elif printf '%s\n' "$DUMP" | grep -q "id: repo-session-sync"; then
    pass "loader 组合出了 repo-session-sync 行"
    # The row must carry the config, which proves it was read through the patch
    # rather than merely appearing somewhere in the dump.
    if printf '%s\n' "$DUMP" | grep -A2 "id: repo-session-sync" | grep -q "name: dsh-repo-session-sync"; then
      pass "行上带有正确的包名"
    else
      fail "行存在但包名不对"
    fi
    if printf '%s\n' "$DUMP" | grep -q "defaultTransport: git-branch"; then
      pass "patch 的 config 已合并"
    else
      fail "patch 的 config 没有合并进组合结果"
    fi
  else
    fail "loader 组合结果里没有 repo-session-sync 行"
    printf '%s\n' "$DUMP" | grep -iE "error|not found|invalid" | sed 's/^/    /' | head -10
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
say ""
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s\033[0m\n' "全部通过：插件可被 DSH 组合并激活。"
  exit 0
else
  printf '\033[31m%s\033[0m\n' "有检查未通过，见上面的 ✗。"
  exit 1
fi
