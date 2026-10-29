# infinite-canvas license-server

无限画布的账号与授权服务：邮箱注册登录、注册赠送免费试用、易支付下单与异步通知、运营后台 API。

前端（网页版 / 桌面壳）通过 `license_api` 指向本服务；服务端负责所有**不可信**的判断——试用是否过期、订单是否真的付款成功、后台配置——因此无法靠改前端绕过。

## 前端接线

前端默认**不启用**授权体系（没有服务地址时直接放行），这样开源自建的用户不会被锁在门外。三种接法任选：

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 构建期 | `VITE_LICENSE_API=https://license.example.com VITE_LICENSE_REQUIRED=1 npm run build` | 正式发行，用户无法绕过 |
| 运行期地址 | 打开 `https://你的站点/?license_api=https://license.example.com` 一次 | 自建用户、临时联调 |
| 站内填写 | 登录页底部「服务地址」折叠区 | 桌面端/离线包 |

`VITE_LICENSE_REQUIRED=1` 同时会让「没配地址」也强制走登录页（显示配置引导），不放行。

**能力边界（务必知情）**：构建期写死地址后，用户清 localStorage 并不能绕过；但授权判断毕竟发生在客户端，懂行的人仍可把 `license_api` 指向自建服务伪造「已开通」。要彻底封死需要客户端内置验签公钥、由本地进程校验授权凭据 —— 本版本未做，请按「防君子不防极客」评估风险。


## 为什么必须要有服务端

充值/试用状态如果只存在浏览器里，任何人清一次 localStorage 或改一行 JS 就能"永久免费"。所以：

| 判断 | 位置 |
| --- | --- |
| 账号、密码、试用截止时间 | 本服务（`data/db.json`） |
| 订单是否支付成功 | 本服务（接收易支付 `notify`，验签 + 校验金额） |
| 套餐、免费天数、收费开关、白名单域名、商户号 | 本服务（后台 API） |
| 界面展示与拦截 | 前端，仅作体验，**不作为授权依据** |

## 快速启动

```bash
cd license-server
cp .env.example .env      # 修改后台口令、SMTP、PUBLIC_URL
node src/index.js         # 零依赖，Node >= 20
```

启动后：

- 服务地址 `http://127.0.0.1:8787`
- 健康检查 `GET /api/health`
- 后台页面在**主应用**里：`http://127.0.0.1:3000/admin`（口令即 `LICENSE_ADMIN_PASSWORD`）

## 部署

### Docker

```bash
docker build -t infinite-canvas-license .
docker run -d --name license \
  -p 8787:8787 \
  -v /opt/license-data:/app/data \
  --env-file .env \
  infinite-canvas-license
```

### Wasmer Edge（`*.wasmer.app`）

线上实例：**https://infinite-canvas-license.wasmer.app**（2026-10-29 部署并实测通过）。

仓库里带两份清单：

- `app.yaml` —— 入库的**无机密模板**（owner `1400545582`、卷挂 `/data`）。
- `.wasmer.env` —— 你本机的机密（已 gitignore），格式见下。

```bash
cd license-server
cat > .wasmer.env <<'EOF'      # 已在 .gitignore，别提交
LICENSE_ADMIN_PASSWORD=换成强口令
LICENSE_SECRET=随机长字符串
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=your@qq.com
SMTP_PASS=授权码
SMTP_FROM=your@qq.com
SMTP_FROM_NAME=无限画布
EOF

wasmer login                                     # 或 WASMER_TOKEN=xxx
node scripts/wasmer-deploy.mjs                   # 见下方说明，别直接用 wasmer deploy
```

**为什么要多这一层脚本**（都是实测踩出来的，不是洁癖）：

1. `wasmer app secret create` 在 CLI 7.4.2 上对这个 app 恒定报 `app not found`
   （`wasmer app info` 正常，只有 secret 子命令的查询失败），平台的 secret 通道走不通。
2. `wasmer deploy --env-file` 只把变量喂给**构建阶段**，不会写进运行期的
   `wasi.env_vars` —— 部署完 `GET /api/settings` 里 `requireEmailCode` 仍是 false，
   等于收不到验证码。
3. anybuild 固定读**源目录**里的 `app.yaml`，`--path app.local.yaml` 会被忽略
   （日志里那句 `Using original app.yaml found in source directory`）。

所以 `scripts/wasmer-deploy.mjs` 做的事是：把 `src/` + `package.json` + 注入过机密的
`app.yaml` 拷到系统临时目录，再 `wasmer deploy --dir <临时目录>`。仓库里的 `app.yaml`
永远是干净模板，机密只存在于 `.wasmer.env` 和平台侧的版本配置里。

部署完的验收顺序：`GET /api/health` → 后台登录 → 运营设置里点「邮件自检」→ 用真邮箱注册一次。

换自定义域名：DNS 加 CNAME → 取消 `app.yaml` 里 `domains:` 的注释 → 同步改
`LICENSE_PUBLIC_URL`（`promptPayUrl` 的 `notify_url` 由它拼出来）→ 重新部署。

