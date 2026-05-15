import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const AUTH_URL = "https://xluser-ssl.xunlei.com/v1";
const CLIENT_ID = "Xqp0kJBXWhwaTpB6";
// 注意: 此 client_id 是 public client，token 请求不能带 client_secret
const CLIENT_VERSION = "1.92.42";
const QR_LOGIN_PAGE = "https://i.xunlei.com/center/account/personal/qrcode-login/";
const SDK_VERSION = "9.1.2";

export interface XunleiQrLoginOptions {
  writeEnv?: boolean;
  envPath?: string;
  silent?: boolean;
}

export interface XunleiQrLoginResult {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  userId?: string;
  wroteEnv: boolean;
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  expires_in?: number;
  interval?: number;
  verification_url?: string;
  verification_uri_complete?: string;
  short_uri_complete?: string;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  user_id?: string;
  sub?: string;
  error?: string;
  error_code?: number;
  error_description?: string;
}

function generateDeviceId(): string {
  return randomBytes(16).toString("hex");
}


function buildHeaders(deviceId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "origin": "https://pan.xunlei.com",
    "referer": "https://pan.xunlei.com/",
    "x-client-id": CLIENT_ID,
    "x-client-version": CLIENT_VERSION,
    "x-device-id": deviceId,
    "x-device-name": "PC-Chrome",
    "x-sdk-version": SDK_VERSION,
    "x-protocol-version": "301",
  };
}

export async function loginXunleiByQrCode(
  options: XunleiQrLoginOptions = {},
): Promise<XunleiQrLoginResult> {
  const log = options.silent ? () => {} : console.log.bind(console);
  const deviceId = generateDeviceId();
  const headers = buildHeaders(deviceId);

  const device = await requestDeviceCode(headers);

  if (!device.device_code) {
    throw new Error(`获取设备码失败: ${device.error_description ?? "unknown"}`);
  }

  // 用 i.xunlei.com 的二维码登录页构造扫码 URL（原始 verification_url 页面已下线）
  const userCode = device.user_code;
  if (!userCode) {
    throw new Error("获取二维码链接失败: 缺少 user_code");
  }
  const qrUrl = `${QR_LOGIN_PAGE}?client_id=${CLIENT_ID}&scope=profile%20offline%20pan%20user%20sso%20sync&user_code=${encodeURIComponent(userCode)}`;

  const qrText = await QRCode.toString(qrUrl, {
    type: "terminal",
    small: true,
  });
  log(qrText);
  log("请使用迅雷APP扫描上方二维码登录");

  const expiresIn = device.expires_in ?? 120;
  const interval = Math.max((device.interval ?? 2) * 1000, 2000);
  const startedAt = Date.now();

  let tokenResp: TokenResponse | undefined;

  while (Date.now() - startedAt < expiresIn * 1000) {
    await sleep(interval);

    const result = await pollToken(headers, device.device_code);

    if (result.access_token && result.refresh_token) {
      tokenResp = result;
      break;
    }

    if (result.error === "authorization_pending") {
      continue;
    }

    if (result.error === "slow_down") {
      await sleep(interval);
      continue;
    }

    if (result.error === "expired_token" || result.error === "access_denied") {
      throw new Error(`登录失败: ${result.error_description ?? result.error}`);
    }
  }

  if (!tokenResp?.access_token || !tokenResp?.refresh_token) {
    throw new Error("扫码登录超时");
  }

  const now = Date.now();
  const result: XunleiQrLoginResult = {
    refreshToken: tokenResp.refresh_token,
    accessToken: tokenResp.access_token,
    accessTokenExpiresAt: tokenResp.expires_in
      ? now + (tokenResp.expires_in - 60) * 1000
      : now + 7200_000,
    userId: tokenResp.user_id ?? tokenResp.sub,
    wroteEnv: false,
  };

  if (options.writeEnv) {
    writeTokensToEnv(options.envPath ?? ".env", result);
    result.wroteEnv = true;
  }

  log("迅雷登录成功!");
  return result;
}

async function requestDeviceCode(
  headers: Record<string, string>,
): Promise<DeviceCodeResponse> {
  const resp = await fetch(`${AUTH_URL}/auth/device/code`, {
    method: "POST",
    headers,
    body: JSON.stringify({ scope: "", client_id: CLIENT_ID }),
  });

  return (await resp.json()) as DeviceCodeResponse;
}

async function pollToken(
  headers: Record<string, string>,
  deviceCode: string,
): Promise<TokenResponse> {
  const resp = await fetch(`${AUTH_URL}/auth/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }),
  });

  return (await resp.json()) as TokenResponse;
}

function writeTokensToEnv(
  envPath: string,
  result: XunleiQrLoginResult,
): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  content = updateEnvValue(
    content,
    "NETDISK_TRANSFER_XUNLEI_REFRESH_TOKEN",
    result.refreshToken,
  );
  content = updateEnvValue(
    content,
    "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN",
    result.accessToken,
  );
  content = updateEnvValue(
    content,
    "NETDISK_TRANSFER_XUNLEI_ACCESS_TOKEN_EXPIRES_AT",
    String(result.accessTokenExpiresAt),
  );
  writeFileSync(envPath, content);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
