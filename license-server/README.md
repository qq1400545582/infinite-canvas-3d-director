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
- **运营后台 `http://127.0.0.1:8787/admin`**（口令即 `LICENSE_ADMIN_PASSWORD`）
- 根路径 `/` 是**主应用首页**：部署目录里有 `public/` 时直接托管前端产物，没有时给落地页
  （或跳转到后台配的「站点地址」），**不会再把根路径导回后台**。本地想让 `/` 也是主应用：
  `LICENSE_WEB_DIR=../web/dist node src/index.js`

## 同一域名下的两个入口

| 路径 | 内容 |
| --- | --- |
| `/`、`/login`、`/purchase`、其他前端路由 | 主应用（`web/dist`，SPA 回退到 `index.html`） |
| `/admin` | 运营后台（`src/admin.html`，单页，零依赖） |
| `/api/*` | JSON 接口（账号、授权、支付、后台） |

部署脚本会把 `web/dist` 一起拷进部署目录的 `public/`（`--no-web` 可以只更新后台接口，
部署体积从 76 MB 降到几百 KB）。静态资源里 `/assets/*` 带 hash，按
`max-age=31536000, immutable` 长缓存；`index.html`、`config.js`、插件清单走 `no-cache` + ETag。

## 前后端分离：后台不再在主应用里

| 角色 | 部署位置 | 内容 |
| --- | --- | --- |
| 用户端 | 同一域名的 `/`（也可用静态站 / 桌面壳） | 只有登录、注册、购买、以及画布本身；**不再包含任何后台页面或后台请求** |
| 运营后台 | 同一域名的 `/admin` | 单文件 HTML，零依赖，随 `src/` 一起部署 |

这样做的原因：后台改一次配置不必重新构建整个前端；后台代码不会被打进公开的
JS 产物（以前 `web/dist` 里能搜到 `/api/admin/...` 和后台入口链接）；想进一步隔离
就给后台单独绑一个域名（Nginx 反代到同一服务，只放行 `/admin` 与 `/api/admin/*`）。

后台页面（`src/admin.html`）的七个页签与对应能力：

| 页签 | 能改什么 | 落库位置 |
| --- | --- | --- |
| 概览 | 只读：用户/订单/收入/发信与支付是否就绪 | — |
| 发信配置 | SMTP 服务器、端口、SSL/STARTTLS、账号、授权码、发件人、邮件自检 | `settings.smtp` |
| 支付配置 | 易支付网关、pid、密钥、**支付方式多选**（可同时开支付宝/微信/云闪付/QQ 钱包/网银/京东/PayPal，也支持自定义代码）、**支付呈现方式**（页内二维码 / 收银台跳转）、网站名、客服邮箱 | `settings.epay` |
| 会员权限 | 收费开关、免费试用天数、是否开放注册、是否强制邮箱验证码、站点地址、购买页公告、注册邮箱域名白名单、会员权益清单 | `settings.*` |
| 会员套餐 | 套餐名称/时长/价格/划线价/角标/说明/排序/上下架/删除 | `plans[]` |
| 用户管理 | **添加用户**（邮箱+密码+直接开通天数，创建后即可登录）、开通 N 天、精确改到期日、重置密码、重置试用、启用/禁用、备注 | `users[]` |
| 订单 | 按状态筛选、手动标记已支付（线下转账补单） | `orders[]` |

**添加用户与关闭注册配套**：把「开放自助注册」关掉后，注册接口返回 403，但已有账号照常
登录；新客户由管理员在「用户管理 → 添加用户」里开号，创建成功后会显示一次初始密码
（带复制按钮），把这串发给客户即可。

**支付方式可以同时开多个**：用户端购买页会出现支付方式选择，用户自己挑。代码由支付平台
定义，标准码支付为 `alipay` / `wxpay` / `qqpay` / `bank` / `jdpay` / `paypal`；云闪付在部分
平台写作 `unionpay`、部分归到 `bank`，按平台实际支持的填。平台不认的代码下单会失败并
降级到收银台，不会让用户卡住。

**页内二维码**（默认）：下单走 `mapi.php`（由网关地址自动推导），平台返回二维码内容后由
服务端生成 SVG，用户在自己的购买页扫码付款，全程不离开本站。平台偶尔不给二维码（例如
某些渠道只给跳转链接），这时自动退回收银台，弹窗里给出「前往支付」按钮并显示提示。
二维码编码器在 `src/qr.js`，零依赖，覆盖版本 1–40 与四档纠错等级（已用 jsQR 逐条解码验证）。

