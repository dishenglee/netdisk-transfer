import { strict as assert } from "node:assert";
import { ResourceTransferRecord } from "../resource-transfer.types.js";
import {
  BaiduDriveClient,
  BaiduDriveFile,
  BaiduShareOptions,
  BaiduShareTransferParams,
} from "./baidu-drive-client.js";
import { BaiduTransferAdapter } from "./baidu-transfer.adapter.js";

class FakeBaiduDriveClient implements BaiduDriveClient {
  readonly renamedFiles: Array<{ path: string; newName: string }> = [];
  readonly shareOptions: BaiduShareOptions[] = [];
  readonly transferredTargets: string[] = [];
  readonly verifiedPasscodes: Array<{ shareUrl: string; passcode: string }> = [];

  constructor(
    private readonly filesByPath: Record<string, BaiduDriveFile[]> = {},
    private readonly listErrorsByPath: Record<string, Error[]> = {},
  ) {}

  async getBdstoken(): Promise<string> {
    return "bdstoken-1";
  }

  async ensureDirectory(path: string, bdstoken: string): Promise<BaiduDriveFile> {
    if (path === "/公众号软件") {
      assert.equal(bdstoken, "bdstoken-1");
      return {
        fsId: "target-root-fs-id",
        fileName: "公众号软件",
        path,
        isDir: true,
      };
    }

    assert.equal(path, "/公众号软件/【公众号：涤生AGI】测试软件");
    assert.equal(bdstoken, "bdstoken-1");
    return {
      fsId: "target-fs-id",
      fileName: "【公众号：涤生AGI】测试软件",
      path,
      isDir: true,
    };
  }

  async listFiles(path: string, bdstoken: string): Promise<BaiduDriveFile[]> {
    assert.equal(bdstoken, "bdstoken-1");
    const errors = this.listErrorsByPath[path] ?? [];
    const error = errors.shift();
    if (error) {
      throw error;
    }

    return this.filesByPath[path] ?? [];
  }

  async verifyPasscode(
    shareUrl: string,
    passcode: string,
    bdstoken: string,
  ): Promise<void> {
    assert.equal(bdstoken, "bdstoken-1");
    this.verifiedPasscodes.push({ shareUrl, passcode });
  }

  async getShareTransferParams(
    shareUrl: string,
  ): Promise<BaiduShareTransferParams> {
    assert.equal(shareUrl, "https://pan.baidu.com/s/1abc123");
    return {
      shareId: "share-id-1",
      shareUk: "share-uk-1",
      fsIds: ["source-fs-id"],
      fileNames: ["20240517-资料包"],
      isDirs: [true],
    };
  }

  async transferSharedFiles(
    params: BaiduShareTransferParams,
    targetPath: string,
    bdstoken: string,
  ): Promise<void> {
    assert.equal(params.shareId, "share-id-1");
    assert.equal(bdstoken, "bdstoken-1");
    this.transferredTargets.push(targetPath);
    this.filesByPath[targetPath] = [
      {
        fsId: "saved-folder",
        fileName: "20240517-资料包",
        path: `${targetPath}/20240517-资料包`,
        isDir: true,
      },
    ];
  }

  async renameFile(
    path: string,
    newName: string,
    bdstoken: string,
  ): Promise<void> {
    assert.equal(bdstoken, "bdstoken-1");
    this.renamedFiles.push({ path, newName });
  }

  async createShare(
    fsId: string,
    options: BaiduShareOptions,
    bdstoken: string,
  ): Promise<string> {
    assert.equal(fsId, "target-fs-id");
    assert.equal(bdstoken, "bdstoken-1");
    this.shareOptions.push(options);
    return "https://pan.baidu.com/s/new-share";
  }
}

const createResource = (
  overrides: Partial<ResourceTransferRecord> = {},
): ResourceTransferRecord => ({
  id: 1n,
  resourceName: "测试软件 - baidu",
  softwareName: "20240517-测试软件",
  originPlatform: "baidu",
  originShareUrl: "https://pan.baidu.com/s/1abc123?pwd=8888",
  originAccessCode: null,
  targetPlatform: null,
  targetShareUrl: null,
  targetAccessCode: null,
  targetFileId: null,
  targetPath: null,
  transferStatus: "pending",
  remark: null,
  ...overrides,
});

const createAdapter = (client: BaiduDriveClient): BaiduTransferAdapter =>
  new BaiduTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    sharePeriod: 0,
    renamePrefix: "【公众号：涤生AGI】",
  });

