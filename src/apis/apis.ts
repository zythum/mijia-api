/**
 * @file 米家 API 核心封装 — mijiaAPI 类
 *
 * 提供对小米米家云平台的全功能 API 封装，包括：
 * - 二维码登录 / Token 自动刷新
 * - 家庭、房间、设备列表查询
 * - 设备属性读写（单/批量）
 * - 设备动作执行
 * - 场景、耗材、统计数据查询
 *
 * API 端点：https://api.mijia.tech/app
 * 认证协议：米家私有 RC4 加密 + SHA256/SHA1 签名
 */

import type { Cache } from '../cache/cache.js';
import { MemoryCache } from '../cache/memory-cache.js';

import { APIError, ERROR_CODE, LoginError } from '../utils/errors.js';
import {
  decrypt,
  genNonce,
  generateEncParams,
  getSignedNonce,
} from '../utils/crypto.js';

// ============================================================
// 时区 / 夏令时工具函数
// ============================================================

/** 获取当前时区偏移，格式如 "+08:00" */
function getTimezoneOffset(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const sign = offset >= 0 ? '+' : '-';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** 获取 IANA 时区名称，如 "Asia/Shanghai" */
function getTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 当前是否处于夏令时 */
function getIsDaylight(): boolean {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(-jan.getTimezoneOffset(), -jul.getTimezoneOffset());
  return -now.getTimezoneOffset() > stdOffset;
}

/** 夏令时偏移量（毫秒） */
function getDstOffset(): number {
  const jan = new Date(new Date().getFullYear(), 0, 1);
  const jul = new Date(new Date().getFullYear(), 6, 1);
  const diff = jan.getTimezoneOffset() - jul.getTimezoneOffset();
  return Math.abs(diff) * 60 * 1000;
}

// ============================================================
// CookieJar — 简易 Cookie 管理器
// ============================================================

/**
 * 简易 Cookie 管理器，用于维持 API 会话
 *
 * 原生 fetch 不自动管理 Cookie，因此需要手动维护。
 */
class CookieJar {
  private cookies = new Map<string, string>();

  /** 设置单个 Cookie */
  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** 从 Set-Cookie 头解析并设置 */
  setFromHeader(header: string): void {
    const eqIdx = header.indexOf('=');
    if (eqIdx === -1) return;
    const name = header.slice(0, eqIdx).trim();
    const rest = header.slice(eqIdx + 1);
    const semiIdx = rest.indexOf(';');
    const value = semiIdx === -1 ? rest : rest.slice(0, semiIdx);
    this.cookies.set(name, value);
  }

  /** 拼接完整的 Cookie 头字符串 */
  getString(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** 获取指定 Cookie 的值 */
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

// ============================================================
// 认证数据类型
// ============================================================

/**
 * 认证数据接口
 *
 * 保存到本地 JSON 文件，后续启动时自动加载。
 * 关键字段：
 * - ssecurity: 签名密钥（用于 RC4 加密 + SHA256 签名）
 * - serviceToken: API 访问令牌
 * - cUserId: 用户标识（用于 Cookie）
 * - userId: 用户 ID
 * - passToken: 密码令牌
 */
export interface AuthData {
  ua?: string;
  ssecurity?: string;
  userId?: string;
  cUserId?: string;
  serviceToken?: string;
  passToken?: string;
  pass_o?: string;
  deviceId?: string;
  expireTime?: number;
  saveTime?: number;
  psecurity?: string;
  nonce?: string;
  [key: string]: unknown;
}

/**
 * 二维码信息
 *
 * QRlogin 的 onQR 回调会收到此对象，调用方自行选择合适的展示方式：
 * - loginUrl:    用于终端生成二维码字符画
 * - qrImageUrl:  二维码图片 URL（可在浏览器中打开）
 */
export interface QRInfo {
  /** 二维码图片 URL（可在浏览器中打开） */
  qrImageUrl: string;
  /** 用于终端生成二维码字符画的 URL */
  loginUrl: string;
}

// ============================================================
// MiOT 协议参数类型
// ============================================================

/**
 * 设备属性查询/操作参数
 *
 * @property did   设备 ID，从 getDevicesList() 获取
 * @property siid  服务 ID（Service ID），从设备规格获取
 * @property piid  属性 ID（Property ID），从设备规格获取
 */
export interface PropParam {
  did: string;
  siid: number;
  piid: number;
}

/**
 * 设备属性设置参数（在 PropParam 基础上增加 value）
 */
export interface SetPropParam extends PropParam {
  value: unknown;
}

/**
 * 设备动作执行参数
 *
 * @property did    设备 ID
 * @property siid   服务 ID
 * @property aiid   动作 ID（Action ID）
 * @property value  可选的动作参数数组
 */
export interface ActionParam {
  did: string;
  siid: number;
  aiid: number;
  value?: unknown[];
}

// ============================================================
// mijiaAPI 主类
// ============================================================

/**
 * 米家 API 主类
 *
 * 封装了与米家云平台通信的所有接口，使用二维码登录认证。
 *
 * @example
 * ```ts
 * const api = new mijiaAPI();
 * await api.login();
 * const homes = await api.getHomesList();
 * const devices = await api.getDevicesList();
 * ```
 */
export class mijiaAPI {
  /** 区域设置，如 "zh_CN" */
  private locale: string;
  /** 米家 API 基础 URL */
  private apiBaseUrl = 'https://api.mijia.tech/app';
  /** 二维码登录 URL */
  private loginUrl = 'https://account.xiaomi.com/longPolling/loginUrl';
  /** 服务登录 URL（用于 Token 刷新） */
  private serviceLoginUrl: string;
  /** 认证数据（内存中） */
  private authData: AuthData = {};
  /** Cookie 管理器 */
  private cookieJar = new CookieJar();
  /** 缓存实例，不传则使用 MemoryCache */
  readonly cache: Cache;

  /**
   * @param cache 可选 Cache 实例。不传则使用 MemoryCache（数据仅在内存中）；
   *              CLI/MCP 中请传入 DiskCache 实例以实现持久化。
   */
  constructor(cache?: Cache) {
    this.cache = cache ?? new MemoryCache();

    // 自动检测系统区域设置
    try {
      const raw = Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN';
      this.locale = raw.replace('-', '_');
      if (!this.locale.includes('_')) {
        this.locale = 'zh_CN';
      }
    } catch {
      this.locale = 'zh_CN';
    }

    this.serviceLoginUrl = `https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=${this.locale}`;

    // 尝试加载已有认证数据
    const saved = this.cache.loadAuthData();
    if (saved) {
      this.authData = saved as AuthData;
      this._initSession();
    }
  }

  /**
   * 初始化 HTTP 会话（设置 Cookie）
   *
   * 根据认证数据中的 cUserId / serviceToken 构造会话 Cookie。
   */
  private _initSession(): void {
    const cUserId = this.authData['cUserId'];
    const serviceToken = this.authData['serviceToken'];
    if (!cUserId || !serviceToken) return;

    const countryCode = this.locale.split('_')[1] || 'CN';

    this.cookieJar.set('cUserId', cUserId as string);
    this.cookieJar.set('yetAnotherServiceToken', serviceToken as string);
    this.cookieJar.set('serviceToken', serviceToken as string);
    this.cookieJar.set('timezone_id', getTimezoneName());
    this.cookieJar.set('timezone', `GMT${getTimezoneOffset()}`);
    this.cookieJar.set('is_daylight', String(getIsDaylight()));
    this.cookieJar.set('dst_offset', String(getDstOffset()));
    this.cookieJar.set('channel', 'MI_APP_STORE');
    this.cookieJar.set('countryCode', countryCode);
    this.cookieJar.set('PassportDeviceId', this.deviceId);
    this.cookieJar.set('locale', this.locale);
  }

  /**
   * pass_o 参数（设备标识的一部分）
   *
   * 16 位随机十六进制字符串，用于辅助设备标识。
   */
  private get _pass_o(): string {
    if (!this.authData['pass_o']) {
      this.authData['pass_o'] = Array.from({ length: 16 }, () =>
        '0123456789abcdef'.charAt(Math.floor(Math.random() * 16)),
      ).join('');
    }
    return this.authData['pass_o'] as string;
  }

  /**
   * 用户代理字符串（模拟米家 Android App）
   *
   * 格式示例：
   * `Android-15-11.0.701-Xiaomi-23046RP50C-...-SmartHome-MI_APP_STORE-...`
   */
  get userAgent(): string {
    if (!this.authData['ua']) {
      const uaId1 = this._randHex(40);
      const uaId2 = this._randHex(32);
      const uaId3 = this._randHex(32);
      const uaId4 = this._randHex(40);
      const cc = this.locale.split('_')[1] || 'CN';
      this.authData['ua'] =
        `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${uaId1}-${cc}-${uaId3}-${uaId2}-SmartHome-MI_APP_STORE-${uaId1}|${uaId4}|${this._pass_o}-64`;
    }
    return this.authData['ua'] as string;
  }

  /**
   * 设备 ID（随机生成，模拟 Android 设备）
   *
   * 16 位随机字母数字字符串，用于 API 请求的设备标识。
   */
  get deviceId(): string {
    if (!this.authData['deviceId']) {
      const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
      this.authData['deviceId'] = Array.from({ length: 16 }, () =>
        chars.charAt(Math.floor(Math.random() * chars.length)),
      ).join('');
    }
    return this.authData['deviceId'] as string;
  }

  /** 生成随机十六进制字符串 */
  private _randHex(len: number): string {
    return Array.from({ length: len }, () =>
      '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16)),
    ).join('');
  }

  /**
   * 检查 API 是否可用（认证数据完整有效）
   *
   * 验证必需的五个字段全部存在：
   * ua, ssecurity, userId, cUserId, serviceToken
   */
  get available(): boolean {
    if (Object.keys(this.authData).length === 0) return false;

    const required = ['ua', 'ssecurity', 'userId', 'cUserId', 'serviceToken'] as const;
    for (const k of required) {
      if (!this.authData[k]) return false;
    }
    return true;
  }

  // ============================================================
  // 认证辅助方法
  // ============================================================

  /**
   * 解析小米服务登录返回值
   *
   * 小米登录接口返回格式为 `&&&START&&&{json}`，需要去掉前缀。
   */
  private _parseServiceRet(text: string): Record<string, unknown> {
    return JSON.parse(text.replace('&&&START&&&', ''));
  }

  /**
   * 同步方式解析并校验服务端返回
   *
   * @param text       响应文本
   * @param verifyCode 是否校验 code 字段（某些接口的 code=0 表示未登录，不视为错误）
   */
  private _handleRetSync(text: string, verifyCode = true): Record<string, unknown> {
    const data = this._parseServiceRet(text);
    if (verifyCode && (data['code'] as number) !== 0) {
      throw new LoginError(
        data['code'] as number,
        (data['desc'] as string) || '未知错误',
      );
    }
    return data;
  }

  /** 保存认证数据 */
  private _saveAuthData(): void {
    this.authData['saveTime'] = Date.now();
    this.cache.saveAuthData({ ...this.authData });
  }

  /**
   * 获取服务登录位置信息
   *
   * 向小米账号服务发起登录请求，获取：
   * - 如果 Token 有效：直接刷新 serviceToken
   * - 如果 Token 无效：返回二维码登录所需的参数（location、sign 等）
   *
   * @returns 成功时返回 `{ code: '0', message: '刷新Token成功' }`，
   *          否则返回 URL 查询参数字典
   */
  private async _getLocation(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Connection: 'keep-alive',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: [
        `deviceId=${this.deviceId}`,
        `pass_o=${this._pass_o}`,
        `passToken=${this.authData['passToken'] || ''}`,
        `userId=${this.authData['userId'] || ''}`,
        `cUserId=${this.authData['cUserId'] || ''}`,
        `uLocale=${this.locale}`,
      ].join('; '),
    };

    const response = await fetch(this.serviceLoginUrl, { headers });
    const text = await response.text();
    const serviceData = this._handleRetSync(text, false);
    const location = serviceData['location'] as string;

    // code === 0 表示已登录，直接重定向到 location 完成刷新
    if (serviceData['code'] === 0) {
      const ret = await fetch(location, {
        headers: {
          'User-Agent': this.userAgent,
          Cookie: headers['Cookie'],
        },
        redirect: 'manual',
      });

      const retText = await ret.text();
      if (ret.status === 200 && retText === 'ok') {
        // 解析 Set-Cookie 更新 authData
        for (const c of ret.headers.getSetCookie?.() ?? []) {
          const eq = c.indexOf('=');
          if (eq !== -1) {
            const name = c.slice(0, eq).trim();
            const rest = c.slice(eq + 1);
            const semi = rest.indexOf(';');
            const val = semi === -1 ? rest : rest.slice(0, semi);
            this.authData[name] = val;
          }
        }
        this.authData['ssecurity'] = serviceData['ssecurity'] as string;
        return { code: '0', message: '刷新Token成功' };
      }
    }

    // 需要重新登录，返回 URL 参数
    const url = new URL(location);
    const result: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { result[k] = v; });
    return result;
  }

  // ============================================================
  // 公开 API：认证
  // ============================================================

  /**
   * 刷新 serviceToken
   *
   * 如果当前 Token 有效，直接返回 { tokenRefreshed: false }；
   * 否则通过小米账号服务自动尝试刷新。
   *
   * @returns 刷新结果与认证数据
   * @throws {LoginError} 刷新失败时抛出
   */
  async refreshToken(): Promise<{ tokenRefreshed: boolean; authData: AuthData }> {
    if (this.available) {
      return { tokenRefreshed: false, authData: this.authData };
    }

    const loc = await this._getLocation();
    if (loc['code'] === '0' && loc['message'] === '刷新Token成功') {
      this._saveAuthData();
      this._initSession();
      return { tokenRefreshed: true, authData: this.authData };
    }
    throw new LoginError(-1, '刷新Token失败，请重新登录');
  }

  /**
   * 二维码登录（login 的别名）
   *
   * 如果已有有效 Token 则自动跳过登录流程。
   *
   * @returns 认证数据
   * @see QRlogin
   */
  async login(onQR?: (info: QRInfo) => void | Promise<void>): Promise<AuthData> {
    return this.QRlogin(onQR);
  }

  /**
   * 二维码登录
   *
   * 完整登录流程：
   * 1. 尝试获取 location（可能自动完成 Token 刷新）
   * 2. 如需要登录，获取二维码 URL 并通过 onQR 回调通知调用方
   * 3. 轮询等待用户用米家 APP 扫码（120 秒超时）
   * 4. 提取认证密钥并保存到本地文件
   *
   * onQR 回调接收 QRInfo 对象，包含：
   * - loginUrl:    用于终端生成二维码字符画的 URL
   * - qrImageUrl:  二维码图片 URL（可在浏览器中打开）
   *
   * 调用方在回调中自行决定展示方式：
   * - CLI: 可打印二维码到终端，或打开浏览器
   * - MCP: 通常打开浏览器，或将 URL 返回给 AI 客户端
   *
   * @param onQR 可选回调，收到二维码信息后调用方自行展示
   * @returns 认证数据（包含 ssecurity, serviceToken, cUserId 等）
   * @throws {LoginError} 登录超时或服务端返回错误时抛出
   */
  async QRlogin(onQR?: (info: QRInfo) => void | Promise<void>): Promise<AuthData> {
    // Step 1: 尝试获取 location（可能自动刷新 Token）
    const loc = await this._getLocation();
    if (loc['code'] === '0' && loc['message'] === '刷新Token成功') {
      this._saveAuthData();
      this._initSession();
      return this.authData;
    }

    // Step 2: 获取二维码登录 URL
    const qp = new URLSearchParams(loc);
    qp.set('theme', '');
    qp.set('bizDeviceType', '');
    qp.set('_hasLogo', 'false');
    qp.set('_qrsize', '240');
    qp.set('_dc', String(Date.now()));

    const url = `${this.loginUrl}?${qp.toString()}`;
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'keep-alive',
    };

    const loginResp = await fetch(url, { headers });
    const loginText = await loginResp.text();
    const loginData = this._handleRetSync(loginText);

    // 通过回调通知调用方二维码信息
    if (onQR) {
      await onQR({
        loginUrl: loginData['loginUrl'] as string,
        qrImageUrl: loginData['qr'] as string,
      });
    }

    // Step 3: 轮询等待扫码（120 秒超时）
    const lpResp = await fetch(loginData['lp'] as string, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    const lpText = await lpResp.text();
    const lpData = this._handleRetSync(lpText);

    // Step 4: 提取认证密钥
    for (const key of ['psecurity', 'nonce', 'ssecurity', 'passToken', 'userId', 'cUserId']) {
      this.authData[key] = lpData[key] as string;
    }

    // 执行回调 URL 并收集 Cookie
    const callbackUrl = lpData['location'] as string;
    const cbResp = await fetch(callbackUrl, { headers });
    for (const c of cbResp.headers.getSetCookie?.() ?? []) {
      const eq = c.indexOf('=');
      if (eq !== -1) {
        const name = c.slice(0, eq).trim();
        const rest = c.slice(eq + 1);
        const semi = rest.indexOf(';');
        this.authData[name] = semi === -1 ? rest : rest.slice(0, semi);
      }
    }

    // 设置 30 天过期时间
    this.authData['expireTime'] = Date.now() + 30 * 24 * 60 * 60 * 1000;
    this._saveAuthData();
    this._initSession();
    return this.authData;
  }

  // ============================================================
  // 核心请求方法
  // ============================================================

  /**
   * 发送已认证的 API 请求
   *
   * 自动处理：
   * - Token 刷新（可选）
   * - 请求参数 RC4 加密
   * - SHA1 签名
   * - 响应解密（RC4 / gzip）
   *
   * @param uri          API 路径，如 '/miotspec/prop/get'
   * @param data         请求体数据
   * @param refreshToken 是否在请求前自动刷新 Token，默认 true
   * @returns            解密后的 result 字段
   * @throws {APIError}  服务端返回错误时抛出
   */
  async request(
    uri: string,
    data: Record<string, unknown>,
    refreshToken = true,
  ): Promise<unknown> {
    // 请求前刷新 Token（如果启用）
    if (refreshToken) {
      try {
        await this.refreshToken();
      } catch {
        // 刷新失败不阻止请求，让实际请求决定是否失败
      }
    }

    // 构造请求参数
    const url = this.apiBaseUrl + uri;
    const params: Record<string, string> = {
      data: JSON.stringify(data),
    };

    // 加密参数
    const nonce = genNonce();
    const ssecurity = this.authData['ssecurity'] as string;
    const signedNonce = await getSignedNonce(ssecurity, nonce);
    const encParams = await generateEncParams(uri, 'POST', signedNonce, nonce, params, ssecurity);

    // 发送请求
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'accept-encoding': 'identity',
        'Content-Type': 'application/x-www-form-urlencoded',
        'miot-accept-encoding': 'GZIP',
        'miot-encrypt-algorithm': 'ENCRYPT-RC4',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        Cookie: this.cookieJar.getString(),
      },
      body: new URLSearchParams(encParams).toString(),
    });

    // 解析响应（优先尝试明文 JSON，否则解密）
    const retText = await response.text();
    let retData: Record<string, unknown>;

    try {
      retData = JSON.parse(retText);
    } catch {
      const decrypted = await decrypt(ssecurity, nonce, retText);
      retData = JSON.parse(decrypted);
    }

    // 校验响应状态
    if ((retData['code'] as number) !== 0 || !('result' in retData)) {
      throw new APIError(
        retData['code'] as number,
        (retData['message'] as string) ||
          (retData['desc'] as string) ||
          '未知错误',
      );
    }

    return retData['result'];
  }

  // ============================================================
  // 内部辅助方法（分页查询等）
  // ============================================================

  /**
   * 获取指定家庭的 owner UID
   *
   * @param homeId 家庭 ID
   * @returns 用户 ID（数字）
   */
  private async _getHomeOwner(homeId: string): Promise<number> {
    const homes = await this.getHomesList();
    for (const home of homes) {
      if (home['id'] === homeId) {
        return Number(home['uid']);
      }
    }
    throw new APIError(-1, `未找到 home_id=${homeId} 的家庭信息`);
  }

  /**
   * 获取指定家庭下的设备列表（内部方法，支持分页）
   *
   * @param homeId 家庭 ID
   * @returns 设备列表（每项包含 home_id 字段）
   */
  private async _getDevicesListByHome(homeId: string): Promise<Record<string, unknown>[]> {
    const uri = '/home/home_device_list';
    let startDid = '';
    let hasMore = true;
    const devices: Record<string, unknown>[] = [];

    while (hasMore) {
      const result = (await this.request(uri, {
        home_owner: await this._getHomeOwner(homeId),
        home_id: Number(homeId),
        limit: 200,
        start_did: startDid,
        get_split_device: true,
        support_smart_home: true,
        get_cariot_device: true,
        get_third_device: true,
      })) as Record<string, unknown>;

      if (result && Array.isArray(result['device_info'])) {
        for (const d of result['device_info'] as Record<string, unknown>[]) {
          d['home_id'] = homeId;
          devices.push(d);
        }
        startDid = (result['max_did'] as string) || '';
        hasMore = result['has_more'] === true && startDid !== '';
      } else {
        hasMore = false;
      }
    }

    return devices;
  }

  /**
   * 获取指定家庭下的场景列表（内部方法）
   *
   * @param homeId 家庭 ID
   * @returns 手动场景列表
   */
  private async _getScenesListByHome(homeId: string): Promise<Record<string, unknown>[]> {
    const uri = '/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList';
    const result = (await this.request(uri, {
      app_version: 12,
      get_type: 2,
      home_id: String(homeId),
      owner_uid: await this._getHomeOwner(homeId),
    })) as Record<string, unknown>;

    const scenes = result['manual_scene_info_list'] as Record<string, unknown>[] | undefined;
    if (scenes) {
      for (const s of scenes) {
        s['home_id'] = homeId;
      }
      return scenes;
    }
    return [];
  }

  /**
   * 获取指定家庭下的耗材列表（内部方法）
   *
   * @param homeId 家庭 ID
   * @returns 耗材列表
   */
  private async _getConsumableItemsByHome(homeId: string): Promise<Record<string, unknown>[]> {
    const uri = '/v2/home/standard_consumable_items';
    const result = (await this.request(uri, {
      home_id: Number(homeId),
      owner_id: await this._getHomeOwner(homeId),
      filter_ignore: true,
    })) as Record<string, unknown>;

    try {
      const items = (result['items'] as Record<string, unknown>[])[0]['consumes_data'] as Record<string, unknown>[];
      for (const item of items) {
        if (Array.isArray(item['details']) && item['details'].length === 1) {
          item['details'] = item['details'][0];
        }
        item['home_id'] = homeId;
      }
      return items;
    } catch {
      return [];
    }
  }

  // ============================================================
  // 公开 API：家庭 / 设备 / 场景 / 耗材
  // ============================================================

  /**
   * 检查新消息
   *
   * 轻量级接口，常用于 Token 有效性验证。
   *
   * @param refreshToken 是否自动刷新 Token，默认 true
   * @param beginAt      起始时间戳（秒），默认 1 小时前
   */
  async checkNewMsg(
    refreshToken = true,
    beginAt = Math.floor(Date.now() / 1000) - 3600,
  ): Promise<unknown> {
    return this.request('/v2/message/v2/check_new_msg', { begin_at: beginAt }, refreshToken);
  }

  /**
   * 获取用户的所有家庭列表
   *
   * 包括自己创建的家庭和被共享的家庭。
   * 每个家庭包含房间列表（roomlist），房间中通过 dids 字段关联设备。
   *
   * @returns 家庭信息列表
   *
   * @example
   * ```ts
   * const homes = await api.getHomesList();
   * for (const home of homes) {
   *   console.log(home.name, home.id);
   *   for (const room of home.roomlist) {
   *     console.log('  ', room.name, room.dids); // 房间内的设备 ID 列表
   *   }
   * }
   * ```
   */
  async getHomesList(): Promise<Record<string, unknown>[]> {
    const result = (await this.request('/v2/homeroom/gethome_merged', {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
    })) as Record<string, unknown>;

    return result['homelist'] as Record<string, unknown>[];
  }

  /**
   * 获取设备列表
   *
   * @param homeId 可选，指定家庭 ID。
   *               不传则返回所有家庭的设备（会遍历所有家庭）。
   * @returns 设备信息列表
   *
   * 每项包含：
   * - `did`: 设备 ID
   * - `name`: 设备名称
   * - `model`: 设备型号（如 `yeelink.light.lamp4`）
   * - `isOnline`: 是否在线
   * - `home_id`: 所属家庭 ID
   */
  async getDevicesList(homeId?: string): Promise<Record<string, unknown>[]> {
    if (homeId === undefined) {
      const homes = await this.getHomesList();
      const all: Record<string, unknown>[] = [];
      for (const h of homes) {
        all.push(...(await this._getDevicesListByHome(h['id'] as string)));
      }
      return all;
    }
    return this._getDevicesListByHome(homeId);
  }

  /**
   * 获取共享设备列表
   *
   * 其他用户共享给当前用户的设备。
   *
   * @returns 共享设备列表（每项 `home_id` 为 `"shared"`）
   */
  async getSharedDevicesList(): Promise<Record<string, unknown>[]> {
    const result = (await this.request('/v2/home/device_list_page', {
      ssid: ' ',
      bssid: '02:00:00:00:00:00',
      getVirtualModel: true,
      getHuamiDevices: 1,
      get_split_device: true,
      support_smart_home: true,
      get_cariot_device: true,
      get_third_device: true,
      get_phone_device: true,
      get_miwear_device: true,
    })) as Record<string, unknown>;

    const devices = (result['list'] as Record<string, unknown>[]).filter(
      (d) => d['owner'],
    );
    for (const d of devices) {
      d['home_id'] = 'shared';
    }
    return devices;
  }

  /**
   * 获取场景列表
   *
   * @param homeId 可选，不传则遍历所有家庭
   * @returns 手动场景列表
   *
   * 每项包含：
   * - `scene_id`: 场景 ID
   * - `name`: 场景名称
   * - `home_id`: 所属家庭 ID
   */
  async getScenesList(homeId?: string): Promise<Record<string, unknown>[]> {
    if (homeId === undefined) {
      const homes = await this.getHomesList();
      const all: Record<string, unknown>[] = [];
      for (const h of homes) {
        all.push(...(await this._getScenesListByHome(h['id'] as string)));
      }
      return all;
    }
    return this._getScenesListByHome(homeId);
  }

  /**
   * 执行手动场景
   *
   * 触发在米家 APP（智能 → + → 手动控制）中创建的自动化场景。
   *
   * @param sceneId 场景 ID（从 getScenesList 获取）
   * @param homeId  场景所属家庭 ID
   * @returns 执行结果
   */
  async runScene(sceneId: string, homeId: string): Promise<unknown> {
    return this.request(
      '/appgateway/miot/appsceneservice/AppSceneService/NewRunScene',
      {
        scene_id: sceneId,
        scene_type: 2,
        phone_id: 'null',
        home_id: String(homeId),
        owner_uid: await this._getHomeOwner(homeId),
      },
    );
  }

  /**
   * 获取耗材列表
   *
   * 如净水器滤芯、空气净化器滤网等需要定期更换的配件。
   *
   * @param homeId 可选，不传则遍历所有家庭
   * @returns 耗材列表
   *
   * 每项包含：
   * - `did`: 所属设备 ID
   * - `name`: 设备名称
   * - `details`: 耗材详情（description, value 等）
   * - `home_id`: 所属家庭 ID
   */
  async getConsumableItems(homeId?: string): Promise<Record<string, unknown>[]> {
    if (homeId === undefined) {
      const homes = await this.getHomesList();
      const all: Record<string, unknown>[] = [];
      for (const h of homes) {
        all.push(...(await this._getConsumableItemsByHome(h['id'] as string)));
      }
      return all;
    }
    return this._getConsumableItemsByHome(homeId);
  }

  // ============================================================
  // 公开 API：设备属性读写
  // ============================================================

  /**
   * 获取设备属性
   *
   * 支持单条和批量查询。
   *
   * @param data 单条 `PropParam` 或 `PropParam[]`
   *
   * PropParam 格式：
   * - `did`: 设备 ID
   * - `siid`: 服务 ID
   * - `piid`: 属性 ID
   *
   * @returns 输入为单条时返回单条结果，输入为数组时返回结果数组。
   *
   * 返回结果包含：
   * - `code`: 0 表示成功
   * - `value`: 属性值
   * - `siid`, `piid`, `did`: 请求标识
   *
   * @example
   * ```ts
   * // 单条查询 — 获取灯开关状态
   * const result = await api.getDevicesProp({
   *   did: '1234567890',
   *   siid: 2,
   *   piid: 1,     // on
   * });
   * console.log(result.value); // true / false
   *
   * // 批量查询
   * const results = await api.getDevicesProp([
   *   { did: '...', siid: 2, piid: 2 }, // 亮度
   *   { did: '...', siid: 2, piid: 3 }, // 色温
   * ]);
   * ```
   */
  async getDevicesProp(data: PropParam | PropParam[]): Promise<unknown> {
    const params = Array.isArray(data) ? data : [data];
    const result = (await this.request('/miotspec/prop/get', {
      params,
      datasource: 1,
    })) as unknown[];

    if (!Array.isArray(data) && result.length === 1) {
      return result[0];
    }
    return result;
  }

  /**
   * 设置设备属性
   *
   * 支持单条和批量设置。
   *
   * @param data 单条 `SetPropParam` 或 `SetPropParam[]`
   *
   * SetPropParam 格式（在 PropParam 基础上增加）：
   * - `value`: 要设置的值
   *
   * @returns 输入为单条时返回单条结果，输入为数组时返回结果数组。
   *
   * @example
   * ```ts
   * // 开灯
   * await api.setDevicesProp({
   *   did: '1234567890',
   *   siid: 2,
   *   piid: 1,
   *   value: true,
   * });
   *
   * // 设置亮度 50%
   * await api.setDevicesProp({
   *   did: '1234567890',
   *   siid: 2,
   *   piid: 2,
   *   value: 50,
   * });
   * ```
   */
  async setDevicesProp(data: SetPropParam | SetPropParam[]): Promise<unknown> {
    const params = Array.isArray(data) ? data : [data];
    const result = (await this.request('/miotspec/prop/set', {
      params,
    })) as Record<string, unknown>[];

    // 补充中文描述
    for (const r of result) {
      const c = r['code'] as number;
      r['message'] = c === 0 || c === 1 ? '成功' : (ERROR_CODE[String(c)] || '未知错误');
    }

    if (!Array.isArray(data) && result.length === 1) {
      return result[0];
    }
    return result;
  }

  // ============================================================
  // 公开 API：设备动作
  // ============================================================

  /**
   * 执行设备动作
   *
   * 对每个动作参数分别发起请求（不支持批量合并）。
   *
   * @param data 单条 `ActionParam` 或 `ActionParam[]`
   *
   * ActionParam 格式：
   * - `did`: 设备 ID
   * - `siid`: 服务 ID
   * - `aiid`: 动作 ID
   * - `value` (可选): 动作参数数组
   *
   * @returns 输入为单条时返回单条结果，输入为数组时返回结果数组。
   *
   * @example
   * ```ts
   * // 切换灯的开/关状态
   * await api.runAction({
   *   did: '1234567890',
   *   siid: 2,
   *   aiid: 1,     // toggle
   * });
   *
   * // 宠物喂食器出粮 2 份
   * await api.runAction({
   *   did: '0987654321',
   *   siid: 2,
   *   aiid: 1,
   *   value: [2],
   * });
   * ```
   */
  async runAction(data: ActionParam | ActionParam[]): Promise<unknown> {
    const params = Array.isArray(data) ? data : [data];
    const results: Record<string, unknown>[] = [];

    for (const p of params) {
      const r = (await this.request('/miotspec/action', {
        params: p,
      })) as Record<string, unknown>;
      results.push(r);
    }

    // 补充中文描述
    for (const r of results) {
      const c = r['code'] as number;
      r['message'] = c === 0 || c === 1 ? '成功' : (ERROR_CODE[String(c)] || '未知错误');
    }

    if (!Array.isArray(data) && results.length === 1) {
      return results[0];
    }
    return results;
  }

  // ============================================================
  // 公开 API：统计数据
  // ============================================================

  /**
   * 获取设备统计数据
   *
   * 支持按小时/天/周/月不同粒度查询设备的统计信息（如耗电量）。
   *
   * @param data 统计查询参数
   *
   * data 字段：
   * - `did`: 设备 ID
   * - `key`: 统计键，格式 `siid.piid`（如 `"7.1"` 表示空调伴侣的功耗）
   * - `data_type`: 统计粒度
   *   - `stat_hour_v3`: 按小时
   *   - `stat_day_v3`: 按天
   *   - `stat_week_v3`: 按周
   *   - `stat_month_v3`: 按月
   * - `limit`: 最大返回条数
   * - `time_start`: 开始时间戳（秒）
   * - `time_end`: 结束时间戳（秒）
   *
   * @returns 统计数据列表
   *
   * @example
   * ```ts
   * import { mijiaAPI } from 'mijia-api';
   * const api = new mijiaAPI();
   *
   * const ret = await api.getStatistics({
   *   did: '123456',
   *   key: '7.1',
   *   data_type: 'stat_month_v3',
   *   limit: 6,
   *   time_start: Math.floor(Date.now() / 1000) - 24 * 3600 * 30 * 6,
   *   time_end: Math.floor(Date.now() / 1000),
   * });
   * ```
   */
  async getStatistics(data: Record<string, unknown>): Promise<unknown> {
    const params = Array.isArray(data) ? data : [data];
    const results: unknown[] = [];

    for (const p of params) {
      results.push(await this.request('/v2/user/statistics', p as Record<string, unknown>));
    }

    if (!Array.isArray(data) && results.length === 1) {
      return results[0];
    }
    return results;
  }
}
