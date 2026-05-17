/**
 * @file 设备操作高级封装
 *
 * 提供：
 * - `mijiaDevice`：像操作普通 JavaScript 对象一样控制米家设备
 * - `getDeviceInfo`：从 https://home.miot-spec.com/ 获取设备规格（含本地缓存）
 * - `DevProp` / `DevAction`：属性与动作的描述类
 *
 * 通过 `mijiaDevice.create()` 工厂方法创建实例后，
 * 可以用 `device.get('brightness')`、`device.set('on', true)` 等方式操作设备，
 * 无需手动处理 siid/piid 等底层细节。
 */

import type { mijiaAPI, PropParam, SetPropParam, ActionParam } from './apis.js';
import type { Cache } from '../cache/cache.js';
import {
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
  MultipleDevicesFoundError,
} from '../utils/errors.js';
import { version } from '../version.js';

// ============================================================
// 设备规格数据类型
// ============================================================

/**
 * 设备属性定义
 *
 * 描述一个 MiOT 属性的元信息，从 https://home.miot-spec.com/ 解析得到。
 */
export interface DevPropDef {
  /** 属性名称，如 "on"、"brightness" */
  name: string;
  /** 属性描述（中英文） */
  description: string;
  /** 数据类型 */
  type: 'bool' | 'int' | 'uint' | 'float' | 'string';
  /** 读写权限："r" 可读，"w" 可写，"rw" 可读写 */
  rw: string;
  /** 单位，如 "percentage"、"kelvin"，可能为 null */
  unit: string | null;
  /** 数值范围 [min, max, step]，可能为 null */
  range: number[] | null;
  /** 枚举值列表（有限可选值时） */
  'value-list': { value: number | string; description: string }[] | null;
  /** API 调用所需的方法参数 */
  method: { siid: number; piid: number };
}

/**
 * 设备动作定义
 *
 * 描述一个 MiOT 可执行动作的元信息。
 */
export interface DevActionDef {
  /** 动作名称，如 "toggle" */
  name: string;
  /** 动作描述 */
  description: string;
  /** API 调用所需的方法参数 */
  method: { siid: number; aiid: number };
}

/**
 * 设备规格信息
 *
 * 包含设备的基本信息以及所有属性和动作的完整定义。
 */
export interface DeviceInfo {
  /** 设备显示名称 */
  name: string;
  /** 设备型号，如 "yeelink.light.lamp4" */
  model: string;
  /** 属性定义列表 */
  properties: DevPropDef[];
  /** 动作定义列表 */
  actions: DevActionDef[];
}

// ============================================================
// DevProp — 属性描述类
// ============================================================

/**
 * 设备属性描述类
 *
 * 存储属性的名称、类型、范围、单位等信息，
 * 并提供友好的字符串表示（用于调试和 CLI 输出）。
 */
export class DevProp {
  readonly name: string;
  readonly desc: string;
  readonly type: string;
  readonly rw: string;
  readonly unit: string | null;
  readonly range: number[] | null;
  readonly valueList: { value: number | string; description: string }[] | null;
  readonly method: { siid: number; piid: number };

  /**
   * @param def 属性定义
   * @throws {Error} 不支持的数据类型时抛出
   */
  constructor(def: DevPropDef) {
    this.name = def.name;
    this.desc = def.description;
    this.type = def.type;
    this.rw = def.rw;
    this.unit = def.unit;
    this.range = def.range;
    this.valueList = def['value-list'];
    this.method = def.method;

    if (!['bool', 'int', 'uint', 'float', 'string'].includes(this.type)) {
      throw new Error(
        `不支持的类型: ${this.type}, 可选类型: bool, int, uint, float, string`,
      );
    }
  }

  /** 格式化的属性描述文本 */
  toString(): string {
    let s = `  ${this.name}: ${this.desc}`;
    s += `\n    valuetype: ${this.type}, rw: ${this.rw}, unit: ${this.unit}, range: ${JSON.stringify(this.range)}`;
    if (this.valueList) {
      for (const v of this.valueList) {
        s += `\n    ${v.value}: ${v.description}`;
      }
    }
    return s;
  }
}

// ============================================================
// DevAction — 动作描述类
// ============================================================

/**
 * 设备动作描述类
 */
export class DevAction {
  readonly name: string;
  readonly desc: string;
  readonly method: { siid: number; aiid: number };

