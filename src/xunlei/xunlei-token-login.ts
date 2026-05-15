import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, Frame, Locator, Page, Response } from "playwright-core";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const DEFAULT_LOGIN_URL = "https://pan.xunlei.com/";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const XUNLEI_PAN_CLIENT_ID = "Xqp0kJBXWhwaTpB6";
const XUNLEI_QR_SWITCH_SELECTOR = ".xluweb-login-change";
const XUNLEI_QR_SELECTORS = [
  ".xluweb-login-qr-code__image img",
  ".xluweb-login-qr-code__image canvas",
  "img[alt='二维码']",
];
const XUNLEI_QR_SCREENSHOT_SELECTORS = [
  ".xluweb-login-panel.login-panel--code",
  ".xluweb-login-qr-code",
  ".xluweb-login-qr-code__container",
  ...XUNLEI_QR_SELECTORS,
];

export interface XunleiTokenLoginOptions {
  chromePath?: string;
  headless?: boolean;
  loginUrl?: string;
  qrScreenshotPath?: string;
  timeoutMs?: number;
  writeEnv?: boolean;
  envPath?: string;
}

export interface XunleiTokenLoginResult {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  captchaToken?: string;
  captchaTokenExpiresAt?: number;
  deviceId?: string;
  wroteEnv: boolean;
}

interface XunleiLocalCredentials {
  access_token?: string;
  refresh_token?: string;
  accessToken?: string;
  refreshToken?: string;
  expires_in?: number;
  expiresIn?: number;
  expires_at?: number | string;
  expiresAt?: number | string;
}

interface XunleiStorageSnapshot {
  deviceId?: string;
  values: Array<[string, string]>;
}

interface XunleiCaptchaResponse {
  captcha_token?: string;
  expires_in?: number;
}

export const loginAndGetXunleiRefreshToken = async (
  options: XunleiTokenLoginOptions = {},
): Promise<XunleiTokenLoginResult> => {
  let responseCredentials:
    | Omit<XunleiTokenLoginResult, "wroteEnv">
    | undefined;
  let captchaToken: string | undefined;
  let captchaTokenExpiresAt: number | undefined;
  const browser = await chromium.launch({
    headless: Boolean(options.headless),
    executablePath: getBrowserExecutablePath(options.chromePath),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext(
    options.qrScreenshotPath
      ? {
          deviceScaleFactor: 3,
          viewport: { width: 1280, height: 900 },
        }
      : undefined,
  );
  const page = await context.newPage();
  let screenshotTimer: NodeJS.Timeout | undefined;
  page.on("request", (request) => {
    const token = request.headers()["x-captcha-token"];
    if (token) {
      captchaToken = token;
      captchaTokenExpiresAt ??= Date.now() + 5 * 60 * 1000;
    }
  });
  page.on("response", (response) => {
    void readResponseCredentials(response)
      .then((credentials) => {
        if (credentials.refreshToken) {
          responseCredentials = credentials;
        }
      })
      .catch(() => undefined);
    void readResponseCaptcha(response)
      .then((captcha) => {
        if (captcha.captchaToken) {
          captchaToken = captcha.captchaToken;
          captchaTokenExpiresAt = captcha.captchaTokenExpiresAt;
        }
      })
      .catch(() => undefined);
  });

  try {
    await page.goto(options.loginUrl ?? DEFAULT_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.bringToFront();
    if (options.headless || options.qrScreenshotPath) {
      await openXunleiQrLogin(page);
    }

    if (options.qrScreenshotPath) {
      screenshotTimer = startScreenshotLoop(page, options.qrScreenshotPath);
      console.log(`QR screenshot will be refreshed at: ${options.qrScreenshotPath}`);
    }

    const credentials = await waitForLocalCredentials(
      page,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      () => responseCredentials,
    );
    await warmXunleiPanSession(page, options.loginUrl ?? DEFAULT_LOGIN_URL);
    await waitForCaptchaToken(page, () => captchaToken, 15000);
    const resultCredentials = {
      ...credentials,
      captchaToken,
      captchaTokenExpiresAt,
    };
    if (options.writeEnv) {
      writeTokenToEnv(
        options.envPath ?? ".env",
        resultCredentials,
      );
    }

    return {
      ...resultCredentials,
      wroteEnv: Boolean(options.writeEnv),
    };
  } finally {
    if (screenshotTimer) {
      clearInterval(screenshotTimer);
    }
    await browser.close();
  }
};

const waitForCaptchaToken = async (
  page: Page,
  getCaptchaToken: () => string | undefined,
  timeoutMs: number,
): Promise<void> => {
  const startedAt = Date.now();
  while (!getCaptchaToken() && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(1000);
  }
};

const waitForLocalCredentials = async (
  page: Page,
  timeoutMs: number,
  getResponseCredentials?: () =>
    | Omit<XunleiTokenLoginResult, "wroteEnv">
    | undefined,
): Promise<Omit<XunleiTokenLoginResult, "wroteEnv">> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const credentials = await readLocalCredentials(page);
    if (credentials.refreshToken) {
      return credentials;
    }

    const responseCredentials = getResponseCredentials?.();
    if (responseCredentials?.refreshToken) {
      await page.waitForTimeout(3000);
      const stableCredentials = await readLocalCredentials(page);
      return stableCredentials.refreshToken
        ? stableCredentials
        : responseCredentials;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Timed out waiting for Xunlei refresh_token");
};

const readLocalCredentials = async (
  page: Page,
): Promise<Omit<XunleiTokenLoginResult, "wroteEnv">> => {
  for (const target of getSearchTargets(page)) {
    const snapshot = await readStorageSnapshot(target).catch(() => undefined);
    if (!snapshot) {
      continue;
    }

    const credentials = extractCredentials(snapshot);
    if (credentials.refreshToken) {
      return credentials;
    }
  }

  return { refreshToken: "" };
};

const readStorageSnapshot = async (
  target: Page | Frame,
): Promise<XunleiStorageSnapshot> =>
  target.evaluate(() => {
    const values: Array<[string, string]> = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const key of Object.keys(storage)) {
        const value = storage.getItem(key);
        if (value) {
          values.push([key, value]);
        }
      }
    }

    return {
      deviceId: window.localStorage.getItem("deviceid") ?? undefined,
      values,
    };
  });

const readResponseCredentials = async (
  response: Response,
): Promise<Omit<XunleiTokenLoginResult, "wroteEnv">> => {
  const url = response.url();
  if (!/xunlei\.com/i.test(url) || !/auth|oauth|token/i.test(url)) {
    return { refreshToken: "" };
  }

  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) {
    return { refreshToken: "" };
  }

  const json = (await response.json().catch(() => undefined)) as
    | XunleiLocalCredentials
    | undefined;
  if (!json) {
    return { refreshToken: "" };
  }

  return normalizeCredentials(json, Date.now());
};

