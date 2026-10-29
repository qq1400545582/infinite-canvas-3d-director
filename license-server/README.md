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

仓库里已带 `app.yaml`（owner `1400545582`，卷挂 `/data`）。机密走平台 secret，不进仓库：

```bash
cd license-server
cat > .wasmer.env <<'EOF'      # 这个文件已在 .gitignore，别提交
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
wasmer app secret create --from-file=.wasmer.env  # 写进平台，之后可在控制台改
wasmer deploy --non-interactive --build-remote --publish-package
```

部署完拿到 `https://infinite-canvas-license.wasmer.app`，用 `GET /api/health` 自检。
换自定义域名：DNS 加 CNAME → 取消 `app.yaml` 里 `domains:` 的注释 → 同步改 `LICENSE_PUBLIC_URL` → redeploy。

**上 Wasmer 前必须知道的四条**

1. **出站 SMTP 需要实测**：本服务用原始 TCP 连 `smtp.qq.com:465`。Wasmer 是否放行 465/587 出站
   我还没在本机验过（需要 token 才能起实例）。若不通，三条退路：① `enable_email: true` 用平台 sendmail
   （要付费套餐，发件域名由 wasmer 分配，进收件箱率不如自己的邮箱）；② 换 HTTP 邮件 API
   （阿里云邮件推送 / Resend 等，需要在 `mailer.js` 加一个传输分支）；③ 部署到自己的 VPS。
2. **卷是区域性的**，且官方写明"不适合强一致的数据库"。本服务是 JSON 全量落盘，
   若平台起了多个实例，并发写会互相覆盖（丢注册/丢订单）。部署后先看控制台实例数，多实例就要
   换 Postgres（`capabilities.database`）或迁到单实例 VPS。
3. **卷改名/删除 = 数据立刻清空**，`app.yaml` 里 `license-data` 这个名字别动。
4. **`notify_url` 必须公网可达**：先用浏览器或 curl 打一次
   `https://<域名>/api/pay/notify` 确认码支付服务器能访问（不要求返回 success，能连上就行）。

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