  constructor(def: DevActionDef) {
    this.name = def.name;
    this.desc = def.description;
    this.method = def.method;
  }

  toString(): string {
    return `  ${this.name}: ${this.desc}`;
  }
}

// ============================================================
// mijiaDevice — 高级设备控制类
// ============================================================

/** @internal 设备初始化参数 */
interface DeviceInitParams {
  api: mijiaAPI;
  did: string;
  model: string;
  name: string;
  sleepTime: number;
  propList: Record<string, DevProp>;
  actionList: Record<string, DevAction>;
}

/**
 * 米家设备高级控制类
 *
 * 封装了设备属性读写和动作执行，无需关心 siid/piid 细节。
 * 需要通过静态工厂方法 `mijiaDevice.create()` 异步创建实例。
 *
 * @example
 * ```ts
 * const api = new mijiaAPI();
 * await api.login();
 *
 * // 通过设备名称创建
 * const lamp = await mijiaDevice.create(api, { devName: '我的台灯' });
 *
 * // 读写属性
 * const brightness = await lamp.get('brightness');
 * await lamp.set('brightness', 80);
 * await lamp.set('on', false);
 *
 * // 执行动作
 * await lamp.runAction('toggle');
 * ```
 */
export class mijiaDevice {
  readonly api: mijiaAPI;
  readonly did: string;
  readonly model: string;
  readonly name: string;
  readonly sleepTime: number;
  readonly propList: Record<string, DevProp>;
  readonly actionList: Record<string, DevAction>;

  /** @internal 构造函数私有，请使用 create() 工厂方法 */
  private constructor(params: DeviceInitParams) {
    this.api = params.api;
    this.did = params.did;
    this.model = params.model;
    this.name = params.name;
    this.sleepTime = params.sleepTime;
    this.propList = params.propList;
    this.actionList = params.actionList;
  }

  /**
   * 创建 mijiaDevice 实例（异步工厂方法）
   *
   * 自动完成：
   * 1. 根据 did 或 devName 查找设备
   * 2. 从 miot-spec 获取设备规格（含本地缓存）
   * 3. 构建属性/动作索引
   *
   * @param api     mijiaAPI 实例（需已登录）
   * @param options 初始化选项
   * @param options.did      设备 ID（优先于 devName）
   * @param options.devName  设备名称（米家 APP 中设定的名称）
   * @param options.sleepTime 操作后等待时间（秒，默认 0.5）
   * @returns 设备控制实例
   *
   * @throws {DeviceNotFoundError} 未找到匹配设备
   * @throws {MultipleDevicesFoundError} 找到多个同名设备
   */
  static async create(
    api: mijiaAPI,
    options: {
      did?: string;
      devName?: string;
      sleepTime?: number;
    },
  ): Promise<mijiaDevice> {
    const sleepTime = options.sleepTime ?? 0.5;

    if (!options.did && !options.devName) {
      throw new Error('必须提供 did 或 devName 参数之一');
    }
    // did 参数优先级高于 devName，同时提供时忽略 devName
    const devicesList = await api.getDevicesList();
    let did: string;
    let model: string;
    let name: string;

    if (options.did) {
      // 按 did 精确查找
      const matches = devicesList.filter((d) => d['did'] === options.did);
      if (matches.length === 0) {
        throw new DeviceNotFoundError(options.did);
      }
      if (matches.length > 1) {
        throw new MultipleDevicesFoundError(
          `找到多个 did 为 '${options.did}' 的设备`,
        );
      }
      did = options.did;
      name = (matches[0]['name'] as string) || '';
      model = matches[0]['model'] as string;
    } else {
      // 按设备名称查找
      const matches = devicesList.filter(
        (d) => d['name'] === options.devName,
      );
      if (matches.length === 0) {
        throw new DeviceNotFoundError(options.devName!);
      }
      if (matches.length > 1) {
        throw new MultipleDevicesFoundError(
          `找到多个 devName 为 '${options.devName}' 的设备，请使用 did 参数指定具体设备或者修改设备名称以区分`,
        );
      }
      did = matches[0]['did'] as string;
      name = options.devName!;
      model = matches[0]['model'] as string;
    }

    // 获取设备规格（通过 api 的 cache 实例读写缓存）
    const devInfo = await getDeviceInfo(model, api.cache);

    // 构建属性索引（含连字符别名）
    const propList: Record<string, DevProp> = {};
    const actionList: Record<string, DevAction> = {};

    for (const propDef of devInfo.properties) {
      const propObj = new DevProp(propDef);
      propList[propDef.name] = propObj;
      // 为带连字符的属性名创建下划线别名（如 "color-temperature" → "color_temperature"）
      if (propDef.name.includes('-')) {
        propList[propDef.name.replace(/-/g, '_')] = propObj;
      }
    }

    for (const actDef of devInfo.actions) {
      actionList[actDef.name] = new DevAction(actDef);
    }

    return new mijiaDevice({
      api,
      did,
      model,
      name,
      sleepTime,
      propList,
      actionList,
    });
  }

