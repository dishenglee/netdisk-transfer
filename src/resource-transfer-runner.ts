import {
  NetdiskTransferAdapter,
  ResourceTransferRecord,
  ResourceTransferRepository,
  ResourceTransferRunnerResult,
} from "./resource-transfer.types.js";

export class ResourceTransferRunner {
  constructor(
    private readonly repository: ResourceTransferRepository,
    private readonly adapters: NetdiskTransferAdapter[],
  ) {}

  async transferResource(id: string | bigint): Promise<ResourceTransferRunnerResult> {
    const resourceId = typeof id === "bigint" ? id : BigInt(id);
    const resource = await this.repository.findResourceById(resourceId);
    if (!resource) {
      throw new Error("resource not found");
    }

    const adapter = this.findAdapter(resource);
    if (!adapter) {
      const message = `No transfer adapter configured for origin platform: ${
        resource.originPlatform ?? "unknown"
      }`;
      const updated = await this.repository.updateResourceTransfer(resourceId, {
        transferStatus: "unsupported",
        lastTransferAt: new Date(),
        remark: this.appendRemark(resource.remark, message),
      });

      return { ...updated, message };
    }

    await this.repository.updateResourceTransfer(resourceId, {
      transferStatus: "running",
      remark: this.appendRemark(resource.remark, `Transfer started via ${adapter.platform}`),
    });

    try {
      const result = await adapter.transfer(resource);
      const message = result.message ?? "transfer success";
      const updated = await this.repository.updateResourceTransfer(resourceId, {
        targetPlatform: result.targetPlatform,
        targetShareUrl: result.targetShareUrl ?? null,
        targetAccessCode: result.targetAccessCode ?? null,
        targetFileId: result.targetFileId ?? null,
        targetPath: result.targetPath ?? null,
        transferStatus: "success",
        linkStatus: result.targetShareUrl ? "valid" : undefined,
        lastTransferAt: new Date(),
        remark: this.appendRemark(resource.remark, message),
      });

      return { ...updated, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.updateResourceTransfer(resourceId, {
        transferStatus: "failed",
        lastTransferAt: new Date(),
        remark: this.appendRemark(resource.remark, message),
      });
      throw error;
    }
  }

  private findAdapter(
    resource: ResourceTransferRecord,
  ): NetdiskTransferAdapter | undefined {
    return this.adapters.find((adapter) => adapter.supports(resource));
  }

  private appendRemark(current: string | null, message: string): string {
    const entry = `[${new Date().toISOString()}] ${message}`;
    const next = current ? `${current}\n${entry}` : entry;
    return next.length > 2000 ? next.slice(next.length - 2000) : next;
  }
}
