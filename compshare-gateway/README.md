# ComfyUI → OpenAI 兼容网关

让**无限画布零改动**调用 GPU 实例上的 ComfyUI。跑在实例里，画布侧不需要改任何代码。

```
画布 ──OpenAI 协议──▶ 网关 :8000 ──ComfyUI 协议──▶ ComfyUI :6006
                      └──文本/其它 ──▶ vLLM :8002（反代，画布无感）
```

## 为什么需要它

画布所有媒体请求都走同一个形状（`web/src/services/api/*.ts`）：

| 用途 | 画布请求 |
|---|---|
| 探测能不能用 | `GET /v1/models` |
| 文生图 | `POST /v1/images/generations` |
| 图生图 | `POST /v1/images/edits`（multipart），404 时回退 `generations` 带 `image` |
| 视频 | `POST /v1/videos` → `GET /v1/videos/{id}` → `GET /v1/videos/{id}/content` |
| 语音 | `POST /v1/audio/speech` |
| 文本 | `POST /v1/responses` / `/v1/chat/completions` |

而 ComfyUI **不是** OpenAI 协议：它只有 `POST /prompt`（提交图结构）、
`GET /history/{prompt_id}`（轮询）、`GET /view`（取图）。直接把 6006 填成画布渠道地址
必然失败——探测阶段就 404。

本网关就是这层翻译：`/v1/images/generations` → 填工作流 → `/prompt` →
轮询 `/history` → `/view` → 按 OpenAI 形状返回 `{created, data:[{b64_json}]}`。

## 关键设计（都是对着画布源码核过的，不是猜的）

1. **模型名必须能被画布 `guessCapability` 正确归类**，否则图像模型会落进「文本」下拉。
   画布的关键词表（`web/src/stores/use-config-store.ts`）：

   ```
   VIDEO = video sora veo kling wan hailuo
   AUDIO = audio tts speech voice music sound
   IMAGE = seedream gpt-image image dall-e dalle imagen flux sdxl stable-diffusion midjourney
   判定顺序：video → audio → image → 其余 text
   ```

   网关启动时用**同一张表**自检每个模型 id；归类不符就自动追加 `-image` / `-video` /
   `-audio` 后缀并打日志。所以叫 `sd15-txt2img` 也能出现在图像下拉里，叫
   `flux-video` 会按视频归类。想名字好看就把 `id` 改成含对应关键词的。

2. **画布会多发几个 OpenAI 之外的可选字段**：`output_format`、`response_format`、
   `quality`、`background`。网关照单全收不报错（画布侧 `withImageFieldFallback`
   遇到 400 会剔字段重试，能兜住，但白白多一次往返）。

3. **n > 1 用串行多跑 + seed 递增**实现，不改 `batch_size`：各家工作流的 batch 节点
   位置不一，猜错会静默出图数量不对。

4. **`/v1/images/edits` 真的实现了**（不靠 404 让画布回退）：图生图要先
   `POST /upload/image` 把参考图传给 ComfyUI，再把返回文件名填进 LoadImage 节点。

5. **文本反代**：网关占 8000 后 vLLM 必须在别的端口（默认反代 `127.0.0.1:8002`），
   `/v1/models` 会把 vLLM 模型并进来，文本下拉不受影响。

6. **只用标准库**（`http.server` / `urllib` / `json` / `re`）。实例里 pip 装
   fastapi/uvicorn 可能没外网或版本冲突，`python3 gateway.py` 就能跑。ComfyUI 本身
   就是 Python 环境，解释器一定在。

## 部署

### 1. 上传

把整个 `compshare-gateway/` 目录传到实例，例如 `/root/compshare-gateway/`。
画布里已有实例文件管理（SFTP，`/agent/compshare/sftp/*`）可以用。

### 2. 准备工作流

在 ComfyUI 里配好你的图生图/图生图工作流，点 **Save (API Format)** 导出 JSON，
放进 `workflows/`。

> 必须用 **API Format**，不能是前端画布格式。判据：API 格式每个节点都有
> `class_type`；前端格式是 `widgets`/`inputs`。网关启动时会检查，错了直接拒绝启动。

### 3. 写配置

```bash
cp gateway.config.example.json gateway.config.json
vi gateway.config.json
```

最关键的两个字段：

