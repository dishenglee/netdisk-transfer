import { strict as assert } from "node:assert";
import { ResourceTransferRecord } from "../resource-transfer.types.js";
import {
  QuarkDriveClient,
  QuarkDriveFile,
  QuarkSaveSharedFilesInput,
  QuarkShareOptions,
  QuarkSharedFile,
  QuarkTaskResult,
} from "./quark-drive-client.js";
import { QuarkTransferAdapter } from "./quark-transfer.adapter.js";

class FakeQuarkDriveClient implements QuarkDriveClient {
  readonly savedInputs: QuarkSaveSharedFilesInput[] = [];
  readonly shareOptions: QuarkShareOptions[] = [];
  readonly renamedFiles: Array<{ fid: string; fileName: string }> = [];

  constructor(
    private readonly existingFilesByParent: Record<string, QuarkDriveFile[]> = {},
    private readonly directoryIdsByPath: Record<string, string> = {},
    private readonly expectedShareFid = "target-dir-fid",
  ) {}

  async getShareToken(pwdId: string, passcode: string): Promise<string> {
    assert.equal(pwdId, "abc123");
    assert.equal(passcode, "8888");
    return "stoken-1";
  }

  async listSharedFiles(
    pwdId: string,
    stoken: string,
    pdirFid: string,
  ): Promise<QuarkSharedFile[]> {
    assert.equal(pwdId, "abc123");
    assert.equal(stoken, "stoken-1");
    assert.equal(pdirFid, "0");

    return [
      {
        fid: "source-fid-1",
        fileName: "20240517-原始文件.zip",
        dir: false,
        shareFidToken: "token-1",
      },
    ];
  }

  async ensureDirectory(path: string): Promise<string> {
    assert.equal(path, "/公众号软件/【公众号：涤生AGI】测试软件");
    this.directoryIdsByPath[path] = "target-dir-fid";
    return "target-dir-fid";
  }

  async findDirectory(path: string): Promise<string | undefined> {
    return this.directoryIdsByPath[path];
  }

  async listFiles(pdirFid: string): Promise<QuarkDriveFile[]> {
    return this.existingFilesByParent[pdirFid] ?? [];
  }

  async saveSharedFiles(input: QuarkSaveSharedFilesInput): Promise<string> {
    this.savedInputs.push(input);
    this.existingFilesByParent[input.toPdirFid] = [
      {
        fid: "saved-fid-1",
        fileName: "【公众号：软件室】20240517-原始文件.zip",
        dir: false,
      },
    ];
    return "save-task-1";
  }

  async waitTask(taskId: string): Promise<QuarkTaskResult> {
    assert.match(taskId, /save-task|share-task/);
    return {
      savedFids: taskId === "save-task-1" ? ["saved-fid-1"] : [],
    };
  }

  async renameFile(fid: string, fileName: string): Promise<void> {
    this.renamedFiles.push({ fid, fileName });
  }

  async createShareTask(
    fid: string,
    title: string,
    options: QuarkShareOptions,
  ): Promise<string> {
    assert.equal(fid, this.expectedShareFid);
    assert.equal(title, "【公众号：涤生AGI】测试软件");
    this.shareOptions.push(options);
    return "share-task-1";
  }

  async getShareId(taskId: string): Promise<string> {
    assert.equal(taskId, "share-task-1");
    return "share-id-1";
  }

  async submitShare(shareId: string): Promise<{
    shareUrl: string;
    title: string;
    passcode?: string;
  }> {
    assert.equal(shareId, "share-id-1");
    return {
      shareUrl: "https://pan.quark.cn/s/new-share",
      title: "测试软件",
      passcode: "9999",
    };
  }
}

const createResource = (
  overrides: Partial<ResourceTransferRecord> = {},
): ResourceTransferRecord => ({
  id: 1n,
  resourceName: "测试软件 - quark",
  softwareName: "20240517-测试软件",
  originPlatform: "quark",
  originShareUrl: "https://pan.quark.cn/s/abc123?pwd=8888",
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

const runTransferCase = async (): Promise<void> => {
  const client = new FakeQuarkDriveClient();
  const adapter = new QuarkTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareUrlType: 2,
    shareExpiredType: 2,
    renamePrefix: "【公众号：涤生AGI】",
  });

  const result = await adapter.transfer(createResource());

  assert.equal(result.targetPlatform, "quark");
  assert.equal(result.targetFileId, "target-dir-fid");
  assert.equal(result.targetPath, "/公众号软件/【公众号：涤生AGI】测试软件");
  assert.equal(result.targetShareUrl, "https://pan.quark.cn/s/new-share?pwd=9999");
  assert.equal(result.targetAccessCode, "9999");
  assert.equal(client.savedInputs.length, 1);
  assert.deepEqual(client.savedInputs[0], {
    pwdId: "abc123",
    stoken: "stoken-1",
    toPdirFid: "target-dir-fid",
    files: [{ fid: "source-fid-1", shareFidToken: "token-1" }],
  });
  assert.equal(client.shareOptions[0].urlType, 2);
  assert.equal(client.shareOptions[0].expiredType, 2);
  assert.match(client.shareOptions[0].passcode ?? "", /^[A-Za-z0-9]{4}$/u);
  assert.deepEqual(client.renamedFiles, [
    {
      fid: "saved-fid-1",
      fileName: "【公众号：涤生AGI】原始文件.zip",
    },
  ]);
};