**SMTP 现在由后台管理**：只要在后台保存过一次，`settings.smtp` 就优先于环境变量
（`GET /api/admin/settings` 的 `mail.source` 会标 `db` / `env` / `none`）。好处是不会
因为改个授权码就要重新部署；回退办法是把「发信服务器」清空并保存，就会重新读环境变量。
「邮件自检」支持**先试发、后保存**——用表单当前值发一封，收到再点保存，避免把配置存坏
之后验证码彻底发不出去（那种情况只能去服务器上改文件）。

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

所以 `scripts/wasmer-deploy.mjs` 做的事是：把 `src/` + `package.json` + `../web/dist`（→ `public/`）
+ 注入过机密的 `app.yaml` 拷到系统临时目录，再 `wasmer deploy --dir <临时目录>`。仓库里的 `app.yaml`
永远是干净模板，机密只存在于 `.wasmer.env` 和平台侧的版本配置里。

前端产物是构建出来的，不进仓库，所以每次部署前请先构建：

```bash
cd ../web && VITE_LICENSE_API=https://<授权服务域名> VITE_LICENSE_REQUIRED=1 npx vite build
cd ../license-server && node scripts/wasmer-deploy.mjs            # 带前端（76 MB，慢）
node scripts/wasmer-deploy.mjs --no-web                            # 只更后台/接口（几百 KB，快）
node scripts/wasmer-deploy.mjs --web D:/other/dist                 # 指定别的产物目录
```

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

后台「支付配置」填：网关地址（默认 `https://api-pc.nandiu.com/xpay/epay/submit.php`）、商户 PID、商户密钥、支付方式（可多选）、呈现方式（页内二维码 / 收银台跳转）。

两种下单接口（同一个网关目录）：

| 模式 | 端点 | 返回 | 用在哪 |
| --- | --- | --- | --- |
| API（页内二维码） | `mapi.php` | JSON：`qrcode` / `payurl` / `urlscheme` 三选一 | 默认。服务端把二维码画成本地 SVG |
| 页面跳转 | `submit.php` | 收银台页面 | 平台拿不出二维码时的兜底 |

签名实现与官方文档一致（`src/epay.js`）：

1. 去掉 `sign`、`sign_type` 与空值
2. 参数名 ASCII 升序，拼成 `a=b&c=d`
3. 末尾直接接商户密钥，取 MD5 小写

异步通知校验：验签 → `trade_status === TRADE_SUCCESS` → 金额与订单一致 → 幂等置为已支付并按套餐天数续期 → 返回纯文本 `success`。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` `/*` | 主应用（`public/` 静态产物，SPA 回退；无产物时跳「站点地址」或给落地页） |
| GET | `/admin` | 运营后台（服务端自带单页，无构建步骤） |
| GET | `/api/health` | 健康检查 |
| GET | `/api/settings` | 公开配置（白名单域名、试用天数、是否开放注册、会员权益、在用套餐） |
| POST | `/api/auth/send-code` | 发送注册验证码 `{email}` |
| POST | `/api/auth/register` | 注册 `{email,password,code}` |
| POST | `/api/auth/login` | 登录 `{email,password}` |
| GET | `/api/auth/me` | 当前账号与授权状态（Bearer） |
| POST | `/api/pay/create` | 创建订单 `{planId, type?}` → `{mode, qrSvg, qrContent, payUrl, notice}`（Bearer） |
| GET | `/api/pay/order/:outTradeNo` | 查询订单状态（Bearer） |
| GET/POST | `/api/pay/notify` | 易支付异步通知（验签） |
| GET | `/api/pay/return` | 支付完成跳回前端购买页 |
| POST | `/api/admin/login` | 后台口令登录 |
| GET/PUT | `/api/admin/settings` | 读/写运营设置（含 `smtp`、`epay`、会员权限） |
| POST | `/api/admin/test-mail` | 邮件自检 `{to, smtp?}`；`smtp` 传表单当前值可先测后存 |
| GET/POST/PUT/DELETE | `/api/admin/plans` | 套餐增删改查 |
| GET | `/api/admin/users` | 用户列表（`?q=` 搜索） |
| POST | `/api/admin/users` | **添加用户** `{email,password,days,trialDays,note}` → 含一次性 `credentials` |
| POST | `/api/admin/users/:id/action` | `activate` / `set-expiry` / `set-password` / `reset-trial` / `disable` / `enable` / `note` |
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
| `LICENSE_ADMIN_PASSWORD` | 后台口令，不填默认 `admin123`（启动日志会告警，后台首页也会标红） |
| `SMTP_*` | 发信参数**初始值**；后台「发信配置」保存一次后就以数据库为准（可不再改环境变量） |
