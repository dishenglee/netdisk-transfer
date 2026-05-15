import {
  NetdiskTransferAdapter,
  NetdiskTransferResult,
  ResourceTransferRecord,
} from "../resource-transfer.types.js";
import { XunleiDriveClient, XunleiDriveFile } from "./xunlei-drive-client.js";

interface XunleiTransferAdapterOptions {
  enabled: boolean;
  targetRoot: string;
  shareExpirationDays: number;
  renamePrefix?: string;
}

interface ParsedXunleiShareUrl {
  shareId: string;
  passCode: string;
}

export class XunleiTransferAdapter implements NetdiskTransferAdapter {
  readonly platform = "xunlei";

  constructor(
    private readonly client: XunleiDriveClient,
    private readonly options: XunleiTransferAdapterOptions,
  ) {}

  supports(resource: ResourceTransferRecord): boolean {
    return (
      this.options.enabled &&
      resource.originPlatform === "xunlei" &&
      Boolean(resource.originShareUrl)
    );
  }

  async transfer(
    resource: ResourceTransferRecord,
  ): Promise<NetdiskTransferResult> {
    if (!resource.originShareUrl) {
      throw new Error("originShareUrl is required");
    }

    const parsed = this.parseShareUrl(
      resource.originShareUrl,
      resource.originAccessCode,
    );
    const rawTargetName = this.sanitizeName(
      resource.softwareName ?? resource.resourceName,
    );
    const targetName = this.applyRenamePrefix(rawTargetName);
    const targetPath = this.joinPath(this.options.targetRoot, targetName);
    const legacyTargetPath =
      rawTargetName === targetName
        ? undefined
        : this.joinPath(this.options.targetRoot, rawTargetName);
    const targetDir = await this.resolveTargetDirectory(
      targetPath,
      targetName,
      legacyTargetPath,
    );
    const detail = await this.client.getShareDetail(
      parsed.shareId,
      parsed.passCode,
    );
    if (detail.files.length === 0) {
      throw new Error("Xunlei share is empty");
    }

    const existingTargetFiles = await this.client.listFiles(targetDir.id);
    let sharedFileIds = existingTargetFiles.map((file) => file.id);
    if (existingTargetFiles.length === 0) {
      const taskId = await this.client.restoreSharedFiles(
        parsed.shareId,
        detail,
        targetDir.id,
      );
      const taskResult = await this.client.waitTask(taskId);
      sharedFileIds = taskResult.fileIds;
      const savedFiles = await this.client.listFiles(targetDir.id);
      await this.renameFilesRecursively(savedFiles);
    } else {
      await this.renameFilesRecursively(existingTargetFiles);
    }

    const shareFileIds = sharedFileIds.length > 0 ? sharedFileIds : [targetDir.id];
    const share = await this.client.createShare(shareFileIds, {
      expirationDays: this.options.shareExpirationDays,
      title: targetName,
    });

    return {
      targetPlatform: "xunlei",
      targetShareUrl: share.passCode
        ? `${share.shareUrl}?pwd=${share.passCode}`
        : share.shareUrl,
      targetAccessCode: share.passCode,
      targetFileId: targetDir.id,
      targetPath,
      message: `Xunlei transfer saved ${detail.files.length} item(s) into ${targetPath}`,
    };
  }

  private async resolveTargetDirectory(
    targetPath: string,
    targetName: string,
    legacyTargetPath?: string,
  ): Promise<XunleiDriveFile> {
    await this.client.ensureDirectory(this.options.targetRoot);
    const targetDir = await this.findDirectory(targetPath);
    const legacyDir = legacyTargetPath
      ? await this.findDirectory(legacyTargetPath)
      : undefined;

    if (targetDir && legacyDir) {
      const targetFiles = await this.client.listFiles(targetDir.id);
      const legacyFiles = await this.client.listFiles(legacyDir.id);
      if (targetFiles.length === 0 && legacyFiles.length > 0) {
        await this.client.renameFile(
          targetDir.id,
          this.createBackupDirectoryName(targetName),
        );
        await this.client.renameFile(legacyDir.id, targetName);
        return { ...legacyDir, name: targetName };
      }
    }

    if (targetDir) {
      return targetDir;
    }

    if (legacyDir) {
      await this.client.renameFile(legacyDir.id, targetName);
      return { ...legacyDir, name: targetName };
    }

    return this.client.ensureDirectory(targetPath);
  }

