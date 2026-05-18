/**
 * @file MCP 服务器 — 让 AI 直接控制米家设备
 *
 * 通过 cli.ts 的 `mcp` 子命令启动：`npx mijia-api mcp`
 *
 * 将 mijia-api 所有功能包装为 MCP 工具，AI 客户端（如 Claude Desktop）
 * 可直接调用这些工具来查询和控制米家设备。
 *
 * AI 客户端配置（cline_mcp_settings.json / claude_desktop_config.json）：
 * ```json
 * {
 *   "mcpServers": {
 *     "mijia-api": {
 *       "command": "npx",
 *       "args": ["mijia-api", "mcp", "--cache-dir", "/data/mijia-cache"]
 *     }
 *   }
 * }
 * ```
 *
 * 可用工具：
 *   认证类   login, logout
 *   查询类   list-homes, list-rooms, list-devices, list-scenes, list-consumables
 *   操作类   get-prop, set-prop, run-scene, device-info
 *   语音类   run-speaker
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execSync } from 'node:child_process';
import { z } from 'zod';

import { MijiaAPI, getDeviceInfo, MijiaDevice, version } from './index.js';
import type { Cache, QRInfo } from './index.js';

/**
 * 启动 MCP 服务器
 *
 * @param options.cache  Cache 实例（通常为 DiskCache）
 */
/** 通过系统浏览器打开 URL（跨平台） */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' :
    platform === 'win32' ? 'start' :
    'xdg-open';
  execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 5000 });
}