**上 Wasmer 已经验过 / 还没解决的**

| 项 | 结论 |
|---|---|
| 出站 SMTP（`smtp.qq.com:465` 原始 TCP + TLS） | ✅ 实测通，一次发信约 3.2–3.9 s |
| 持久化（`/data/db.json` 跨重启、跨重新部署） | ✅ 用户在多次 redeploy 后仍在 |
| 运行期环境变量 | ⚠️ 只能靠 `app.yaml` 的 `env:`，见上面第 2 点 |
| 多实例并发写 | ⚠️ **仍未解决**。JSON 全量落盘，两个实例同时注册会互相覆盖。当前 `load()` 每次请求都按 mtime 重读磁盘，能消除"读到旧数据"，但消不掉"同时写"。别给这个 app 开多实例；真上量就换 Postgres 或单实例 VPS |
| `notify_url` 公网可达 | ⚠️ 未经码支付侧验证。上线前用 curl 打一次 `/api/pay/notify` 确认外部能连 |
| 国内访问速度 | ⚠️ 本机实测 TLS 握手 ~0.37 s、整请求 ~0.75 s，可用但不算快；国内各地实际体感需自测 |

运行时是 `wasmer/edgejs-quickjs@0.2.5`（Edge.js + QuickJS 沙箱），`node:fs` / `node:net` /
`node:tls` / `node:crypto` 都能用，scrypt 会比原生慢一些（注册接口 ~0.25 s）。

### 宝塔 / 裸机

```bash
node src/index.js            # 用 systemd / pm2 守护
```

Nginx 反代要点：

- **必须**把 `/api/pay/notify` 原样透传给本服务（易支付服务器直接访问，不能有登录或鉴权拦截）
- `LICENSE_PUBLIC_URL` 填写对外 https 域名，`notify_url` 由它拼出来
- 前端站点与授权服务不同域时，`LICENSE_ALLOWED_ORIGINS` 填前端域名（或保持 `*`）

## 易支付配置

后台「支付设置」填 4 项：网关地址（默认 `https://api-pc.nandiu.com/xpay/epay/submit.php`）、商户 PID、商户密钥、支付方式（`alipay` / `wxpay`）。

签名实现与官方文档一致（`src/epay.js`）：

1. 去掉 `sign`、`sign_type` 与空值
2. 参数名 ASCII 升序，拼成 `a=b&c=d`
3. 末尾直接接商户密钥，取 MD5 小写

异步通知校验：验签 → `trade_status === TRADE_SUCCESS` → 金额与订单一致 → 幂等置为已支付并按套餐天数续期 → 返回纯文本 `success`。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/settings` | 公开配置（白名单域名、试用天数、在用套餐） |
| POST | `/api/auth/send-code` | 发送注册验证码 `{email}` |
| POST | `/api/auth/register` | 注册 `{email,password,code}` |
| POST | `/api/auth/login` | 登录 `{email,password}` |
| GET | `/api/auth/me` | 当前账号与授权状态（Bearer） |
| POST | `/api/pay/create` | 创建订单 `{planId}` → `{payUrl}`（Bearer） |
| GET | `/api/pay/order/:outTradeNo` | 查询订单状态（Bearer） |
| GET/POST | `/api/pay/notify` | 易支付异步通知（验签） |
| GET | `/api/pay/return` | 支付完成跳回前端购买页 |
| POST | `/api/admin/login` | 后台口令登录 |
| GET/PUT | `/api/admin/settings` | 读/写运营设置 |
| GET/POST/PUT/DELETE | `/api/admin/plans` | 套餐增删改查 |
| GET | `/api/admin/users` | 用户列表（`?q=` 搜索） |
| POST | `/api/admin/users/:id/action` | `activate` / `disable` / `enable` / `reset-trial` |
| GET | `/api/admin/orders` | 订单列表（`?status=paid`） |
| POST | `/api/admin/orders/:outTradeNo/paid` | 手动补单 |

## 安全要点

- 密码用 scrypt 加盐存储；令牌是 HMAC-SHA256 签名，带过期时间
- 验证码 10 分钟有效、同邮箱 60 秒一条、最多试错 5 次
- 发码 / 注册 / 登录 / 后台登录都有按 IP 的限流
- 后台密钥字段只回显掩码，不会泄露到前端
- `data/` 目录含用户与订单，**已加入 .gitignore**，备份请自行处理

## 环境变量

见 `.env.example`。三个最常改的：

| 变量 | 说明 |
| --- | --- |
| `LICENSE_PUBLIC_URL` | 对外地址，拼 `notify_url` 用，部署到域名后必填 |
| `LICENSE_ADMIN_PASSWORD` | 后台口令，不填默认 `admin123` |
| `SMTP_*` | 发信用，QQ 邮箱填授权码；未配置时验证码注册不可用（可用 `LICENSE_DEV_ECHO_CODE=1` 本地调试） |
