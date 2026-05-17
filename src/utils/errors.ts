/**
 * @file 错误码映射表与自定义异常类
 *
 * 所有与米家 API 交互过程中可能抛出的异常均定义在此。
 * 错误码来源：
 *   https://github.com/kekeandzeyu/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/i18n/zh-Hans.json
 */

/**
 * 米家 API 错误码 → 中文描述映射表
 *
 * 涵盖 MiOT 协议层（-704xxx、-705xxx、-706xxx）和通用层（-100xx）的错误码。
 */
export const ERROR_CODE: Record<string, string> = {
  /** 通用错误 */
  '-10000': '未知错误',
  '-10001': '服务不可用',
  '-10002': '参数无效',
  '-10003': '资源不足',
  '-10004': '内部错误',
  '-10005': '权限不足',
  '-10006': '执行超时',
  '-10007': '设备离线或者不存在',
  '-10020': '未授权OAuth2',
  '-10030': '无效的token（HTTP）',
  '-10040': '无效的消息格式',
  '-10050': '无效的证书',

  /** MiOT 协议层通用错误 */
  '-704000000': '未知错误',
  '-704010000': '未授权（设备可能被删除）',
  '-704014006': '没找到设备描述',

  /** MiOT 协议层 Property 错误 */
  '-704030013': 'Property不可读',
  '-704030023': 'Property不可写',
  '-704030033': 'Property不可订阅',

  /** MiOT 协议层 Service / Event / Action 错误 */
  '-704040002': 'Service不存在',
  '-704040003': 'Property不存在',
  '-704040004': 'Event不存在',
  '-704040005': 'Action不存在',
  '-704040999': '功能未上线',

  /** MiOT 协议层设备错误 */
  '-704042001': 'Device不存在',
  '-704042011': '设备离线',
  '-704053036': '设备操作超时',
  '-704053100': '设备在当前状态下无法执行此操作',
  '-704083036': '设备操作超时',
  '-704090001': 'Device不存在',

  /** MiOT 协议层参数错误 */
  '-704220008': '无效的ID',
  '-704220025': 'Action参数个数不匹配',
  '-704220035': 'Action参数错误',
  '-704220043': 'Property值错误',
  '-704222034': 'Action返回值错误',

  /** 厂商自定义错误 */
  '-705004000': '未知错误',
  '-705004501': '未知错误',
  '-705201013': 'Property不可读',
  '-705201015': 'Action执行错误',
  '-705201023': 'Property不可写',
  '-705201033': 'Property不可订阅',

  /** 另一组厂商自定义错误 */
  '-706012000': '未知错误',
  '-706012013': 'Property不可读',
  '-706012015': 'Action执行错误',
  '-706012023': 'Property不可写',
  '-706012033': 'Property不可订阅',
  '-706012043': 'Property值错误',
  '-706014006': '没找到设备描述',
};

/**
 * 登录失败异常
 *
 * 在二维码登录或 Token 刷新过程中，若服务端返回非零 code 或网络异常时抛出。
 */
export class LoginError extends Error {
  /**
   * @param code    错误码（服务端返回的 code，或 -1 表示本地错误）
   * @param message 错误描述
   */
  constructor(public code: number, message: string) {
    super(`code: ${code}, message: ${message}`);
    this.name = 'LoginError';
  }
}

/**
 * API 请求失败异常
 *
 * 调用米家 API 后服务端返回的 code !== 0 或缺少 result 字段时抛出。
 */
export class APIError extends Error {
  /**
   * @param code    错误码
   * @param message 错误描述
   */
  constructor(public code: number, message: string) {
    super(`code: ${code}, message: ${message}`);
    this.name = 'APIError';
  }
}

/**
 * 设备未找到异常
 *
 * 通过 did 或设备名查找设备时，在设备列表中找不到匹配项时抛出。
 */
export class DeviceNotFoundError extends Error {
  /**
   * @param searchKey 搜索用的 did 或设备名
   */
  constructor(public searchKey: string) {
    super(`未找到 did 为 '${searchKey}' 的设备，请检查 did 是否正确`);
    this.name = 'DeviceNotFoundError';
  }
}

/**
 * 找到多个匹配设备的异常
 *
 * 通过设备名查找时，有多个设备的 name 相同（同名设备）时抛出。
 * 建议改用 did 来精确指定。
 */
export class MultipleDevicesFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipleDevicesFoundError';
  }
}

/**
 * 获取设备属性失败异常
 */
export class DeviceGetError extends Error {
  /**
   * @param devName  设备名称
   * @param propName 属性名称
   * @param code     错误码
   */
  constructor(devName: string, propName: string, code: number) {
    super(
      `获取设备 '${devName}' 的属性 '${propName}' 时失败, code: ${code}, message: ${ERROR_CODE[String(code)] || '未知错误'}`,
    );
    this.name = 'DeviceGetError';
  }
}

/**
 * 设置设备属性失败异常
 */
export class DeviceSetError extends Error {
  /**
   * @param devName  设备名称
   * @param propName 属性名称
   * @param code     错误码
   */
  constructor(devName: string, propName: string, code: number) {
    super(
      `设置设备 '${devName}' 的属性 '${propName}' 时失败, code: ${code}, message: ${ERROR_CODE[String(code)] || '未知错误'}`,
    );
    this.name = 'DeviceSetError';
  }
}

/**
 * 执行设备动作失败异常
 */
export class DeviceActionError extends Error {
  /**
   * @param devName    设备名称
   * @param actionName 动作名称
   * @param code       错误码
   */
  constructor(devName: string, actionName: string, code: number) {
    super(
      `执行设备 '${devName}' 的动作 '${actionName}' 时失败, code: ${code}, message: ${ERROR_CODE[String(code)] || '未知错误'}`,
    );
    this.name = 'DeviceActionError';
  }
}

/**
 * 获取设备规格信息失败异常
 *
 * 从 https://home.miot-spec.com/ 获取设备规格时网络错误或页面结构异常时抛出。
 */
export class GetDeviceInfoError extends Error {
  /**
   * @param deviceModel 设备型号，如 'yeelink.light.lamp4'
   */
  constructor(deviceModel: string) {
    super(`获取设备型号 '${deviceModel}' 的设备信息失败`);
    this.name = 'GetDeviceInfoError';
  }
}
