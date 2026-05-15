import { strict as assert } from "node:assert";
import {
  BAIDU_LOGIN_BUTTON_TEXTS,
  formatBaiduCookieHeader,
} from "./baidu-cookie-login.js";

const runFormatCookieCase = (): void => {
  const cookie = formatBaiduCookieHeader([
    {
      name: "BAIDUID",
      value: "1",
      domain: ".baidu.com",
    },
    {
      name: "BDUSS",
      value: "2",
      domain: ".pan.baidu.com",
    },
    {
      name: "ignore",
      value: "3",
      domain: ".example.com",
    },
  ]);

  assert.deepEqual(new Set(cookie.split("; ")), new Set(["BAIDUID=1", "BDUSS=2"]));
};

const runPreferPanDomainCookieCase = (): void => {
  const cookie = formatBaiduCookieHeader([
    {
      name: "STOKEN",
      value: "generic",
      domain: ".baidu.com",
    },
    {
      name: "STOKEN",
      value: "pan",
      domain: ".pan.baidu.com",
    },
  ]);

  assert.equal(cookie, "STOKEN=pan");
};

const main = (): void => {
  runFormatCookieCase();
  runPreferPanDomainCookieCase();
  assert.ok(BAIDU_LOGIN_BUTTON_TEXTS.includes("去登录"));
};

main();
