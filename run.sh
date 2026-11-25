#!/usr/bin/env bash
# A股看盘 Webapp —— 一键启动
#
# 用法：
#   ./run.sh              # 默认 127.0.0.1:8848，只有本机能访问
#   ./run.sh 8899         # 换端口
#   ASHARE_HOST=0.0.0.0 ./run.sh    # 局域网可访问（无鉴权，见 README）
#
# 第一次运行会自动建 .venv 并装依赖，之后直接启动。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PORT_ARG="${1:-}"

# ---------- 1. 找 Python ----------
PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[run] 没找到 python3，请先装 Python 3.10 或更高版本" >&2
  exit 1
fi

# eltdx 要求 >=3.10
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "[run] 需要 Python 3.10+，当前是 $("$PY" -V 2>&1)" >&2
  exit 1
fi

# ---------- 2. 准备虚拟环境 ----------
VENV="$HERE/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "[run] 首次运行，创建虚拟环境 .venv ..."
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

# 依赖已装过就跳过（比对 marker 文件，避免每次都跑 pip）
MARK="$VENV/.deps-installed"
if [ ! -f "$MARK" ] || [ "$HERE/requirements.txt" -nt "$MARK" ]; then
  echo "[run] 安装依赖 ..."
  "$VPY" -m pip install --upgrade pip -q
  "$VPY" -m pip install -q -r "$HERE/requirements.txt"
  touch "$MARK"
fi

# ---------- 3. 启动 ----------
if [ -n "$PORT_ARG" ]; then
  exec "$VPY" server.py --port "$PORT_ARG"
else
  exec "$VPY" server.py
fi
