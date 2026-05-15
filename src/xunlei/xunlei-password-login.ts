import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { updateEnvValue } from "../quark/quark-cookie-login.js";

const AUTH_URL = "https://xluser-ssl.xunlei.com/v1";
const DEFAULT_CLIENT_ID = "Xp6vsxz_7IYVw2BB";
const DEFAULT_CLIENT_SECRET = "Xp6vsy4tN9toTVdMSpomVdXpRmES";
const DEFAULT_CLIENT_VERSION = "7.51.0.8196";
const DEFAULT_PACKAGE_NAME = "com.xunlei.downloadprovider";

export interface XunleiPasswordLoginOptions {
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  clientVersion?: string;
  packageName?: string;
  deviceId?: string;
  writeEnv?: boolean;
  envPath?: string;
  silent?: boolean;
}

export interface XunleiPasswordLoginResult {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  captchaToken?: string;
  captchaTokenExpiresAt?: number;
  deviceId: string;
  userId?: string;
  wroteEnv: boolean;
}

interface CaptchaInitResponse {
  captcha_token?: string;
  expires_in?: number;
}

interface SigninResponse {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: string;
  sub?: string;
  captcha_token?: string;
}

export async function loginXunleiByPassword(
  options: XunleiPasswordLoginOptions = {},
): Promise<XunleiPasswordLoginResult> {
  const log = options.silent ? () => {} : console.log.bind(console);
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = options.clientSecret ?? DEFAULT_CLIENT_SECRET;
  const clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const deviceId = options.deviceId ?? generateDeviceId();

  let username = options.username;
  let password = options.password;

  if (!username || !password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!username) {
        username = await rl.question("请输入迅雷账号（手机号/邮箱）: ");
      }
      if (!password) {
        password = await rl.question("请输入密码: ");
      }
    } finally {
      rl.close();
    }
  }

  if (!username || !password) {
    throw new Error("用户名和密码不能为空");
  }

  log("正在初始化验证...");
  const timestamp = Math.floor(Date.now() / 1000);
  const captchaSign = buildCaptchaSign(
    clientId,
    clientVersion,
    packageName,
    deviceId,
    timestamp,
  );

  const captchaResult = await initCaptcha({
    clientId,
    deviceId,
    captchaSign,
    timestamp,
  });

  log("正在登录...");
  const signinResult = await signin({
    username,
    password,
    captchaToken: captchaResult.captchaToken,
    clientId,
    clientSecret,
  });

  if (!signinResult.refresh_token || !signinResult.access_token) {
    throw new Error(
      `登录失败: ${JSON.stringify(signinResult)}`,
    );
  }

  const now = Date.now();
  const result: XunleiPasswordLoginResult = {
    refreshToken: signinResult.refresh_token,
    accessToken: signinResult.access_token,
    accessTokenExpiresAt: signinResult.expires_in
      ? now + (signinResult.expires_in - 60) * 1000
      : now + 7200_000,
    captchaToken: signinResult.captcha_token ?? captchaResult.captchaToken,
    captchaTokenExpiresAt: captchaResult.captchaTokenExpiresAt,
    deviceId,
    userId: signinResult.user_id ?? signinResult.sub,
    wroteEnv: false,
  };

  if (options.writeEnv) {
    writeTokensToEnv(options.envPath ?? ".env", result);
    result.wroteEnv = true;
  }

  log("迅雷登录成功!");
  return result;
}

async function initCaptcha(params: {
  clientId: string;
  deviceId: string;
  captchaSign: string;
  timestamp: number;
}): Promise<{ captchaToken: string; captchaTokenExpiresAt?: number }> {
  const resp = await fetch(`${AUTH_URL}/shield/captcha/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: params.clientId,
      device_id: params.deviceId,
      action: "POST:/v1/auth/signin",
      captcha_sign: params.captchaSign,
      timestamp: String(params.timestamp),
      meta: { captcha_sign: params.captchaSign, client_version: DEFAULT_CLIENT_VERSION },
    }),
  });

  const json = (await resp.json()) as CaptchaInitResponse;
  if (!json.captcha_token) {
    throw new Error(`初始化验证失败: ${JSON.stringify(json)}`);
  }

  return {
    captchaToken: json.captcha_token,
    captchaTokenExpiresAt: json.expires_in
      ? Date.now() + Math.max(json.expires_in - 30, 1) * 1000
      : undefined,
  };
}

async function signin(params: {
  username: string;
  password: string;
  captchaToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<SigninResponse> {
  const resp = await fetch(`${AUTH_URL}/auth/signin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-captcha-token": params.captchaToken,
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      username: params.username,
      password: params.password,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`登录请求失败 (${resp.status}): ${text}`);
  }

  return (await resp.json()) as SigninResponse;
}

function buildCaptchaSign(
  clientId: string,
  clientVersion: string,
  packageName: string,
  deviceId: string,
  timestamp: number,
): string {
  const raw = `${clientId}${clientVersion}${packageName}${deviceId}${timestamp}`;
  return `1.${md5(raw)}`;
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function generateDeviceId(): string {
  const raw = `${Date.now()}${Math.random()}`;
  return md5(raw);
}

function writeTokensToEnv(
  envPath: string,
  result: XunleiPasswordLoginResult,
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
  if (result.captchaToken) {
    content = updateEnvValue(
      content,
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN",
      result.captchaToken,
    );
  }
  if (result.captchaTokenExpiresAt) {
    content = updateEnvValue(
      content,
      "NETDISK_TRANSFER_XUNLEI_CAPTCHA_TOKEN_EXPIRES_AT",
      String(result.captchaTokenExpiresAt),
    );
  }
  content = updateEnvValue(
    content,
    "NETDISK_TRANSFER_XUNLEI_DEVICE_ID",
    result.deviceId,
  );
  writeFileSync(envPath, content);
}
