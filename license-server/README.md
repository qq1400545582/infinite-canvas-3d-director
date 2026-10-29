# infinite-canvas license-server

无限画布的账号与授权服务：邮箱注册登录、注册赠送免费试用、易支付下单与异步通知、运营后台 API。

前端（网页版 / 桌面壳）通过 `license_api` 指向本服务；服务端负责所有**不可信**的判断——试用是否过期、订单是否真的付款成功、后台配置——因此无法靠改前端绕过。

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
