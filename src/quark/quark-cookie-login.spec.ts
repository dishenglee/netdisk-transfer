import { strict as assert } from "node:assert";
import {
  QUARK_LOGIN_QR_SELECTORS,
  formatQuarkCookieHeader,
  updateEnvValue,
} from "./quark-cookie-login.js";

const runFormatCookieCase = (): void => {
  const cookie = formatQuarkCookieHeader([
    {
      name: "a",
      value: "1",
      domain: ".pan.quark.cn",
    },
    {
      name: "b",
      value: "2",
      domain: ".drive-pc.quark.cn",
    },
    {
      name: "ignore",
      value: "3",
      domain: ".example.com",
    },
  ]);

  assert.equal(cookie, "a=1; b=2");
};

const runUpdateExistingEnvCase = (): void => {
  const next = updateEnvValue(
    'PORT=3000\nNETDISK_TRANSFER_QUARK_COOKIE=""\nOTHER="1"\n',
    "NETDISK_TRANSFER_QUARK_COOKIE",
    "a=1; b=2",
  );

  assert.equal(
    next,
    'PORT=3000\nNETDISK_TRANSFER_QUARK_COOKIE="a=1; b=2"\nOTHER="1"\n',
  );
};

const runAppendEnvCase = (): void => {
  const next = updateEnvValue("PORT=3000\n", "NETDISK_TRANSFER_QUARK_COOKIE", "a=1");

  assert.equal(next, 'PORT=3000\nNETDISK_TRANSFER_QUARK_COOKIE="a=1"\n');
};

const main = (): void => {
  runFormatCookieCase();
  runUpdateExistingEnvCase();
  runAppendEnvCase();
  assert.ok(QUARK_LOGIN_QR_SELECTORS.includes(".qrcode-display canvas"));
};

main();
