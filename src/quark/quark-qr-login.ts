import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { updateEnvValue } from "./quark-cookie-login.js";

const CLIENT_ID = "532";
const TOKEN_URL = "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin";
const POLL_URL = "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken";
const EXCHANGE_URL = "https://pan.quark.cn/account/info";

export interface QuarkQrLoginOptions {
  writeEnv?: boolean;
  envPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  silent?: boolean;
}

export interface QuarkQrLoginResult {
  cookie: string;
  cookieNames: string[];
  wroteEnv: boolean;
}

interface QrTokenResponse {
  status: number;
  message: string;
  data?: { members?: { token?: string } };
}

interface QrPollResponse {
  status: number;
  message: string;
  data?: { members?: { service_ticket?: string } };
}

export async function loginQuarkByQrCode(
  options: QuarkQrLoginOptions = {},
): Promise<QuarkQrLoginResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const log = options.silent ? () => {} : console.log.bind(console);

  const token = await getQrToken();
  const qrUrl = buildQrUrl(token);
  const qrText = await QRCode.toString(qrUrl, { type: "terminal", small: true });
  log(qrText);
  log("请使用夸克APP扫描上方二维码登录");

  const startedAt = Date.now();
  let serviceTicket: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await pollQrStatus(token);
    if (result.ticket) {
      serviceTicket = result.ticket;
      break;
    }
    if (result.expired) {
      throw new Error("二维码已过期，请重试");
    }
    await sleep(pollIntervalMs);
  }

  if (!serviceTicket) {
    throw new Error("扫码登录超时");
  }

  log("扫码成功，正在获取 Cookie...");
  const cookies = await exchangeTicketForCookies(serviceTicket);
  const cookie = formatCookieString(cookies);

  if (!cookie) {
    throw new Error("获取 Cookie 失败，响应中没有有效的 Set-Cookie");
  }

  if (options.writeEnv) {
    const envPath = options.envPath ?? ".env";
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    writeFileSync(
      envPath,
      updateEnvValue(existing, "NETDISK_TRANSFER_QUARK_COOKIE", cookie),
    );
  }

  log("夸克网盘登录成功!");
  return {
    cookie,
    cookieNames: [...cookies.keys()],
    wroteEnv: Boolean(options.writeEnv),
  };
}

async function getQrToken(): Promise<string> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("v", "1.2");
  url.searchParams.set("request_id", randomUUID());

  const resp = await fetch(url);
  const json = (await resp.json()) as QrTokenResponse;
  const token = json.data?.members?.token;
  if (json.status !== 2000000 || !token) {
    throw new Error(`获取二维码失败: ${json.message ?? json.status}`);
  }
  return token;
}

function buildQrUrl(token: string): string {
  return `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=${CLIENT_ID}&ssb=weblogin&uc_param_str=&uc_biz_str=S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0`;
}

async function pollQrStatus(
  token: string,
): Promise<{ ticket?: string; expired?: boolean }> {
  const url = new URL(POLL_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("v", "1.2");
  url.searchParams.set("token", token);
  url.searchParams.set("request_id", randomUUID());

  const resp = await fetch(url);
  const json = (await resp.json()) as QrPollResponse;

  if (json.status === 2000000) {
    return { ticket: json.data?.members?.service_ticket };
  }
  if (json.status === 50004002 || json.status === 50004003) {
    return { expired: true };
  }
  return {};
}

async function exchangeTicketForCookies(
  serviceTicket: string,
): Promise<Map<string, string>> {
  const cookies = new Map<string, string>();
  let currentUrl: string | null =
    `${EXCHANGE_URL}?st=${encodeURIComponent(serviceTicket)}&lw=scan`;

  for (let i = 0; i < 10 && currentUrl; i++) {
    const resp: Response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        cookie: formatCookieString(cookies),
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

  return cookies;
}

function collectCookies(resp: Response, jar: Map<string, string>): void {
  const raw =
    typeof (resp.headers as any).getSetCookie === "function"
      ? (resp.headers as any).getSetCookie()
      : resp.headers.get("set-cookie")?.split(/,(?=\s*\w+=)/) ?? [];

  for (const header of raw as string[]) {
    const nameValue = header.split(";")[0];
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      jar.set(nameValue.substring(0, eqIdx).trim(), nameValue.substring(eqIdx + 1).trim());
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
