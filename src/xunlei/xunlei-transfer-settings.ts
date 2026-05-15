export interface XunleiTransferConfig {
  get<T extends string>(key: string): T | undefined;
}

export interface XunleiTransferSettings {
  targetRoot: string;
  clientId: string;
  deviceId: string;
  captchaAction: string;
  shareExpirationDays: number;
  renamePrefix: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
}

const DEFAULT_XUNLEI_CLIENT_ID = "Xqp0kJBXWhwaTpB6";
const DEFAULT_XUNLEI_DEVICE_ID = "925b7631473a13716b791d7f28289cad";
const DEFAULT_XUNLEI_CAPTCHA_ACTION = "GET:/drive/v1/share";
const DEFAULT_XUNLEI_SHARE_EXPIRATION_DAYS = -1;
const DEFAULT_XUNLEI_RENAME_PREFIX = "【公众号：涤生AGI】";
const DEFAULT_XUNLEI_TASK_POLL_INTERVAL_MS = 1000;
const DEFAULT_XUNLEI_TASK_MAX_ATTEMPTS = 60;

export const resolveXunleiTransferSettings = (
  config: XunleiTransferConfig,
  targetRoot: string,
): XunleiTransferSettings => ({
  targetRoot,
  clientId:
    config.get<string>("NETDISK_TRANSFER_XUNLEI_CLIENT_ID") ??
    DEFAULT_XUNLEI_CLIENT_ID,
  deviceId:
    config.get<string>("NETDISK_TRANSFER_XUNLEI_DEVICE_ID") ??
    DEFAULT_XUNLEI_DEVICE_ID,
  captchaAction: normalizeCaptchaAction(
    config.get<string>("NETDISK_TRANSFER_XUNLEI_CAPTCHA_ACTION") ??
      DEFAULT_XUNLEI_CAPTCHA_ACTION,
  ),
  shareExpirationDays: Number(
    config.get<string>("NETDISK_TRANSFER_XUNLEI_SHARE_EXPIRATION_DAYS") ??
      DEFAULT_XUNLEI_SHARE_EXPIRATION_DAYS,
  ),
  renamePrefix:
    config.get<string>("NETDISK_TRANSFER_XUNLEI_RENAME_PREFIX") ??
    DEFAULT_XUNLEI_RENAME_PREFIX,
  taskPollIntervalMs: Number(
    config.get<string>("NETDISK_TRANSFER_XUNLEI_TASK_POLL_INTERVAL_MS") ??
      DEFAULT_XUNLEI_TASK_POLL_INTERVAL_MS,
  ),
  taskMaxAttempts: Number(
    config.get<string>("NETDISK_TRANSFER_XUNLEI_TASK_MAX_ATTEMPTS") ??
      DEFAULT_XUNLEI_TASK_MAX_ATTEMPTS,
  ),
});

const normalizeCaptchaAction = (action: string): string =>
  action.replace(/^([a-z]+):/u, (match) => match.toUpperCase());
