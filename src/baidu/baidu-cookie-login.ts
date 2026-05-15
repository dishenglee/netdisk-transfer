import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BrowserContext, chromium, Cookie, Page } from "playwright-core";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const DEFAULT_LOGIN_URL = "https://pan.baidu.com/disk/main";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const BAIDU_COOKIE_DOMAINS = [
  "pan.baidu.com",
  "baidu.com",
  "passport.baidu.com",
];
export const BAIDU_LOGIN_BUTTON_TEXTS = ["去登录", "登录", "扫码登录"];
const BAIDU_LOGIN_BUTTON_SELECTORS = [
  "button.bd-login-button__wrapper",
  ".bd-login-button__wrapper",
];

export interface BaiduCookieLoginOptions {
  chromePath?: string;
  headless?: boolean;
  loginUrl?: string;
  qrScreenshotPath?: string;
  timeoutMs?: number;
  writeEnv?: boolean;
  envPath?: string;
}

export interface BaiduCookieLoginResult {
  cookie: string;
  cookieNames: string[];
  wroteEnv: boolean;
}

export const formatBaiduCookieHeader = (
  cookies: Array<Pick<Cookie, "name" | "value" | "domain">>,
): string => {
  const seen = new Set<string>();
  const pairs: string[] = [];
  const sortedCookies = [...cookies].sort(
    (left, right) =>
      getBaiduCookieDomainPriority(right.domain) -
      getBaiduCookieDomainPriority(left.domain),
  );

  for (const cookie of sortedCookies) {
    if (!isBaiduCookieDomain(cookie.domain) || seen.has(cookie.name)) {
      continue;
    }

    seen.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }

  return pairs.join("; ");
};

export const loginAndGetBaiduCookie = async (
  options: BaiduCookieLoginOptions = {},
): Promise<BaiduCookieLoginResult> => {
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

  try {
    await page.goto(options.loginUrl ?? DEFAULT_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.bringToFront();
    await openBaiduLoginDialogIfPresent(page);
    if (options.qrScreenshotPath) {
      screenshotTimer = startScreenshotLoop(page, options.qrScreenshotPath);
      console.log(`QR screenshot will be refreshed at: ${options.qrScreenshotPath}`);
    }
    const cookies = await waitForLoginCookies(
      context,
      page,
      options.loginUrl ?? DEFAULT_LOGIN_URL,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const cookie = formatBaiduCookieHeader(cookies);
    if (!cookie) {
      throw new Error("Baidu cookie is empty after login");
    }

    if (options.writeEnv) {
      writeCookieToEnv(options.envPath ?? ".env", cookie);
    }

    return {
      cookie,
      cookieNames: cookies.map((item) => item.name),
      wroteEnv: Boolean(options.writeEnv),
    };
  } finally {
    if (screenshotTimer) {
      clearInterval(screenshotTimer);
    }
    await browser.close();
  }
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
  const selectors = [
    "#TANGRAM__PSP_11__QrcodeMain",
    ".tang-pass-qrcode-img",
    "#TANGRAM__PSP_11__qrcodeContent",
    "#TANGRAM__PSP_11__qrcode",
    "#passport-login-pop",
  ];

  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if (!(await element.isVisible().catch(() => false))) {
      continue;
    }

    await element.screenshot({ path: screenshotPath });
    return;
  }
};

const openBaiduLoginDialogIfPresent = async (page: Page): Promise<void> => {
  if (await hasVisibleBaiduLoginDialog(page)) {
    return;
  }

  for (const selector of BAIDU_LOGIN_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    await button.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    return;
  }

  for (const text of BAIDU_LOGIN_BUTTON_TEXTS) {
    const button = page.getByRole("button", { name: text }).first();
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    await button.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    return;
  }
};

const hasVisibleBaiduLoginDialog = async (page: Page): Promise<boolean> => {
  const selectors = [
    ".tang-pass-login",
    ".tang-pass-qrcode",
    "#TANGRAM__PSP_11__qrcode",
  ];

  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
};

const waitForLoginCookies = async (
  context: BrowserContext,
  page: Page,
  loginUrl: string,
  timeoutMs: number,
): Promise<Cookie[]> => {
  const startedAt = Date.now();
  let triedPanAuth = false;

  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies([
      "https://pan.baidu.com/",
      "https://passport.baidu.com/",
      "https://www.baidu.com/",
    ]);
    if (!hasUsableBaiduCookie(cookies)) {
      await openBaiduLoginDialogIfPresent(page);
      await sleep(1000);
      continue;
    }

    if (!triedPanAuth) {
      triedPanAuth = true;
      await page.goto(loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    const nextCookies = await context.cookies([
      "https://pan.baidu.com/",
      "https://passport.baidu.com/",
      "https://www.baidu.com/",
    ]);
    if (await hasValidPanSession(nextCookies)) {
      return nextCookies.filter((cookie) => isBaiduCookieDomain(cookie.domain));
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for Baidu login cookies");
};

const writeCookieToEnv = (envPath: string, cookie: string): void => {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(
    envPath,
    updateEnvValue(existing, "NETDISK_TRANSFER_BAIDU_COOKIE", cookie),
  );
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

const isBaiduCookieDomain = (domain: string): boolean => {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  return BAIDU_COOKIE_DOMAINS.some(
    (candidate) =>
      normalized === candidate || normalized.endsWith(`.${candidate}`),
  );
};

const getBaiduCookieDomainPriority = (domain: string): number => {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  if (normalized === "pan.baidu.com") {
    return 3;
  }
  if (normalized.endsWith(".pan.baidu.com")) {
    return 2;
  }
  if (normalized === "baidu.com" || normalized.endsWith(".baidu.com")) {
    return 1;
  }

  return 0;
};

const hasUsableBaiduCookie = (cookies: Cookie[]): boolean => {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has("BAIDUID") && (names.has("BDUSS") || names.has("STOKEN"));
};

const hasValidPanSession = async (cookies: Cookie[]): Promise<boolean> => {
  const cookie = formatBaiduCookieHeader(cookies);
  if (!cookie) {
    return false;
  }

  try {
    const url = new URL("https://pan.baidu.com/api/gettemplatevariable");
    url.searchParams.set("clienttype", "0");
    url.searchParams.set("app_id", "38824127");
    url.searchParams.set("web", "1");
    url.searchParams.set(
      "fields",
      '["bdstoken","token","uk","isdocuser","servertime"]',
    );
    const response = await fetch(url, {
      headers: {
        cookie,
        referer: DEFAULT_LOGIN_URL,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      },
    });
    const json = (await response.json()) as {
      errno?: number;
      result?: { bdstoken?: string };
    };

    return json.errno === 0 && Boolean(json.result?.bdstoken);
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
