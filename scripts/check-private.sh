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
HITS=$(echo "$FILES" | xargs -r grep -nIE '/Users/[a-z0-9_.-]+/(Documents|Github|Work|\.dsh)' 2>/dev/null | grep -v 'scripts/check-private.sh' || true)
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
HITS=$(echo "$FILES" | grep -vE '^(test/|docs/)' | xargs -r grep -nIE 'session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' 2>/dev/null || true)
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
