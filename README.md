# netdisk-transfer

网盘文件转存工具，支持将分享链接中的文件自动转存到自己的网盘并生成新的分享链接。

## 支持平台

| 平台 | 认证方式 | 转存 | 生成分享链接 |
|------|---------|------|-------------|
| 夸克网盘 | Cookie | ✅ | ✅ |
| 百度网盘 | Cookie | ✅ | ✅ |
| UC网盘 | Cookie | ✅ | ✅ |
| 迅雷网盘 | Refresh Token | ✅ | ✅ |

## 快速开始

### 环境要求

- Node.js >= 20

### 安装

```bash
git clone https://github.com/dishenglee/netdisk-transfer.git
cd netdisk-transfer
npm install
```

### 配置

复制环境变量模板并填入对应平台的认证信息：

```bash
cp .env.example .env
```

至少配置一个平台的 Cookie / Token 即可使用。

### CLI 使用

```bash
# 夸克网盘
npx tsx src/cli.ts https://pan.quark.cn/s/xxxxx

# 百度网盘（带提取码）
npx tsx src/cli.ts https://pan.baidu.com/s/xxxxx abcd

# UC网盘
npx tsx src/cli.ts https://drive.uc.cn/s/xxxxx

# 迅雷网盘（密码在链接中）
npx tsx src/cli.ts "https://pan.xunlei.com/s/xxxxx?pwd=xxxx"
```

## 作为库使用

```typescript
import { TransferService } from "netdisk-transfer";

const service = new TransferService({
  config: {
    get(key) { return process.env[key]; }
  },
  repository: {
    async findResourceById(id) { /* 查询资源记录 */ },
    async updateResourceTransfer(id, data) { /* 更新转存状态 */ },
  },
});

const result = await service.transferResource("1");
console.log(result.targetShareUrl);
```

`TransferService` 不依赖任何框架，通过接口注入配置源和数据仓储，可集成到 NestJS、Express 或任意 Node.js 项目中。

## 环境变量

### 通用

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NETDISK_TRANSFER_TARGET_ROOT` | 转存目标目录 | `/公众号软件` |
| `NETDISK_TRANSFER_RENAME_PREFIX` | 文件重命名前缀 | 无 |

### 夸克网盘

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NETDISK_TRANSFER_QUARK_COOKIE` | 夸克网盘 Cookie | - |
| `NETDISK_TRANSFER_QUARK_SHARE_URL_TYPE` | 分享类型 (1=公开, 2=私密) | `2` |
| `NETDISK_TRANSFER_QUARK_SHARE_EXPIRED_TYPE` | 有效期 (1=1天, 2=7天, 3=30天, 4=永久) | `1` |
| `NETDISK_TRANSFER_QUARK_SHARE_PASSCODE` | 自定义提取码 | 随机 |

### 百度网盘

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NETDISK_TRANSFER_BAIDU_COOKIE` | 百度网盘 Cookie | - |
| `NETDISK_TRANSFER_BAIDU_SHARE_PERIOD` | 有效期 (0=永久, 1=1天, 7=7天, 30=30天) | `0` |
| `NETDISK_TRANSFER_BAIDU_SHARE_PASSCODE` | 自定义提取码 | 随机 |

### UC网盘

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NETDISK_TRANSFER_UC_COOKIE` | UC网盘 Cookie | - |
| `NETDISK_TRANSFER_UC_SHARE_URL_TYPE` | 分享类型 (1=公开, 2=私密) | `1` |
| `NETDISK_TRANSFER_UC_SHARE_EXPIRED_TYPE` | 有效期 (1=1天, 2=7天, 3=30天, 4=永久) | `1` |
| `NETDISK_TRANSFER_UC_SHARE_PASSCODE` | 自定义提取码 | 随机 |

### 迅雷网盘

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NETDISK_TRANSFER_XUNLEI_REFRESH_TOKEN` | 迅雷 Refresh Token | - |
| `NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN` | Access Token（自动刷新） | - |
| `NETDISK_TRANSFER_XUNLEI_SHARE_EXPIRATION_DAYS` | 分享有效天数 (-1=永久) | `-1` |

## 登录获取 Cookie / Token

### 一键登录（推荐）

内置纯 HTTP 登录工具，无需安装浏览器：

```bash
# 统一入口（交互式选择平台）
npm run login

# 指定平台
npx tsx src/login.ts quark    # 夸克 - 终端扫码
npx tsx src/login.ts baidu    # 百度 - 打开链接扫码
npx tsx src/login.ts uc       # UC  - 终端扫码
npx tsx src/login.ts xunlei   # 迅雷 - 终端扫码
```

登录成功后自动将 Cookie / Token 写入 `.env` 文件。

| 平台 | 登录方式 | 依赖 |
|------|---------|------|
| 夸克 | APP 扫码（终端显示二维码） | 无 |
| 百度 | APP 扫码（浏览器打开图片） | 无 |
| UC | APP 扫码（终端显示二维码） | 无 |
| 迅雷 | APP 扫码（终端显示二维码） | 无 |

### 手动获取

也可以手动从浏览器复制：

1. 登录对应网盘网页版
2. 打开浏览器开发者工具 (F12) -> Network 面板
3. 刷新页面，复制任意请求的 `Cookie` 请求头值
4. 填入 `.env` 对应字段

### Playwright 登录（可选）

如果已安装 `playwright-core`，也可以使用浏览器扫码登录：

```bash
npx tsx src/quark/quark-cookie-login.ts   # 夸克
npx tsx src/baidu/baidu-cookie-login.ts   # 百度
npx tsx src/xunlei/xunlei-token-login.ts  # 迅雷
```

## 开发

```bash
npm run build        # 编译 TypeScript
npm run typecheck    # 类型检查
npm test             # 运行测试
```

## License

MIT
