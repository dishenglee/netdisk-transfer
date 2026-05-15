import { createHash } from "node:crypto";
import {
  XunleiCreatedShare,
  XunleiDriveClient,
  XunleiDriveFile,
  XunleiRestoreTaskResult,
  XunleiShareDetail,
  XunleiShareOptions,
  XunleiSharedFile,
} from "./xunlei-drive-client.js";

export type XunleiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface XunleiDriveApiClientOptions {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  captchaToken?: string;
  captchaTokenExpiresAt?: number;
  clientId: string;
  deviceId: string;
  captchaAction: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
  fetchFn?: XunleiFetch;
  onRefreshToken?: (refreshToken: string) => void;
  now?: () => number;
}

interface XunleiTokenData {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface XunleiCaptchaData extends XunleiErrorEnvelope {
  captcha_token?: string;
  expires_in?: number;
  url?: string;
}

interface XunleiCaptchaMeta {
  captcha_sign: string;
  client_version: string;
  package_name: string;
  timestamp: string;
  user_id: string;
}

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface CachedCaptcha {
  action: string;
  token: string;
  expiresAt: number;
}

interface XunleiErrorEnvelope {
  error?: string;
  error_code?: number | string;
  error_description?: string;
  message?: string;
}

interface XunleiShareFileData {
  id?: string;
  file_id?: string;
  name?: string;
  is_dir?: boolean;
  kind?: string;
}

interface XunleiShareDetailData extends XunleiErrorEnvelope {
  share_status?: string;
  share_status_text?: string;
  title?: string;
  pass_code_token?: string;
  files?: XunleiShareFileData[];
}

interface XunleiFileData extends XunleiErrorEnvelope {
  id?: string;
  file_id?: string;
  name?: string;
  kind?: string;
  is_dir?: boolean;
}

interface XunleiFileListData extends XunleiErrorEnvelope {
  files?: XunleiFileData[];
  next_page_token?: string;
}

interface XunleiCreateFolderData extends XunleiErrorEnvelope {
  file?: XunleiFileData;
}

interface XunleiRestoreData extends XunleiErrorEnvelope {
  restore_task_id?: string;
}

interface XunleiTaskData extends XunleiErrorEnvelope {
  progress?: number;
  message?: string;
  params?: {
    trace_file_ids?: string;
  };
}

interface XunleiShareData extends XunleiErrorEnvelope {
  share_url?: string;
  pass_code?: string;
}

const XUNLEI_USER_BASE_URL = "https://xluser-ssl.xunlei.com";
const XUNLEI_PAN_BASE_URL = "https://api-pan.xunlei.com";
const XUNLEI_SDK_VERSION = "9.1.2";
const XUNLEI_PROTOCOL_VERSION = "301";
const XUNLEI_PAN_PACKAGE_NAME = "pan.xunlei.com";
const XUNLEI_PAN_VERSION = "1.92.42";
const XUNLEI_CAPTCHA_ALG_VERSION = "1";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const XUNLEI_CAPTCHA_SIGN_SALTS = [
  "7Qnav",
  "WK61VVjPsL+uYfIiDUI/nE+yp/7p4kZI5",
  "c/zRV/vRMmVKu539",
  "Zce54FjwGkWROH9I",
  "UuyZZ2m+cSbM1kXjBorXbF+vjhcivCqTLy4cGDsV8A+",
  "e7t5UwnZ7tjMMF4tp+Wcy0DyZB",
  "edcLZvZ",
  "5aaQ",
  "hHGpzXXNM5G8jOK74Ycptoyqp2+C4sH",
  "",
  "H6d+MYn8jIfY7bn",
  "A8CnwvQfwnqXhvZRov",
  "o5ghfWNEDqKbu",
  "/XhBvBFfQz72yN/pobPdmUFj",
] as const;

class XunleiRequestError extends Error {
  constructor(
    readonly errorCode: string | undefined,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class XunleiDriveApiClient implements XunleiDriveClient {
  private readonly fetchFn: XunleiFetch;
  private refreshToken: string;
  private token?: CachedToken;
  private readonly captchas = new Map<string, CachedCaptcha>();

  constructor(private readonly options: XunleiDriveApiClientOptions) {
    this.refreshToken = options.refreshToken;
    this.fetchFn = options.fetchFn ?? fetch;
    if (
      options.accessToken &&
      options.accessTokenExpiresAt &&
      options.accessTokenExpiresAt > this.now()
    ) {
      this.token = {
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
        expiresAt: options.accessTokenExpiresAt,
      };
    }
    if (
      options.captchaToken &&
      options.captchaTokenExpiresAt &&
      options.captchaTokenExpiresAt > this.now()
    ) {
      const action = this.normalizeCaptchaAction(options.captchaAction);
      this.captchas.set(action, {
        action,
        token: options.captchaToken,
        expiresAt: options.captchaTokenExpiresAt,
      });
    }
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    const json = await this.requestPan<XunleiFileData>(
      "GET",
      `/drive/v1/files/${encodeURIComponent(fileId)}`,
      {},
    );
    const url = (json as Record<string, unknown>).web_content_link as string | undefined;
    if (!url) {
      throw new Error(`Xunlei file ${fileId} has no download URL`);
    }
    return url;
  }

  async getShareDetail(
    shareId: string,
    passCode: string,
  ): Promise<XunleiShareDetail> {
    const json = await this.requestPan<XunleiShareDetailData>(
      "GET",
      "/drive/v1/share",
      {
        searchParams: {
          share_id: shareId,
          pass_code: passCode,
          limit: "100",
          pass_code_token: "",
          page_token: "",
          thumbnail_size: "SIZE_SMALL",
        },
      },
    );
    if (json.share_status && json.share_status !== "OK") {
      throw new Error(
        json.share_status_text ?? `Xunlei share status is ${json.share_status}`,
      );
    }

    const files = (json.files ?? []).map((file) => this.mapSharedFile(file));
    return {
      shareId,
      title: json.title ?? "",
      passCodeToken: json.pass_code_token ?? "",
      files,
    };
  }

  async ensureDirectory(path: string): Promise<XunleiDriveFile> {
    const normalized = this.normalizeDirectoryPath(path);
    const segments = normalized.split("/").filter(Boolean);
    let parentId = "";
    let current: XunleiDriveFile | undefined;

    for (const segment of segments) {
      const siblings = await this.listFiles(parentId);
      current = siblings.find((item) => item.isDir && item.name === segment);
      if (!current) {
        current = await this.createDirectory(parentId, segment);
      }

      parentId = current.id;
    }

    if (!current) {
      throw new Error("Xunlei target directory cannot be root");
    }

    return current;
  }

  async listFiles(parentId: string): Promise<XunleiDriveFile[]> {
    const files: XunleiDriveFile[] = [];
    let pageToken = "";

    while (true) {
      const json = await this.requestPan<XunleiFileListData>(
        "GET",
        "/drive/v1/files",
        {
          searchParams: {
            parent_id: parentId,
            filters: JSON.stringify({
              phase: { eq: "PHASE_TYPE_COMPLETE" },
              trashed: { eq: false },
            }),
            with_audit: "true",
            thumbnail_size: "SIZE_SMALL",
            limit: "100",
            page_token: pageToken,
          },
        },
      );
      const list = json.files ?? [];
      files.push(...list.map((item) => this.mapDriveFile(item)));

      pageToken = json.next_page_token ?? "";
      if (!pageToken || list.length === 0) {
        return files;
      }
    }
  }

  async restoreSharedFiles(
    shareId: string,
    detail: XunleiShareDetail,
    parentId: string,
  ): Promise<string> {
    const json = await this.requestPan<XunleiRestoreData>(
      "POST",
      "/drive/v1/share/restore",
      {
        body: {
          parent_id: parentId,
          share_id: shareId,
          pass_code_token: detail.passCodeToken,
          ancestor_ids: [],
          specify_parent_id: true,
          file_ids: detail.files.map((file) => file.id),
        },
      },
    );
    if (!json.restore_task_id) {
      throw new Error("Xunlei restore response missing restore_task_id");
    }

    return json.restore_task_id;
  }

  async waitTask(taskId: string): Promise<XunleiRestoreTaskResult> {
    for (let attempt = 0; attempt < this.options.taskMaxAttempts; attempt += 1) {
      const json = await this.requestPan<XunleiTaskData>(
        "GET",
        `/drive/v1/tasks/${encodeURIComponent(taskId)}`,
      );
      if (json.progress === 100) {
        return {
          fileIds: this.extractTraceFileIds(json.params?.trace_file_ids),
        };
      }

      await this.sleep(this.options.taskPollIntervalMs);
    }

    throw new Error(`Xunlei task timed out: ${taskId}`);
  }

  async renameFile(fileId: string, name: string): Promise<void> {
    await this.requestPan(
      "PATCH",
      `/drive/v1/files/${encodeURIComponent(fileId)}`,
      {
        body: {
          name,
          space: "",
        },
      },
    );
  }

  async createShare(
    fileIds: string[],
    options: XunleiShareOptions,
  ): Promise<XunleiCreatedShare> {
    const json = await this.requestPan<XunleiShareData>(
      "POST",
      "/drive/v1/share",
      {
        body: {
          file_ids: fileIds,
          share_to: "copy",
          params: {
            subscribe_push: "false",
            WithPassCodeInLink: "true",
          },
          title: options.title,
          restore_limit: "-1",
          expiration_days: options.expirationDays.toString(),
        },
      },
    );
    if (!json.share_url) {
      throw new Error("Xunlei share response missing share_url");
    }

    return {
      shareUrl: json.share_url,
      passCode: json.pass_code,
    };
  }

  async validate(): Promise<void> {
    await this.listFiles("");
  }

  private async createDirectory(
    parentId: string,
    name: string,
  ): Promise<XunleiDriveFile> {
    const json = await this.requestPan<XunleiCreateFolderData>(
      "POST",
      "/drive/v1/files",
      {
        body: {
          kind: "drive#folder",
          name,
          parent_id: parentId,
          space: "",
        },
      },
    );
    if (!json.file) {
      throw new Error(`Xunlei create directory response missing file: ${name}`);
    }

    return this.mapDriveFile(json.file);
  }

  private async requestPan<T>(
    method: "GET" | "PATCH" | "POST",
    pathname: string,
    options: {
      body?: unknown;
      searchParams?: Record<string, string>;
    } = {},
  ): Promise<T & XunleiErrorEnvelope> {
    const accessToken = await this.getAccessToken();
    const action = this.buildCaptchaAction(method, pathname);
    let captchaToken = await this.getCaptchaToken(action);

    try {
      return await this.requestJson<T>(
        `${XUNLEI_PAN_BASE_URL}${pathname}`,
        method,
        {
          ...options,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "x-captcha-token": captchaToken,
          },
        },
      );
    } catch (error) {
      if (!this.isCaptchaError(error)) {
        throw error;
      }

      captchaToken = await this.getCaptchaToken(action, true);
      return this.requestJson<T>(`${XUNLEI_PAN_BASE_URL}${pathname}`, method, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-captcha-token": captchaToken,
        },
      });
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt > now) {
      return this.token.accessToken;
    }

