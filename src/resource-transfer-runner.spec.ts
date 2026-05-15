import { strict as assert } from "node:assert";
import {
  NetdiskTransferAdapter,
  ResourceTransferRecord,
  ResourceTransferRepository,
  ResourceTransferUpdate,
} from "./resource-transfer.types.js";
import { ResourceTransferRunner } from "./resource-transfer-runner.js";

class InMemoryResourceTransferRepository implements ResourceTransferRepository {
  readonly updates: ResourceTransferUpdate[] = [];

  constructor(private resource?: ResourceTransferRecord) {}

  async findResourceById(id: bigint): Promise<ResourceTransferRecord | null> {
    if (this.resource?.id !== id) {
      return null;
    }

    return this.resource;
  }

  async updateResourceTransfer(
    id: bigint,
    data: ResourceTransferUpdate,
  ): Promise<ResourceTransferRecord> {
    assert.equal(this.resource?.id, id);
    this.updates.push(data);
    this.resource = { ...this.resource, ...data } as ResourceTransferRecord;
    return this.resource;
  }
}

const createResource = (
  overrides: Partial<ResourceTransferRecord> = {},
): ResourceTransferRecord => ({
  id: 12n,
  resourceName: "测试软件 - quark",
  softwareName: "测试软件",
  originPlatform: "quark",
  originShareUrl: "https://pan.quark.cn/s/source",
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

const runSuccessCase = async (): Promise<void> => {
  const repository = new InMemoryResourceTransferRepository(createResource());
  const adapterCalls: ResourceTransferRecord[] = [];
  const adapter: NetdiskTransferAdapter = {
    platform: "quark",
    supports: (resource) => resource.originPlatform === "quark",
    transfer: async (resource) => {
      adapterCalls.push(resource);

      return {
        targetPlatform: "quark",
        targetShareUrl: "https://pan.quark.cn/s/target",
        targetAccessCode: "8888",
        targetFileId: "file-1",
        targetPath: "/公众号软件/测试软件",
        message: "ok",
      };
    },
  };
  const runner = new ResourceTransferRunner(repository, [adapter]);

  const result = await runner.transferResource("12");

  assert.equal(adapterCalls.length, 1);
  assert.equal(repository.updates[0].transferStatus, "running");
  assert.equal(repository.updates[1].transferStatus, "success");
  assert.equal(result.transferStatus, "success");
  assert.equal(result.targetShareUrl, "https://pan.quark.cn/s/target");
  assert.equal(result.targetAccessCode, "8888");
  assert.equal(result.targetPath, "/公众号软件/测试软件");
};

const runUnsupportedCase = async (): Promise<void> => {
  const repository = new InMemoryResourceTransferRepository(
    createResource({ originPlatform: "alipan" }),
  );
  const runner = new ResourceTransferRunner(repository, []);

  const result = await runner.transferResource("12");

  assert.equal(repository.updates.length, 1);
  assert.equal(repository.updates[0].transferStatus, "unsupported");
  assert.equal(result.transferStatus, "unsupported");
  assert.match(result.message, /No transfer adapter/i);
};

const runFailureCase = async (): Promise<void> => {
  const repository = new InMemoryResourceTransferRepository(createResource());
  const adapter: NetdiskTransferAdapter = {
    platform: "quark",
    supports: () => true,
    transfer: async () => {
      throw new Error("cookie expired");
    },
  };
  const runner = new ResourceTransferRunner(repository, [adapter]);

  await assert.rejects(() => runner.transferResource("12"), /cookie expired/);

  assert.equal(repository.updates[0].transferStatus, "running");
  assert.equal(repository.updates[1].transferStatus, "failed");
  assert.match(repository.updates[1].remark ?? "", /cookie expired/);
};

const main = async (): Promise<void> => {
  await runSuccessCase();
  await runUnsupportedCase();
  await runFailureCase();
};

void main();
