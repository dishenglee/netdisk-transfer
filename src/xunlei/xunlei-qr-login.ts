import { existsSync, readFileSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const AUTH_URL = "https://xluser-ssl.xunlei.com/v1";
const DEFAULT_CLIENT_ID = "Xqp0kJBXWhwaTpB6";
const DEFAULT_CLIENT_SECRET = "Xp6vsy4tN9toTVdMSpomVdXpRmES";

export interface XunleiQrLoginOptions {
  clientId?: string;
  clientSecret?: string;
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

export async function loginXunleiByQrCode(
  options: XunleiQrLoginOptions = {},
): Promise<XunleiQrLoginResult> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = options.clientSecret ?? DEFAULT_CLIENT_SECRET;
  const log = options.silent ? () => {} : console.log.bind(console);

  const device = await requestDeviceCode(clientId);

  if (!device.device_code) {
    throw new Error(`获取设备码失败: ${device.error_description ?? "unknown"}`);
  }

  const qrUrl = device.short_uri_complete ?? device.verification_uri_complete ?? device.verification_url;
  if (!qrUrl) {
    throw new Error("获取二维码链接失败");
  }

  const qrText = await QRCode.toString(qrUrl, { type: "terminal", small: true });
  log(qrText);
  log("请使用迅雷APP扫描上方二维码登录");

  const expiresIn = device.expires_in ?? 120;
  const interval = Math.max((device.interval ?? 2) * 1000, 2000);
  const startedAt = Date.now();

  let tokenResp: TokenResponse | undefined;

  while (Date.now() - startedAt < expiresIn * 1000) {
    await sleep(interval);

    const result = await pollToken(clientId, clientSecret, device.device_code);

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

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const resp = await fetch(`${AUTH_URL}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });

  return (await resp.json()) as DeviceCodeResponse;
}

async function pollToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
): Promise<TokenResponse> {
  const resp = await fetch(`${AUTH_URL}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
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
