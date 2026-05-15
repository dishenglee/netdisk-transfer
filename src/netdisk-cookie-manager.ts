import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BaiduDriveApiClient } from "./baidu/baidu-drive-api-client.js";
import { QuarkDriveApiClient } from "./quark/quark-drive-api-client.js";
import { updateEnvValue } from "./quark/quark-cookie-login.js";

export type NetdiskCookiePlatform = "baidu" | "quark";

export interface NetdiskCookieValidationResult {
  platform: NetdiskCookiePlatform;
  valid: boolean;
  message: string;
}

export const getNetdiskCookieEnvKey = (
  platform: NetdiskCookiePlatform,
): string => {
  if (platform === "baidu") {
    return "NETDISK_TRANSFER_BAIDU_COOKIE";
  }

  return "NETDISK_TRANSFER_QUARK_COOKIE";
};

export const parseNetdiskCookiePlatform = (
  value: string,
): NetdiskCookiePlatform => {
  if (value === "baidu" || value === "quark") {
    return value;
  }

  throw new Error("platform must be baidu or quark");
};

export const getCookieNames = (cookie: string): string[] =>
  cookie
    .split(";")
    .map((item) => item.trim().split("=")[0])
    .filter(Boolean);

export const writeNetdiskCookieToEnv = (
  envPath: string,
  platform: NetdiskCookiePlatform,
  cookie: string,
): void => {
  const trimmedCookie = cookie.trim();
  if (!trimmedCookie) {
    throw new Error("cookie is empty");
  }

  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(
    envPath,
    updateEnvValue(existing, getNetdiskCookieEnvKey(platform), trimmedCookie),
  );
};

export const validateNetdiskCookie = async (
  platform: NetdiskCookiePlatform,
  cookie: string,
): Promise<NetdiskCookieValidationResult> => {
  try {
    if (platform === "baidu") {
      const client = new BaiduDriveApiClient({ cookie });
      await client.getBdstoken();
      return {
        platform,
        valid: true,
        message: "Baidu cookie is valid",
      };
    }

    const client = new QuarkDriveApiClient({
      cookie,
      taskPollIntervalMs: 100,
      taskMaxAttempts: 1,
    });
    await client.listFiles("0");
    return {
      platform,
      valid: true,
      message: "Quark cookie is valid",
    };
  } catch (error) {
    return {
      platform,
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
