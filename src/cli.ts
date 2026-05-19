#!/usr/bin/env node

/**
 * @file 米家 CLI — 命令行控制小米米家设备
 *
 * 子命令一览：
 *   认证类     login, logout, whoami
 *   查询类     list-homes, list-rooms, list-devices(list-devices|ls),
 *              list-scenes, list-consumables
 *   操作类     get, set, run-scene, device-info
 *   语音类     run (小爱音箱)
 *
 * @example 常用命令
 * ```bash
 * npx mijia-api list-devices
 * npx mijia-api get --dev-name "台灯" --prop-name "brightness"
 * npx mijia-api set --did 318289031 --prop-name on --value false
 * npx mijia-api run "关灯" --speaker-did 1073935066
 * ```
 */

import chalk from 'chalk';
import { Command, Option } from 'commander';
import { execSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import yaml from 'js-yaml';

import { MijiaAPI, getDeviceInfo, MijiaDevice, version } from './index.js';
import type { QRInfo } from './apis/apis.js';
import { DiskCache } from './cache/disk-cache.js';

/** 全局 DiskCache 实例，在 preAction hook 中初始化 */
let _diskCache: DiskCache | null = null;

/** 获取 DiskCache 实例（带默认值） */
function getCache(): DiskCache {
  if (!_diskCache) _diskCache = new DiskCache();
  return _diskCache;
}

/** 初始化 API（无有效 token 时报错，提示用户手动 login） */
async function initApi(): Promise<MijiaAPI> {
  const api = new MijiaAPI(getCache());
  if (!api.available) {
    console.error('❌ 未登录或 token 已过期，请先执行：');
    console.error('   npx mijia-api login');
    process.exit(1);
  }
  return api;
}

/**
 * 在终端打印二维码（通过 stderr，避免干扰管道输出）
 */
function printQR(loginUrl: string): void {
  console.error('请使用米家APP扫描下方二维码');
  qrcode.generate(loginUrl, { small: false }, (qr: string) => {
    console.error(qr);
  });
  console.error('如果无法扫描二维码，请更改终端字体，如 `Maple Mono`、`Fira Code` 等。');
}

/**
 * 通过系统浏览器打开 URL（跨平台）
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' :
    platform === 'win32' ? 'start' :
    'xdg-open'; // linux
  execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 5000 });
  console.error('已在浏览器中打开二维码图片，请使用米家 APP 扫码');
}

/** 创建 onQR 回调：根据 --browser 参数决定展示方式 */
function createQRHandler(browser?: boolean): (info: QRInfo) => void {
  return (info: QRInfo) => {
    if (browser) {
      console.error('正在打开浏览器显示二维码...');
      openBrowser(info.qrImageUrl);
    } else {
      printQR(info.loginUrl);
    }
    console.error(`也可以访问链接查看二维码图片: ${info.qrImageUrl}`);
  };
}

// ============================================================
// CLI 定义
// ============================================================

/** 输出模式 */
type OutputMode = 'text' | 'yaml' | 'json';

/** 按输出模式打印结构化数据 */
function printOutput(data: unknown, mode: 'yaml' | 'json'): void {
  if (mode === 'yaml') {
    console.log(yaml.dump(data, { indent: 2, lineWidth: -1, noCompatMode: true }));
  } else if (mode === 'json') {
    console.log(JSON.stringify(data, null, 2));
  }
  // text 模式下由各命令自行处理
}

const program = new Command();

program
  .name('mijia-api')
  .version(version)
  .description('小米米家设备 CLI')
  .addOption(new Option('--cache-dir <path>', '自定义缓存根目录（默认 ~/.config/mijia-api）'))
  .addOption(new Option('--auth-secret-key <key>', '自定义认证文件加密密钥'))
  .addOption(new Option('-o, --output <format>', '输出格式').default('text').choices(['text', 'yaml', 'json']))
  .hook('preAction', () => {
    const opts = program.opts();
    _diskCache = new DiskCache(opts.cacheDir, opts.authSecretKey);
  });

// ---- 认证 ----

program
  .command('login')
  .description('登录米家账号')
  .option('-b, --browser', '通过浏览器打开二维码图片（替代终端打印）')
  .action(async (options) => {
    const api = new MijiaAPI(getCache());
    await api.QRlogin(createQRHandler(options.browser));
    console.log('✅ 登录成功');
  });

program
  .command('logout')
  .description('清除本地认证信息，退出登录')
  .action(async () => {
    getCache().deleteAuthData();
    console.log('✅ 已清除认证信息');
  });

program
  .command('whoami')
  .description('查看当前登录的账号信息（脱敏显示）')
  .action(async () => {
    const api = new MijiaAPI(getCache());
    const info = await api.whoami();
    for (const [key, value] of Object.entries(info)) {
      console.log(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  });

// ---- 查询类 ----

program
  .command('list-homes')
  .description('列出所有家庭及房间')
  .action(async () => {
    const output = program.opts().output as OutputMode;
    const api = await initApi();
    const homes = await api.getHomesList();

    if (output !== 'text') {
      printOutput(
        homes.map((h) => ({
          id: h['id'],
          name: h['name'],
          address: h['address'],
          roomCount: (h['roomlist'] as unknown[]).length,
          createTime: new Date((h['create_time'] as number) * 1000).toISOString(),
        })),
        output,
      );
      return;
    }

    console.log('家庭列表:');
    for (const home of homes) {
      console.log(`  - ${home['name']}`);
      console.log(`    ID: ${home['id']}`);
      console.log(`    地址: ${home['address']}`);
      console.log(`    房间: ${(home['roomlist'] as unknown[]).length} 个`);
      console.log(`    创建时间: ${new Date((home['create_time'] as number) * 1000).toLocaleString()}`);
    }
  });

program
  .command('list-rooms')
  .description('列出房间及其设备')
  .option('--home-id <id>', '家庭 ID（不传则查全部）')
  .action(async (options) => {
    const output = program.opts().output as OutputMode;
    const api = await initApi();
    const [homes, devices] = await Promise.all([
      api.getHomesList(),
      api.getDevicesList(),
    ]);
    const deviceMap = new Map(devices.map((d) => [d['did'] as string, d]));

    const target = options.homeId ? homes.filter((h) => h['id'] === options.homeId) : homes;

    if (output !== 'text') {
      printOutput(
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
        output,
      );
      return;
    }

    for (const home of target) {
      console.log(`\n${chalk.bold(home['name'] as string)} (${home['id']})`);
      for (const room of home['roomlist'] as Record<string, unknown>[]) {
        const dids = (room['dids'] as string[]) ?? [];
        console.log(`  ${chalk.cyan('📍')} ${room['name']} (${dids.length} 台设备)`);
        for (const did of dids) {
          const d = deviceMap.get(did);
          if (d) {
            const icon = (d['model'] as string).includes('light') ? '💡' : '  ';
            console.log(`    ${icon} ${d['name']}`);
            console.log(`       did: ${d['did']}, model: ${d['model']}, online: ${d['isOnline']}`);
          }
        }
      }
    }
  });

program
  .command('list-devices')
  .alias('ls')
  .description('列出所有设备（含共享）')
  .action(async () => {
    const output = program.opts().output as OutputMode;
    const api = await initApi();
    const devices = [
      ...(await api.getDevicesList()),
      ...(await api.getSharedDevicesList()),
    ];

    if (output !== 'text') {
      printOutput(
        devices.map((d) => ({ did: d['did'], name: d['name'], model: d['model'], online: d['isOnline'] })),
        output,
      );
      return;
    }

    console.log('设备列表:');
    for (const d of devices) {
      console.log(`  - ${d['name']}`);
      console.log(`    did: ${d['did']}, model: ${d['model']}, online: ${d['isOnline']}`);
    }
  });

program
  .command('list-scenes')
  .description('列出场景')
  .option('--home-id <id>', '家庭 ID（不传则查全部）')
  .action(async (options) => {
    const output = program.opts().output as OutputMode;
    const api = await initApi();
    const scenes = options.homeId
      ? await api.getScenesList(options.homeId)
      : await api.getScenesList();

    if (output !== 'text') {
      printOutput(
        scenes.map((s) => ({ sceneId: s['scene_id'], name: s['name'], homeId: s['home_id'] })),
        output,
      );
      return;
    }

    console.log('场景列表:');
    for (const s of scenes) {
      console.log(`  - ${s['name']}  (ID: ${s['scene_id']}, 家庭: ${s['home_id']})`);
    }
  });

program
  .command('list-consumables')
  .description('列出耗材（滤芯、滤网等）')
  .option('--home-id <id>', '家庭 ID（不传则查全部）')
  .action(async (options) => {
    const output = program.opts().output as OutputMode;
    const api = await initApi();
    const items = options.homeId
      ? await api.getConsumableItems(options.homeId)
      : await api.getConsumableItems();

    if (output !== 'text') {
      printOutput(
        items.map((item) => ({ did: item['did'], name: item['name'], details: item['details'] })),
        output,
      );
      return;
    }

    console.log('耗材列表:');
    for (const item of items) {
      const details = item['details'] as Record<string, unknown>;
      console.log(`  - ${item['name']} (${item['did']})`);
      console.log(`    描述: ${details['description']}, 值: ${details['value']}`);
    }
  });

// ---- 操作类 ----

program
  .command('run-scene')
  .description('运行场景')
  .requiredOption('--scene-id <id>', '场景 ID')
  .option('--home-id <id>', '家庭 ID（不传则自动查找）')
  .action(async (options) => {
    const api = await initApi();

    if (options.homeId) {
      await api.runScene(options.sceneId, options.homeId);
      console.log(`场景 ${options.sceneId} 运行成功`);
      return;
    }

    const scenes = await api.getScenesList();
    const scene = scenes.find((s) => s['scene_id'] === options.sceneId);
    if (!scene) {
      console.error(`场景 ${options.sceneId} 未找到`);
      process.exit(1);
    }
    await api.runScene(scene['scene_id'] as string, scene['home_id'] as string);
    console.log(`场景 ${scene['name']} 运行成功`);
  });

program
  .command('device-info')
  .description('查询设备规格（从 miot-spec 在线获取）')
  .requiredOption('--model <model>', '设备型号，如 yeelink.light.lamp4')
  .action(async (options) => {
    const output = program.opts().output as OutputMode;
    const info = await getDeviceInfo(options.model, getCache());
    if (output !== 'text') {
      printOutput(info, output);
    } else {
      console.log(JSON.stringify(info, null, 2));
    }
  });

program
  .command('get')
  .description('读取设备属性')
  .option('--did <did>', '设备 did')
  .option('--dev-name <name>', '设备名称（与 did 二选一）')
  .requiredOption('--prop-name <name>', '属性名，如 brightness')
  .action(async (options) => {
    const api = await initApi();
    const device = await MijiaDevice.create(api, { did: options.did, devName: options.devName });
    const value = await device.get(options.propName);
    const unit = device.propList[options.propName]?.unit || '';
    console.log(`${device.name} 的 ${options.propName} = ${value} ${unit}`);
  });

program
  .command('set')
  .description('设置设备属性')
  .option('--did <did>', '设备 did')
  .option('--dev-name <name>', '设备名称（与 did 二选一）')
  .requiredOption('--prop-name <name>', '属性名，如 on、brightness')
  .requiredOption('--value <value>', '属性值，如 true、80')
  .action(async (options) => {
    const api = await initApi();
    const device = await MijiaDevice.create(api, { did: options.did, devName: options.devName });
    try {
      await device.set(options.propName, options.value);
    } catch (err) {
      console.error(`设置失败: ${err}`);
      process.exit(1);
    }
    const unit = device.propList[options.propName]?.unit || '';
    console.log(`${device.name} 的 ${options.propName} 已设为 ${options.value} ${unit}`);
  });

// ---- 语音类 ----

program
  .command('run')
  .description('小爱音箱语音指令')
  .argument('<prompt>', '自然语言，如 "打开客厅灯"')
  .option('--speaker-did <did>', '音箱 did（不传则自动查找）')
  .option('--quiet', '静默执行，小爱不语音回复')
  .action(async (prompt: string, options) => {
    const api = await initApi();
    let speaker: MijiaDevice;

    if (options.speakerDid) {
      speaker = await MijiaDevice.create(api, { did: options.speakerDid });
    } else {
      const devices = await api.getDevicesList();
      const found = devices.find((d) => (d['model'] as string).includes('xiaomi.wifispeaker'));
      if (!found) throw new Error('未找到小爱音箱');
      speaker = await MijiaDevice.create(api, { did: found['did'] as string });
    }

    await speaker.runAction('execute-text-directive', [prompt, options.quiet ? 1 : 0]);
    console.log('指令已发送，看看设备变化吧。');
  });

// ---- MCP 服务器 ----

program
  .command('mcp')
  .description('启动 MCP 服务器（AI 客户端通过 stdio 通信）')
  .action(async () => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { createMcpServer } = await import('./mcp.js');
    const server = createMcpServer({ cache: getCache() });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

// ============================================================
// 入口
// ============================================================

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
