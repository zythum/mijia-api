import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Cache } from './cache.js';

/**
 * 磁盘缓存 — 数据读写到本地文件系统
 *
 * 目录结构：
 *   {cacheDir}/
 *     ├── auth.json              # 认证数据（不加密）
 *     ├── auth.txt               # 认证数据（AES-256-GCM 加密）
 *     └── device-cache/          # 设备规格缓存
 *           └── {model}.json
 */
export class DiskCache implements Cache {
  readonly cacheDir: string;
  private readonly authKeyBuffer?: Buffer | null;

  private static readonly DEFAULT_KEY = String.fromCharCode(
    73, 110, 110, 111, 118, 97, 116, 105, 111, 110, 95,
    102, 111, 114, 95, 101, 118, 101, 114, 121, 111, 110, 101
  );

  private static readonly IV_LEN = 'Are You Ok??'.length;

  /**
   * @param cacheDir      缓存根目录，默认 ~/.config/mijia-api
   * @param authSecretKey 认证文件加密密钥。传 null 则不加密（使用 auth.json）;
   *                      传具体值则启用 AES-256-GCM 加密（使用 auth.txt）;
   *                      不传使用内置默认密钥。
   */
  constructor(cacheDir?: string, authSecretKey: string | null = DiskCache.DEFAULT_KEY) {
    this.cacheDir = cacheDir ?? resolve(homedir(), '.config', 'mijia-api');
    this.authKeyBuffer = authSecretKey === null ? null : createHash('sha256').update(authSecretKey).digest();
  }

  /** 认证文件完整路径（加密时用 auth.txt，否则 auth.json） */
  private _authPath(): string {
    const file = this.authKeyBuffer ? 'auth.txt' : 'auth.json';
    return resolve(this.cacheDir, file);
  }

  /** 某设备型号的缓存文件路径 */
  private _deviceCacheFile(model: string): string {
    return resolve(this.cacheDir, 'device-cache', `${model}.json`);
  }

  saveAuthData(data: Record<string, unknown>): void {
    mkdirSync(this.cacheDir, { recursive: true });
    const json = JSON.stringify(data, null, 2);
    const content = this.authKeyBuffer ? encrypt(json, this.authKeyBuffer, DiskCache.IV_LEN) : json;
    writeFileSync(this._authPath(), content, 'utf-8');
  }

  loadAuthData(): Record<string, unknown> | null {
    if (!existsSync(this._authPath())) return null;
    try {
      const content = readFileSync(this._authPath(), 'utf-8');
      const json = this.authKeyBuffer ? decrypt(content, this.authKeyBuffer, DiskCache.IV_LEN) : content;
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  deleteAuthData(): void {
    try {
      unlinkSync(this._authPath());
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


/**
 * AES-256-GCM 加密
 * 格式: Base64(12 字节 IV + 16 字节 AuthTag + 密文)
 */
function encrypt(plaintext: string, authKeyBuffer: Buffer, IV_LEN: number): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', authKeyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * AES-256-GCM 解密
 * @throws 认证失败或格式错误时抛出异常
 */
function decrypt(payload: string, authKeyBuffer: Buffer, IV_LEN: number): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const encrypted = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv('aes-256-gcm', authKeyBuffer, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf-8') + decipher.final('utf-8');
}