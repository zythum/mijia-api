# @zythum02/mijia-api

[![npm](https://img.shields.io/npm/v/%40zythum02%2Fmijia-api)](https://www.npmjs.com/package/@zythum02/mijia-api)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-green.svg)](https://opensource.org/licenses/GPL-3.0)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> 从 [Do1e/mijia-api](https://github.com/Do1e/mijia-api) 移植的 TypeScript 版本

小米米家设备控制工具，提供三种使用方式：

- **TypeScript API** — 在代码中直接控制设备
- **CLI** — 命令行操作
- **MCP Server** — 让 AI 客户端（Claude Desktop、Cline 等）直接控制设备

---

## 安装

```bash
npm install @zythum02/mijia-api
# 或
pnpm add @zythum02/mijia-api
# 或
yarn add @zythum02/mijia-api
```

---

## TypeScript API

### 登录

首次使用需要通过二维码登录，认证数据会自动持久化：

```typescript
import { mijiaAPI } from '@zythum02/mijia-api';

const api = new mijiaAPI();
await api.login();  // 终端打印二维码，用米家 APP 扫码
```

Token 有效期为 30 天，后续启动自动加载。

### 查询设备

```typescript
const homes = await api.getHomesList();
const devices = await api.getDevicesList();
```

### 读写属性

```typescript
// 获取亮度
const result = await api.getDevicesProp({
  did: '318289031', siid: 2, piid: 2,
});
console.log(result.value);

// 关灯
await api.setDevicesProp({
  did: '318289031', siid: 2, piid: 1, value: false,
});
```

### 高级封装（mijiaDevice）

无需关心 siid/piid：

```typescript
import { mijiaAPI, mijiaDevice } from '@zythum02/mijia-api';

const api = new mijiaAPI();
const lamp = await mijiaDevice.create(api, { devName: '台灯' });

await lamp.set('brightness', 60);
await lamp.set('on', false);
const brightness = await lamp.get('brightness');
```

### 跨平台（浏览器）

API 层无 Node.js 依赖，可在浏览器中使用：

```typescript
import { mijiaAPI } from '@zythum02/mijia-api';
const api = new mijiaAPI();  // 默认 MemoryCache，数据在内存中
```

需要持久化时传入 `DiskCache`：

```typescript
import { mijiaAPI } from '@zythum02/mijia-api';
import { DiskCache } from '@zythum02/mijia-api/cache/disk-cache';

const api = new mijiaAPI(new DiskCache('/custom/path'));
```

---

## CLI

```bash
npx @zythum02/mijia-api <command> [options]
```

### 全局选项

| 选项 | 说明 |
|------|------|
| `--cache-dir <path>` | 缓存根目录（默认 `~/.config/mijia-api`） |
| `-o, --output <format>` | 输出格式: `text` / `yaml` / `json`（默认 `text`） |

### 查询类

| 命令 | 说明 |
|------|------|
| `list-homes` | 列出所有家庭及房间 |
| `list-rooms [--home-id]` | 列出房间及其设备 |
| `list-devices` / `ls` | 列出所有设备（含共享） |
| `list-scenes [--home-id]` | 列出场景 |
| `list-consumables [--home-id]` | 列出耗材 |

### 操作类

| 命令 | 说明 |
|------|------|
| `get --did <id> --prop-name <name>` | 读取设备属性 |
| `set --did <id> --prop-name <name> --value <v>` | 设置设备属性 |
| `run-scene --scene-id <id>` | 运行场景 |
| `device-info --model <model>` | 查询设备规格 |

### 语音类

| 命令 | 说明 |
|------|------|
| `run <prompt> [--speaker-did] [--quiet]` | 小爱音箱语音指令 |

### 示例

```bash
# 登录
npx @zythum02/mijia-api login

# 查看设备
npx @zythum02/mijia-api ls

# YAML / JSON 输出
npx @zythum02/mijia-api ls -o yaml
npx @zythum02/mijia-api ls -o json

# 关灯
npx @zythum02/mijia-api set --did 318289031 --prop-name on --value false

# 语音控制
npx @zythum02/mijia-api run "关掉客厅灯"

# 指定缓存目录
npx @zythum02/mijia-api --cache-dir /data/mijia-cache ls
```

---

## MCP Server

让 AI 客户端直接控制米家设备。作为 MCP Server 运行时，二维码自动通过浏览器打开。

### 启动

```bash
npx @zythum02/mijia-api mcp
# 或指定缓存目录
npx @zythum02/mijia-api mcp --cache-dir /data/mijia-cache
```

### AI 客户端配置

#### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "mijia-api": {
      "command": "npx",
      "args": [
        "-y",
        "@zythum02/mijia-api",
        "mcp"
      ]
    }
  }
}
```

#### Cline / Roo Code

`cline_mcp_settings.json` 或 `roo_mcp_settings.json`：

```json
{
  "mcpServers": {
    "mijia-api": {
      "command": "npx",
      "args": [
        "-y",
        "@zythum02/mijia-api",
        "mcp",
        "--cache-dir",
        "/path/to/mijia-cache"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

#### VS Code 插件（Cline / Continue）

```json
{
  "mcpServers": {
    "mijia-api": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@zythum02/mijia-api",
        "mcp"
      ]
    }
  }
}
```

### 可用 MCP 工具

| 工具 | 功能 | 参数 |
|------|------|------|
| `login` | 登录米家账号（浏览器打开二维码） | — |
| `logout` | 清除认证信息 | — |
| `list-homes` | 列出所有家庭 | — |
| `list-rooms` | 按房间查看设备 | `homeId?` |
| `list-devices` | 列出所有设备（含共享） | — |
| `list-scenes` | 列出场景 | `homeId?` |
| `list-consumables` | 列出耗材 | `homeId?` |
| `get-prop` | 读取设备属性 | `did?`, `devName?`, `propName` |
| `set-prop` | 设置设备属性 | `did?`, `devName?`, `propName`, `value` |
| `run-scene` | 运行场景 | `sceneId`, `homeId?` |
| `device-info` | 查询设备规格 | `model` |
| `run-speaker` | 小爱音箱语音指令 | `prompt`, `speakerDid?`, `quiet?` |

---

## 设备规格查询

```typescript
import { getDeviceInfo } from '@zythum02/mijia-api';

const info = await getDeviceInfo('yeelink.light.lamp4');
console.log(info.properties);  // 属性列表
console.log(info.actions);     // 动作列表
```

结果自动缓存到 `~/.config/mijia-api/device-cache/{model}.json`。

---

## 项目结构

```
src/
├── index.ts                  # 统一导出（纯 API，无平台依赖）
├── cache/
│   ├── cache.ts              # Cache 接口
│   ├── memory-cache.ts       # 内存缓存（浏览器可用）
│   └── disk-cache.ts         # 磁盘缓存（Node.js）
├── apis/
│   ├── apis.ts               # mijiaAPI — 核心 API
│   └── devices.ts            # mijiaDevice / getDeviceInfo
├── cli.ts                    # CLI 入口
├── mcp.ts                    # MCP Server（createMcpServer）
├── utils/
│   ├── crypto.ts             # 米家 RC4 加解密（纯 JS，无平台依赖）
│   └── errors.ts             # 错误码与异常类
└── version.ts                # 版本号
```

---

## 致谢

* [Do1e/mijia-api](https://github.com/Do1e/mijia-api) — 原始 Python 版本
* [Squachen/micloud](https://github.com/Squachen/micloud) — 加解密算法参考
* [米家 APP 网络请求的抓包、加解密与构造的代码笔记](https://imkero.net/posts/mihome-app-api/)
* [al-one/hass-xiaomi-miot](https://github.com/al-one/hass-xiaomi-miot)

## 开源许可

本项目采用 [GPL-3.0](LICENSE) 开源许可证。

**请注意：GPL-3.0 是具有"强传染性"的开源许可证。**
如果您在您的项目中使用、修改或分发本项目的代码（包括作为库依赖），您的整个项目也**必须**以 GPL-3.0 或兼容许可证开源发布。

## 免责声明

* 本项目仅供学习交流使用，不得用于商业用途，如有侵权请联系删除
* 用户使用本项目所产生的任何后果，需自行承担风险
* 开发者不对使用本项目产生的任何直接或间接损失负责