  /**
   * 设备信息的文本表示
   *
   * 显示设备名称、型号、所有属性和动作列表。
   */
  toString(): string {
    const keys = Object.keys(this.propList);
    const props = Object.values(this.propList)
      // 跳过下划线别名，避免重复
      .filter((_, idx) => !keys[idx]?.includes('_'))
      .map((p) => p.toString())
      .filter(Boolean)
      .join('\n');

    const actions = Object.values(this.actionList)
      .map((a) => a.toString())
      .join('\n');

    return (
      `${this.name} (${this.model})\n` +
      `Properties:\n${props || 'No properties available'}\n` +
      `Actions:\n${actions || 'No actions available'}`
    );
  }

  /**
   * 获取设备属性值
   *
   * @param name 属性名称，如 "on"、"brightness"、"color-temperature"
   * @returns 属性值（boolean / number / string）
   *
   * @throws {Error} 属性不存在或不可读时抛出
   * @throws {DeviceGetError} API 调用失败时抛出
   *
   * @example
   * ```ts
   * const brightness = await lamp.get('brightness'); // 50
   * const isOn = await lamp.get('on'); // true
   * ```
   */
  async get(name: string): Promise<boolean | number | string> {
    const prop = this.propList[name];
    if (!prop) {
      throw new Error(
        `不支持的属性: ${name}, 可用属性: ${Object.keys(this.propList)}`,
      );
    }
    if (!prop.rw.includes('r')) {
      throw new Error(`属性 ${name} 不可读取`);
    }

    const method: PropParam = {
      did: this.did,
      siid: prop.method.siid,
      piid: prop.method.piid,
    };

    const result = (await this.api.getDevicesProp(
      method,
    )) as Record<string, unknown>;
    if ((result['code'] as number) !== 0) {
      throw new DeviceGetError(this.name, name, result['code'] as number);
    }

    await this._sleep();
    return result['value'] as boolean | number | string;
  }

  /**
   * 设置设备属性值
   *
   * 自动进行类型转换和校验（布尔值、整数范围、枚举值等）。
   *
   * @param name  属性名称
   * @param value 属性值（支持 string 自动转为 bool/number）
   *
   * @throws {Error} 属性不存在、不可写或值非法时抛出
   * @throws {DeviceSetError} API 调用失败时抛出
   *
   * @example
   * ```ts
   * const { code } = await lamp.set('on', true); // code=0 成功
   * await lamp.set('brightness', 80);             // 不关心返回值
   * await lamp.set('color-temperature', 4000);
   * ```
   */
  async set(name: string, value: unknown): Promise<{ code: number }> {
    const prop = this.propList[name];
    if (!prop) {
      throw new Error(
        `不支持的属性: ${name}, 可用属性: ${Object.keys(this.propList)}`,
      );
    }
    if (!prop.rw.includes('w')) {
      throw new Error(`属性 ${name} 不可写入`);
    }

    let finalValue = value;

    // 类型转换与校验
    if (prop.type === 'bool') {
      finalValue = this._coerceBool(value);
    } else if (prop.type === 'int' || prop.type === 'uint') {
      finalValue = this._coerceInt(prop, value);
    } else if (prop.type === 'float') {
      finalValue = this._coerceFloat(prop, value);
    } else if (prop.type === 'string') {
      if (typeof value !== 'string') {
        throw new Error(`无效字符串值: ${value}`);
      }
    }

    // 检查枚举值列表
    if (prop.valueList) {
      const validValues = prop.valueList.map((v) => v.value);
      if (!validValues.includes(finalValue as number | string)) {
        throw new Error(
          `无效值: ${finalValue}, 请使用 ${JSON.stringify(prop.valueList)}`,
        );
      }
    }

    const method: SetPropParam = {
      did: this.did,
      siid: prop.method.siid,
      piid: prop.method.piid,
      value: finalValue,
    };

    const result = (await this.api.setDevicesProp(
      method,
    )) as Record<string, unknown>;
    const code = result['code'] as number;
    if (code !== 0 && code !== 1) {
      throw new DeviceSetError(this.name, name, code);
    }

    await this._sleep();
    return { code };
  }

