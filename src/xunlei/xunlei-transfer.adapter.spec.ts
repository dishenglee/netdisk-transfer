import { strict as assert } from "node:assert";
import { ResourceTransferRecord } from "../resource-transfer.types.js";
import {
  XunleiCreatedShare,
  XunleiDriveClient,
  XunleiDriveFile,
  XunleiRestoreTaskResult,
  XunleiShareDetail,
  XunleiShareOptions,
} from "./xunlei-drive-client.js";
import { XunleiTransferAdapter } from "./xunlei-transfer.adapter.js";

class FakeXunleiDriveClient implements XunleiDriveClient {
  readonly renamedFiles: Array<{ fileId: string; name: string }> = [];
  readonly shareOptions: Array<{ fileIds: string[]; options: XunleiShareOptions }> =
    [];
  readonly restoredTargets: string[] = [];

  constructor(
    private readonly filesByParent: Record<string, XunleiDriveFile[]> = {},
  ) {}

  async getShareDetail(
    shareId: string,
    passCode: string,
  ): Promise<XunleiShareDetail> {
    assert.equal(shareId, "VOabc123");
    assert.equal(passCode, "8888");

    return {
      shareId,
      title: "测试软件",
      passCodeToken: "pass-code-token-1",
      files: [
        {
          id: "source-file-id",
          name: "20240517-资料包",
          isDir: true,
        },
      ],
    };
  }

  async ensureDirectory(path: string): Promise<XunleiDriveFile> {
    if (path === "/公众号软件") {
      return {
        id: "target-root-id",
        name: "公众号软件",
        isDir: true,
      };
    }

    assert.equal(path, "/公众号软件/【公众号：涤生AGI】测试软件");
    return {
      id: "target-folder-id",
      name: "【公众号：涤生AGI】测试软件",
      isDir: true,
    };
  }

  async listFiles(parentId: string): Promise<XunleiDriveFile[]> {
    return this.filesByParent[parentId] ?? [];
  }

  async restoreSharedFiles(
    shareId: string,
    detail: XunleiShareDetail,
    parentId: string,
  ): Promise<string> {
    assert.equal(shareId, "VOabc123");
    assert.equal(detail.passCodeToken, "pass-code-token-1");
    assert.equal(parentId, "target-folder-id");
    this.restoredTargets.push(parentId);
    this.filesByParent[parentId] = [
      {
        id: "saved-folder-id",
        name: "20240517-资料包",
        isDir: true,
      },
    ];
    return "restore-task-1";
  }

  async waitTask(taskId: string): Promise<XunleiRestoreTaskResult> {
    assert.equal(taskId, "restore-task-1");
    return {
      fileIds: ["saved-folder-id"],
    };
  }

  async renameFile(fileId: string, name: string): Promise<void> {
    this.renamedFiles.push({ fileId, name });
  }

  async createShare(
    fileIds: string[],
    options: XunleiShareOptions,
  ): Promise<XunleiCreatedShare> {
    this.shareOptions.push({ fileIds, options });
    return {
      shareUrl: "https://pan.xunlei.com/s/new-share",
      passCode: "abcd",
    };
  }
}

const createResource = (
  overrides: Partial<ResourceTransferRecord> = {},
): ResourceTransferRecord => ({
  id: 1n,
  resourceName: "测试软件 - xunlei",
  softwareName: "20240517-测试软件",
  originPlatform: "xunlei",
  originShareUrl: "https://pan.xunlei.com/s/VOabc123?pwd=8888#",
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

const createAdapter = (client: XunleiDriveClient): XunleiTransferAdapter =>
  new XunleiTransferAdapter(client, {
    enabled: true,
    targetRoot: "/公众号软件",
    shareExpirationDays: -1,
    renamePrefix: "【公众号：涤生AGI】",
  });

const runTransferCase = async (): Promise<void> => {
  const client = new FakeXunleiDriveClient({
    "saved-folder-id": [
      {
        id: "saved-file-id",
        name: "【公众号：软件室】20240517-安装包.zip",
        isDir: false,
      },
    ],
  });
  const adapter = createAdapter(client);

  const result = await adapter.transfer(createResource());

  assert.equal(result.targetPlatform, "xunlei");
  assert.equal(result.targetFileId, "target-folder-id");
  assert.equal(result.targetPath, "/公众号软件/【公众号：涤生AGI】测试软件");
  assert.equal(
    result.targetShareUrl,
    "https://pan.xunlei.com/s/new-share?pwd=abcd",
  );
  assert.equal(result.targetAccessCode, "abcd");
  assert.deepEqual(client.restoredTargets, ["target-folder-id"]);
  assert.deepEqual(client.renamedFiles, [
    {
      fileId: "saved-folder-id",
      name: "【公众号：涤生AGI】资料包",
    },
    {
      fileId: "saved-file-id",
      name: "【公众号：涤生AGI】安装包.zip",
    },
  ]);
  assert.deepEqual(client.shareOptions[0], {
    fileIds: ["saved-folder-id"],
    options: {
      expirationDays: -1,
      title: "【公众号：涤生AGI】测试软件",
    },
  });
};

const runAccessCodeOverrideCase = async (): Promise<void> => {
  const client = new FakeXunleiDriveClient();
  const adapter = createAdapter(client);

  await adapter.transfer(
    createResource({
      originShareUrl: "https://pan.xunlei.com/s/VOabc123?pwd=wrong#",
      originAccessCode: "8888",
    }),
  );

  assert.equal(client.restoredTargets.length, 1);
};

const runExistingTargetDirectoryCase = async (): Promise<void> => {
  const client = new FakeXunleiDriveClient({
    "target-folder-id": [
      {
        id: "existing-file-id",
        name: "【公众号：软件室】20240517-已转存.zip",
        isDir: false,
      },
    ],
  });
  const adapter = createAdapter(client);

  await adapter.transfer(createResource());

  assert.deepEqual(client.restoredTargets, []);
  assert.deepEqual(client.renamedFiles, [
    {
      fileId: "existing-file-id",
      name: "【公众号：涤生AGI】已转存.zip",
    },
  ]);
  assert.deepEqual(client.shareOptions[0].fileIds, ["existing-file-id"]);
};

const runUnsupportedCase = (): void => {
  const adapter = new XunleiTransferAdapter(new FakeXunleiDriveClient(), {
    enabled: false,
    targetRoot: "/公众号软件",
    shareExpirationDays: -1,
    renamePrefix: "【公众号：涤生AGI】",
  });

  assert.equal(adapter.supports(createResource()), false);
};

const main = async (): Promise<void> => {
  await runTransferCase();
  await runAccessCodeOverrideCase();
  await runExistingTargetDirectoryCase();
  runUnsupportedCase();
};

void main();
