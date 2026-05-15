export interface BaiduTransferConfig {
  get<T extends string>(key: string): T | undefined;
}

export interface BaiduTransferSettings {
  targetRoot: string;
  sharePeriod: number;
  sharePasscode?: string;
  renamePrefix: string;
}

const DEFAULT_BAIDU_RENAME_PREFIX = "【公众号：涤生AGI】";
const DEFAULT_BAIDU_SHARE_PERIOD = 0;

export const resolveBaiduTransferSettings = (
  config: BaiduTransferConfig,
  targetRoot: string,
): BaiduTransferSettings => ({
  targetRoot,
  sharePeriod: Number(
    config.get<string>("NETDISK_TRANSFER_BAIDU_SHARE_PERIOD") ??
      DEFAULT_BAIDU_SHARE_PERIOD,
  ),
  sharePasscode:
    config.get<string>("NETDISK_TRANSFER_BAIDU_SHARE_PASSCODE") || undefined,
  renamePrefix:
    config.get<string>("NETDISK_TRANSFER_BAIDU_RENAME_PREFIX") ??
    DEFAULT_BAIDU_RENAME_PREFIX,
});
