/**
 * @file 米家 API 加解密工具集
 *
 * 纯 JS / Web API 实现，无 Node.js 平台依赖，可在浏览器中运行。
 * 依赖：
 * - Web Crypto API（crypto.subtle / crypto.getRandomValues）
 * - pako（gzip 解压，纯 JS）
 * - TextEncoder / TextDecoder
 * - btoa / atob（Base64）
 *
 * 提供米家 API 认证所需的加密原语：
 * - RC4 流加密（纯 JS 实现，无系统依赖）
 * - 随机 nonce 生成
 * - SHA256 / SHA1 签名
 * - API 请求参数加密
 * - API 响应解密（支持 gzip 解压）
 *
 * 移植自 https://github.com/Squachen/micloud (MIT License)
 */

import { ungzip } from 'pako';

// ============================================================
// Base64 工具（Uint8Array ↔ Base64）
// ============================================================

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================
// SHA 哈希（Web Crypto API）
// ============================================================

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

// ============================================================
// RC4 流加密（纯 JS 实现）
// ============================================================

/**
 * RC4 加密器
 *
 * 与 Python PyCryptodome 的 ARC4 实现兼容（丢弃前 1024 字节输出）。
 */
class RC4 {
  /** 内部状态数组 S-box */
  private s: Uint8Array;
  /** 指针 i */
  private i: number;
  /** 指针 j */
  private j: number;

  /**
   * @param key 密钥字节数组
   */
  constructor(key: Uint8Array) {
    this.s = new Uint8Array(256);
    this.i = 0;
    this.j = 0;

    // 初始化 S-box：S[i] = i
    for (let i = 0; i < 256; i++) {
      this.s[i] = i;
    }

    // 密钥调度算法（KSA）
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.s[i] + key[i % key.length]) & 0xff;
      [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
    }
  }

  /**
   * 伪随机生成算法（PRGA）— 对数据进行加/解密
   *
   * RC4 加解密是同一操作（异或），此方法可同时用于加密和解密。
   *
   * @param data 输入数据
   * @returns    处理后的数据
   */
  crypt(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let k = 0; k < data.length; k++) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + this.s[this.i]) & 0xff;
      [this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];
      const t = (this.s[this.i] + this.s[this.j]) & 0xff;
      out[k] = data[k] ^ this.s[t];
    }
    return out;
  }
}

// ============================================================
// Nonce 生成
// ============================================================

/**
 * 生成 API 请求所需的随机 nonce
 *
 * 格式：8 字节随机数 + 时间戳分钟数（变长大端编码）→ Base64。
 *
 * @returns Base64 编码的 nonce 字符串
 */
export function genNonce(): string {
  const millis = Date.now();

  // 8 字节随机数
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);

  // 时间戳分钟数（变长大端编码）
  const part2 = Math.floor(millis / 60000);
  const part2Bytes: number[] = [];
  let temp = part2;
  while (temp > 0) {
    part2Bytes.unshift(temp & 0xff);
    temp >>>= 8;
  }
  if (part2Bytes.length === 0) part2Bytes.push(0);

  // 合并
  const combined = new Uint8Array(buf.length + part2Bytes.length);
  combined.set(buf);
  combined.set(part2Bytes, buf.length);

  return base64Encode(combined);
}

// ============================================================
// SHA256 签名
// ============================================================

/**
 * 使用 SHA256 对 ssecret 和 nonce 进行签名
 *
 * 算法：SHA256(base64decode(ssecret) + base64decode(nonce)) → Base64
 *
 * @param ssecret 服务端下发的 ssecurity（Base64 编码）
 * @param nonce   随机 nonce（Base64 编码）
 * @returns       签名结果（Base64 编码）
 */
export async function getSignedNonce(ssecret: string, nonce: string): Promise<string> {
  const data = new Uint8Array([
    ...base64Decode(ssecret),
    ...base64Decode(nonce),
  ]);
  const hash = await sha256(data);
  return base64Encode(hash);
}

// ============================================================
// RC4 加解密封装
// ============================================================

/**
 * 使用 RC4 加密数据
 *
 * 调用前先丢弃 1024 字节输出（与 PyCryptodome 兼容）。
 *
 * @param password 加密密钥（Base64 编码）
 * @param payload  明文数据
 * @returns        加密后的 Base64 字符串
 */
