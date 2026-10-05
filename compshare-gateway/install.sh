#!/usr/bin/env bash
# 生成 systemd 服务并（可选）立即启动。
#
#   ./install.sh              # 生成服务文件 + 打印后续命令
#   ./install.sh --start      # 生成并立即 enable --now
#
# 只用标准库，无需 pip install。

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${DIR}/gateway.config.json"
SERVICE=/etc/systemd/system/comfy-openai-gateway.service
PYTHON="$(command -v python3 || command -v python)"

if [ ! -f "$CONFIG" ]; then
  echo "找不到 ${CONFIG}" >&2
  echo "先执行：cp gateway.config.example.json gateway.config.json" >&2
  exit 1
fi

if [ -z "$PYTHON" ]; then
  echo "找不到 python3" >&2
  exit 1
fi

echo "==> 自检配置"
"$PYTHON" "${DIR}/gateway.py" --config "$CONFIG" --check

echo "==> 写入 ${SERVICE}"
cat > "$SERVICE" <<EOF
[Unit]
Description=ComfyUI to OpenAI compatible gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${DIR}
ExecStart=${PYTHON} ${DIR}/gateway.py --config ${CONFIG}
Restart=always
RestartSec=5
StandardOutput=append:/root/comfy-gateway.log
StandardError=append:/root/comfy-gateway.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "==> 已写入 ${SERVICE}"

if [ "${1:-}" = "--start" ]; then
  systemctl enable --now comfy-openai-gateway
  sleep 2
  systemctl --no-pager status comfy-openai-gateway || true
  echo
  echo "自检：curl http://127.0.0.1:\$(python3 -c \"import json;print(json.load(open('${CONFIG}'))['port'])\")/healthz"
else
  echo "下一步：systemctl enable --now comfy-openai-gateway"
fi