  /**
   * 执行设备动作
   *
   * @param name         动作名称
   * @param value        可选，动作参数数组
   * @param extraParams  可选，额外参数（如 `{ _in: [...] }`，下划线前缀自动去除）
   *
   * @throws {Error} 动作不存在时抛出
   * @throws {DeviceActionError} API 调用失败时抛出
   *
   * @example
   * ```ts
   * const { code } = await lamp.runAction('toggle');       // code=0 成功
   * await feeder.runAction('feed', [2]);                    // 不关心返回值
   * await speaker.runAction('execute-text-directive', ['关灯', 0]);
   * ```
   */
  async runAction(
    name: string,
    value?: unknown[],
    extraParams?: Record<string, unknown>,
  ): Promise<{ code: number }> {
    const act = this.actionList[name];
    if (!act) {
      throw new Error(
        `不支持的动作: ${name}, 可用动作: ${Object.keys(this.actionList)}`,
      );
    }

    const method: ActionParam & Record<string, unknown> = {
      did: this.did,
      siid: act.method.siid,
      aiid: act.method.aiid,
    };

    if (value !== undefined) {
      method.value = value;
    }

    // 处理额外参数（自动去除下划线前缀以支持 JavaScript 保留字）
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        const cleanKey = k.startsWith('_') ? k.slice(1) : k;
        if (cleanKey in method) {
          throw new Error(
            `无效的参数: ${k}. 请勿使用以下参数 (${Object.keys(method).join(', ')})`,
          );
        }
        method[cleanKey] = v;
      }
    }

    const result = (await this.api.runAction(
      method,
    )) as Record<string, unknown>;
    const code = result['code'] as number;
    if (code !== 0 && code !== 1) {
      throw new DeviceActionError(this.name, name, code);
    }

    await this._sleep();
    return { code };
  }

  /**
   * 将任意值转换为布尔值
   *
   * 接受的输入格式：
   * - boolean: 原样返回
   * - string: "true"/"false"/"0"/"1"（不区分大小写）
   * - number: 0/1
   */
  private _coerceBool(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      if (value === '0') return false;
      if (value === '1') return true;
    }
    if (typeof value === 'number') {
      if (value === 0) return false;
      if (value === 1) return true;
    }
    throw new Error(`无效布尔值: ${value}`);
  }

  /**
   * 将任意值转换为整数并进行范围/步长校验
   */
  private _coerceInt(prop: DevProp, value: unknown): number {
    const num = Number(value);
    if (!Number.isInteger(num)) {
      throw new Error(`无效整数值: ${value}`);
    }
    if (prop.range) {
      if (num < prop.range[0] || num > prop.range[1]) {
        throw new Error(
          `${num} 超出数值范围, 应该在 ${prop.range[0]} ~ ${prop.range[1]} 之间`,
        );
      }
      if (prop.range.length >= 3 && prop.range[2] !== 1) {
        if ((num - prop.range[0]) % prop.range[2] !== 0) {
          throw new Error(
            `无效的值: ${num}, 应该在范围 ${prop.range[0]} ~ ${prop.range[1]} 内且步长为 ${prop.range[2]}`,
          );
        }
      }
    }
    return num;
  }

  /**
   * 将任意值转换为浮点数并进行范围/步长校验
   */
  private _coerceFloat(prop: DevProp, value: unknown): number {
    const num = Number(value);
    if (isNaN(num)) {
      throw new Error(`无效浮点数值: ${value}`);
    }
    if (prop.range) {
      if (num < prop.range[0] || num > prop.range[1]) {
        throw new Error(
          `${num} 超出数值范围, 应该在 ${prop.range[0]} ~ ${prop.range[1]} 之间`,
        );
      }
      if (
        prop.range.length >= 3 &&
        typeof prop.range[2] === 'number' &&
        prop.range[2] !== 1
      ) {
        if ((num - prop.range[0]) % prop.range[2] !== 0) {
          throw new Error(
            `无效的值: ${num}, 应该在范围 ${prop.range[0]} ~ ${prop.range[1]} 内且步长为 ${prop.range[2]}`,
          );
        }
      }
    }
    return num;
  }

  /** 操作间等待（设备响应延迟补偿） */
  private _sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.sleepTime * 1000));
  }
}