export function encryptRC4(password: string, payload: string): string {
  const key = base64Decode(password);
  const rc4 = new RC4(key);
  // PyCryptodome 兼容：先加密 1024 字节丢弃
  rc4.crypt(new Uint8Array(1024));
  const encrypted = rc4.crypt(new TextEncoder().encode(payload));
  return base64Encode(encrypted);
}

/**
 * 使用 RC4 解密数据
 *
 * @param password 解密密钥（Base64 编码）
 * @param payload  密文数据（Base64 编码）
 * @returns        解密后的 Uint8Array
 */
export function decryptRC4(password: string, payload: string): Uint8Array {
  const key = base64Decode(password);
  const rc4 = new RC4(key);
  rc4.crypt(new Uint8Array(1024));
  const decrypted = rc4.crypt(base64Decode(payload));
  return decrypted;
}

// ============================================================
// 签名生成
// ============================================================

/**
 * 生成 API 请求的 SHA1 签名
 *
 * 签名格式：`{METHOD}&{URI}&{k1}={v1}&{k2}={v2}&...&{signedNonce}` 的 SHA1 → Base64
 *
 * @param uri         请求路径，如 '/miotspec/prop/get'
 * @param method      请求方法，如 'POST'
 * @param signedNonce 已签名的 nonce
 * @param params      请求参数字典（排序前）
 * @returns           Base64 编码的签名
 */
export async function genEncSignature(
  uri: string,
  method: string,
  signedNonce: string,
  params: Record<string, string>,
): Promise<string> {
  const parts: string[] = [method.toUpperCase(), uri];

  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${v}`);
  }

  parts.push(signedNonce);
  const signatureString = parts.join('&');
  const hash = await sha1(new TextEncoder().encode(signatureString));
  return base64Encode(hash);
}

/**
 * 生成 API 请求的加密参数
 *
 * 流程：
 * 1. 计算明文参数的 rc4_hash__
 * 2. 用 RC4 逐一加密每个参数值
 * 3. 计算加密后参数的 signature
 * 4. 添加 ssecurity 和 _nonce 字段
 *
 * @param uri         请求路径
 * @param method      请求方法
 * @param signedNonce 已签名的 nonce
 * @param nonce       原始 nonce
 * @param params      明文参数字典 `{ "data": "..." }`
 * @param ssecurity   ssecurity 密钥
 * @returns           加密后的参数字典（可直接用于 POST body）
 */
export async function generateEncParams(
  uri: string,
  method: string,
  signedNonce: string,
  nonce: string,
  params: Record<string, string>,
  ssecurity: string,
): Promise<Record<string, string>> {
  // 第 1 步：在明文中添加 rc4_hash__（加密前的签名）
  params['rc4_hash__'] = await genEncSignature(uri, method, signedNonce, params);

  // 第 2 步：RC4 加密每个参数值
  const encParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    encParams[k] = encryptRC4(signedNonce, v);
  }

  // 第 3 步：计算加密后的签名
  encParams['signature'] = await genEncSignature(uri, method, signedNonce, encParams);
  encParams['ssecurity'] = ssecurity;
  encParams['_nonce'] = nonce;

  return encParams;
}

// ============================================================
// 响应解密
// ============================================================

/**
 * 解密 API 响应数据
 *
 * 部分 API 响应是 RC4 加密的（有时还会经 gzip 压缩），此函数自动处理两种情形。
 *
 * @param ssecurity ssecurity 密钥
 * @param nonce     请求时使用的 nonce
 * @param payload   密文字符串
 * @returns         解密后的 UTF-8 文本
 */
export async function decrypt(
  ssecurity: string,
  nonce: string,
  payload: string,
): Promise<string> {
  const signedNonce = await getSignedNonce(ssecurity, nonce);
  const decrypted = decryptRC4(signedNonce, payload);

  // 检测 gzip 魔数 (0x1f, 0x8b)
  if (decrypted.length >= 2 && decrypted[0] === 0x1f && decrypted[1] === 0x8b) {
    const raw = ungzip(decrypted);
    return new TextDecoder().decode(raw);
  }

  return new TextDecoder().decode(decrypted);
}
