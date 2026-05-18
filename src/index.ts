/**
 * @file 项目统一导出入口
 *
 * 纯 API 层导出，无平台依赖，可在浏览器中使用。
 * cache 实现（MemoryCache / DiskCache）需单独从 `mijia-api/cache/` 导入。
 *
 * 使用方式：
 * ```ts
 * import { MijiaAPI, MijiaDevice, getDeviceInfo } from 'mijia-api';
 * ```
 */

// 核心 API 类
export { MijiaAPI } from './apis/apis.js';

// API 参数类型
export type { AuthData, PropParam, SetPropParam, ActionParam, QRInfo } from './apis/apis.js';

// 高级设备封装
export { getDeviceInfo, MijiaDevice, DevProp, DevAction } from './apis/devices.js';

// 设备规格类型
export type { DeviceInfo, DevPropDef, DevActionDef } from './apis/devices.js';

// 异常类
export {
  APIError,
  DeviceActionError,
  DeviceGetError,
  DeviceNotFoundError,
  DeviceSetError,
  GetDeviceInfoError,
  LoginError,
  MultipleDevicesFoundError,
  ERROR_CODE,
} from './utils/errors.js';

// Cache 接口
export type { Cache } from './cache/cache.js';

// 版本信息
export { version } from './version.js';
