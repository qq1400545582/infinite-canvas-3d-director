#!/usr/bin/env python3
"""ComfyUI → OpenAI 兼容网关（跑在 GPU 实例里，让无限画布零改动调用 ComfyUI）。

## 为什么需要它

画布所有媒体请求都走同一个形状（`web/src/services/api/*.ts`）：

    buildApiUrl(config.baseUrl, path) + Bearer apiKey
      POST /v1/images/generations      文生图（JSON）
      POST /v1/images/edits           图生图（multipart）
      POST /v1/videos + GET /v1/videos/{id}[/content]
      POST /v1/audio/speech
      POST /v1/responses  /v1/chat/completions   文本
    GET  /v1/models                   模型列表（接入前的探测就打这里）

而 ComfyUI **不是** OpenAI 协议：它只有 `/prompt`（提交图结构）、`/history/{id}`（轮询）、
`/view`（取图）。所以直接把 `6006` 填成渠道地址一定失败（探测阶段就 404）。

本网关就是这层翻译：

    画布 ──OpenAI 协议──▶ 网关 :8000 ──ComfyUI 协议──▶ ComfyUI :6006
                          │
                          └──文本/其它 ──▶ vLLM :8002（反代，画布无感）

## 设计约束（都是实测出来的，不是猜的）

1. **模型名必须能被画布 `guessCapability` 正确归类**，否则图像模型会落进「文本」下拉。
   画布的关键词表（`web/src/stores/use-config-store.ts`）：

       VIDEO  = video sora veo kling wan hailuo
       AUDIO  = audio tts speech voice music sound
       IMAGE  = seedream gpt-image image dall-e dalle imagen flux sdxl stable-diffusion midjourney
       判定顺序：video → audio → image → 其余 text

   网关在启动时用**同一张表**自检每个模型名；归类不符就自动给 id 追加 `-image` / `-video`
   / `-audio` 后缀，并打日志提示用户改工作流名会更干净。
   ⇒ 这是「两个下拉立刻可选」能成立的前提，**不需要改画布一行代码**。

2. **画布会多发几个 OpenAI 之外的可选字段**：`output_format`、`response_format`、
   `quality`、`background`。网关必须**照单全收不报错**（画布侧的
   `withImageFieldFallback` 遇到 400 会剔除字段重试，能兜住，但白白多一次往返）。

3. **n > 1 用串行多跑实现**，不改 `batch_size`：各家工作流的 batch 节点位置不一，
   猜错会静默出图数量不对。串行最稳，也天然给出不同结果。

4. **`/v1/images/edits` 必须真的实现**（不能靠 404 让画布回退）：图生图要把参考图
   先 `POST /upload/image` 传给 ComfyUI，再把返回的文件名填进 LoadImage 节点。

5. **文本反代**：网关占 8000 后 vLLM 必须在别的端口（默认反代到 `127.0.0.1:8002`）。
   `/v1/models` 会把 vLLM 的模型也并进来，这样文本下拉不受影响。

## 只用标准库

实例镜像里 pip 装 fastapi/uvicorn 可能没有外网、也可能版本冲突。本文件只用
Python 3.8+ 标准库（`http.server` / `urllib` / `json` / `re`），`python3 gateway.py`
就能跑。ComfyUI 本身就是 Python 环境，解释器一定在。

## 用法

    python3 gateway.py --config gateway.config.json

配置见 `gateway.config.example.json`；工作流用 ComfyUI 的
「Save (API Format)」导出的 JSON 放进 `workflows/`。
启动时会自检每个工作流文件与注入点，配置有问题直接拒绝启动（不静默跑出坏图）。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Tuple

# --------------------------------------------------------------------------------------
# 画布侧口径（必须与 web/src/stores/use-config-store.ts 完全一致，改一处就要改两处）
# --------------------------------------------------------------------------------------

CANVAS_VIDEO_KEYWORDS = ("video", "sora", "veo", "kling", "wan", "hailuo")
CANVAS_AUDIO_KEYWORDS = ("audio", "tts", "speech", "voice", "music", "sound")
CANVAS_IMAGE_KEYWORDS = (
    "seedream", "gpt-image", "image", "dall-e", "dalle", "imagen",
    "flux", "sdxl", "stable-diffusion", "midjourney",
)

CAPABILITIES = ("image", "video", "audio", "text")


def guess_capability(name: str) -> str:
    """复刻画布的 guessCapability（判定顺序 video → audio → image → text）。"""
    value = str(name or "").lower()
    if any(k in value for k in CANVAS_VIDEO_KEYWORDS):
        return "video"
    if any(k in value for k in CANVAS_AUDIO_KEYWORDS):
        return "audio"
    if any(k in value for k in CANVAS_IMAGE_KEYWORDS):
        return "image"
    return "text"


def capability_suffix(capability: str) -> str:
    return "" if capability == "text" else "-" + capability


# --------------------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------------------

DEFAULT_INJECT_KEYS = (
    "prompt", "negative_prompt", "seed", "width", "height", "steps", "cfg", "image",
)

# 注入点自动推断用的类名特征。显式配置（workflow.mappings）永远优先。
_AUTODETECT = (
    ("image", ("LoadImage",)),
    ("width", ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyLatentImagePresets")),
)
_SAMPLER_HINTS = ("KSampler", "KSamplerAdvanced", "SamplerCustom")
_TEXT_HINTS = ("CLIPTextEncode", "BNK_CLIPTextEncoder")
_SAVE_HINTS = ("SaveImage", "Image Save", "VHS_VideoCombine", "SaveAudio", "SaveAnimatedWEBP", "SaveWEBM")
_VIDEO_NODE_HINTS = ("VHS_VideoCombine", "SaveAnimatedWEBP", "SaveWEBM", "SaveVideo")
_AUDIO_NODE_HINTS = ("SaveAudio", "SaveAudioNode")


@dataclass
class WorkflowSpec:
    """一个对外暴露的模型 = 一份 ComfyUI 工作流 + 一组注入点。"""

    id: str
    capability: str
    workflow_path: str
    mappings: Dict[str, str] = field(default_factory=dict)
    defaults: Dict[str, Any] = field(default_factory=dict)
    label: str = ""
    output_node: str = ""
    # 运行时填充
    resolved_id: str = ""
    workflow: Dict[str, Any] = field(default_factory=dict)
    resolved_mappings: Dict[str, str] = field(default_factory=dict)

    @property
    def display(self) -> str:
        return self.label or self.resolved_id


@dataclass
class GatewayConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    comfy_base: str = "http://127.0.0.1:6006"
    vllm_base: str = "http://127.0.0.1:8002"
    vllm_api_key: str = "sk-mycanvas-2026"
    request_timeout: int = 600
    poll_interval: float = 1.0
    max_poll_seconds: int = 900
    keep_files_seconds: int = 3600
    base_dir: str = ""
    workflows: List[WorkflowSpec] = field(default_factory=list)

    @property
    def files_dir(self) -> str:
        return os.path.join(self.base_dir, "files")


def _abs(base_dir: str, path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(base_dir, path)


def load_config(path: str) -> GatewayConfig:
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    base_dir = os.path.dirname(os.path.abspath(path))
    cfg = GatewayConfig(
        host=str(raw.get("host", "0.0.0.0")),
        port=int(raw.get("port", 8000)),
        comfy_base=str(raw.get("comfy_base", "http://127.0.0.1:6006")).rstrip("/"),
        vllm_base=str(raw.get("vllm_base", "http://127.0.0.1:8002")).rstrip("/"),
        vllm_api_key=str(raw.get("vllm_api_key", "sk-mycanvas-2026")),
        request_timeout=int(raw.get("request_timeout", 600)),
        poll_interval=float(raw.get("poll_interval", 1.0)),
        max_poll_seconds=int(raw.get("max_poll_seconds", 900)),
        keep_files_seconds=int(raw.get("keep_files_seconds", 3600)),
        base_dir=base_dir,
    )
    entries = raw.get("workflows") or []
    if not entries:
        raise ValueError("配置里 workflows 为空：网关至少要暴露一个工作流，否则 /v1/models 探不到任何模型")
    for entry in entries:
        spec = WorkflowSpec(
            id=str(entry.get("id") or "").strip(),
            capability=str(entry.get("capability") or "image").strip().lower(),
            workflow_path=_abs(base_dir, str(entry.get("workflow") or "")),
            mappings={str(k): str(v) for k, v in (entry.get("mappings") or {}).items()},
            defaults=dict(entry.get("defaults") or {}),
            label=str(entry.get("label") or ""),
            output_node=str(entry.get("output_node") or ""),
        )
        if not spec.id:
            raise ValueError("workflows 里存在缺少 id 的条目")
        if spec.capability not in CAPABILITIES:
            raise ValueError(f"工作流 {spec.id} 的 capability={spec.capability!r} 非法，只能是 {CAPABILITIES}")
        cfg.workflows.append(spec)
    return cfg


# --------------------------------------------------------------------------------------
# 工作流自检 + 注入点解析
# --------------------------------------------------------------------------------------


def _node_number(node_id: str) -> Tuple[int, Any]:
    try:
        return (0, int(node_id))
    except ValueError:
        return (1, str(node_id))


def _sorted_nodes(workflow: Dict[str, Any]) -> List[str]:
    return sorted(workflow.keys(), key=_node_number)


def autodetect_mappings(workflow: Dict[str, Any]) -> Dict[str, str]:
    """按 class_type 猜注入点。

    只在配置里没写对应注入点时生效。ComfyUI 导出的 API 格式里，
    CLIPTextEncode 通常按节点号升序 = (正向, 反向)；EmptyLatentImage 提供宽高与 batch。
    猜错不致命（用户显式配置会覆盖），但会在启动日志里提示。
    """
    found: Dict[str, str] = {}
    texts: List[str] = []
    latent = ""
    sampler = ""
    for node_id in _sorted_nodes(workflow):
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        if any(h in class_type for h in _TEXT_HINTS) and not texts:
            texts.append(node_id)
        elif any(h in class_type for h in _TEXT_HINTS) and "negative_prompt" not in found:
            texts.append(node_id)
        if not latent and any(h in class_type for h in _AUTODETECT[1][1]):
            latent = node_id
        if not sampler and any(h in class_type for h in _SAMPLER_HINTS):
            sampler = node_id
        if "image" not in found and any(h in class_type for h in _AUTODETECT[0][1]):
            found["image"] = f"{node_id}.inputs.image"

    if texts:
        found["prompt"] = f"{texts[0]}.inputs.text"
    if len(texts) >= 2:
        found["negative_prompt"] = f"{texts[1]}.inputs.text"
    if latent:
        found["width"] = f"{latent}.inputs.width"
        found["height"] = f"{latent}.inputs.height"
    if sampler:
        inputs = workflow.get(sampler, {}).get("inputs", {}) or {}
        seed_key = "noise_seed" if "noise_seed" in inputs else "seed"
        found["seed"] = f"{sampler}.inputs.{seed_key}"
        found["steps"] = f"{sampler}.inputs.steps"
        found["cfg"] = f"{sampler}.inputs.cfg"
    return found


def guess_output_node(workflow: Dict[str, Any], capability: str) -> str:
    """挑一个「产物节点」：优先与能力相符的保存节点，否则第一个 Save 类节点。"""
    preferred: Iterable[str]
    if capability == "video":
        preferred = _VIDEO_NODE_HINTS
    elif capability == "audio":
        preferred = _AUDIO_NODE_HINTS
    else:
        preferred = ()
    nodes = _sorted_nodes(workflow)
    for node_id in nodes:
        class_type = str((workflow.get(node_id) or {}).get("class_type") or "")
        if any(h in class_type for h in preferred):
            return node_id
    for node_id in nodes:
        class_type = str((workflow.get(node_id) or {}).get("class_type") or "")
        if any(h in class_type for h in _SAVE_HINTS):
            return node_id
    return nodes[-1] if nodes else ""


def get_in(container: Any, path: str) -> Tuple[bool, Any]:
    current = container
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return (False, None)
    return (True, current)


def set_in(container: Any, path: str, value: Any) -> None:
    parts = path.split(".")
    current = container
    for index, part in enumerate(parts[:-1]):
        nxt = parts[index + 1]
        default: Any = [] if nxt.isdigit() else {}
        if isinstance(current, list):
            position = int(part)
            while len(current) <= position:
                current.append({} if isinstance(default, dict) else [])
            current = current[position]
        elif isinstance(current, dict):
            if part not in current or not isinstance(current[part], (dict, list)):
                current[part] = default
            current = current[part]
        else:
            raise ValueError(f"注入点 {path!r} 的中间层不是容器（{type(current).__name__}）")
    last = parts[-1]
    if isinstance(current, list):
        position = int(last)
        while len(current) <= position:
            current.append(None)
        current[position] = value
    elif isinstance(current, dict):
        current[last] = value
    else:
        raise ValueError(f"注入点 {path!r} 的末层不是容器（{type(current).__name__}）")


def prepare_workflows(cfg: GatewayConfig) -> None:
    """加载 + 自检每个工作流；任何硬伤都直接抛错（不静默跑出坏图）。"""
    seen_ids: Dict[str, WorkflowSpec] = {}
    for spec in cfg.workflows:
        if not os.path.isfile(spec.workflow_path):
            raise ValueError(f"工作流 {spec.id} 的文件不存在：{spec.workflow_path}")
        with open(spec.workflow_path, "r", encoding="utf-8") as handle:
            workflow = json.load(handle)
        if not isinstance(workflow, dict) or not workflow:
            raise ValueError(f"工作流 {spec.id} 不是有效的 API 格式 JSON（应形如 {{\"3\":{{\"class_type\":…}}}}）")
        for node_id, node in workflow.items():
            if not isinstance(node, dict) or "class_type" not in node:
                raise ValueError(
                    f"工作流 {spec.id} 的节点 {node_id} 缺少 class_type —— "
                    "这通常说明导出的是「前端画布格式」，请在 ComfyUI 里改用 Save (API Format) 导出"
                )
        spec.workflow = workflow

        mappings = autodetect_mappings(workflow)
        mappings.update({k: v for k, v in spec.mappings.items()})
        missing = [k for k in ("prompt",) if k not in mappings]
        if missing:
            raise ValueError(f"工作流 {spec.id} 找不到提示词注入点（class_type 含 CLIPTextEncode 的节点），请在 mappings.prompt 里显式指定")
        broken = [f"{k}={v}" for k, v in mappings.items() if not get_in(workflow, v)[0]]
        if broken:
            raise ValueError(f"工作流 {spec.id} 的注入点在工作流里不存在：{broken}")
        spec.resolved_mappings = mappings
        if not spec.output_node:
            spec.output_node = guess_output_node(workflow, spec.capability)
        if not spec.output_node:
            raise ValueError(f"工作流 {spec.id} 找不到产物节点，请在 output_node 里显式指定")

        # 能力归类自检：名字必须能被画布 guessCapability 判成声明的 capability
        wanted = spec.capability
        actual = guess_capability(spec.id)
        if actual != wanted:
            spec.resolved_id = f"{spec.id}{capability_suffix(wanted)}"
            print(
                f"[warn] 工作流 id {spec.id!r} 会被画布判成 {actual} 能力，但声明的是 {wanted}；"
                f"已自动暴露为 {spec.resolved_id!r}（下拉里能选到正确的那一栏）。"
                f" 想名字好看就把工作流名改成含 {wanted} 关键词的名字。",
                file=sys.stderr,
            )
        else:
            spec.resolved_id = spec.id
        if spec.resolved_id in seen_ids:
            raise ValueError(f"模型 id 冲突：{seen_ids[spec.resolved_id].id} 与 {spec.id} 都解析成 {spec.resolved_id!r}")
        seen_ids[spec.resolved_id] = spec

        print(
            f"[ok] 模型 {spec.resolved_id}（{wanted}）→ {os.path.basename(spec.workflow_path)}"
            f"；产物节点 {spec.output_node}；注入点 {sorted(mappings)}"
        )


# --------------------------------------------------------------------------------------
# ComfyUI 客户端
# --------------------------------------------------------------------------------------


class GatewayError(Exception):
    """带 HTTP 状态码与 OpenAI 形状的错误体。"""

    def __init__(self, message: str, status: int = 400, kind: str = "invalid_request_error"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.kind = kind


def _http(
    url: str,
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    method: str = "GET",
    timeout: int = 60,
) -> Tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return (response.status, response.read())
    except urllib.error.HTTPError as error:
        return (error.code, error.read())
    except urllib.error.URLError as error:
        raise GatewayError(f"连不上 {url}：{error.reason}。请确认 ComfyUI 已在实例里启动。", 502, "upstream_error") from error
    except socket.timeout as error:
        raise GatewayError(f"请求 {url} 超时", 504, "timeout_error") from error


class ComfyClient:
    def __init__(self, cfg: GatewayConfig):
        self.cfg = cfg

    # -- 基础 ------------------------------------------------------------------
    def health(self) -> Dict[str, Any]:
        status, body = _http(f"{self.cfg.comfy_base}/system_stats", timeout=10)
        if status >= 400:
            return {"ok": False, "status": status}
        try:
            return {"ok": True, "stats": json.loads(body.decode("utf-8", "replace"))}
        except Exception:
            return {"ok": True, "stats": None}

    def submit(self, workflow: Dict[str, Any], client_id: str) -> str:
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode("utf-8")
        status, body = _http(
            f"{self.cfg.comfy_base}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
            timeout=60,
        )
        text = body.decode("utf-8", "replace")
        if status >= 400:
            raise GatewayError(f"ComfyUI 拒绝了这个工作流（HTTP {status}）：{text[:800]}", 400, "workflow_rejected")
        try:
            prompt_id = str(json.loads(text).get("prompt_id") or "")
        except Exception as error:
            raise GatewayError(f"ComfyUI 返回的不是 JSON：{text[:400]}", 502, "upstream_error") from error
        if not prompt_id:
            raise GatewayError(f"ComfyUI 没有返回 prompt_id：{text[:400]}", 502, "upstream_error")
        return prompt_id

    def history(self, prompt_id: str) -> Dict[str, Any]:
        status, body = _http(f"{self.cfg.comfy_base}/history/{urllib.parse.quote(prompt_id)}", timeout=30)
        if status >= 400:
            raise GatewayError(f"查询 ComfyUI 历史失败（HTTP {status}）", 502, "upstream_error")
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except Exception:
            return {}

    def view(self, filename: str, subfolder: str, kind: str) -> bytes:
        query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": kind})
        status, body = _http(f"{self.cfg.comfy_base}/view?{query}", timeout=300)
        if status >= 400:
            raise GatewayError(f"从 ComfyUI 取产物失败（HTTP {status}）：{filename}", 502, "upstream_error")
        return body

    def upload_image(self, filename: str, content: bytes) -> str:
        boundary = "----ComfyGateway" + uuid.uuid4().hex
        parts: List[bytes] = []
        for key, value in (("image", filename), ("type", "input"), ("overwrite", "true")):
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode("utf-8")
            )
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8")
        )
        parts.append(content)
        parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
        status, body = _http(
            f"{self.cfg.comfy_base}/upload/image",
            data=b"".join(parts),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
            timeout=300,
        )
        text = body.decode("utf-8", "replace")
        if status >= 400:
            raise GatewayError(f"上传参考图到 ComfyUI 失败（HTTP {status}）：{text[:400]}", 502, "upstream_error")
        try:
            info = json.loads(text)
        except Exception as error:
            raise GatewayError(f"ComfyUI 上传接口返回异常：{text[:300]}", 502, "upstream_error") from error
        name = str(info.get("name") or filename)
        subfolder = str(info.get("subfolder") or "")
        return f"{subfolder}/{name}" if subfolder else name

    def wait(self, prompt_id: str) -> Dict[str, Any]:
        """轮询 /history 直到出结果；ComfyUI 出错时把 node 的报错原文抛出来。"""
        deadline = time.time() + min(self.cfg.max_poll_seconds, self.cfg.request_timeout)
        while time.time() < deadline:
            entry = self.history(prompt_id).get(prompt_id)
            if isinstance(entry, dict):
                status_info = entry.get("status") or {}
                if status_info.get("completed") is True or status_info.get("status_str") in ("success",):
                    return entry
                messages = status_info.get("messages") or []
                for message in messages:
                    if isinstance(message, list) and len(message) >= 2 and message[0] == "execution_error":
                        detail = message[1] or {}
                        node = detail.get("node_id", "?")
                        exc = detail.get("exception_type", "Error")
                        raise GatewayError(
                            f"ComfyUI 执行出错（节点 {node}）：{exc} — {detail.get('exception_message', '')}",
                            400,
                            "workflow_failed",
                        )
                outputs = entry.get("outputs") or {}
                if outputs:
                    return entry
            time.sleep(self.cfg.poll_interval)
        raise GatewayError(f"等待 ComfyUI 出图超时（{int(self.cfg.max_poll_seconds)}s）", 504, "timeout_error")


def extract_outputs(entry: Dict[str, Any], output_node: str) -> List[Dict[str, str]]:
    """从 history 条目里取出产物文件列表 [{filename, subfolder, type}]。

    ComfyUI 各节点的产物键不统一（images / gifs / audio / video），所以按已知键依次找。
    """
    outputs = entry.get("outputs") or {}
    node = outputs.get(output_node) or {}
    if not isinstance(node, dict):
        node = {}
    for key in ("images", "gifs", "audio", "video", "videos"):
        value = node.get(key)
        if isinstance(value, list) and value:
            files = []
            for item in value:
                if isinstance(item, dict) and item.get("filename"):
                    files.append(
                        {
                            "filename": str(item.get("filename")),
                            "subfolder": str(item.get("subfolder") or ""),
                            "type": str(item.get("type") or "output"),
                        }
                    )
            if files:
                return files
    # 产物节点判断错了也别放弃：全量扫描一次
    for node_id in sorted(outputs.keys()):
        value = outputs[node_id]
        if not isinstance(value, dict):
            continue
        for key in ("images", "gifs", "audio", "video", "videos"):
            items = value.get(key)
            if isinstance(items, list) and items:
                files = []
                for item in items:
                    if isinstance(item, dict) and item.get("filename"):
                        files.append(
                            {
                                "filename": str(item.get("filename")),
                                "subfolder": str(item.get("subfolder") or ""),
                                "type": str(item.get("type") or "output"),
                            }
                        )
                if files:
                    return files
    return []


# --------------------------------------------------------------------------------------
# 产物托管（response_format=url 时用）
# --------------------------------------------------------------------------------------


class FileStore:
    def __init__(self, cfg: GatewayConfig):
        self.cfg = cfg
        self.items: Dict[str, Tuple[bytes, str, float]] = {}
        self.lock = threading.Lock()
        os.makedirs(cfg.files_dir, exist_ok=True)

    def put(self, content: bytes, mime: str) -> str:
        token = uuid.uuid4().hex
        with self.lock:
            self.items[token] = (content, mime, time.time())
        return token

    def get(self, token: str) -> Optional[Tuple[bytes, str]]:
        with self.lock:
            item = self.items.get(token)
        return (item[0], item[1]) if item else None

    def gc(self) -> None:
        limit = time.time() - self.cfg.keep_files_seconds
        with self.lock:
            for token in [t for t, (_, _, at) in self.items.items() if at < limit]:
                self.items.pop(token, None)


MIME_BY_EXT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
}


def guess_mime(filename: str) -> str:
    _, ext = os.path.splitext(filename.lower())
    return MIME_BY_EXT.get(ext, "application/octet-stream")


# --------------------------------------------------------------------------------------
# multipart 解析（图生图要读参考图）
# --------------------------------------------------------------------------------------


@dataclass
class UploadedFile:
    field: str
    filename: str
    content_type: str
    data: bytes


def parse_multipart(body: bytes, content_type: str) -> Dict[str, List[UploadedFile]]:
    match = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not match:
        return {}
    boundary = ("--" + match.group(1)).encode("utf-8")
    result: Dict[str, List[UploadedFile]] = {}
    for chunk in body.split(boundary)[1:]:
        if chunk.startswith(b"--"):
            break
        chunk = chunk[2:] if chunk.startswith(b"\r\n") else chunk.lstrip(b"\n")
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        head, sep, data = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers: Dict[str, str] = {}
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'name="([^"]*)"', disposition)
        if not name_match:
            continue
        file_match = re.search(r'filename="([^"]*)"', disposition)
        result.setdefault(name_match.group(1), []).append(
            UploadedFile(
                field=name_match.group(1),
                filename=file_match.group(1) if file_match else "",
                content_type=headers.get("content-type", ""),
                data=data,
            )
        )
    return result


DATA_URL = re.compile(r"^data:([^;,]*)(;base64)?,(.*)$", re.S)


def decode_data_url(value: str) -> Optional[Tuple[str, bytes]]:
    match = DATA_URL.match(value.strip())
    if not match:
        return None
    import base64

    if match.group(2):
        return (match.group(1) or "image/png", base64.b64decode(match.group(3)))
    import urllib.parse

    return (match.group(1) or "image/png", urllib.parse.unquote_to_bytes(match.group(3)))


# --------------------------------------------------------------------------------------
# 画布请求 → 工作流
# --------------------------------------------------------------------------------------


def parse_size(size: Any) -> Optional[Tuple[int, int]]:
    if not isinstance(size, str) or not size.strip() or size.strip().lower() == "auto":
        return None
    match = re.match(r"^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$", size)
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if not (16 <= width <= 16384 and 16 <= height <= 16384):
        return None
    return (width, height)


def build_prompt(
    spec: WorkflowSpec,
    prompt: str,
    negative: Optional[str],
    seed: Optional[int],
    size: Optional[Tuple[int, int]],
    steps: Optional[int],
    cfg: Optional[float],
    reference: Optional[str],
) -> Dict[str, Any]:
    """按注入点把一次请求写进工作流副本。"""
    workflow = json.loads(json.dumps(spec.workflow))  # 深拷贝：每次请求独立，避免并发串味
    mappings = spec.resolved_mappings
    values: Dict[str, Any] = {"prompt": prompt}
    if negative:
        values["negative_prompt"] = negative
    values["seed"] = seed if seed is not None else random.randint(0, 2 ** 31 - 1)
    if size:
        values["width"], values["height"] = size
    if steps is not None:
        values["steps"] = steps
    if cfg is not None:
        values["cfg"] = cfg
    if reference:
        values["image"] = reference
    for key, value in spec.defaults.items():
        values.setdefault(key, value)

    applied: List[str] = []
    for key, value in values.items():
        path = mappings.get(key)
        if not path:
            continue
        set_in(workflow, path, value)
        applied.append(key)
    if "prompt" not in applied:
        raise GatewayError(f"工作流 {spec.display} 没有提示词注入点，无法生成", 400, "workflow_invalid")
    return workflow


def _as_int(value: Any) -> Optional[int]:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _as_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


# --------------------------------------------------------------------------------------
# 任务表（视频要用：画布先 POST 拿 id，再轮询 GET）
# --------------------------------------------------------------------------------------


@dataclass
class Job:
    id: str
    spec_id: str
    prompt_id: str
    created: float
    status: str = "pending"
    error: str = ""
    files: List[Dict[str, str]] = field(default_factory=list)


class JobStore:
    def __init__(self):
        self.jobs: Dict[str, Job] = {}
        self.lock = threading.Lock()

    def add(self, job: Job) -> None:
        with self.lock:
            self.jobs[job.id] = job

    def get(self, job_id: str) -> Optional[Job]:
        with self.lock:
            return self.jobs.get(job_id)

    def prune(self, ttl: int) -> None:
        limit = time.time() - ttl
        with self.lock:
            for job_id in [k for k, v in self.jobs.items() if v.created < limit and v.status != "pending"]:
                self.jobs.pop(job_id, None)


# --------------------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------------------


class Gateway:
    def __init__(self, cfg: GatewayConfig):
        self.cfg = cfg
        self.comfy = ComfyClient(cfg)
        self.files = FileStore(cfg)
        self.jobs = JobStore()
        self.by_id: Dict[str, WorkflowSpec] = {}
        self.started = time.time()
        self.client_id = "comfy-openai-gateway-" + uuid.uuid4().hex[:8]

    # -- 模型表 ----------------------------------------------------------------
    def spec_of(self, model: str) -> WorkflowSpec:
        name = str(model or "").strip()
        if not name:
            raise GatewayError("缺少 model", 400)
        spec = self.by_id.get(name)
        if spec is None:
            # 画布下拉传的是模型名；宽松匹配一次（大���小写 / 去后缀），减少"明明选到了却说没有"
            lowered = name.lower()
            for key, value in self.by_id.items():
                if key.lower() == lowered:
                    return value
            for key, value in self.by_id.items():
                if key.lower() == lowered.replace("-image", "").replace("-video", "").replace("-audio", ""):
                    return value
            raise GatewayError(f"没有名为 {name!r} 的模型；可用：{', '.join(self.by_id) or '(空)'}", 404, "model_not_found")
        return spec

    def vllm_models(self) -> List[str]:
        """把 vLLM 的模型也并进来（网关占了 8000 之后，文本下拉靠这里）。"""
        if not self.cfg.vllm_base:
            return []
        try:
            status, body = _http(
                f"{self.cfg.vllm_base}/v1/models",
                headers={"Authorization": f"Bearer {self.cfg.vllm_api_key}", "Accept": "application/json"},
                timeout=15,
            )
        except GatewayError:
            return []
        if status >= 400:
            return []
        try:
            parsed = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            return []
        items = parsed if isinstance(parsed, list) else (parsed.get("data") or [])
        out: List[str] = []
        for item in items:
            name = str((item or {}).get("id") or (item or {}).get("name") or "").strip()
            if name and name not in out:
                out.append(name)
        return out

    def models_payload(self) -> Dict[str, Any]:
        data: List[Dict[str, Any]] = []
        for spec in self.cfg.workflows:
            data.append(
                {
                    "id": spec.resolved_id,
                    "object": "model",
                    "created": int(self.started),
                    "owned_by": "comfyui-gateway",
                    # 附带能力提示，方便外部工具识别（画布忽略未知字段）
                    "capability": spec.capability,
                    "label": spec.display,
                }
            )
        for name in self.vllm_models():
            data.append({"id": name, "object": "model", "created": int(self.started), "owned_by": "vllm"})
        return {"object": "list", "data": data}

    # -- 生图核心 --------------------------------------------------------------
    def run_image(self, spec: WorkflowSpec, prompt: str, params: Dict[str, Any], refs: List[UploadedFile]) -> List[bytes]:
        size = parse_size(params.get("size"))
        seed = _as_int(params.get("seed"))
        steps = _as_int(params.get("steps"))
        cfg = _as_float(params.get("cfg"))
        negative = params.get("negative_prompt")
        count = max(1, min(15, _as_int(params.get("n")) or 1))
        want_url = str(params.get("response_format") or "b64_json").lower() == "url"
        base_url = self.public_base.rstrip("/") if self.public_base else ""

        reference_name = ""
        if refs:
            first = refs[0]
            filename = os.path.basename(first.filename or "reference.png") or "reference.png"
            reference_name = self.comfy.upload_image(filename, first.data)

        outputs: List[bytes] = []
        urls: List[str] = []
        for index in range(count):
            workflow = build_prompt(
                spec, prompt, negative, (seed + index) if seed is not None else None,
                size, steps, cfg, reference_name,
            )
            prompt_id = self.comfy.submit(workflow, f"{self.client_id}-{index}")
            entry = self.comfy.wait(prompt_id)
            files = extract_outputs(entry, spec.output_node)
            if not files:
                raise GatewayError(
                    f"ComfyUI 执行完了但没取到产物（工作流 {spec.display} 的产物节点 {spec.output_node}）。"
                    "请确认工作流末尾有 SaveImage / VHS_VideoCombine 之类的保存节点。",
                    502, "no_output",
                )
            item = files[0]
            content = self.comfy.view(item["filename"], item["subfolder"], item["type"])
            if not content:
                raise GatewayError("从 ComfyUI 取到的产物是空的", 502, "empty_output")
            if want_url:
                token = self.files.put(content, guess_mime(item["filename"]))
                urls.append(f"{base_url}/v1/files/{token}")
            else:
                outputs.append(content)
        if want_url:
            return urls  # type: ignore[return-value]
        return outputs

    def image_response(self, spec: WorkflowSpec, images: List[Any], want_url: bool) -> Dict[str, Any]:
        data: List[Dict[str, Any]] = []
        for item in images:
            if isinstance(item, str):
                data.append({"url": item})
            else:
                import base64

                data.append({"b64_json": base64.b64encode(item).decode("ascii")})
        response: Dict[str, Any] = {"created": int(time.time()), "data": data, "model": spec.resolved_id}
        if not want_url:
            response["usage"] = {"images": len(data)}
        return response

    # -- 视频任务 --------------------------------------------------------------
    def create_video_job(self, spec: WorkflowSpec, prompt: str, params: Dict[str, Any], refs: List[UploadedFile]) -> Job:
        size = parse_size(params.get("size"))
        seed = _as_int(params.get("seed"))
        reference_name = ""
        if refs:
            first = refs[0]
            filename = os.path.basename(first.filename or "reference.png") or "reference.png"
            reference_name = self.comfy.upload_image(filename, first.data)
        workflow = build_prompt(spec, prompt, params.get("negative_prompt"), seed, size, None, None, reference_name)
        prompt_id = self.comfy.submit(workflow, self.client_id)
        job = Job(id="video-" + uuid.uuid4().hex[:16], spec_id=spec.resolved_id, prompt_id=prompt_id, created=time.time())
        self.jobs.add(job)
        threading.Thread(target=self._run_job, args=(job, spec), daemon=True).start()
        return job

    def _run_job(self, job: Job, spec: WorkflowSpec) -> None:
        try:
            entry = self.comfy.wait(job.prompt_id)
            job.files = extract_outputs(entry, spec.output_node)
            if not job.files:
                raise GatewayError("ComfyUI 执行完了但没取到视频产物", 502, "no_output")
            job.status = "completed"
        except Exception as error:  # noqa: BLE001 - 任务线程里任何异常都要落成 failed，不能静默
            job.status = "failed"
            job.error = str(error)

    def video_payload(self, job: Job, spec: WorkflowSpec) -> Dict[str, Any]:
        if job.status == "failed":
            return {"id": job.id, "object": "video", "status": "failed", "error": {"message": job.error, "type": "workflow_failed"}}
        if job.status != "completed":
            return {"id": job.id, "object": "video", "status": "queued"}
        base_url = self.public_base.rstrip("/") if self.public_base else ""
        return {
            "id": job.id,
            "object": "video",
            "status": "completed",
            "created": int(job.created),
            "url": f"{base_url}/v1/videos/{job.id}/content",
        }

    # -- 文本反代 --------------------------------------------------------------
    def proxy_vllm(self, path: str, body: Optional[bytes], headers: Dict[str, str], stream: bool) -> Tuple[int, Any, Dict[str, str]]:
        url = f"{self.cfg.vllm_base}{path}"
        out_headers = {"Content-Type": headers.get("content-type") or "application/json"}
        if headers.get("authorization"):
            out_headers["Authorization"] = headers["authorization"]
        elif self.cfg.vllm_api_key:
            out_headers["Authorization"] = f"Bearer {self.cfg.vllm_api_key}"
        status, payload = _http(url, data=body, headers=out_headers, method="POST" if body else "GET", timeout=self.cfg.request_timeout)
        return (status, payload, {"Content-Type": "application/json"})


class Handler(BaseHTTPRequestHandler):
    server_version = "ComfyOpenAIGateway/1.0"
    protocol_version = "HTTP/1.1"
    gateway: Gateway = None  # type: ignore[assignment]

    # -- 基础工具 --------------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}\n")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "*")

    def _send(self, status: int, body: bytes, content_type: str = "application/json", extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _error(self, status: int, message: str, kind: str = "invalid_request_error") -> None:
        self._json(status, {"error": {"message": message, "type": kind, "code": kind}})

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _json_body(self) -> Dict[str, Any]:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8", "replace"))
        except Exception as error:
            raise GatewayError(f"请求体不是 JSON：{error}", 400) from error
        return parsed if isinstance(parsed, dict) else {}

    # -- 路由 ------------------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/healthz", "/health", "/"):
                comfy = self.gateway.comfy.health()
                self._json(
                    200 if comfy.get("ok") else 503,
                    {
                        "ok": bool(comfy.get("ok")),
                        "gateway": "comfyui-openai-gateway",
                        "uptime_seconds": int(time.time() - self.gateway.started),
                        "comfy_base": self.gateway.cfg.comfy_base,
                        "models": [spec.resolved_id for spec in self.gateway.cfg.workflows],
                        "vllm_base": self.gateway.cfg.vllm_base,
                        "vllm_reachable": bool(self.gateway.vllm_models()),
                        "comfy": comfy,
                    },
                )
                return
            if path == "/v1/models":
                self._json(200, self.gateway.models_payload())
                return
            if path.startswith("/v1/models/"):
                model = urllib.parse.unquote(path[len("/v1/models/"):])
                spec = self.gateway.by_id.get(model)
                if not spec:
                    self._error(404, f"没有名为 {model!r} 的模型", "model_not_found")
                    return
                self._json(200, {"id": spec.resolved_id, "object": "model", "owned_by": "comfyui-gateway", "capability": spec.capability})
                return
            if path.startswith("/v1/files/"):
                token = path[len("/v1/files/"):]
                item = self.gateway.files.get(token)
                if not item:
                    self._error(404, "文件已过期或不存在，请重新生成", "not_found")
                    return
                self._send(200, item[0], item[1])
                return
            if path.startswith("/v1/videos/") and path.endswith("/content"):
                self._video_content(path)
                return
            if path.startswith("/v1/videos/"):
                job_id = path[len("/v1/videos/"):]
                job = self.gateway.jobs.get(job_id)
                if not job:
                    self._error(404, f"没有名为 {job_id!r} 的视频任务", "not_found")
                    return
                spec = self.gateway.by_id.get(job.spec_id)
                self._json(200, self.gateway.video_payload(job, spec))  # type: ignore[arg-type]
                return
            if path in ("/v1/responses", "/v1/chat/completions", "/v1/embeddings", "/v1/completions"):
                self._proxy("GET", path)
                return
            self._error(404, f"未知路径 {path}", "not_found")
        except GatewayError as error:
            self._error(error.status, error.message, error.kind)
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"网关内部错误：{error}")

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/v1/images/generations", "/v1/images/edits"):
                self._images(path)
                return
            if path == "/v1/videos":
                self._create_video()
                return
            if path == "/v1/audio/speech":
                self._audio()
                return
            if path in ("/v1/responses", "/v1/chat/completions", "/v1/embeddings", "/v1/completions"):
                self._proxy("POST", path)
                return
            self._error(404, f"未知路径 {path}", "not_found")
        except GatewayError as error:
            self._error(error.status, error.message, error.kind)
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"网关内部错误：{error}")

    # -- 生图 / 图生图 ---------------------------------------------------------
    def _images(self, path: str) -> None:
        content_type = self.headers.get("Content-Type") or ""
        refs: List[UploadedFile] = []
        if path.endswith("/edits") or content_type.startswith("multipart/form-data"):
            fields = parse_multipart(self._read_body(), content_type)
            for key in ("image[]", "image", "images[]", "image_0"):
                refs.extend(fields.get(key, []))
            params = {key: (items[0].data.decode("utf-8", "replace") if items else "") for key, items in fields.items()}
            model = str(params.pop("model", "") or "")
            prompt = str(params.pop("prompt", "") or "")
            # 其余字段都是字符串形态，画布把 n/size/response_format 以字符串送来，
            # 下面统一从 fields 补齐（pop 掉的是二进制，不能当文本用）
            for key, items in fields.items():
                if key in ("model", "prompt"):
                    continue
                if items and key not in params:
                    params[key] = items[0].data.decode("utf-8", "replace")
        else:
            payload = self._json_body()
            model = str(payload.get("model") or "")
            prompt = str(payload.get("prompt") or "")
            params = payload
            # 图生图回退通路：画布把参考图以 data URL 数组放在 image / extra_body.image
            raw_refs = payload.get("image")
            if not raw_refs and isinstance(payload.get("extra_body"), dict):
                raw_refs = payload["extra_body"].get("image")
            if isinstance(raw_refs, str):
                raw_refs = [raw_refs]
            for index, item in enumerate(raw_refs or []):
                if not isinstance(item, str):
                    continue
                decoded = decode_data_url(item)
                if decoded:
                    mime, blob = decoded
                    refs.append(UploadedFile(field="image", filename=f"reference-{index}.{mime.split('/')[-1]}", content_type=mime, data=blob))

        spec = self.gateway.spec_of(model)
        if not prompt.strip():
            raise GatewayError("缺少 prompt", 400)
        want_url = str(params.get("response_format") or "b64_json").lower() == "url"
        images = self.gateway.run_image(spec, prompt, params, refs)
        self._json(200, self.gateway.image_response(spec, images, want_url))

    # -- 视频 ------------------------------------------------------------------
    def _create_video(self) -> None:
        content_type = self.headers.get("Content-Type") or ""
        refs: List[UploadedFile] = []
        if content_type.startswith("multipart/form-data"):
            fields = parse_multipart(self._read_body(), content_type)
            for key in ("image[]", "first_frame", "last_frame", "image"):
                refs.extend(fields.get(key, []))
            params: Dict[str, Any] = {}
            for key, items in fields.items():
                if key.endswith("[]") or key in ("image", "first_frame", "last_frame"):
                    continue
                if items:
                    params[key] = items[0].data.decode("utf-8", "replace")
            model = str(params.pop("model", "") or "")
            prompt = str(params.pop("prompt", "") or "")
        else:
            payload = self._json_body()
            model = str(payload.get("model") or "")
            prompt = str(payload.get("prompt") or "")
            params = payload
        spec = self.gateway.spec_of(model)
        if spec.capability != "video":
            raise GatewayError(f"模型 {spec.display} 不是视频模型（声明 {spec.capability}）", 400)
        if not prompt.strip():
            raise GatewayError("缺少 prompt", 400)
        job = self.gateway.create_video_job(spec, prompt, params, refs)
        self._json(200, {"id": job.id, "object": "video", "status": "queued", "created": int(job.created)})

    def _video_content(self, path: str) -> None:
        job_id = path[len("/v1/videos/"):-len("/content")]
        job = self.gateway.jobs.get(job_id)
        if not job:
            self._error(404, f"没有名为 {job_id!r} 的视频任务", "not_found")
            return
        if job.status == "failed":
            self._error(400, job.error, "workflow_failed")
            return
        if job.status != "completed" or not job.files:
            self._error(409, "视频还没生成完，请稍后再取", "pending")
            return
        item = job.files[0]
        content = self.gateway.comfy.view(item["filename"], item["subfolder"], item["type"])
        self._send(200, content, guess_mime(item["filename"]))

    # -- 语音 ------------------------------------------------------------------
    def _audio(self) -> None:
        payload = self._json_body()
        spec = self.gateway.spec_of(str(payload.get("model") or ""))
        if spec.capability != "audio":
            raise GatewayError(f"模型 {spec.display} 不是语音模型（声明 {spec.capability}）", 400)
        text = str(payload.get("input") or "")
        if not text.strip():
            raise GatewayError("缺少 input", 400)
        images = self.gateway.run_image(spec, text, payload, [])
        if not images:
            raise GatewayError("工作流没有产出音频", 502, "no_output")
        self._send(200, images[0], guess_mime("out.mp3"))

    # -- 文本反代 --------------------------------------------------------------
    def _proxy(self, method: str, path: str) -> None:
        if not self.gateway.cfg.vllm_base:
            self._error(503, "网关未配置 vllm_base，无法处理文本请求", "upstream_error")
            return
        body = self._read_body() if method == "POST" else None
        headers = {
            "content-type": self.headers.get("Content-Type") or "application/json",
            "authorization": self.headers.get("Authorization") or "",
        }
        status, payload, out_headers = self.gateway.proxy_vllm(path, body, headers, stream=False)
        # 上游状态码原样透传：画布靠 401/429 区分「充值 / 换渠道」，改了语义就错了
        self._send(status, payload, out_headers.get("Content-Type", "application/json"))


def serve(cfg: GatewayConfig, public_base: str = "") -> None:
    prepare_workflows(cfg)
    gateway = Gateway(cfg)
    gateway.public_base = public_base  # type: ignore[attr-defined]
    gateway.by_id = {spec.resolved_id: spec for spec in cfg.workflows}

    handler = type("BoundHandler", (Handler,), {"gateway": gateway})
    server = ThreadingHTTPServer((cfg.host, cfg.port), handler)
    server.daemon_threads = True

    def gc_loop() -> None:
        while True:
            time.sleep(300)
            try:
                gateway.files.gc()
                gateway.jobs.prune(cfg.keep_files_seconds)
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=gc_loop, daemon=True).start()

    health = gateway.comfy.health()
    print(f"[info] ComfyUI {cfg.comfy_base} {'可达' if health.get('ok') else '不可达（网关仍会启动，但生成会失败）'}")
    print(f"[info] vLLM   {cfg.vllm_base or '(未配置)'}")
    print(f"[list] 对外模型：{', '.join(gateway.by_id) or '(空)'}")
    print(f"[ready] http://{cfg.host}:{cfg.port}/v1 —— 画布渠道 baseUrl 填 http://<实例域名>:{cfg.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bye]")
        server.shutdown()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="ComfyUI → OpenAI 兼容网关")
    parser.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway.config.json"))
    parser.add_argument("--port", type=int, help="覆盖配置里的监听端口")
    parser.add_argument("--comfy-base", help="覆盖 ComfyUI 地址")
    parser.add_argument("--vllm-base", help="覆盖 vLLM 地址（留空字符串表示不反代文本）")
    parser.add_argument("--public-base", default="", help="对外可访问的根地址，用于 response_format=url 时拼绝对 URL")
    parser.add_argument("--check", action="store_true", help="只自检配置与工作流，不启动服务")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.config):
        print(f"找不到配置文件：{args.config}", file=sys.stderr)
        return 2
    try:
        cfg = load_config(args.config)
    except Exception as error:  # noqa: BLE001
        print(f"配置错误：{error}", file=sys.stderr)
        return 2
    if args.port:
        cfg.port = args.port
    if args.comfy_base:
        cfg.comfy_base = args.comfy_base.rstrip("/")
    if args.vllm_base is not None:
        cfg.vllm_base = args.vllm_base.rstrip("/")
    try:
        if args.check:
            prepare_workflows(cfg)
            print("[check] 配置与工作流自检通过")
            return 0
        serve(cfg, args.public_base)
    except Exception as error:  # noqa: BLE001
        print(f"启动失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())