const runTransferCase = async (): Promise<void> => {
  const client = new FakeBaiduDriveClient({
    "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】资料包": [
      {
        fsId: "saved-file",
        fileName: "【公众号：软件室】20240517-安装包.zip",
        path: "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】资料包/【公众号：软件室】20240517-安装包.zip",
        isDir: false,
      },
    ],
  });
  const adapter = createAdapter(client);

  const result = await adapter.transfer(createResource());

  assert.equal(result.targetPlatform, "baidu");
  assert.equal(result.targetFileId, "target-fs-id");
  assert.equal(result.targetPath, "/公众号软件/【公众号：涤生AGI】测试软件");
  assert.match(result.targetAccessCode ?? "", /^[A-Za-z0-9]{4}$/u);
  assert.equal(
    result.targetShareUrl,
    `https://pan.baidu.com/s/new-share?pwd=${result.targetAccessCode}`,
  );
  assert.deepEqual(client.verifiedPasscodes, [
    {
      shareUrl: "https://pan.baidu.com/s/1abc123",
      passcode: "8888",
    },
  ]);
  assert.deepEqual(client.transferredTargets, [
    "/公众号软件/【公众号：涤生AGI】测试软件",
  ]);
  assert.deepEqual(client.renamedFiles, [
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/20240517-资料包",
      newName: "【公众号：涤生AGI】资料包",
    },
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】资料包/【公众号：软件室】20240517-安装包.zip",
      newName: "【公众号：涤生AGI】安装包.zip",
    },
  ]);
  assert.deepEqual(client.shareOptions[0], {
    period: 0,
    passcode: result.targetAccessCode,
  });
};

const runAccessCodeOverrideCase = async (): Promise<void> => {
  const client = new FakeBaiduDriveClient();
  const adapter = createAdapter(client);

  await adapter.transfer(
    createResource({
      originAccessCode: "9999",
    }),
  );

  assert.deepEqual(client.verifiedPasscodes, [
    {
      shareUrl: "https://pan.baidu.com/s/1abc123",
      passcode: "9999",
    },
  ]);
};

const runExistingTargetDirectoryCase = async (): Promise<void> => {
  const client = new FakeBaiduDriveClient({
    "/公众号软件/【公众号：涤生AGI】测试软件": [
      {
        fsId: "already-saved-file",
        fileName: "已转存.zip",
        path: "/公众号软件/【公众号：涤生AGI】测试软件/已转存.zip",
        isDir: false,
      },
    ],
  });
  const adapter = createAdapter(client);

  await adapter.transfer(createResource());

  assert.deepEqual(client.transferredTargets, []);
  assert.deepEqual(client.renamedFiles, [
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/已转存.zip",
      newName: "【公众号：涤生AGI】已转存.zip",
    },
  ]);
};

const runAlreadyPrefixedExistingFileCase = async (): Promise<void> => {
  const client = new FakeBaiduDriveClient({
    "/公众号软件/【公众号：涤生AGI】测试软件": [
      {
        fsId: "already-prefixed-file",
        fileName: "【公众号：涤生AGI】【公众号：软件室】20240517-已转存.zip",
        path: "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】【公众号：软件室】20240517-已转存.zip",
        isDir: false,
      },
    ],
  });
  const adapter = createAdapter(client);

  await adapter.transfer(createResource());

  assert.deepEqual(client.renamedFiles, [
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】【公众号：软件室】20240517-已转存.zip",
      newName: "【公众号：涤生AGI】已转存.zip",
    },
  ]);
};

const runRetryRenamedDirectoryListCase = async (): Promise<void> => {
  const renamedPath =
    "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】资料包";
  const client = new FakeBaiduDriveClient(
    {
      "/公众号软件/【公众号：涤生AGI】测试软件": [
        {
          fsId: "nested-folder",
          fileName: "20240517-资料包",
          path: "/公众号软件/【公众号：涤生AGI】测试软件/20240517-资料包",
          isDir: true,
        },
      ],
      [renamedPath]: [
        {
          fsId: "nested-file",
          fileName: "【公众号：软件室】20240517-安装包.zip",
          path: `${renamedPath}/【公众号：软件室】20240517-安装包.zip`,
          isDir: false,
        },
      ],
    },
    {
      [renamedPath]: [new Error("Baidu request failed errno=-9")],
    },
  );
  const adapter = new BaiduTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    sharePeriod: 0,
    renamePrefix: "【公众号：涤生AGI】",
    listRetryDelayMs: 0,
    listRetryMaxAttempts: 2,
  });

  await adapter.transfer(createResource());

  assert.deepEqual(client.renamedFiles, [
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/20240517-资料包",
      newName: "【公众号：涤生AGI】资料包",
    },
    {
      path: "/公众号软件/【公众号：涤生AGI】测试软件/【公众号：涤生AGI】资料包/【公众号：软件室】20240517-安装包.zip",
      newName: "【公众号：涤生AGI】安装包.zip",
    },
  ]);
};

const runUnsupportedCase = (): void => {
  const adapter = new BaiduTransferAdapter(new FakeBaiduDriveClient(), {
    enabled: false,
    targetRoot: "/公众号软件",
    sharePeriod: 0,
    renamePrefix: "【公众号：涤生AGI】",
  });

  assert.equal(adapter.supports(createResource()), false);
};

const main = async (): Promise<void> => {
  await runTransferCase();
  await runAccessCodeOverrideCase();
  await runExistingTargetDirectoryCase();
  await runAlreadyPrefixedExistingFileCase();
  await runRetryRenamedDirectoryListCase();
  runUnsupportedCase();
};

void main();
