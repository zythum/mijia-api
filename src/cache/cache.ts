/** 缓存接口 — 所有 cache 实现需遵循此接口 */
export interface Cache {
  /** 保存认证数据 */
  saveAuthData(data: Record<string, unknown>): void;

  /** 读取认证数据，不存在返回 null */
  loadAuthData(): Record<string, unknown> | null;

  /** 删除认证数据 */
  deleteAuthData(): void;

  /** 保存设备规格缓存 */
  saveDeviceSpec(model: string, data: unknown): void;

  /** 读取设备规格缓存，不存在返回 null */
  loadDeviceSpec(model: string): unknown | null;
}
