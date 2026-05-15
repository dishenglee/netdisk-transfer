import { strict as assert } from "node:assert";
import { BaiduDriveApiClient, BaiduFetch } from "./baidu-drive-api-client.js";

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

  return headers[name] ?? "";
};

const createResponse = (body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": typeof body === "string" ? "text/html" : "application/json",
    },
  });

const runSharePageParseCase = async (): Promise<void> => {
  const client = new BaiduDriveApiClient({
    cookie: "BAIDUID=1; BDUSS=2",
    fetchFn: async () =>
      createResponse(
        '"shareid":12345,"x":1,"share_uk":"67890","y":2,"fs_id":111,"server_filename":"20240517-资料包","isdir":1,"fs_id":222,"server_filename":"安装包.zip","isdir":0,',
      ),
  });

  const params = await client.getShareTransferParams(
    "https://pan.baidu.com/s/1abc123",
  );

  assert.deepEqual(params, {
    shareId: "12345",
    shareUk: "67890",
    fsIds: ["111", "222"],
    fileNames: ["20240517-资料包", "安装包.zip"],
    isDirs: [true, false],
  });
};

const runVerifyPasscodeUpdatesBdclndCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  const fetchFn: BaiduFetch = async (input, init) => {
    requests.push({ url: input.toString(), init });

    if (input.toString().includes("/share/verify")) {
      return createResponse({ errno: 0, randsk: "rand-sk-1" });
    }

    return createResponse({ errno: 0, link: "https://pan.baidu.com/s/new" });
  };
  const client = new BaiduDriveApiClient({
    cookie: "BAIDUID=1; BDUSS=2",
    fetchFn,
  });

  await client.verifyPasscode("https://pan.baidu.com/s/1abc123", "8888", "token");
  await client.createShare("target-fs-id", { period: 0, passcode: "abcd" }, "token");

  assert.match(requests[0].url, /\/share\/verify/u);
  assert.match(requests[0].url, /surl=abc123/u);
  assert.match(
    getHeader(requests[1].init?.headers, "cookie"),
    /BDCLND=rand-sk-1/u,
  );
};

const runRenameEndpointCase = async (): Promise<void> => {
  const requests: CapturedRequest[] = [];
  const client = new BaiduDriveApiClient({
    cookie: "BAIDUID=1; BDUSS=2",
    fetchFn: async (input, init) => {
      requests.push({ url: input.toString(), init });
      return createResponse({ errno: 0 });
    },
  });

  await client.renameFile("/公众号软件/旧文件.zip", "新文件.zip", "token");

  assert.match(requests[0].url, /\/api\/filemanager/u);
  assert.match(requests[0].url, /opera=rename/u);
  assert.match(requests[0].init?.body?.toString() ?? "", /filelist=/u);
  assert.match(
    decodeURIComponent(requests[0].init?.body?.toString() ?? ""),
    /"newname":"新文件\.zip"/u,
  );
};

const main = async (): Promise<void> => {
  await runSharePageParseCase();
  await runVerifyPasscodeUpdatesBdclndCase();
  await runRenameEndpointCase();
};

void main();
