import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BrowserContext, chromium, Cookie, Page } from "playwright-core";

const DEFAULT_LOGIN_URL = "https://pan.quark.cn/";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const REQUIRED_COOKIE_NAMES = ["__puus", "kps", "sign", "vcode"];
const QUARK_COOKIE_DOMAINS = [
  "pan.quark.cn",
  "drive-pc.quark.cn",
  "drive.quark.cn",
  "quark.cn",
];
export const QUARK_LOGIN_QR_SELECTORS = [
  ".qrcode-display canvas",
  ".qrcode-display",
  ".qrcode-container canvas",
  ".qrcode-container",
];

export interface QuarkCookieLoginOptions {
  chromePath?: string;
  headless?: boolean;
  loginUrl?: string;
  qrScreenshotPath?: string;
  timeoutMs?: number;
  writeEnv?: boolean;
  envPath?: string;
}

export interface QuarkCookieLoginResult {
  cookie: string;
  cookieNames: string[];
  wroteEnv: boolean;
}

export const formatQuarkCookieHeader = (
  cookies: Array<Pick<Cookie, "name" | "value" | "domain">>,
): string => {
  const seen = new Set<string>();
  const pairs: string[] = [];

  for (const cookie of cookies) {
    if (!isQuarkCookieDomain(cookie.domain) || seen.has(cookie.name)) {
      continue;
    }

    seen.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }

  return pairs.join("; ");
};

export const updateEnvValue = (
  content: string,
  key: string,
  value: string,
): string => {
  const escapedValue = value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  const nextLine = `${key}="${escapedValue}"`;
  const pattern = new RegExp(`^${key}=.*$`, "mu");

  if (pattern.test(content)) {
    return content.replace(pattern, nextLine);
  }

  const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
  return `${content}${separator}${nextLine}\n`;
};

export const loginAndGetQuarkCookie = async (
  options: QuarkCookieLoginOptions = {},
): Promise<QuarkCookieLoginResult> => {
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
    if (options.qrScreenshotPath) {
      screenshotTimer = startScreenshotLoop(page, options.qrScreenshotPath);
      console.log(`QR screenshot will be refreshed at: ${options.qrScreenshotPath}`);
    }
    const cookies = await waitForLoginCookies(
      context,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const cookie = formatQuarkCookieHeader(cookies);
    if (!cookie) {
      throw new Error("Quark cookie is empty after login");
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
  for (const selector of QUARK_LOGIN_QR_SELECTORS) {
    const element = page.locator(selector).first();
    if (!(await element.isVisible().catch(() => false))) {
      continue;
    }

    await element.screenshot({ path: screenshotPath });
    return;
  }
};

const waitForLoginCookies = async (
  context: BrowserContext,
  timeoutMs: number,
): Promise<Cookie[]> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies([
      "https://pan.quark.cn/",
      "https://drive-pc.quark.cn/",
      "https://drive.quark.cn/",
    ]);
    if (hasUsableQuarkCookie(cookies)) {
      return cookies.filter((cookie) => isQuarkCookieDomain(cookie.domain));
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for Quark login cookies");
};

const writeCookieToEnv = (envPath: string, cookie: string): void => {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(
    envPath,
    updateEnvValue(existing, "NETDISK_TRANSFER_QUARK_COOKIE", cookie),
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

const isQuarkCookieDomain = (domain: string): boolean => {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  return QUARK_COOKIE_DOMAINS.some(
    (candidate) =>
      normalized === candidate || normalized.endsWith(`.${candidate}`),
  );
};

const hasUsableQuarkCookie = (cookies: Cookie[]): boolean => {
  const names = new Set(cookies.map((cookie) => cookie.name));
  if (names.has("__puus")) {
    return true;
  }

  return REQUIRED_COOKIE_NAMES.every((name) => names.has(name));
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