    const json = await this.requestJson<XunleiTokenData>(
      `${XUNLEI_USER_BASE_URL}/v1/auth/token`,
      "POST",
      {
        body: {
          client_id: this.options.clientId,
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
        },
      },
    );
    if (!json.access_token || !json.refresh_token || !json.expires_in) {
      throw new Error("Xunlei token response missing access_token");
    }

    this.refreshToken = json.refresh_token;
    this.token = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: now + (json.expires_in - 60) * 1000,
    };
    this.options.onRefreshToken?.(json.refresh_token);

    return json.access_token;
  }

  private async getCaptchaToken(
    action: string,
    renew = false,
  ): Promise<string> {
    const now = this.now();
    const cached = this.captchas.get(action);
    if (!renew && cached && cached.expiresAt > now) {
      return cached.token;
    }

    const json = await this.requestJson<XunleiCaptchaData>(
      `${XUNLEI_USER_BASE_URL}/v1/shield/captcha/init`,
      "POST",
      {
        body: {
          client_id: this.options.clientId,
          action,
          device_id: this.options.deviceId,
          captcha_token: cached?.token ?? "",
          meta: this.buildCaptchaMeta(),
        },
      },
    );
    if (!json.captcha_token || !json.expires_in) {
      if (json.url) {
        throw new Error(
          `Xunlei captcha requires browser verification: ${json.url}`,
        );
      }
      throw new Error("Xunlei captcha response missing captcha_token");
    }

    this.captchas.set(action, {
      action,
      token: json.captcha_token,
      expiresAt: now + (json.expires_in - 10) * 1000,
    });

    return json.captcha_token;
  }

  private async requestJson<T>(
    urlString: string,
    method: "GET" | "PATCH" | "POST",
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      searchParams?: Record<string, string>;
    } = {},
  ): Promise<T & XunleiErrorEnvelope> {
    const url = new URL(urlString);
    for (const [key, value] of Object.entries(options.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchFn(url, {
      method,
      headers: {
        accept: "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        origin: "https://pan.xunlei.com",
        pragma: "no-cache",
        referer: "https://pan.xunlei.com/",
        "user-agent": DEFAULT_USER_AGENT,
        "x-client-id": this.options.clientId,
        "x-device-id": this.options.deviceId,
        "x-sdk-version": XUNLEI_SDK_VERSION,
        "x-protocol-version": XUNLEI_PROTOCOL_VERSION,
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: T & XunleiErrorEnvelope;
    try {
      json = (text ? JSON.parse(text) : {}) as T & XunleiErrorEnvelope;
    } catch {
      throw new Error(`Xunlei response is not JSON: ${url.pathname}`);
    }

    const errorCode = this.extractErrorCode(json);
    if (!response.ok || errorCode) {
      throw new XunleiRequestError(
        errorCode,
        json.error_description ??
          json.message ??
          `Xunlei request failed: ${url.pathname}`,
        response.status,
      );
    }

    return json;
  }

  private buildCaptchaAction(
    method: "GET" | "PATCH" | "POST",
    pathname: string,
  ): string {
    return `${method}:${pathname}`;
  }

  private normalizeCaptchaAction(action: string): string {
    return action.replace(/^([a-z]+):/u, (match) => match.toUpperCase());
  }

  private buildCaptchaMeta(): XunleiCaptchaMeta {
    const timestamp = String(this.now());
    return {
      captcha_sign: this.buildCaptchaSign(timestamp),
      client_version: XUNLEI_PAN_VERSION,
      package_name: XUNLEI_PAN_PACKAGE_NAME,
      timestamp,
      user_id: this.extractUserId() ?? "0",
    };
  }

  private buildCaptchaSign(timestamp: string): string {
    let value = [
      this.options.clientId,
      XUNLEI_PAN_VERSION,
      XUNLEI_PAN_PACKAGE_NAME,
      this.getRiskDeviceId(),
      timestamp,
    ].join("");
    for (const salt of XUNLEI_CAPTCHA_SIGN_SALTS) {
      value = this.md5(`${value}${salt}`);
    }

    return `${XUNLEI_CAPTCHA_ALG_VERSION}.${value}`;
  }

  private getRiskDeviceId(): string {
    const match = this.options.deviceId.match(/^wdi\d+\.([a-z0-9]{32})/iu);
    return match?.[1] ?? this.options.deviceId;
  }

  private extractUserId(): string | undefined {
    const accessToken = this.token?.accessToken ?? this.options.accessToken;
    if (!accessToken) {
      return undefined;
    }

    const payload = accessToken.split(".")[1];
    if (!payload) {
      return undefined;
    }

    try {
      const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/");
      const padded = normalized.padEnd(
        Math.ceil(normalized.length / 4) * 4,
        "=",
      );
      const json = JSON.parse(
        Buffer.from(padded, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      const userId = json.sub ?? json.user_id ?? json.uid;
      return typeof userId === "string" || typeof userId === "number"
        ? String(userId)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private md5(value: string): string {
    return createHash("md5").update(value).digest("hex");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isCaptchaError(error: unknown): boolean {
    return (
      error instanceof XunleiRequestError &&
      ["captcha_required", "captcha_invalid"].includes(error.errorCode ?? "")
    );
  }

  private extractErrorCode(json: XunleiErrorEnvelope): string | undefined {
    if (json.error) {
      return json.error;
    }
    if (json.error_code === undefined) {
      return undefined;
    }

    return String(json.error_code);
  }

  private mapSharedFile(file: XunleiShareFileData): XunleiSharedFile {
    const id = file.id ?? file.file_id;
    if (!id) {
      throw new Error("Xunlei shared file response missing id");
    }

    return {
      id,
      name: file.name ?? "",
      isDir: this.isDirectory(file),
    };
  }

  private mapDriveFile(file: XunleiFileData): XunleiDriveFile {
    const id = file.id ?? file.file_id;
    if (!id) {
      throw new Error("Xunlei file response missing id");
    }

    return {
      id,
      name: file.name ?? "",
      isDir: this.isDirectory(file),
    };
  }

  private isDirectory(file: { is_dir?: boolean; kind?: string }): boolean {
    return file.is_dir === true || file.kind === "drive#folder";
  }

  private extractTraceFileIds(value: string | undefined): string[] {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return Object.values(parsed)
        .map((item) => (typeof item === "string" ? item : undefined))
        .filter((item): item is string => Boolean(item));
    } catch {
      return [];
    }
  }

  private normalizeDirectoryPath(path: string): string {
    const normalized = path.replace(/\/+/gu, "/").replace(/\/$/u, "");
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