const readResponseCaptcha = async (
  response: Response,
): Promise<Pick<XunleiTokenLoginResult, "captchaToken" | "captchaTokenExpiresAt">> => {
  const url = response.url();
  if (!url.includes("/v1/shield/captcha/init")) {
    return {};
  }

  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) {
    return {};
  }

  const json = (await response.json().catch(() => undefined)) as
    | XunleiCaptchaResponse
    | undefined;
  if (!json?.captcha_token) {
    return {};
  }

  return {
    captchaToken: json.captcha_token,
    captchaTokenExpiresAt: json.expires_in
      ? Date.now() + Math.max(json.expires_in - 30, 1) * 1000
      : undefined,
  };
};

const extractCredentials = (
  snapshot: XunleiStorageSnapshot,
): Omit<XunleiTokenLoginResult, "wroteEnv"> => {
  const preferred = snapshot.values.find(
    ([key]) => key === `credentials_${XUNLEI_PAN_CLIENT_ID}`,
  );
  const preferredCredentials = preferred
    ? extractCredentialsFromEntry(preferred, snapshot.deviceId)
    : undefined;
  if (preferredCredentials?.refreshToken) {
    return preferredCredentials;
  }

  for (const [key, value] of snapshot.values) {
    if (!/credential|token|auth/i.test(`${key} ${value}`)) {
      continue;
    }

    const credentials = extractCredentialsFromEntry([key, value], snapshot.deviceId);
    if (credentials.refreshToken) {
      return credentials;
    }
  }

  return { refreshToken: "", deviceId: snapshot.deviceId };
};

const extractCredentialsFromEntry = (
  [, value]: [string, string],
  deviceId?: string,
): Omit<XunleiTokenLoginResult, "wroteEnv"> => {
  const fromJson = parseCredentialJson(value);
  if (fromJson.refreshToken) {
    return {
      ...fromJson,
      deviceId: fromJson.deviceId ?? deviceId,
    };
  }

  const refreshToken = value.match(/"refresh_token"\s*:\s*"([^"]+)"/)?.[1];
  if (refreshToken) {
    return {
      refreshToken,
      accessToken: value.match(/"access_token"\s*:\s*"([^"]+)"/)?.[1],
      deviceId,
    };
  }

  return { refreshToken: "", deviceId };
};

const parseCredentialJson = (
  value: string,
): Omit<XunleiTokenLoginResult, "wroteEnv"> => {
  try {
    return normalizeCredentials(JSON.parse(value) as XunleiLocalCredentials);
  } catch {
    return { refreshToken: "" };
  }
};

const normalizeCredentials = (
  value: XunleiLocalCredentials,
  now = Date.now(),
): Omit<XunleiTokenLoginResult, "wroteEnv"> => {
  const expiresAt = value.expires_at ?? value.expiresAt;
  const expiresIn = value.expires_in ?? value.expiresIn;

  return {
    refreshToken: value.refresh_token ?? value.refreshToken ?? "",
    accessToken: value.access_token ?? value.accessToken,
    accessTokenExpiresAt:
      parseExpiresAt(expiresAt) ??
      (expiresIn ? now + (expiresIn - 60) * 1000 : undefined),
  };
};

