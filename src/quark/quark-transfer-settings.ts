export interface QuarkTransferConfig {
  get<T extends string>(key: string): T | undefined;
}

export interface QuarkTransferSettings {
  targetRoot: string;
  shareUrlType: number;
  shareExpiredType: number;
  sharePasscode?: string;
  renamePrefix: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
}

const DEFAULT_QUARK_TASK_POLL_INTERVAL_MS = 1000;
const DEFAULT_QUARK_TASK_MAX_ATTEMPTS = 60;
const DEFAULT_QUARK_RENAME_PREFIX = "【公众号：涤生AGI】";
const DEFAULT_QUARK_SHARE_EXPIRED_TYPE = 1;

export const resolveQuarkTransferSettings = (
  config: QuarkTransferConfig,
  targetRoot: string,
): QuarkTransferSettings => ({
  targetRoot,
  shareUrlType: Number(
    config.get<string>("NETDISK_TRANSFER_QUARK_SHARE_URL_TYPE") ?? 2,
  ),
  shareExpiredType: Number(
    config.get<string>("NETDISK_TRANSFER_QUARK_SHARE_EXPIRED_TYPE") ??
      DEFAULT_QUARK_SHARE_EXPIRED_TYPE,
  ),
  sharePasscode:
    config.get<string>("NETDISK_TRANSFER_QUARK_SHARE_PASSCODE") ?? undefined,
  renamePrefix:
    config.get<string>("NETDISK_TRANSFER_QUARK_RENAME_PREFIX") ??
    DEFAULT_QUARK_RENAME_PREFIX,
  taskPollIntervalMs: Number(
    config.get<string>("NETDISK_TRANSFER_QUARK_TASK_POLL_INTERVAL_MS") ??
      DEFAULT_QUARK_TASK_POLL_INTERVAL_MS,
  ),
  taskMaxAttempts: Number(
    config.get<string>("NETDISK_TRANSFER_QUARK_TASK_MAX_ATTEMPTS") ??
      DEFAULT_QUARK_TASK_MAX_ATTEMPTS,
  ),
});
