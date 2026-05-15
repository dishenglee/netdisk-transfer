import { strict as assert } from "node:assert";
import {
  getCookieNames,
  getNetdiskCookieEnvKey,
  parseNetdiskCookiePlatform,
} from "./netdisk-cookie-manager.js";

const runPlatformEnvKeyCase = (): void => {
  assert.equal(
    getNetdiskCookieEnvKey("baidu"),
    "NETDISK_TRANSFER_BAIDU_COOKIE",
  );
  assert.equal(
    getNetdiskCookieEnvKey("quark"),
    "NETDISK_TRANSFER_QUARK_COOKIE",
  );
};

const runParsePlatformCase = (): void => {
  assert.equal(parseNetdiskCookiePlatform("baidu"), "baidu");
  assert.equal(parseNetdiskCookiePlatform("quark"), "quark");
  assert.throws(() => parseNetdiskCookiePlatform("alipan"), /baidu or quark/u);
};

const runCookieNamesCase = (): void => {
  assert.deepEqual(getCookieNames("a=1; b=2; c=x=y"), ["a", "b", "c"]);
};

const main = (): void => {
  runPlatformEnvKeyCase();
  runParsePlatformCase();
  runCookieNamesCase();
};

main();