| 字段 | 说明 |
|---|---|
| `port` | 网关监听端口。**想让画布「接入画布」一键按钮生效就填 8000**（画布探测固定打 8000），此时 `vllm_base` 要指向 vLLM 实际端口 |
| `vllm_base` | vLLM 地址，如 `http://127.0.0.1:8002`。留 `""` 表示不反代文本 |

只想手动加渠道（偏好设置 → 渠道 → 新建，baseUrl 填 `https://8000-<实例ID>.pod.compshare.cn`）
的话，`port` 可以用任意空闲端口，比如 8188，不影响 ComfyUI 自己的 6006。

每个工作流条目：

```json
{
  "id": "sd15-txt2img",          // 模型名（画布下拉里显示的就是它）
  "capability": "image",         // image / video / audio / text
  "workflow": "workflows/xxx.json",
  "mappings": {                  // 注入点：<节点号>.inputs.<字段>
    "prompt": "6.inputs.text",
    "negative_prompt": "7.inputs.text",
    "seed": "3.inputs.seed",
    "width": "5.inputs.width",
    "height": "5.inputs.height",
    "steps": "3.inputs.steps",
    "cfg": "3.inputs.cfg"
  },
  "output_node": "9",            // 产物节点（SaveImage / VHS_VideoCombine …）
  "defaults": { "steps": 28, "cfg": 6.5 }
}
```

`mappings` **可以只写 `prompt`**，其余按 `class_type` 自动推断（CLIPTextEncode →
提示词、EmptyLatentImage → 宽高、KSampler → seed/steps/cfg）。猜错时日志会提示，
再手写覆盖即可。

### 4. 自检（先做这步，别跳过）

```bash
python3 gateway.py --check
```

会打印每个模型的最终 id、能力、产物节点、注入点；有硬伤（工作流格式错、注入点不存在、
找不到提示词节点）直接非零退出，不会让你等到出图才发现。

### 5. 启动

```bash
python3 gateway.py --config gateway.config.json
# 对外可访问地址（response_format=url 时拼绝对 URL 用）
python3 gateway.py --public-base https://8000-<实例ID>.pod.compshare.cn
```

后台常驻：

```bash
nohup python3 gateway.py > /root/comfy-gateway.log 2>&1 &
```

或用 `install.sh` 生成 systemd 服务。

### 6. 在画布里接入

- **一键**：实例卡片点「接入画布」。前提是网关占着 8000 且 `/v1/models` 能列出工作流。
  探测会自动把 ComfyUI 模型按能力写进渠道，两个下拉立刻能选。
- **手动**：偏好设置 → 渠道 → 新建，baseUrl 填 `https://8000-<实例ID>.pod.compshare.cn`，
  apiKey 随便填非空（画布要求非空才允许发请求），模型名填网关 `/v1/models` 里的 id。

⚠️ 跨域：实例地址是别的域名，浏览器/桌面壳直连会被 CORS 拦。**必须同时开本地代理**
（偏好设置 → 本地代理 Tab，装 `npx @basketikun/canvas-proxy@latest` 并打开开关），
画布会用 `http://127.0.0.1:23210/` 前缀转发。

## 自检接口

```bash
curl http://127.0.0.1:8000/healthz
```

返回 ComfyUI / vLLM 是否可达、对外模型列表。ComfyUI 没起来时返回 503。

```bash
curl http://127.0.0.1:8000/v1/models
```

## 测试

```bash
python3 tests/test_gateway_e2e.py            # 51 项：真网关 + 假 ComfyUI + 假 vLLM
python3 tests/test_gateway_e2e.py --dump /tmp/dump.json
node tests/verify-with-canvas-source.mjs /tmp/dump.json   # 用画布真实 parseImagePayload 复验
node tests/verify-url.mjs                                # 用画布真实 buildApiUrl 查 /v1/v1
```

## 已知边界

- 只认 OpenAI 兼容的用法。ComfyUI 原生的 websocket 实时预览协议没实现。
- 视频/语音端点已实现，但依赖工作流里有对应产物节点
  （`VHS_VideoCombine` / `SaveAudio`），没有就会报「没取到产物」。
- 产物托管在内存，`keep_files_seconds`（默认 3600s）后过期；重启即失效。
  `response_format=b64_json`（画布默认）不受影响。
- 视频任务表只在内存，重启后轮询中的任务会 404。