  private async findDirectory(path: string): Promise<XunleiDriveFile | undefined> {
    const segments = path.replace(/\/+/gu, "/").split("/").filter(Boolean);
    let parentId = "";
    let current: XunleiDriveFile | undefined;

    for (const segment of segments) {
      const siblings = await this.client.listFiles(parentId);
      current = siblings.find((item) => item.isDir && item.name === segment);
      if (!current) {
        return undefined;
      }

      parentId = current.id;
    }

    return current;
  }

  private async renameFilesRecursively(files: XunleiDriveFile[]): Promise<void> {
    for (const file of files) {
      await this.renameWithPrefix(file.id, file.name);
      if (!file.isDir) {
        continue;
      }

      const children = await this.client.listFiles(file.id);
      await this.renameFilesRecursively(children);
    }
  }

  private async renameWithPrefix(
    fileId: string,
    fileName: string,
  ): Promise<void> {
    const prefixedName = this.applyRenamePrefix(fileName);
    if (prefixedName === fileName) {
      return;
    }

    await this.client.renameFile(fileId, prefixedName);
  }

  private applyRenamePrefix(fileName: string): string {
    const prefix = this.options.renamePrefix?.trim();
    if (!prefix) {
      return fileName;
    }

    const withoutPrefix = fileName.startsWith(prefix)
      ? fileName.slice(prefix.length)
      : fileName;
    const normalizedName = this.stripLeadingDecorations(withoutPrefix);

    return `${prefix}${normalizedName}`;
  }

  private stripLeadingDecorations(fileName: string): string {
    let normalized = fileName.trim();

    for (let index = 0; index < 10; index += 1) {
      const next = normalized
        .replace(/^【\s*公众号\s*[：:]\s*[^】]+】\s*/u, "")
        .replace(/^\[\s*公众号\s*[：:]\s*[^\]]+\]\s*/u, "")
        .replace(/^\d{8}[\s._-]*/u, "")
        .replace(/^\d{4}[-._年]\d{1,2}[-._月]\d{1,2}日?[\s._-]*/u, "")
        .trim();
      if (next === normalized) {
        break;
      }

      normalized = next;
    }

    return normalized || "未命名资源";
  }

  private parseShareUrl(
    shareUrl: string,
    originAccessCode: string | null,
  ): ParsedXunleiShareUrl {
    const url = new URL(shareUrl);
    if (url.hostname !== "pan.xunlei.com") {
      throw new Error(`Invalid Xunlei share URL: ${shareUrl}`);
    }

    const shareId = url.pathname.match(/\/s\/([^/]+)/u)?.[1];
    if (!shareId) {
      throw new Error(`Invalid Xunlei share URL: ${shareUrl}`);
    }

    return {
      shareId,
      passCode:
        originAccessCode ??
        url.searchParams.get("pwd") ??
        url.searchParams.get("pass_code") ??
        "",
    };
  }

  private joinPath(root: string, name: string): string {
    return `${root.replace(/\/+$/u, "")}/${name}`.replace(/\/+/gu, "/");
  }

  private sanitizeName(value: string): string {
    const sanitized = value
      .replace(/[\\/:*?"<>|]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);

    return sanitized || "未命名资源";
  }

  private createBackupDirectoryName(targetName: string): string {
    const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
    return this.sanitizeName(`${targetName}-空目录-${timestamp}`);
  }
}
