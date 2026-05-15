import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const QRCODE_URL = "https://passport.baidu.com/v2/api/getqrcode";
const UNICAST_URL = "https://passport.baidu.com/channel/unicast";
const BDUSS_LOGIN_URL =
  "https://passport.baidu.com/v3/login/main/qrbdusslogin";
const PAN_URL = "https://pan.baidu.com/disk/main";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface BaiduQrLoginOptions {
  writeEnv?: boolean;
  envPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  silent?: boolean;
}

export interface BaiduQrLoginResult {
  cookie: string;
  cookieNames: string[];
  wroteEnv: boolean;
}

interface QrcodeApiResponse {
  errno?: number;
  sign?: string;
  channel_id?: string;
}

interface UnicastApiResponse {
  errno?: number;
  channel_v?: string;
}

export async function loginBaiduByQrCode(
  options: BaiduQrLoginOptions = {},
): Promise<BaiduQrLoginResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const log = options.silent ? () => {} : console.log.bind(console);
  const gid = randomUUID().toUpperCase();
  const cookies = new Map<string, string>();

  const qr = await getQrCode(gid, cookies);
  const qrUrl = buildQrUrl(qr.channelId);

  const qrText = await QRCode.toString(qrUrl, {
    type: "terminal",
    small: true,
  });
  log(qrText);
  log("请使用百度网盘APP扫描上方二维码登录");

  const startedAt = Date.now();
  let bdussValue: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await pollUnicast(qr.channelId, gid, cookies);
    if (result.v) {
      bdussValue = result.v;
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (!bdussValue) {
    throw new Error("扫码登录超时");
  }

  log("扫码成功，正在获取 Cookie...");
  await exchangeBdussForCookies(bdussValue, gid, cookies);
  await visitPanPage(cookies);

  const cookie = formatCookieString(cookies);
  if (!cookie || !cookies.has("BDUSS")) {
    throw new Error("获取 Cookie 失败，缺少 BDUSS");
  }

  if (options.writeEnv) {
    const envPath = options.envPath ?? ".env";
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    writeFileSync(
      envPath,
      updateEnvValue(existing, "NETDISK_TRANSFER_BAIDU_COOKIE", cookie),
    );
  }

  log("百度网盘登录成功!");
  return {
    cookie,
    cookieNames: [...cookies.keys()],
    wroteEnv: Boolean(options.writeEnv),
  };
}

async function getQrCode(
  gid: string,
  cookies: Map<string, string>,
): Promise<{ channelId: string }> {
  const url = new URL(QRCODE_URL);
  url.searchParams.set("lp", "pc");
  url.searchParams.set("qrloginfrom", "pc");
  url.searchParams.set("gid", gid);
  url.searchParams.set("apiver", "v3");
  url.searchParams.set("tt", String(Date.now()));
  url.searchParams.set("tpl", "netdisk");

  const resp: Response = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": UA },
  });
  collectCookies(resp, cookies);

  const text = await resp.text();
  const json = parseJsonpOrJson(text) as QrcodeApiResponse;

  const channelId = json.channel_id ?? json.sign;
  if (!channelId) {
    throw new Error(`获取百度二维码失败: ${JSON.stringify(json)}`);
  }

  return { channelId };
}

function buildQrUrl(sign: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `https://wappass.baidu.com/wp/?qrlogin&t=${t}&error=0&sign=${sign}&cmd=login&lp=pc&tpl=netdisk&adapter=3&qrloginfrom=pc`;
}

async function pollUnicast(
  channelId: string,
  gid: string,
  cookies: Map<string, string>,
): Promise<{ v?: string }> {
  const url = new URL(UNICAST_URL);
  url.searchParams.set("channel_id", channelId);
  url.searchParams.set("gid", gid);
  url.searchParams.set("tpl", "netdisk");
  url.searchParams.set("apiver", "v3");
  url.searchParams.set("tt", String(Date.now()));
  url.searchParams.set("_", String(Date.now()));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);

  try {
    const resp: Response = await fetch(url, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        cookie: formatCookieString(cookies),
      },
      signal: controller.signal,
    });
    collectCookies(resp, cookies);

    const text = await resp.text();
    const json = parseJsonpOrJson(text) as UnicastApiResponse;

    if (json.errno === 0 && json.channel_v) {
      const inner = parseJsonpOrJson(json.channel_v) as {
        status?: number;
        v?: string;
      };
      if (inner.status === 0 && inner.v) {
        return { v: inner.v };
      }
    }
    return {};
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {};
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeBdussForCookies(
  bdussValue: string,
  gid: string,
  cookies: Map<string, string>,
): Promise<void> {
  const url = new URL(BDUSS_LOGIN_URL);
  url.searchParams.set("v", String(Date.now()));
  url.searchParams.set("bduss", bdussValue);
  url.searchParams.set("u", PAN_URL);
  url.searchParams.set("loginVersion", "v5");
  url.searchParams.set("qrcode", "1");
  url.searchParams.set("tpl", "netdisk");
  url.searchParams.set("apiver", "v3");
  url.searchParams.set("tt", String(Date.now()));
  url.searchParams.set("gid", gid);

  await followRedirects(url.toString(), cookies);
}

async function visitPanPage(cookies: Map<string, string>): Promise<void> {
  const url = new URL("https://pan.baidu.com/api/gettemplatevariable");
  url.searchParams.set("clienttype", "0");
  url.searchParams.set("app_id", "38824127");
  url.searchParams.set("web", "1");
  url.searchParams.set(
    "fields",
    '["bdstoken","token","uk","isdocuser","servertime"]',
  );

  const resp: Response = await fetch(url, {
    headers: {
      "user-agent": UA,
      cookie: formatCookieString(cookies),
      referer: PAN_URL,
    },
  });
  collectCookies(resp, cookies);
}

async function followRedirects(
  startUrl: string,
  cookies: Map<string, string>,
): Promise<void> {
  let currentUrl: string | null = startUrl;

  for (let i = 0; i < 15 && currentUrl; i++) {
    const resp: Response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        cookie: formatCookieString(cookies),
      },
    });
    collectCookies(resp, cookies);

    const location: string | null = resp.headers.get("location");
    if (location && resp.status >= 300 && resp.status < 400) {
      currentUrl = new URL(location, currentUrl).toString();
    } else {
      currentUrl = null;
    }
  }
}

function parseJsonpOrJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const match = trimmed.match(/^\w+\((.*)\);?$/s);
  try {
    return JSON.parse(match ? match[1] : trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function collectCookies(resp: Response, jar: Map<string, string>): void {
  const raw =
    typeof (resp.headers as any).getSetCookie === "function"
      ? (resp.headers as any).getSetCookie()
      : (resp.headers.get("set-cookie")?.split(/,(?=\s*\w+=)/) ?? []);

  for (const header of raw as string[]) {
    const nameValue = header.split(";")[0];
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      const name = nameValue.substring(0, eqIdx).trim();
      const value = nameValue.substring(eqIdx + 1).trim();
      if (value && value !== "EXPIRED") {
        jar.set(name, value);
      }
    }
  }
}

function formatCookieString(cookies: Map<string, string>): string {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
