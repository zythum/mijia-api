import type { Cache } from './cache.js';

/**
 * 内存缓存 — 所有数据读写内存，不涉及文件系统
 *
 * 适用于浏览器、Serverless 等无文件系统环境。
 * 应用重启后数据丢失。
 */
export class MemoryCache implements Cache {
  private authData: Record<string, unknown> | null = null;
  private deviceSpecs = new Map<string, unknown>();

  saveAuthData(data: Record<string, unknown>): void {
    this.authData = { ...data };
  }

  loadAuthData(): Record<string, unknown> | null {
    return this.authData ? { ...this.authData } : null;
  }

  deleteAuthData(): void {
    this.authData = null;
  }

  saveDeviceSpec(model: string, data: unknown): void {
    this.deviceSpecs.set(model, data);
  }

  loadDeviceSpec(model: string): unknown | null {
    return this.deviceSpecs.get(model) ?? null;
  }
}
