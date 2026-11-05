#!/usr/bin/env bash
# 提交前隐私扫描闸门 —— 防止把本机路径、真实会话数据、凭据误提交。
# 用法：scripts/check-private.sh [--staged]
#   --staged 只扫暂存区（git hook 用）；默认扫整个工作树
# 退出码 1 = 发现风险，应阻断提交。
set -uo pipefail

MODE="${1:-all}"
FAIL=0

if [ "$MODE" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM)
else
  FILES=$(git ls-files)
fi

[ -z "$FILES" ] && exit 0

# ── 规则 1：本机绝对路径泄漏 ──
# 真实家目录用户名不得出现在源码/文档里（README 示例也必须是 <you>）
# 占位用户名不算泄漏：x / you / user / example / demo / me / someone 等
# 是文档与测试里约定俗成的合成值，真实用户名几乎不会长这样。
# 其余看起来像真实人名/账号的，一律仍然拦。
PLACEHOLDER_USER='x|you|your|user|username|me|example|demo|someone|foo|bar|baz|test|tester'
HITS=$(echo "$FILES" | xargs -r grep -nIE '/Users/[a-z0-9_.-]+/(Documents|Github|Work|\.dsh)' 2>/dev/null \
  | grep -v 'scripts/check-private.sh' \
  | grep -vE "/Users/(${PLACEHOLDER_USER})/" || true)
if [ -n "$HITS" ]; then
  echo "❌ 检测到本机绝对路径，请改成占位符（如 ~/project 或 <repo>）："
  echo "$HITS" | head -20
  FAIL=1
fi

# ── 规则 2：凭据形态字符串 ──
PATTERNS='gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}'
HITS=$(echo "$FILES" | xargs -r grep -nIE "$PATTERNS" 2>/dev/null | grep -v 'scripts/check-private.sh' || true)
if [ -n "$HITS" ]; then
  echo "❌ 检测到疑似凭据："
  echo "$HITS" | head -20
  FAIL=1
fi

# ── 规则 3：被禁提交的目录/文件类型 ──
FORBIDDEN=$(echo "$FILES" | grep -E '(^|/)(\.dsh|sessions|attachments|storages)/|\.credentials\.|(^|/)\.env$|\.pem$|\.key$|id_rsa|id_ed25519' || true)
if [ -n "$FORBIDDEN" ]; then
  echo "❌ 以下文件属于用户真实数据或密钥，不得提交："
  echo "$FORBIDDEN" | head -20
  FAIL=1
fi

# ── 规则 4：真实会话 UUID 出现在测试外的源码里 ──
# 合成 UUID（全 0、全 1、全 a、0000-4000-8000 这种固定模板）是测试夹具的
# 标准写法，不可能是真实会话；真实的随机 UUID 才需要拦。
SYNTH_UUID='([0]{8}-[0]{4}-[0]{4}-[0]{4}-[0]{12})|([1]{8}-[1]{4}-[1]{4}-[1]{4}-[1]{12})|([a]{8}-[a]{4}-[a]{4}-[a]{4}-[a]{12})|([0-9a-f]{8}-0000-4000-8000-[0]{12})'
HITS=$(echo "$FILES" | grep -vE '^(test/|docs/|scripts/)' | xargs -r grep -nIE 'session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' 2>/dev/null \
  | grep -vE "session-${SYNTH_UUID}" || true)
if [ -n "$HITS" ]; then
  echo "❌ 源码中出现真实会话 ID（请改用合成 fixture）："
  echo "$HITS" | head -10
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "🚫 提交已阻断。修复上述问题后重试；确属误报请调整 scripts/check-private.sh 规则。"
  exit 1
fi
echo "✅ 隐私扫描通过（$([ "$MODE" = "--staged" ] && echo 暂存区 || echo 工作树)）"
