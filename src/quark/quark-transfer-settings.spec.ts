import { strict as assert } from "node:assert";
import { resolveQuarkTransferSettings } from "./quark-transfer-settings.js";

class FakeConfig {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get<T extends string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

const runDefaultPermanentExpiryCase = (): void => {
  const settings = resolveQuarkTransferSettings(new FakeConfig({}), "/公众号软件");

  assert.equal(settings.shareExpiredType, 1);
};

const runEnvOverrideCase = (): void => {
  const settings = resolveQuarkTransferSettings(
    new FakeConfig({
      NETDISK_TRANSFER_QUARK_SHARE_EXPIRED_TYPE: "4",
    }),
    "/公众号软件",
  );

  assert.equal(settings.shareExpiredType, 4);
};

const main = (): void => {
  runDefaultPermanentExpiryCase();
  runEnvOverrideCase();
};

main();
