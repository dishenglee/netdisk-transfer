import { ExternalCommandNetdiskTransferAdapter } from "./external-command-netdisk-transfer.adapter.js";
import { BaiduDriveApiClient } from "./baidu/baidu-drive-api-client.js";
import { BaiduTransferAdapter } from "./baidu/baidu-transfer.adapter.js";
import { resolveBaiduTransferSettings } from "./baidu/baidu-transfer-settings.js";
import { QuarkDriveApiClient } from "./quark/quark-drive-api-client.js";
import { QuarkTransferAdapter } from "./quark/quark-transfer.adapter.js";
import { resolveQuarkTransferSettings } from "./quark/quark-transfer-settings.js";
import { ResourceTransferRunner } from "./resource-transfer-runner.js";
import {
  NetdiskTransferAdapter,
  ResourceTransferRepository,
  ResourceTransferRunnerResult,
} from "./resource-transfer.types.js";
import { UcDriveApiClient } from "./uc/uc-drive-api-client.js";
import { UcTransferAdapter } from "./uc/uc-transfer.adapter.js";
import { resolveUcTransferSettings } from "./uc/uc-transfer-settings.js";
import { XunleiDriveApiClient } from "./xunlei/xunlei-drive-api-client.js";
import { XunleiTransferAdapter } from "./xunlei/xunlei-transfer.adapter.js";
import { resolveXunleiTransferSettings } from "./xunlei/xunlei-transfer-settings.js";
import { updateEnvValue } from "./quark/quark-cookie-login.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_TARGET_ROOT = "/公众号软件";
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface TransferServiceConfig {
  get<T extends string>(key: string): T | undefined;
}

export interface TransferServiceOptions {
  config: TransferServiceConfig;
  repository: ResourceTransferRepository;
}

export class TransferService {
  private readonly runner: ResourceTransferRunner;

  constructor(options: TransferServiceOptions) {
    const { config, repository } = options;
    const targetRoot =
      config.get<string>("NETDISK_TRANSFER_TARGET_ROOT") ?? DEFAULT_TARGET_ROOT;
    const timeoutMs = Number(
      config.get<string>("NETDISK_TRANSFER_COMMAND_TIMEOUT_MS") ??
        DEFAULT_COMMAND_TIMEOUT_MS,
    );

    this.runner = new ResourceTransferRunner(repository, [
      ...this.createQuarkAdapters(config, targetRoot),
      ...this.createBaiduAdapters(config, targetRoot, timeoutMs),
      ...this.createUcAdapters(config, targetRoot),
      ...this.createXunleiAdapters(config, targetRoot),
    ]);
  }

  async transferResource(id: string): Promise<ResourceTransferRunnerResult> {
    return this.runner.transferResource(id);
  }

  private createQuarkAdapters(
    config: TransferServiceConfig,
    targetRoot: string,
  ): NetdiskTransferAdapter[] {
    const adapters: NetdiskTransferAdapter[] = [];
    const cookie = config.get<string>("NETDISK_TRANSFER_QUARK_COOKIE");
    const settings = resolveQuarkTransferSettings(config, targetRoot);
    if (cookie) {
      adapters.push(
        new QuarkTransferAdapter(
          new QuarkDriveApiClient({
            cookie,
            taskPollIntervalMs: settings.taskPollIntervalMs,
            taskMaxAttempts: settings.taskMaxAttempts,
          }),
          {
            enabled: true,
            targetRoot: settings.targetRoot,
            shareUrlType: settings.shareUrlType,
            shareExpiredType: settings.shareExpiredType,
            sharePasscode: settings.sharePasscode,
            renamePrefix: settings.renamePrefix,
          },
        ),
      );
    }

    const command = config.get<string>("NETDISK_TRANSFER_QUARK_COMMAND");
    if (command) {
      adapters.push(
        new ExternalCommandNetdiskTransferAdapter({
          platform: "quark",
          command,
          targetRoot,
          timeoutMs: Number(
            config.get<string>("NETDISK_TRANSFER_COMMAND_TIMEOUT_MS") ??
              DEFAULT_COMMAND_TIMEOUT_MS,
          ),
        }),
      );
    }

    return adapters;
  }

