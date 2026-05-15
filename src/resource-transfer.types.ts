export interface ResourceTransferRecord {
  id: bigint;
  resourceName: string;
  softwareName: string | null;
  originPlatform: string | null;
  originShareUrl: string | null;
  originAccessCode: string | null;
  targetPlatform: string | null;
  targetShareUrl: string | null;
  targetAccessCode: string | null;
  targetFileId: string | null;
  targetPath: string | null;
  transferStatus: string;
  remark: string | null;
}

export interface ResourceTransferUpdate {
  targetPlatform?: string | null;
  targetShareUrl?: string | null;
  targetAccessCode?: string | null;
  targetFileId?: string | null;
  targetPath?: string | null;
  transferStatus?: string;
  linkStatus?: string;
  lastTransferAt?: Date;
  remark?: string | null;
}

export interface ResourceTransferRepository {
  findResourceById(id: bigint): Promise<ResourceTransferRecord | null>;
  updateResourceTransfer(
    id: bigint,
    data: ResourceTransferUpdate,
  ): Promise<ResourceTransferRecord>;
}

export interface NetdiskTransferResult {
  targetPlatform: string;
  targetShareUrl?: string;
  targetAccessCode?: string;
  targetFileId?: string;
  targetPath?: string;
  message?: string;
}

export interface NetdiskTransferAdapter {
  platform: string;
  supports(resource: ResourceTransferRecord): boolean;
  transfer(resource: ResourceTransferRecord): Promise<NetdiskTransferResult>;
}

export type ResourceTransferRunnerResult = ResourceTransferRecord & {
  message: string;
};