// ============================================================
// getDeviceInfo — 获取设备规格信息
// ============================================================

/** 米家规格平台基础 URL */
const DEVICE_SPEC_URL = 'https://home.miot-spec.com/spec/';

/**
 * 获取设备规格信息
 *
 * 从 https://home.miot-spec.com/ 在线获取设备的属性和动作定义。
 * 支持通过 Cache 实例读写缓存，不传 cache 则每次从网络拉取。
 *
 * @param deviceModel 设备型号，如 `'yeelink.light.lamp4'`
 * @param cache       可选 Cache 实例。传 DiskCache 可持久化，传 MemoryCache 仅在内存中缓存
 * @param noCache     可选，设为 true 则跳过缓存，始终从网络拉取（但依然会写入缓存）
 * @returns 设备规格信息
 *
 * @throws {GetDeviceInfoError} 网络错误或页面结构异常时抛出
 *
 * @example
 * ```ts
 * const info = await getDeviceInfo('yeelink.light.lamp4');
 * console.log(info.name);            // 米家台灯 1S
 * console.log(info.properties);      // 属性列表
 * console.log(info.actions);         // 动作列表
 * ```
 */
export async function getDeviceInfo(
  deviceModel: string,
  cache?: Cache,
  noCache?: boolean,
): Promise<DeviceInfo> {
  // 检查缓存
  if (cache && !noCache) {
    const cached = cache.loadDeviceSpec(deviceModel);
    if (cached) return cached as DeviceInfo;
  }

  // 从 miot-spec 获取设备页面
  const response = await fetch(`${DEVICE_SPEC_URL}${deviceModel}`, {
    headers: {
      'User-Agent': `mijia-api/${version}`,
    },
  });

  if (response.status !== 200) {
    throw new GetDeviceInfoError(deviceModel);
  }

  const html = await response.text();

  // 从 HTML 中提取页面数据（支持新旧两种格式）
  let pageData: Record<string, unknown>;

  // 新格式: <script data-page="app" type="application/json">{...json...}</script>
  const scriptMatch = html.match(/<script\s+data-page="app"\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (scriptMatch) {
    pageData = JSON.parse(scriptMatch[1]);
  } else {
    // 旧格式: data-page="{...json...}">
    const attrMatch = html.match(/data-page="(.*?)">/);
    if (!attrMatch) {
      throw new GetDeviceInfoError(deviceModel);
    }
    const rawJson = attrMatch[1].replace(/&quot;/g, '"');
    pageData = JSON.parse(rawJson);
  }

  // 解析规格数据
  const propsData = pageData['props'] as Record<string, unknown>;
  const product = propsData['product'] as Record<string, unknown> | undefined;
  const spec = propsData['spec'] as Record<string, unknown>;

  const result: DeviceInfo = {
    name: (product?.['name'] as string) || (spec?.['name'] as string) || deviceModel,
    model: (product?.['model'] as string) || deviceModel,
    properties: [],
    actions: [],
  };

  // 获取 services 列表（支持新旧两种格式）
  let servicesList: Record<string, unknown>[] = [];

  // 新格式: tree.services 是数组
  const tree = propsData['tree'] as Record<string, unknown> | undefined;
  const treeServices = tree?.['services'];
  if (treeServices !== undefined && treeServices !== null && Array.isArray(treeServices)) {
    servicesList = treeServices as Record<string, unknown>[];
  } else if (spec?.['services'] !== undefined && spec?.['services'] !== null) {
    // 旧格式: spec.services 是以 siid 为 key 的对象
    const servicesObj = spec['services'] as Record<string, unknown>;
    servicesList = Object.values(servicesObj) as Record<string, unknown>[];
  }

  const propNamesSeen: string[] = [];
  const actionNamesSeen: string[] = [];

  for (const service of servicesList) {
    const siid = Number(service['iid']);

    // 解析属性
    const rawProps = service['properties'];
    if (rawProps && Array.isArray(rawProps)) {
      // 新格式: properties 是数组
      const propsArr = rawProps as Record<string, unknown>[];
      for (const prop of propsArr) {
        let propType: string;
        const fmt = prop['format'] as string;
        if (fmt?.startsWith('int')) {
          propType = 'int';
        } else if (fmt?.startsWith('uint')) {
          propType = 'uint';
        } else {
          propType = fmt || 'string';
        }

        const access = prop['access'] as string[];
        const rw =
          (access?.includes('read') ? 'r' : '') +
          (access?.includes('write') ? 'w' : '');

        let name = prop['type'] as string;
        if (propNamesSeen.includes(name)) {
          name = `${service['type']}-${name}`;
        }
        propNamesSeen.push(name);

        result.properties.push({
          name,
          description: `${prop['description'] || ''}`,
          type: propType as DevPropDef['type'],
          rw,
          unit: (prop['unit'] as string) || null,
          range: (prop['value-range'] as number[]) || (prop['valueRange'] as number[]) || null,
          'value-list': ((prop['value-list'] as DevPropDef['value-list'])?.length ? (prop['value-list'] as DevPropDef['value-list']) : null) ||
            ((prop['valueList'] as DevPropDef['value-list'])?.length ? (prop['valueList'] as DevPropDef['value-list']) : null),
          method: { siid, piid: Number(prop['iid']) },
        });
      }
    } else if (rawProps && typeof rawProps === 'object') {
      // 旧格式: properties 是以 piid 为 key 的对象
      const rawPropsObj = rawProps as Record<string, unknown>;
      for (const piid of Object.keys(rawPropsObj)) {
        const prop = rawPropsObj[piid] as Record<string, unknown>;

        let propType: string;
        const fmt = prop['format'] as string;
        if (fmt?.startsWith('int')) {
          propType = 'int';
        } else if (fmt?.startsWith('uint')) {
          propType = 'uint';
        } else {
          propType = fmt || 'string';
        }

        const access = prop['access'] as string[];
        const rw =
          (access?.includes('read') ? 'r' : '') +
          (access?.includes('write') ? 'w' : '');

        let name = prop['name'] as string;
        if (propNamesSeen.includes(name)) {
          name = `${service['name']}-${name}`;
        }
        propNamesSeen.push(name);

        result.properties.push({
          name,
          description: `${prop['description'] || ''} / ${prop['desc_zh_cn'] || ''}`,
          type: propType as DevPropDef['type'],
          rw,
          unit: (prop['unit'] as string) || null,
          range: (prop['value-range'] as number[]) || (prop['valueRange'] as number[]) || null,
          'value-list': ((prop['value-list'] as DevPropDef['value-list'])?.length ? (prop['value-list'] as DevPropDef['value-list']) : null) ||
            ((prop['valueList'] as DevPropDef['value-list'])?.length ? (prop['valueList'] as DevPropDef['value-list']) : null),
          method: { siid, piid: Number(piid) },
        });
      }
    }

    // 解析动作
    const rawActions = service['actions'];
    if (rawActions && Array.isArray(rawActions)) {
      // 新格式: actions 是数组
      const actionsArr = rawActions as Record<string, unknown>[];
      for (const act of actionsArr) {
        let name = act['type'] as string;
        if (actionNamesSeen.includes(name)) {
          name = `${service['type']}-${name}`;
        }
        actionNamesSeen.push(name);

        result.actions.push({
          name,
          description: `${act['description'] || ''}`,
          method: { siid, aiid: Number(act['iid']) },
        });
      }
    } else if (rawActions && typeof rawActions === 'object') {
      // 旧格式: actions 是以 aiid 为 key 的对象
      const rawActionsObj = rawActions as Record<string, unknown>;
      for (const aiid of Object.keys(rawActionsObj)) {
        const act = rawActionsObj[aiid] as Record<string, unknown>;

        let name = act['name'] as string;
        if (actionNamesSeen.includes(name)) {
          name = `${service['name']}-${name}`;
        }
        actionNamesSeen.push(name);

        result.actions.push({
          name,
          description: `${act['description'] || ''} / ${act['desc_zh_cn'] || ''}`,
          method: { siid, aiid: Number(aiid) },
        });
      }
    }
  }

  // 写入缓存
  if (cache) {
    cache.saveDeviceSpec(deviceModel, result);
  }

  return result;
}