  private createBaiduAdapters(
    config: TransferServiceConfig,
    targetRoot: string,
    timeoutMs: number,
  ): NetdiskTransferAdapter[] {
    const adapters: NetdiskTransferAdapter[] = [];
    const cookie = config.get<string>("NETDISK_TRANSFER_BAIDU_COOKIE");
    const settings = resolveBaiduTransferSettings(config, targetRoot);

    if (cookie) {
      adapters.push(
        new BaiduTransferAdapter(new BaiduDriveApiClient({ cookie }), {
          enabled: true,
          targetRoot: settings.targetRoot,
          sharePeriod: settings.sharePeriod,
          sharePasscode: settings.sharePasscode,
          renamePrefix: settings.renamePrefix,
        }),
      );
    }

    const command = config.get<string>("NETDISK_TRANSFER_BAIDU_COMMAND");
    if (command) {
      adapters.push(
        new ExternalCommandNetdiskTransferAdapter({
          platform: "baidu",
          command,
          targetRoot,
          timeoutMs,
        }),
      );
    }

    return adapters;
  }

  private createUcAdapters(
    config: TransferServiceConfig,
    targetRoot: string,
  ): NetdiskTransferAdapter[] {
    const adapters: NetdiskTransferAdapter[] = [];
    const cookie = config.get<string>("NETDISK_TRANSFER_UC_COOKIE");
    const settings = resolveUcTransferSettings(config, targetRoot);

    if (cookie) {
      adapters.push(
        new UcTransferAdapter(
          new UcDriveApiClient({
            cookie,
            taskPollIntervalMs: settings.taskPollIntervalMs,
            taskMaxAttempts: settings.taskMaxAttempts,
          }),
          {
            enabled: true,
            targetRoot: settings.targetRoot,
            shareUrlType: settings.shareUrlType,
            shareExpiredType: settings.shareExpiredType,
            sharePasscode: settings.sharePasscode,
            renamePrefix: settings.renamePrefix,
          },
        ),
      );
    }

    return adapters;
  }

  private createXunleiAdapters(
    config: TransferServiceConfig,
    targetRoot: string,
  ): NetdiskTransferAdapter[] {
    const adapters: NetdiskTransferAdapter[] = [];
    const refreshToken = config.get<string>(
      "NETDISK_TRANSFER_XUNLEI_REFRESH_TOKEN",
    );
    const accessToken = config.get<string>(
      "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN",
    );
    const expiresAtStr = config.get<string>(
      "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN_EXPIRES_AT",
    );
    const captchaToken = config.get<string>(
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN",
    );
    const captchaExpiresAtStr = config.get<string>(
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN_EXPIRES_AT",
    );
    const settings = resolveXunleiTransferSettings(config, targetRoot);

    if (refreshToken) {
      adapters.push(
        new XunleiTransferAdapter(
          new XunleiDriveApiClient({
            refreshToken,
            accessToken,
            accessTokenExpiresAt: parseExpiresAt(expiresAtStr),
            captchaToken,
            captchaTokenExpiresAt: parseExpiresAt(captchaExpiresAtStr),
            clientId: settings.clientId,
            deviceId: settings.deviceId,
            captchaAction: settings.captchaAction,
            taskPollIntervalMs: settings.taskPollIntervalMs,
            taskMaxAttempts: settings.taskMaxAttempts,
            onRefreshToken: (nextToken) =>
              persistXunleiRefreshToken(config, nextToken),
          }),
          {
            enabled: true,
            targetRoot: settings.targetRoot,
            shareExpirationDays: settings.shareExpirationDays,
            renamePrefix: settings.renamePrefix,
          },
        ),
      );
    }

    return adapters;
  }
}

function parseExpiresAt(value?: string): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function persistXunleiRefreshToken(
  config: TransferServiceConfig,
  refreshToken: string,
): void {
  const envPath = config.get<string>("NETDISK_TRANSFER_XUNLEI_ENV_PATH");
  if (envPath === "false") return;

  const path = envPath || ".env";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(
    path,
    updateEnvValue(
      existing,
      "NETDISK_TRANSFER_XUNLEI_REFRESH_TOKEN",
      refreshToken,
    ),
  );
}