const parseExpiresAt = (value?: number | string): number | undefined => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const openXunleiQrLogin = async (page: Page): Promise<void> => {
  if (!(await waitForLoginFrame(page, 30000))) {
    return;
  }

  await page.waitForTimeout(3000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await hasVisibleQrCode(page)) {
      return;
    }

    const loginFrame = await waitForLoginFrame(page, 10000);
    if (!loginFrame) {
      continue;
    }

    await clickQrSwitch(page, loginFrame);

    await page.waitForTimeout(1500);
  }
};

const waitForLoginFrame = async (
  page: Page,
  timeoutMs: number,
): Promise<Frame | undefined> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of page.frames()) {
      if (
        await frame
          .locator(".xluweb-login-panel, .login-component")
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  return undefined;
};

const clickQrSwitch = async (page: Page, frame: Frame): Promise<void> => {
  const switchLocator = frame.locator(XUNLEI_QR_SWITCH_SELECTOR).first();
  if (!(await switchLocator.isVisible().catch(() => false))) {
    return;
  }

  await switchLocator
    .click({ force: true, position: { x: 30, y: 30 }, timeout: 3000 })
    .catch(() => undefined);

  if (await hasVisibleQrCode(page)) {
    return;
  }

  await frame
    .evaluate((selector) => {
      (document.querySelector(selector) as HTMLElement | null)?.click();
    }, XUNLEI_QR_SWITCH_SELECTOR)
    .catch(() => undefined);

  if (await hasVisibleQrCode(page)) {
    return;
  }

  const box = await switchLocator.boundingBox().catch(() => undefined);
  if (box) {
    await page.mouse
      .click(box.x + box.width / 2, box.y + box.height / 2)
      .catch(() => undefined);
  }
};

const waitForVisibleLocator = async (
  page: Page,
  selectors: string[],
  timeoutMs: number,
): Promise<Locator | undefined> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const element = await findVisibleLocator(page, selectors);
    if (element) {
      return element;
    }

    await page.waitForTimeout(500);
  }

  return undefined;
};

const startScreenshotLoop = (
  page: Page,
  screenshotPath: string,
): NodeJS.Timeout => {
  void captureLoginScreenshot(page, screenshotPath).catch(() => {});

  return setInterval(() => {
    void captureLoginScreenshot(page, screenshotPath).catch(() => {});
  }, 2000);
};

const captureLoginScreenshot = async (
  page: Page,
  screenshotPath: string,
): Promise<void> => {
  if (!(await hasVisibleQrCode(page))) {
    await openXunleiQrLogin(page);
  }

  const element = await waitForVisibleLocator(
    page,
    XUNLEI_QR_SCREENSHOT_SELECTORS,
    5000,
  );
  if (element) {
    await element.screenshot({ path: screenshotPath });
    return;
  }

  if (!existsSync(screenshotPath)) {
    throw new Error("Xunlei QR code is not visible yet");
  }
};

const hasVisibleQrCode = async (page: Page): Promise<boolean> =>
  Boolean(await findVisibleQrLocator(page));

const findVisibleQrLocator = async (page: Page): Promise<Locator | undefined> => {
  return findVisibleLocator(page, XUNLEI_QR_SELECTORS);
};

const findVisibleLocator = async (
  page: Page,
  selectors: string[],
): Promise<Locator | undefined> => {
  for (const frame of page.frames()) {
    if (
      !(await frame
        .locator(".xluweb-login-panel, .login-component")
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      continue;
    }

    for (const selector of selectors) {
      const element = frame.locator(selector).first();
      if (await element.isVisible().catch(() => false)) {
        return element;
      }
    }
  }

  return undefined;
};

const getSearchTargets = (page: Page): Array<Page | Frame> => [
  page,
  ...page.frames(),
];

const warmXunleiPanSession = async (
  page: Page,
  loginUrl: string,
): Promise<void> => {
  if (!page.url().startsWith("https://pan.xunlei.com")) {
    await page
      .goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => undefined);
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
};

const writeTokenToEnv = (
  envPath: string,
  credentials: Omit<XunleiTokenLoginResult, "wroteEnv">,
): void => {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  let next = updateEnvValue(
    existing,
    "NETDISK_TRANSFER_XUNLEI_REFRESH_TOKEN",
    credentials.refreshToken,
  );
  if (credentials.accessToken) {
    next = updateEnvValue(
      next,
      "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN",
      credentials.accessToken,
    );
  }
  if (credentials.accessTokenExpiresAt) {
    next = updateEnvValue(
      next,
      "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN_EXPIRES_AT",
      String(credentials.accessTokenExpiresAt),
    );
  }
  if (credentials.captchaToken) {
    next = updateEnvValue(
      next,
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN",
      credentials.captchaToken,
    );
  }
  if (credentials.captchaTokenExpiresAt) {
    next = updateEnvValue(
      next,
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN_EXPIRES_AT",
      String(credentials.captchaTokenExpiresAt),
    );
  }
  if (credentials.deviceId) {
    next = updateEnvValue(
      next,
      "NETDISK_TRANSFER_XUNLEI_DEVICE_ID",
      credentials.deviceId,
    );
  }

  writeFileSync(envPath, next);
};

const getBrowserExecutablePath = (configured?: string): string | undefined => {
  if (configured) {
    return configured;
  }

  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
};
