"""网关端到端测试：真网关 + 假 ComfyUI + 假 vLLM。

不 mock 网关本身 —— 起真的 HTTP 服务，用 urllib 按画布的真实请求形状打过去，
断言两件画布最关心的事：
  1) `GET /v1/models` 能不能列出工作流（这决定「接入画布」探测是否成功）；
  2) `POST /v1/images/generations` 返回的形状能不能被画布 `parseImagePayload` 解析出图片。

运行：python3 tests/test_gateway_e2e.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import gateway as gw  # noqa: E402

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASSED if condition else FAILED).append(name)
    print(("  PASS  " if condition else "  FAIL  ") + name + (("  → " + detail) if detail and not condition else ""))


# --------------------------------------------------------------------------------------
# 假 ComfyUI：实现网关真正会调用的四个端点
# --------------------------------------------------------------------------------------

WORKFLOW = {
    "3": {"class_type": "KSampler", "inputs": {"seed": 0, "steps": 28, "cfg": 6.5,
          "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "x.safetensors"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "orig prompt", "clip": ["4", 1]}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "orig negative", "clip": ["4", 1]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "test", "images": ["8", 0]}},
}

STATE = {
    "prompts": {},      # prompt_id -> workflow
    "poll_counts": {},  # prompt_id -> 已轮询次数（用来验证「真的在轮询」）
    "uploads": [],      # 上传记录
    "error_prompt_id": None,
    "polls_before_done": 3,
}


class FakeComfy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def _send(self, status, body, ctype="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/system_stats":
            return self._send(200, {"system": {"os": "linux"}, "devices": [{"name": "RTX 3060"}]})
        if parsed.path.startswith("/history/"):
            prompt_id = parsed.path[len("/history/"):]
            count = STATE["poll_counts"].get(prompt_id, 0) + 1
            STATE["poll_counts"][prompt_id] = count
            if count < STATE["polls_before_done"]:
                return self._send(200, {prompt_id: {"outputs": {}, "status": {"completed": False}}})
            if prompt_id == STATE["error_prompt_id"]:
                return self._send(200, {prompt_id: {"outputs": {}, "status": {"completed": False, "messages": [
                    ["execution_error", {"node_id": "3", "exception_type": "RuntimeError",
                                        "exception_message": "CUDA out of memory"}]]}}})
            return self._send(200, {prompt_id: {"outputs": {"9": {"images": [
                {"filename": "test_00001_.png", "subfolder": "", "type": "output"}]}},
                "status": {"completed": True}}})
        if parsed.path == "/view":
            query = urllib.parse.parse_qs(parsed.query)
            return self._send(200, PNG_1PX, "image/png")
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        if self.path == "/prompt":
            payload = json.loads(raw.decode("utf-8"))
            prompt_id = uuid.uuid4().hex
            STATE["prompts"][prompt_id] = payload["prompt"]
            return self._send(200, {"prompt_id": prompt_id, "number": 1, "node_errors": {}})
        if self.path == "/upload/image":
            STATE["uploads"].append(raw)
            return self._send(200, {"name": "reference-0.png", "subfolder": "", "type": "input"})
        return self._send(404, {"error": "not found"})


class FakeVLLM(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"object": "list", "data": [
                {"id": "Qwen3-8B", "object": "model"},
                {"id": "gpt-image-2", "object": "model"},
            ]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8"))
        body = json.dumps({
            "id": "chatcmpl-1", "object": "chat.completion", "model": payload.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "透传成功"}, "finish_reason": "stop"}],
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_server(handler) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def request(url: str, method: str = "GET", body=None, headers=None, timeout=30):
    data = body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


# --------------------------------------------------------------------------------------
# 测试用例
# --------------------------------------------------------------------------------------


def write_config(tmp: str, comfy: str, vllm: str, workflows, name: str = "main") -> str:
    """每次调用写独立的子目录 + 配置文件名，避免多次调用互相覆盖（曾导致断言对象错位）。"""
    slot = os.path.join(tmp, name)
    os.makedirs(slot, exist_ok=True)
    workflow_path = os.path.join(slot, "wf.json")
    with open(workflow_path, "w", encoding="utf-8") as handle:
        json.dump(WORKFLOW, handle)
    config = {
        "host": "127.0.0.1",
        "port": 0,
        "comfy_base": comfy,
        "vllm_base": vllm,
        "vllm_api_key": "sk-test",
        "poll_interval": 0.05,
        "max_poll_seconds": 20,
        "workflows": workflows,
    }
    config_path = os.path.join(slot, "gateway.config.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False)
    return config_path


def build_gateway(config_path: str) -> gw.Gateway:
    cfg = gw.load_config(config_path)
    gw.prepare_workflows(cfg)
    gateway = gw.Gateway(cfg)
    gateway.public_base = ""
    gateway.by_id = {spec.resolved_id: spec for spec in cfg.workflows}
    return gateway


def start_gateway(gateway: gw.Gateway):
    handler = type("H", (gw.Handler,), {"gateway": gateway})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def canvas_parse(payload: bytes):
    """复刻画布 parseImagePayload 的判定（web/src/services/api/image.ts:246-279）。

    只认 b64_json / url，两者都没有就抛错 —— 网关返回格式错了这里就会红。
    """
    obj = json.loads(payload.decode("utf-8"))
    image_list = obj.get("data") or obj.get("images") or obj.get("results") or []
    out = []
    for item in image_list:
        if isinstance(item.get("b64_json"), str) and item["b64_json"]:
            out.append("data:image/png;base64," + item["b64_json"])
        elif isinstance(item.get("url"), str) and item["url"]:
            out.append(item["url"])
    if not out:
        keys = [k for k in obj if k not in ("code", "msg", "error")]
        raise AssertionError("画布解析不到图片；payload 字段=" + ",".join(keys))
    return out


def main() -> int:
    # --dump <path>：把网关的真实响应写出来，供 node 侧用画布真实源码复验
    dump_path = None
    if "--dump" in sys.argv:
        dump_path = sys.argv[sys.argv.index("--dump") + 1]

    comfy_server = start_server(FakeComfy)
    vllm_server = start_server(FakeVLLM)
    comfy = f"http://127.0.0.1:{comfy_server.server_address[1]}"
    vllm = f"http://127.0.0.1:{vllm_server.server_address[1]}"

    with tempfile.TemporaryDirectory() as tmp:
        # ============ §1 配置自检 ============
        print("\n§1 配置与工作流自检")
        cfg_path = write_config(tmp, comfy, vllm, [{
            "id": "sd15-txt2img", "capability": "image", "workflow": "wf.json",
            "mappings": {"prompt": "6.inputs.text", "negative_prompt": "7.inputs.text",
                         "seed": "3.inputs.seed", "width": "5.inputs.width",
                         "height": "5.inputs.height", "steps": "3.inputs.steps", "cfg": "3.inputs.cfg"},
            "output_node": "9",
        }])
        cfg = gw.load_config(cfg_path)
        gw.prepare_workflows(cfg)
        spec = cfg.workflows[0]
        check("显式 mappings 全部命中真实节点", set(spec.resolved_mappings) >= {"prompt", "seed", "width", "height"})
        check("产物节点推断为 SaveImage 节点 9", spec.output_node == "9")
        check("含 image 的模型名归类为 image", gw.guess_capability("sd15-txt2img-image") == "image")
        check("模型名无关键词时补后缀后可被画布识别", spec.resolved_id == "sd15-txt2img-image",
              f"实际 {spec.resolved_id}")

        # 前端画布格式（有 widgets、无 class_type）必须被拒绝
        os.makedirs(os.path.join(tmp, "bad-format"), exist_ok=True)
        with open(os.path.join(tmp, "bad-format", "bad.json"), "w", encoding="utf-8") as handle:
            json.dump({"3": {"widgets": {}, "inputs": {}}}, handle)
        try:
            bad_cfg = gw.load_config(write_config(tmp, comfy, vllm, [
                {"id": "x", "capability": "image", "workflow": "bad.json", "mappings": {"prompt": "3.inputs.text"}},
            ], name="bad-format"))
            gw.prepare_workflows(bad_cfg)
            check("前端画布格式被拒绝启动", False, "竟然通过了")
        except ValueError as error:
            check("前端画布格式被拒绝启动", "class_type" in str(error))

        # 注入点写错必须报错，不静默出坏图
        try:
            wrong = gw.load_config(write_config(tmp, comfy, vllm, [
                {"id": "y", "capability": "image", "workflow": "wf.json",
                 "mappings": {"prompt": "99.inputs.text"}},
            ], name="wrong-mapping"))
            gw.prepare_workflows(wrong)
            check("注入点不存在时拒绝启动", False, "竟然通过了")
        except ValueError as error:
            check("注入点不存在时拒绝启动", "注入点" in str(error))

        # 不写 mappings 时靠 class_type 自动推断
        auto_cfg = gw.load_config(write_config(tmp, comfy, vllm, [
            {"id": "auto", "capability": "image", "workflow": "wf.json"},
        ], name="auto"))
        gw.prepare_workflows(auto_cfg)
        auto = auto_cfg.workflows[0].resolved_mappings
        check("自动推断出 prompt 注入点", auto.get("prompt") == "6.inputs.text", str(auto))
        check("自动推断出 seed 注入点", auto.get("seed") == "3.inputs.seed", str(auto))
        check("自动推断出宽高注入点", auto.get("width") == "5.inputs.width" and auto.get("height") == "5.inputs.height", str(auto))
        check("自动推断出产物节点", auto_cfg.workflows[0].output_node == "9")

        # ============ §2 /v1/models（探测能否成功） ============
        print("\n§2 GET /v1/models（画布接入前的探测）")
        gateway = build_gateway(cfg_path)
        # 注意：server 必须一直活到 §9 结束。shutdown() 只是停 accept 循环，
        # 端口仍在 backlog 里排队 —— 之后再打这个地址会一直挂到超时。
        server, base = start_gateway(gateway)
        try:
            status, body = request(f"{base}/v1/models")
            payload = json.loads(body.decode("utf-8"))
            ids = [item["id"] for item in payload["data"]]
            check("HTTP 200", status == 200, str(status))
            check("object=list 且 data 有 id（画布探测要求）", payload.get("object") == "list" and all("id" in i for i in payload["data"]))
            check("列出 ComfyUI 工作流模型", spec.resolved_id in ids, str(ids))
            check("并入 vLLM 的文本模型（网关占了 8000，文本不能丢）", "Qwen3-8B" in ids, str(ids))
            check("并入 vLLM 的图像模型", "gpt-image-2" in ids, str(ids))
            check("comfyui 探活 OK", gateway.comfy.health().get("ok") is True)

            status, body = request(f"{base}/healthz")
            health = json.loads(body.decode("utf-8"))
            check("/healthz 报活", status == 200 and health.get("ok") is True and health.get("vllm_reachable") is True)
        except Exception as error:  # noqa: BLE001
            check("§2 探测流程", False, repr(error))

        # ============ §3 文生图（画布真实请求形状） ============
        print("\n§3 POST /v1/images/generations（文生图）")
        # 画布 image.ts:896-918 会多发这些可选字段，网关必须照单全收
        canvas_body = {
            "model": spec.resolved_id,
            "prompt": "一只在雪地里的猫",
            "n": 1,
            "size": "768x1024",
            "response_format": "b64_json",
            "output_format": "png",
            "quality": "high",
            "background": "transparent",
        }
        status, body = request(f"{base}/v1/images/generations", "POST", canvas_body,
                               {"Content-Type": "application/json", "Authorization": "Bearer x"})
        check("HTTP 200（画布多发的可选字段未导致 400）", status == 200, body.decode("utf-8", "replace")[:300])
        images = canvas_parse(body)
        check("画布能解析出 data:image/png", images[0].startswith("data:image/png;base64,"), images[0][:40])
        check("返回的 base64 能解回 PNG 字节", base64.b64decode(images[0].split(",", 1)[1]) == PNG_1PX)

        # 校验注入真的写进了工作流（而不是被忽略）
        submitted = list(STATE["prompts"].values())[-1]
        check("prompt 被写进 CLIPTextEncode", submitted["6"]["inputs"]["text"] == "一只在雪地里的猫", str(submitted["6"]["inputs"]["text"]))
        check("size 被拆成宽高", submitted["5"]["inputs"]["width"] == 768 and submitted["5"]["inputs"]["height"] == 1024,
              f'{submitted["5"]["inputs"]["width"]}x{submitted["5"]["inputs"]["height"]}')
        check("未提供 seed 时自动随机", isinstance(submitted["3"]["inputs"]["seed"], int) and submitted["3"]["inputs"]["seed"] > 0)
        check("defaults 生效（steps=28）", submitted["3"]["inputs"]["steps"] == 28)
        check("确实经过 /history 轮询后才返回", len(STATE["poll_counts"]) >= 1)

        # ============ §4 n>1 与 seed 固定 ============
        print("\n§4 多张与固定 seed")
        status, body = request(f"{base}/v1/images/generations", "POST", {"model": spec.resolved_id, "prompt": "p", "n": 3, "seed": 42},
                               {"Content-Type": "application/json"})
        payload = json.loads(body.decode("utf-8"))
        check("n=3 返回 3 张", len(payload["data"]) == 3, str(len(payload["data"])))
        submitted_list = list(STATE["prompts"].values())[-3:]
        seeds = [w["3"]["inputs"]["seed"] for w in submitted_list]
        check("n>1 时按 seed 递增避免重复图", seeds == [42, 43, 44], str(seeds))

        # ============ §5 图生图（multipart，走画布 /images/edits） ============
        print("\n§5 POST /v1/images/edits（图生图 / multipart）")
        boundary = "----t"
        ref_png = base64.b64encode(PNG_1PX).decode("ascii")
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{spec.resolved_id}\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n把它变成油画\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nb64_json\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"ref.png\"\r\nContent-Type: image/png\r\n\r\n".encode(),
            PNG_1PX,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        status, body = request(f"{base}/v1/images/edits", "POST", b"".join(parts),
                               {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        check("图生图 HTTP 200", status == 200, body.decode("utf-8", "replace")[:300])
        check("图生图返回可解析图片", canvas_parse(body)[0].startswith("data:image/png;base64,"))
        check("参考图已上传到 ComfyUI /upload/image", len(STATE["uploads"]) >= 1)

        # ============ §6 图生图回退通路（画布 404 后改走 generations 带 data URL） ============
        print("\n§6 generations 带 data URL（画布 requestEditViaGenerations 回退形状）")
        payload = {"model": spec.resolved_id, "prompt": "换背景", "n": 1,
                   "response_format": "b64_json", "output_format": "png",
                   "image": ["data:image/png;base64," + ref_png]}
        status, body = request(f"{base}/v1/images/generations", "POST", payload, {"Content-Type": "application/json"})
        check("回退通路 HTTP 200", status == 200, body.decode("utf-8", "replace")[:300])
        check("回退通路返回可解析图片", canvas_parse(body)[0].startswith("data:image/png;base64,"))

        payload2 = {"model": spec.resolved_id, "prompt": "x", "extra_body": {"image": ["data:image/png;base64," + ref_png]}}
        status, body = request(f"{base}/v1/images/generations", "POST", payload2, {"Content-Type": "application/json"})
        check("extra_body.image 形状也支持", status == 200 and canvas_parse(body), body.decode("utf-8", "replace")[:200])

        # ============ §7 response_format=url ============
        print("\n§7 response_format=url")
        status, body = request(f"{base}/v1/images/generations", "POST",
                               {"model": spec.resolved_id, "prompt": "p", "response_format": "url"},
                               {"Content-Type": "application/json"})
        payload = json.loads(body.decode("utf-8"))
        check("url 形态返回 url 字段", bool(payload["data"][0].get("url")), json.dumps(payload)[:200])
        token = payload["data"][0]["url"].rsplit("/", 1)[-1]
        status, raw = request(f"{base}/v1/files/{token}")
        check("url 可下载且字节一致", status == 200 and raw == PNG_1PX, str(status))

        # 把真实响应 dump 出去，供 tests/verify-with-canvas-source.mjs
        # 用**画布真实源码** parseImagePayload 复验（而不是本文件复刻的版本）
        if dump_path:
            _, txt2img_body = request(f"{base}/v1/images/generations", "POST",
                                      {"model": spec.resolved_id, "prompt": "p", "n": 1,
                                       "response_format": "b64_json", "output_format": "png"},
                                      {"Content-Type": "application/json"})
            _, multi_body = request(f"{base}/v1/images/generations", "POST",
                                    {"model": spec.resolved_id, "prompt": "p", "n": 2},
                                    {"Content-Type": "application/json"})
            _, edit_body = request(f"{base}/v1/images/edits", "POST", b"".join([
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{spec.resolved_id}\r\n".encode(),
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n油画\r\n".encode(),
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"r.png\"\r\nContent-Type: image/png\r\n\r\n".encode(),
                PNG_1PX, f"\r\n--{boundary}--\r\n".encode(),
            ]), {"Content-Type": f"multipart/form-data; boundary={boundary}"})
            with open(dump_path, "w", encoding="utf-8") as handle:
                json.dump([
                    {"label": "文生图 b64_json", "payload": json.loads(txt2img_body.decode("utf-8"))},
                    {"label": "多张 n=2", "payload": json.loads(multi_body.decode("utf-8"))},
                    {"label": "图生图 edits", "payload": json.loads(edit_body.decode("utf-8"))},
                ], handle, ensure_ascii=False)
            print(f"\n[dump] 真实响应已写入 {dump_path}")

        # ============ §8 错误处理 ============
        print("\n§8 错误处理")
        status, body = request(f"{base}/v1/images/generations", "POST", {"model": "不存在的模型", "prompt": "p"},
                               {"Content-Type": "application/json"})
        check("未知模型返回 404 + OpenAI 错误体",
              status == 404 and json.loads(body)["error"]["message"], body.decode("utf-8", "replace")[:200])

        status, body = request(f"{base}/v1/images/generations", "POST", {"model": spec.resolved_id},
                               {"Content-Type": "application/json"})
        check("缺 prompt 返回 400", status == 400, str(status))

        # ComfyUI 执行出错时，把节点/异常原文带回（画布会把它显示成节点错误）
        STATE["error_prompt_id"] = "boom"
        STATE["polls_before_done"] = 1
        STATE["poll_counts"].pop("boom", None)
        STATE["prompts"]["boom"] = WORKFLOW
        try:
            gateway.comfy.wait("boom")
            check("ComfyUI 报错时把节点原文抛给画布", False, "竟然没抛错")
        except gw.GatewayError as error:
            check("ComfyUI 报错时把节点原文抛给画布",
                  "CUDA out of memory" in error.message and "节点 3" in error.message, error.message)

        # ============ §9 文本反代 ============
        print("\n§9 文本反代（网关占 8000 后文本仍可用）")
        status, body = request(f"{base}/v1/chat/completions", "POST", {"model": "Qwen3-8B", "messages": []},
                               {"Content-Type": "application/json", "Authorization": "Bearer sk-test"})
        check("chat/completions 透传成功", status == 200 and json.loads(body)["choices"][0]["message"]["content"] == "透传成功",
              body.decode("utf-8", "replace")[:200])

        # ============ §10 画布 keyword 口径一致性 ============
        print("\n§10 与画布关键词表逐条对齐")
        pairs = [
            ("wan-video", "video"), ("sora-2", "video"), ("kling-video", "video"),
            ("gpt-image-2", "image"), ("flux-dev", "image"), ("sdxl-base", "image"),
            ("tts-voice", "audio"), ("cosyvoice-model", "audio"),
            ("qwen2.5-7b", "text"), ("MiniMax-H3", "text"),
            ("sd-turbo", "text"), ("hunyuan3d", "text"),
        ]
        for name, expected in pairs:
            actual = gw.guess_capability(name)
            check(f"guessCapability({name}) == {expected}", actual == expected, f"实际 {actual}")

        server.shutdown()
        server.server_close()

    comfy_server.shutdown()
    vllm_server.shutdown()

    print("\n" + "=" * 62)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        for name in FAILED:
            print("  FAILED: " + name)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())