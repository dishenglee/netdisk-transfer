export interface UcTransferConfig {
  get<T extends string>(key: string): T | undefined;
}

export interface UcTransferSettings {
  targetRoot: string;
  shareUrlType: number;
  shareExpiredType: number;
  sharePasscode?: string;
  renamePrefix: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
}

const DEFAULT_UC_TASK_POLL_INTERVAL_MS = 1000;
const DEFAULT_UC_TASK_MAX_ATTEMPTS = 60;
const DEFAULT_UC_RENAME_PREFIX = "【公众号：涤生AGI】";
const DEFAULT_UC_SHARE_EXPIRED_TYPE = 4;

export const resolveUcTransferSettings = (
  config: UcTransferConfig,
  targetRoot: string,
): UcTransferSettings => ({
  targetRoot,
  shareUrlType: Number(
    config.get<string>("NETDISK_TRANSFER_UC_SHARE_URL_TYPE") ?? 1,
  ),
  shareExpiredType: Number(
    config.get<string>("NETDISK_TRANSFER_UC_SHARE_EXPIRED_TYPE") ??
      DEFAULT_UC_SHARE_EXPIRED_TYPE,
  ),
  sharePasscode:
    config.get<string>("NETDISK_TRANSFER_UC_SHARE_PASSCODE") ?? undefined,
  renamePrefix:
    config.get<string>("NETDISK_TRANSFER_UC_RENAME_PREFIX") ??
    DEFAULT_UC_RENAME_PREFIX,
  taskPollIntervalMs: Number(
    config.get<string>("NETDISK_TRANSFER_UC_TASK_POLL_INTERVAL_MS") ??
      DEFAULT_UC_TASK_POLL_INTERVAL_MS,
  ),
  taskMaxAttempts: Number(
    config.get<string>("NETDISK_TRANSFER_UC_TASK_MAX_ATTEMPTS") ??
      DEFAULT_UC_TASK_MAX_ATTEMPTS,
  ),
});