const runAccessCodeOverrideCase = async (): Promise<void> => {
  const client = new FakeQuarkDriveClient();
  const adapter = new QuarkTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareUrlType: 1,
    shareExpiredType: 2,
    sharePasscode: "1234",
    renamePrefix: "【公众号：涤生AGI】",
  });

  const result = await adapter.transfer(
    createResource({
      originShareUrl: "https://pan.quark.cn/s/abc123?pwd=wrong",
      originAccessCode: "8888",
    }),
  );

  assert.equal(result.targetAccessCode, "9999");
  assert.deepEqual(client.shareOptions[0], {
    urlType: 1,
    expiredType: 2,
    passcode: "1234",
  });
};

const runExistingTargetDirectoryCase = async (): Promise<void> => {
  const client = new FakeQuarkDriveClient({
    "target-dir-fid": [
      {
        fid: "already-saved-file",
        fileName: "已转存.zip",
        dir: false,
      },
    ],
  });
  const adapter = new QuarkTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareUrlType: 2,
    shareExpiredType: 2,
    renamePrefix: "【公众号：涤生AGI】",
  });

  const result = await adapter.transfer(createResource());

  assert.equal(client.savedInputs.length, 0);
  assert.deepEqual(client.renamedFiles, [
    {
      fid: "already-saved-file",
      fileName: "【公众号：涤生AGI】已转存.zip",
    },
  ]);
  assert.equal(result.targetShareUrl, "https://pan.quark.cn/s/new-share?pwd=9999");
};

const runAlreadyPrefixedExistingFileCase = async (): Promise<void> => {
  const client = new FakeQuarkDriveClient({
    "target-dir-fid": [
      {
        fid: "already-prefixed-file",
        fileName: "【公众号：涤生AGI】【公众号：软件室】20240517-已转存.zip",
        dir: false,
      },
    ],
  });
  const adapter = new QuarkTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareUrlType: 2,
    shareExpiredType: 2,
    renamePrefix: "【公众号：涤生AGI】",
  });

  await adapter.transfer(createResource());

  assert.deepEqual(client.renamedFiles, [
    {
      fid: "already-prefixed-file",
      fileName: "【公众号：涤生AGI】已转存.zip",
    },
  ]);
};

const runNestedExistingTargetDirectoryCase = async (): Promise<void> => {
  const client = new FakeQuarkDriveClient({
    "target-dir-fid": [
      {
        fid: "nested-folder",
        fileName: "20240517-资料包",
        dir: true,
      },
    ],
    "nested-folder": [
      {
        fid: "nested-file",
        fileName: "【公众号：软件室】20240517-安装包.dmg",
        dir: false,
      },
    ],
  });
  const adapter = new QuarkTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareUrlType: 2,
    shareExpiredType: 2,
    renamePrefix: "【公众号：涤生AGI】",
  });

  await adapter.transfer(createResource());

  assert.deepEqual(client.renamedFiles, [
    {
      fid: "nested-folder",
      fileName: "【公众号：涤生AGI】资料包",
    },
    {
      fid: "nested-file",
      fileName: "【公众号：涤生AGI】安装包.dmg",
    },
  ]);
};

const runUnsupportedCase = (): void => {
  const adapter = new QuarkTransferAdapter(new FakeQuarkDriveClient(), {
    enabled: false,
    targetRoot: "/公众号软件",
    shareUrlType: 2,
    shareExpiredType: 2,
    renamePrefix: "【公众号：涤生AGI】",
  });

  assert.equal(adapter.supports(createResource()), false);
};

const main = async (): Promise<void> => {
  await runTransferCase();
  await runAccessCodeOverrideCase();
  await runExistingTargetDirectoryCase();
  await runAlreadyPrefixedExistingFileCase();
  await runNestedExistingTargetDirectoryCase();
  runUnsupportedCase();
};

void main();
