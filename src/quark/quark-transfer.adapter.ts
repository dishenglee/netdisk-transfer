import {
  NetdiskTransferAdapter,
  NetdiskTransferResult,
  ResourceTransferRecord,
} from "../resource-transfer.types.js";
import {
  QuarkDriveClient,
  QuarkSaveSharedFilesInput,
  QuarkSharedFile,
} from "./quark-drive-client.js";

interface QuarkTransferAdapterOptions {
  enabled: boolean;
  targetRoot: string;
  shareUrlType: number;
  shareExpiredType: number;
  sharePasscode?: string;
  renamePrefix?: string;
}

interface ParsedQuarkShareUrl {
  pwdId: string;
  passcode: string;
  pdirFid: string;
}

const SAVE_CHUNK_SIZE = 100;

export class QuarkTransferAdapter implements NetdiskTransferAdapter {
  readonly platform = "quark";

  constructor(
    private readonly client: QuarkDriveClient,
    private readonly options: QuarkTransferAdapterOptions,
  ) {}

  supports(resource: ResourceTransferRecord): boolean {
    return (
      this.options.enabled &&
      resource.originPlatform === "quark" &&
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
    const targetDirFid = await this.resolveTargetDirectory(
      targetPath,
      targetName,
      legacyTargetPath,
    );
    const stoken = await this.client.getShareToken(
      parsed.pwdId,
      parsed.passcode,
    );
    const sharedFiles = await this.client.listSharedFiles(
      parsed.pwdId,
      stoken,
      parsed.pdirFid,
    );
    if (sharedFiles.length === 0) {
      throw new Error("Quark share is empty");
    }

    const existingTargetFiles = await this.client.listFiles(targetDirFid);
    if (existingTargetFiles.length === 0) {
      await this.saveSharedFiles(parsed.pwdId, stoken, targetDirFid, sharedFiles);
    } else {
      await this.renameFilesRecursively(existingTargetFiles);
    }
    const shareTaskId = await this.client.createShareTask(
      targetDirFid,
      targetName,
      {
        urlType: this.options.shareUrlType,
        expiredType: this.options.shareExpiredType,
        passcode: this.getSharePasscode(),
      },
    );
    await this.client.waitTask(shareTaskId);
    const shareId = await this.client.getShareId(shareTaskId);
    const share = await this.client.submitShare(shareId);

    return {
      targetPlatform: "quark",
      targetShareUrl: share.passcode
        ? `${share.shareUrl}?pwd=${share.passcode}`
        : share.shareUrl,
      targetAccessCode: share.passcode,
      targetFileId: targetDirFid,
      targetPath,
      message: `Quark transfer saved ${sharedFiles.length} item(s) into ${targetPath}`,
    };
  }

  private async resolveTargetDirectory(
    targetPath: string,
    targetName: string,
    legacyTargetPath?: string,
  ): Promise<string> {
    const targetDirFid = await this.client.findDirectory(targetPath);
    const legacyDirFid = legacyTargetPath
      ? await this.client.findDirectory(legacyTargetPath)
      : undefined;

    if (targetDirFid && legacyDirFid) {
      const targetFiles = await this.client.listFiles(targetDirFid);
      const legacyFiles = await this.client.listFiles(legacyDirFid);
      if (targetFiles.length === 0 && legacyFiles.length > 0) {
        await this.client.renameFile(
          targetDirFid,
          this.createBackupDirectoryName(targetName),
        );
        await this.client.renameFile(legacyDirFid, targetName);
        return legacyDirFid;
      }
    }

    if (targetDirFid) {
      return targetDirFid;
    }

    if (legacyDirFid) {
      await this.client.renameFile(legacyDirFid, targetName);
      return legacyDirFid;
    }

    return this.client.ensureDirectory(targetPath);
  }

  private async saveSharedFiles(
    pwdId: string,
    stoken: string,
    targetDirFid: string,
    sharedFiles: QuarkSharedFile[],
  ): Promise<void> {
    for (let index = 0; index < sharedFiles.length; index += SAVE_CHUNK_SIZE) {
      const chunk = sharedFiles.slice(index, index + SAVE_CHUNK_SIZE);
      const input: QuarkSaveSharedFilesInput = {
        pwdId,
        stoken,
        toPdirFid: targetDirFid,
        files: chunk.map((file) => ({
          fid: file.fid,
          shareFidToken: file.shareFidToken,
        })),
      };
      const taskId = await this.client.saveSharedFiles(input);
      await this.client.waitTask(taskId);
    }

    const savedFiles = await this.client.listFiles(targetDirFid);
    await this.renameFilesRecursively(savedFiles);
  }

  private async renameFilesRecursively(
    files: Array<{ fid: string; fileName: string; dir: boolean }>,
  ): Promise<void> {
    for (const file of files) {
      await this.renameWithPrefix(file.fid, file.fileName);
      if (!file.dir) {
        continue;
      }

      const children = await this.client.listFiles(file.fid);
      await this.renameFilesRecursively(children);
    }
  }

  private async renameWithPrefix(fid: string, fileName: string): Promise<void> {
    const prefixedName = this.applyRenamePrefix(fileName);
    if (prefixedName === fileName) return;

    await this.client.renameFile(fid, prefixedName);
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
  ): ParsedQuarkShareUrl {
    const url = new URL(shareUrl);
    const match = url.pathname.match(/\/s\/([A-Za-z0-9_-]+)/u);
    const pwdId = match?.[1];
    if (!pwdId) {
      throw new Error(`Invalid Quark share URL: ${shareUrl}`);
    }

    return {
      pwdId,
      passcode: originAccessCode ?? url.searchParams.get("pwd") ?? "",
      pdirFid: this.extractPdirFid(url.pathname),
    };
  }

  private extractPdirFid(pathname: string): string {
    const matches = Array.from(pathname.matchAll(/\/([A-Za-z0-9]{32})-?[^/]*/gu));
    return matches.at(-1)?.[1] ?? "0";
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

  private getSharePasscode(): string | undefined {
    if (this.options.sharePasscode) {
      return this.options.sharePasscode;
    }

    if (this.options.shareUrlType !== 2) {
      return undefined;
    }

    return this.generateSharePasscode();
  }

  private generateSharePasscode(): string {
    const chars =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let passcode = "";
    for (let index = 0; index < 4; index += 1) {
      passcode += chars[Math.floor(Math.random() * chars.length)];
    }

    return passcode;
  }
}
