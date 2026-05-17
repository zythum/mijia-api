import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Cache } from './cache.js';

/**
 * 磁盘缓存 — 数据读写到本地文件系统
 *
 * 目录结构：
 *   {cacheDir}/
 *     ├── auth.json              # 认证数据
 *     └── device-cache/          # 设备规格缓存
 *           └── {model}.json
 */
export class DiskCache implements Cache {
  readonly cacheDir: string;

  /**
   * @param cacheDir 缓存根目录，默认 ~/.config/mijia-api
   */
  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? resolve(homedir(), '.config', 'mijia-api');
  }

  /** auth.json 完整路径 */
  private get _authPath(): string {
    return resolve(this.cacheDir, 'auth.json');
  }

  /** 某设备型号的缓存文件路径 */
  private _deviceCacheFile(model: string): string {
    return resolve(this.cacheDir, 'device-cache', `${model}.json`);
  }

  saveAuthData(data: Record<string, unknown>): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this._authPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  loadAuthData(): Record<string, unknown> | null {
    if (!existsSync(this._authPath)) return null;
    try {
      return JSON.parse(readFileSync(this._authPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  deleteAuthData(): void {
    try {
      unlinkSync(this._authPath);
    } catch {
      // 文件不存在时忽略
    }
  }

  saveDeviceSpec(model: string, data: unknown): void {
    const file = this._deviceCacheFile(model);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  loadDeviceSpec(model: string): unknown | null {
    const file = this._deviceCacheFile(model);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }
}
