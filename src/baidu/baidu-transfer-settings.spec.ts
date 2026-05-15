import { strict as assert } from "node:assert";
import { resolveBaiduTransferSettings } from "./baidu-transfer-settings.js";

class FakeConfig {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get<T extends string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

const runDefaultPermanentShareCase = (): void => {
  const settings = resolveBaiduTransferSettings(new FakeConfig({}), "/公众号软件");

  assert.equal(settings.sharePeriod, 0);
};

const runEnvOverrideCase = (): void => {
  const settings = resolveBaiduTransferSettings(
    new FakeConfig({
      NETDISK_TRANSFER_BAIDU_SHARE_PERIOD: "7",
      NETDISK_TRANSFER_BAIDU_SHARE_PASSCODE: "abcd",
    }),
    "/公众号软件",
  );

  assert.equal(settings.sharePeriod, 7);
  assert.equal(settings.sharePasscode, "abcd");
};

const main = (): void => {
  runDefaultPermanentShareCase();
  runEnvOverrideCase();
};

main();
