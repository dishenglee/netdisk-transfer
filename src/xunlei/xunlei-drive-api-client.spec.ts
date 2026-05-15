import { strict as assert } from "node:assert";
import {
  XunleiDriveApiClient,
  XunleiFetch,
} from "./xunlei-drive-api-client.js";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

const getHeader = (headers: HeadersInit | undefined, name: string): string => {
  if (!headers) {
    return "";
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? "";
  }

  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name);
    return match?.[1] ?? "";
  }

  const matchedKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === name,
  );
  return matchedKey ? headers[matchedKey] : "";
};

const createResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });

const createJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url");

  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

const createErrorResponse = (body: unknown, status = 400): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const createClient = (
  fetchFn: XunleiFetch,
  onRefreshToken?: (token: string) => void,
): XunleiDriveApiClient =>
  new XunleiDriveApiClient({
    refreshToken: "refresh-1",
    clientId: "client-1",
    deviceId: "device-1",
    captchaAction: "legacy-action",
    taskPollIntervalMs: 0,
    taskMaxAttempts: 2,
    fetchFn,
    onRefreshToken,
    now: () => 1700000000000,
  });

const runShareDetailCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  let refreshedToken = "";
  const fetchFn: XunleiFetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });

    if (url.includes("/v1/auth/token")) {
      return createResponse({
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }
    if (url.includes("/v1/shield/captcha/init")) {
      return createResponse({
        captcha_token: "captcha-1",
        expires_in: 3600,
      });
    }
    if (url.includes("/drive/v1/share")) {
      return createResponse({
        share_status: "OK",
        title: "测试软件",
        pass_code_token: "pass-code-token-1",
        files: [{ id: "file-1", name: "资料包", kind: "drive#folder" }],
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = createClient(fetchFn, (token) => {
    refreshedToken = token;
  });

  const detail = await client.getShareDetail("VOabc123", "8888");

  assert.equal(refreshedToken, "refresh-2");
  assert.deepEqual(detail, {
    shareId: "VOabc123",
    title: "测试软件",
    passCodeToken: "pass-code-token-1",
    files: [{ id: "file-1", name: "资料包", isDir: true }],
  });
  const shareRequest = requests.find((item) =>
    item.url.includes("/drive/v1/share?"),
  );
  assert.ok(shareRequest);
  assert.match(shareRequest.url, /share_id=VOabc123/u);
  assert.match(shareRequest.url, /pass_code=8888/u);
  assert.equal(
    getHeader(shareRequest.init?.headers, "authorization"),
    "Bearer access-1",
  );
  assert.equal(getHeader(shareRequest.init?.headers, "x-captcha-token"), "captcha-1");

  const captchaRequest = requests.find((item) =>
    item.url.includes("/v1/shield/captcha/init"),
  );
  assert.ok(captchaRequest);
  assert.equal(getHeader(captchaRequest.init?.headers, "x-client-id"), "client-1");
  assert.equal(getHeader(captchaRequest.init?.headers, "x-device-id"), "device-1");
  assert.equal(getHeader(captchaRequest.init?.headers, "x-sdk-version"), "9.1.2");
  assert.equal(getHeader(captchaRequest.init?.headers, "x-protocol-version"), "301");
  assert.deepEqual(JSON.parse(captchaRequest.init?.body?.toString() ?? "{}"), {
    client_id: "client-1",
    action: "GET:/drive/v1/share",
    device_id: "device-1",
    captcha_token: "",
    meta: {
      captcha_sign: "1.34c2228fe26878b076a8b5f846eb400c",
      client_version: "1.92.42",
      package_name: "pan.xunlei.com",
      timestamp: "1700000000000",
      user_id: "0",
    },
  });
};

const runRestoreTaskAndShareCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  const fetchFn: XunleiFetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });

    if (url.includes("/v1/auth/token")) {
      return createResponse({
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }
    if (url.includes("/v1/shield/captcha/init")) {
      return createResponse({
        captcha_token: "captcha-1",
        expires_in: 3600,
      });
    }
    if (url.includes("/drive/v1/share/restore")) {
      return createResponse({ restore_task_id: "restore-task-1" });
    }
    if (url.includes("/drive/v1/tasks/restore-task-1")) {
      return createResponse({
        progress: 100,
        params: {
          trace_file_ids: JSON.stringify({ source1: "saved-file-1" }),
        },
      });
    }
    if (url.endsWith("/drive/v1/share")) {
      return createResponse({
        share_url: "https://pan.xunlei.com/s/new-share",
        pass_code: "abcd",
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = createClient(fetchFn);
  const detail = {
    shareId: "VOabc123",
    title: "测试软件",
    passCodeToken: "pass-code-token-1",
    files: [{ id: "source-file-1", name: "资料包", isDir: true }],
  };

  const taskId = await client.restoreSharedFiles("VOabc123", detail, "parent-1");
  const task = await client.waitTask(taskId);
  const share = await client.createShare(["saved-file-1"], {
    expirationDays: -1,
    title: "测试软件",
  });

  assert.equal(taskId, "restore-task-1");
  assert.deepEqual(task.fileIds, ["saved-file-1"]);
  assert.deepEqual(share, {
    shareUrl: "https://pan.xunlei.com/s/new-share",
    passCode: "abcd",
  });
  const restoreBody = JSON.parse(
    requests.find((item) => item.url.includes("/share/restore"))?.init?.body?.toString() ??
      "{}",
  ) as { parent_id?: string; file_ids?: string[] };
  assert.equal(restoreBody.parent_id, "parent-1");
  assert.deepEqual(restoreBody.file_ids, ["source-file-1"]);
  const shareBody = JSON.parse(
    requests.at(-1)?.init?.body?.toString() ?? "{}",
  ) as { expiration_days?: string };
  assert.equal(shareBody.expiration_days, "-1");
  const captchaActions = requests
    .filter((item) => item.url.includes("/v1/shield/captcha/init"))
    .map((item) => {
      const body = JSON.parse(item.init?.body?.toString() ?? "{}") as {
        action?: string;
      };
      return body.action;
    });
  assert.deepEqual(captchaActions, [
    "POST:/drive/v1/share/restore",
    "GET:/drive/v1/tasks/restore-task-1",
    "POST:/drive/v1/share",
  ]);
};

const runRenameEndpointCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  const fetchFn: XunleiFetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });

    if (url.includes("/v1/auth/token")) {
      return createResponse({
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }
    if (url.includes("/v1/shield/captcha/init")) {
      return createResponse({
        captcha_token: "captcha-1",
        expires_in: 3600,
      });
    }

    return createResponse({});
  };
  const client = createClient(fetchFn);

  await client.renameFile("file-1", "【公众号：涤生AGI】安装包.zip");

  const renameRequest = requests.find((item) =>
    item.url.endsWith("/drive/v1/files/file-1"),
  );
  assert.ok(renameRequest);
  assert.equal(renameRequest.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(renameRequest.init?.body?.toString() ?? "{}"), {
    name: "【公众号：涤生AGI】安装包.zip",
    space: "",
  });
};

const runCaptchaRetryCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  let panAttempts = 0;
  let captchaAttempts = 0;
  const fetchFn: XunleiFetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });

    if (url.includes("/v1/auth/token")) {
      return createResponse({
        access_token: "access-1",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }
    if (url.includes("/v1/shield/captcha/init")) {
      captchaAttempts += 1;
      return createResponse({
        captcha_token: `captcha-${captchaAttempts}`,
        expires_in: 3600,
      });
    }
    if (url.includes("/drive/v1/share?")) {
      panAttempts += 1;
      if (panAttempts === 1) {
        return createErrorResponse({
          error_code: 9,
          error: "captcha_invalid",
          error_description: "captcha expired",
        });
      }

      return createResponse({
        share_status: "OK",
        title: "测试软件",
        pass_code_token: "pass-code-token-1",
        files: [{ id: "file-1", name: "资料包", kind: "drive#folder" }],
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = createClient(fetchFn);

  await client.getShareDetail("VOabc123", "8888");

  const panRequests = requests.filter((item) =>
    item.url.includes("/drive/v1/share?"),
  );
  assert.equal(panRequests.length, 2);
  assert.equal(getHeader(panRequests[0]?.init?.headers, "x-captcha-token"), "captcha-1");
  assert.equal(getHeader(panRequests[1]?.init?.headers, "x-captcha-token"), "captcha-2");

  const captchaRequestBodies = requests
    .filter((item) => item.url.includes("/v1/shield/captcha/init"))
    .map((item) => JSON.parse(item.init?.body?.toString() ?? "{}") as {
      captcha_token?: string;
    });
  assert.equal(captchaRequestBodies[1]?.captcha_token, "captcha-1");
};

const runCaptchaMetaFromBrowserCredentialCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  const fetchFn: XunleiFetch = async (input, init) => {
    const url = input.toString();
    requests.push({ url, init });

    if (url.includes("/v1/shield/captcha/init")) {
      return createResponse({
        captcha_token: "captcha-1",
        expires_in: 3600,
      });
    }
    if (url.includes("/drive/v1/files")) {
      return createResponse({ files: [] });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = new XunleiDriveApiClient({
    refreshToken: "refresh-1",
    accessToken: createJwt({ sub: 12345 }),
    accessTokenExpiresAt: 1700003600000,
    clientId: "client-1",
    deviceId: "wdi10.0123456789abcdef0123456789abcdef.extra",
    captchaAction: "GET:/drive/v1/files",
    taskPollIntervalMs: 0,
    taskMaxAttempts: 2,
    fetchFn,
    now: () => 1700000000000,
  });

  await client.validate();

  const captchaRequest = requests.find((item) =>
    item.url.includes("/v1/shield/captcha/init"),
  );
  assert.ok(captchaRequest);
  assert.deepEqual(JSON.parse(captchaRequest.init?.body?.toString() ?? "{}"), {
    client_id: "client-1",
    action: "GET:/drive/v1/files",
    device_id: "wdi10.0123456789abcdef0123456789abcdef.extra",
    captcha_token: "",
    meta: {
      captcha_sign: "1.702c77f78a761e6c3f474a65e28f9add",
      client_version: "1.92.42",
      package_name: "pan.xunlei.com",
      timestamp: "1700000000000",
      user_id: "12345",
    },
  });
};

const main = async (): Promise<void> => {
  await runShareDetailCase();
  await runRestoreTaskAndShareCase();
  await runRenameEndpointCase();
  await runCaptchaRetryCase();
  await runCaptchaMetaFromBrowserCredentialCase();
};

void main();
