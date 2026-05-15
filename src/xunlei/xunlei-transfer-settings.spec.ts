import { strict as assert } from "node:assert";
import { resolveXunleiTransferSettings } from "./xunlei-transfer-settings.js";

class FakeConfig {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get<T extends string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

const defaults = resolveXunleiTransferSettings(new FakeConfig({}), "/公众号软件");
assert.equal(defaults.targetRoot, "/公众号软件");
assert.equal(defaults.clientId, "Xqp0kJBXWhwaTpB6");
assert.equal(defaults.deviceId, "925b7631473a13716b791d7f28289cad");
assert.equal(defaults.captchaAction, "GET:/drive/v1/share");
assert.equal(defaults.shareExpirationDays, -1);
assert.equal(defaults.renamePrefix, "【公众号：涤生AGI】");
assert.equal(defaults.taskPollIntervalMs, 1000);
assert.equal(defaults.taskMaxAttempts, 60);

const custom = resolveXunleiTransferSettings(
  new FakeConfig({
    NETDISK_TRANSFER_XUNLEI_CLIENT_ID: "client",
    NETDISK_TRANSFER_XUNLEI_DEVICE_ID: "device",
    NETDISK_TRANSFER_XUNLEI_CAPTCHA_ACTION: "post:/drive/v1/share",
    NETDISK_TRANSFER_XUNLEI_SHARE_EXPIRATION_DAYS: "2",
    NETDISK_TRANSFER_XUNLEI_RENAME_PREFIX: "prefix",
    NETDISK_TRANSFER_XUNLEI_TASK_POLL_INTERVAL_MS: "50",
    NETDISK_TRANSFER_XUNLEI_TASK_MAX_ATTEMPTS: "3",
  }),
  "/root",
);
assert.equal(custom.clientId, "client");
assert.equal(custom.deviceId, "device");
assert.equal(custom.captchaAction, "POST:/drive/v1/share");
assert.equal(custom.shareExpirationDays, 2);
assert.equal(custom.renamePrefix, "prefix");
assert.equal(custom.taskPollIntervalMs, 50);
assert.equal(custom.taskMaxAttempts, 3);

console.log("xunlei-transfer-settings.spec.ts ok");