export function createMcpServer(options: { cache: Cache }): McpServer {
  const { cache } = options;

  /** 每次调用创建新实例，确保 login 后的状态能反映到后续请求 */
  async function getApi(): Promise<MijiaAPI> {
    const api = new MijiaAPI(cache);
    if (!api.available) {
      throw new Error('未登录或 token 已过期，请先调用 login 工具');
    }
    return api;
  }

  const server = new McpServer({
    name: 'mijia-api',
    version,
    description: '小米米家设备控制 — 查询家庭/房间/设备，读取/设置属性，执行场景等',
  });

  // ---- 认证 ----

  server.tool(
    'login',
    '登录米家账号。首次使用必须登录，之后 token 有效期为 30 天。' +
    '调用此工具后会自动在浏览器中打开二维码页面，需要用户用手机上的米家 APP 扫描二维码完成认证。' +
    '扫码过程可能需要等待，最长 120 秒，请耐心等待不要超时取消。' +
    '登录成功后其他工具即可正常使用。' +
    '注意：MCP 模式下二维码始终通过浏览器打开（终端 QR 不适用于 MCP stdio 通信场景）。',
    {},
    async () => {
      try {
        const api = new MijiaAPI(cache);
        await api.QRlogin((info: QRInfo) => {
          openBrowser(info.qrImageUrl);
        });
        return { content: [{ type: 'text', text: '✅ 登录成功' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'logout',
    '清除本地保存的认证信息（auth.json），退出当前登录的米家账号。' +
    '之后需要重新 login 才能使用其他工具。',
    {},
    async () => {
      try {
        cache.deleteAuthData();
        return { content: [{ type: 'text', text: '✅ 已清除认证信息' }] };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: [{ type: 'text', text: '认证文件不存在，无需退出' }] };
        }
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 查询类 ----

  server.tool(
    'list-homes',
    '列出当前账号下的所有家庭。每个家庭包含 ID、名称、地址、房间列表和各自设备数量。' +
    '适合先调此工具了解整体结构，再结合 list-rooms 查看具体设备。',
    {},
    async () => {
      try {
        const api = await getApi();
        const homes = await api.getHomesList();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              homes.map((h) => ({
                id: h['id'],
                name: h['name'],
                address: h['address'],
                rooms: (h['roomlist'] as Record<string, unknown>[]).map((r) => ({
                  id: r['id'],
                  name: r['name'],
                  deviceCount: (r['dids'] as string[]).length,
                })),
              })),
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list-rooms',
    '按房间维度列出设备。每个房间会显示其中的设备列表，' +
    '包含 did、名称、型号、在线状态，并标注是否为灯设备（isLight）。' +
    '适合用户说"客厅有什么设备"或"关掉所有灯"这类场景。',
    {
      homeId: z.string().optional().describe(
        '家庭 ID，只查指定家庭下的房间。不传则查全部家庭的房间。' +
        '家庭 ID 可从 list-homes 的返回中获取。',
      ),
    },
    async ({ homeId }) => {
      try {
        const api = await getApi();
        const [homes, devices] = await Promise.all([api.getHomesList(), api.getDevicesList()]);
        const deviceMap = new Map(devices.map((d) => [d['did'] as string, d]));
        const target = homeId ? homes.filter((h) => h['id'] === homeId) : homes;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              target.map((h) => ({
                id: h['id'],
                name: h['name'],
                rooms: (h['roomlist'] as Record<string, unknown>[]).map((r) => ({
                  id: r['id'],
                  name: r['name'],
                  devices: ((r['dids'] as string[]) ?? [])
                    .map((did) => {
                      const d = deviceMap.get(did);
                      return d
                        ? { did: d['did'], name: d['name'], model: d['model'], online: d['isOnline'], isLight: (d['model'] as string).includes('light') }
                        : null;
                    })
                    .filter(Boolean),
                })),
              })),
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list-devices',
    '列出当前账号下的所有设备（含共享设备）。返回 did、名称、型号、在线状态。' +
    '如果用户需要知道有哪些设备可用，优先用此工具。' +
    '如果用户按房间问，优先用 list-rooms 更直观。',
    {},
    async () => {
      try {
        const api = await getApi();
        const devices = [...(await api.getDevicesList()), ...(await api.getSharedDevicesList())];
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              devices.map((d) => ({ did: d['did'], name: d['name'], model: d['model'], online: d['isOnline'] })),
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list-scenes',
    '列出账号下所有手动场景。返回场景 ID、名称、所属家庭 ID。' +
    '场景是在米家 APP 中预设的自动化操作（如"离家模式"）。' +
    '执行场景请用 run-scene 工具，传入 sceneId。',
    {
      homeId: z.string().optional().describe(
        '家庭 ID，只查指定家庭的场景。不传则查全部。',
      ),
    },
    async ({ homeId }) => {
      try {
        const api = await getApi();
        const scenes = homeId ? await api.getScenesList(homeId) : await api.getScenesList();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              scenes.map((s) => ({ sceneId: s['scene_id'], name: s['name'], homeId: s['home_id'] })),
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list-consumables',
    '列出所有需要更换的耗材（如净水器滤芯、空气净化器滤网等）。' +
    '返回耗材所属设备名称、did，以及耗材的描述和当前值。' +
    '适合用户问"我的滤芯还能用多久"这类问题。',
    {
      homeId: z.string().optional().describe(
        '家庭 ID，只查指定家庭的耗材。不传则查全部。',
      ),
    },
    async ({ homeId }) => {
      try {
        const api = await getApi();
        const items = homeId ? await api.getConsumableItems(homeId) : await api.getConsumableItems();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              items.map((item) => ({ did: item['did'], name: item['name'], details: item['details'] })),
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 操作类 ----

  server.tool(
    'run-scene',
    '执行一个手动场景。场景 ID 可通过 list-scenes 获取。' +
    '如果不传 homeId 则会自动遍历所有家庭查找场景。' +
    '如果已知 homeId，传它可以避免一次额外的场景列表请求。',
    {
      sceneId: z.string().describe('场景 ID，可从 list-scenes 返回中获取'),
      homeId: z.string().optional().describe('场景所属的家庭 ID。已知时传入可加速执行，不传则自动查找'),
    },
    async ({ sceneId, homeId }) => {
      try {
        const api = await getApi();
        if (homeId) {
          await api.runScene(sceneId, homeId);
          return { content: [{ type: 'text', text: `场景 ${sceneId} 运行成功` }] };
        }
        const scenes = await api.getScenesList();
        const scene = scenes.find((s) => s['scene_id'] === sceneId);
        if (!scene) return { content: [{ type: 'text', text: `未找到场景 ${sceneId}` }], isError: true };
        await api.runScene(scene['scene_id'] as string, scene['home_id'] as string);
        return { content: [{ type: 'text', text: `✅ 场景「${scene['name']}」已执行` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'device-info',
    '查询设备规格信息。返回设备支持的所有属性（名称、类型、范围、单位）和动作列表。' +
    '在调用 get-prop / set-prop 之前，建议先调此工具确认设备的属性名称和取值范围。' +
    '例如灯的常用属性：on（开关）、brightness（亮度 1-100）、color-temperature（色温 2700-6500）。' +
    '结果会自动缓存，同型号设备第二次查询不重复请求网络。',
    {
      model: z.string().describe('设备型号，如 yeelink.light.lamp4。型号可从 list-devices 或 list-rooms 的返回中获取'),
    },
    async ({ model }) => {
      try {
        const info = await getDeviceInfo(model);
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get-prop',
    '读取设备的某个属性当前值。支持通过 did 或 devName 指定设备，propName 传属性名称。' +
    '属性名称可通过 device-info 查询获得。' +
    '如果不知道 did，先用 list-devices 或 list-rooms 查看。' +
    '常用灯的属性示例：get-prop --dev-name "台灯" --prop-name on → 获取开关状态；' +
    'get-prop --did 318289031 --prop-name brightness → 获取亮度。',
    {
      did: z.string().optional().describe('设备 did。与 devName 二选一，did 优先级更高'),
      devName: z.string().optional().describe('设备名称（米家 APP 中设定的名称）。与 did 二选一'),
      propName: z.string().describe(
        '属性名称。灯的常用属性：' +
        'on（开关，返回 true/false）、' +
        'brightness（亮度，返回 1-100）、' +
        'color-temperature（色温，返回 2700-6500）。' +
        '其他属性请先用 device-info 查询。',
      ),
    },
    async ({ did, devName, propName }) => {
      try {
        const api = await getApi();
        const device = await MijiaDevice.create(api, { did, devName });
        const value = await device.get(propName);
        const unit = device.propList[propName]?.unit || '';
        return { content: [{ type: 'text', text: `${device.name} → ${propName} = ${value} ${unit}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'set-prop',
    '设置设备的某个属性值。支持通过 did 或 devName 指定设备。' +
    '属性名称和取值范围请先用 device-info 查询。' +
    '操作示例：' +
    'set-prop --did 318289031 --prop-name on --value false → 关灯；' +
    'set-prop --dev-name "台灯" --prop-name brightness --value 80 → 调亮度到 80%；' +
    'set-prop --did 318289031 --prop-name color-temperature --value 4000 → 调色温到 4000K。',
    {
      did: z.string().optional().describe('设备 did。与 devName 二选一，did 优先级更高'),
      devName: z.string().optional().describe('设备名称（米家 APP 中设定的名称）。与 did 二选一'),
      propName: z.string().describe(
        '属性名称。灯的常用属性：' +
        'on（开关，值用 true/false）、' +
        'brightness（亮度，值用 1-100 整数）、' +
        'color-temperature（色温，值用 2700-6500 整数）。' +
        '其他属性请先用 device-info 查询支持哪些属性及取值范围。',
      ),
      value: z.union([z.string(), z.number(), z.boolean()]).describe(
        '要设置的属性值。' +
        '开关用布尔值 true(开)/false(关)；' +
        '亮度/色温等数值直接用数字；' +
        '字符串类型的属性直接传字符串。' +
        '注意：数值不要加引号，布尔值不要加引号。',
      ),
    },
    async ({ did, devName, propName, value }) => {
      try {
        const api = await getApi();
        const device = await MijiaDevice.create(api, { did, devName });
        await device.set(propName, value);
        const unit = device.propList[propName]?.unit || '';
        return { content: [{ type: 'text', text: `✅ ${device.name} → ${propName} = ${value} ${unit}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 语音类 ----

  server.tool(
    'run-speaker',
    '通过小爱音箱执行自然语言语音指令。适合用户说"帮我关灯"这样模糊的指令，' +
    '小爱音箱会自动理解并执行。' +
    '也可以用此工具执行一些 API 不直接支持的操作。' +
    '如果不知道音箱 did，不传 speakerDid 会自动查找第一个小爱音箱。' +
    '示例：run-speaker --prompt "关闭客厅灯" → 小爱会关客厅灯并语音回复；' +
    'run-speaker --prompt "把亮度调到50%" --quiet true → 静默执行，小爱不回复。',
    {
      prompt: z.string().describe('自然语言指令。如 "打开客厅灯"、"把空调调到26度"、"现在几点了"'),
      speakerDid: z.string().optional().describe('小爱音箱的 did。不传则自动查找第一个小爱音箱'),
      quiet: z.boolean().optional().describe('静默模式。true=小爱执行但不语音回复，false=正常回复（默认）'),
    },
    async ({ prompt, speakerDid, quiet }) => {
      try {
        const api = await getApi();
        let speaker: MijiaDevice;

        if (speakerDid) {
          speaker = await MijiaDevice.create(api, { did: speakerDid });
        } else {
          const devices = await api.getDevicesList();
          const found = devices.find((d) => (d['model'] as string).includes('xiaomi.wifispeaker'));
          if (!found) return { content: [{ type: 'text', text: '未找到小爱音箱' }], isError: true };
          speaker = await MijiaDevice.create(api, { did: found['did'] as string });
        }

        await speaker.runAction('execute-text-directive', [prompt, quiet ? 1 : 0]);
        return { content: [{ type: 'text', text: '指令已发送，看看设备变化吧。' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}
