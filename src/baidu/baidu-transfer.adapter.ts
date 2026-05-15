import {
  NetdiskTransferAdapter,
  NetdiskTransferResult,
  ResourceTransferRecord,
} from "../resource-transfer.types.js";
import { BaiduDriveClient, BaiduDriveFile } from "./baidu-drive-client.js";

interface BaiduTransferAdapterOptions {
  enabled: boolean;
  targetRoot: string;
  sharePeriod: number;
  sharePasscode?: string;
  renamePrefix?: string;
  listRetryDelayMs?: number;
  listRetryMaxAttempts?: number;
}

interface ParsedBaiduShareUrl {
  shareUrl: string;
  passcode: string;
}

const DEFAULT_LIST_RETRY_DELAY_MS = 1000;
const DEFAULT_LIST_RETRY_MAX_ATTEMPTS = 5;

export class BaiduTransferAdapter implements NetdiskTransferAdapter {
  readonly platform = "baidu";

  constructor(
    private readonly client: BaiduDriveClient,
    private readonly options: BaiduTransferAdapterOptions,
  ) {}

  supports(resource: ResourceTransferRecord): boolean {
    return (
      this.options.enabled &&
      resource.originPlatform === "baidu" &&
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
    const bdstoken = await this.client.getBdstoken();
    const legacyTargetPath =
      rawTargetName === targetName
        ? undefined
        : this.joinPath(this.options.targetRoot, rawTargetName);
    const targetDir = await this.resolveTargetDirectory(
      targetPath,
      targetName,
      bdstoken,
      legacyTargetPath,
    );

    if (parsed.passcode) {
      await this.client.verifyPasscode(
        parsed.shareUrl,
        parsed.passcode,
        bdstoken,
      );
    }

    const transferParams = await this.client.getShareTransferParams(
      parsed.shareUrl,
    );
    if (transferParams.fsIds.length === 0) {
      throw new Error("Baidu share is empty");
    }

    const existingTargetFiles = await this.listFilesWithRetry(
      targetPath,
      bdstoken,
    );
    if (existingTargetFiles.length === 0) {
      await this.client.transferSharedFiles(transferParams, targetPath, bdstoken);
      const savedFiles = await this.client.listFiles(targetPath, bdstoken);
      await this.renameFilesRecursively(savedFiles, bdstoken);
    } else {
      await this.renameFilesRecursively(existingTargetFiles, bdstoken);
    }

    const passcode = this.getSharePasscode();
    const shareUrl = await this.client.createShare(
      targetDir.fsId,
      {
        period: this.options.sharePeriod,
        passcode,
      },
      bdstoken,
    );

    return {
      targetPlatform: "baidu",
      targetShareUrl: `${shareUrl}?pwd=${passcode}`,
      targetAccessCode: passcode,
      targetFileId: targetDir.fsId,
      targetPath,
      message: `Baidu transfer saved ${transferParams.fsIds.length} item(s) into ${targetPath}`,
    };
  }

  private async resolveTargetDirectory(
    targetPath: string,
    targetName: string,
    bdstoken: string,
    legacyTargetPath?: string,
  ): Promise<BaiduDriveFile> {
    await this.client.ensureDirectory(this.options.targetRoot, bdstoken);
    const targetDir = await this.findDirectory(targetPath, bdstoken);
    const legacyDir = legacyTargetPath
      ? await this.findDirectory(legacyTargetPath, bdstoken)
      : undefined;

    if (targetDir && legacyDir) {
      const targetFiles = await this.listFilesWithRetry(targetPath, bdstoken);
      const legacyFiles = await this.listFilesWithRetry(
        legacyTargetPath as string,
        bdstoken,
      );
      if (targetFiles.length === 0 && legacyFiles.length > 0) {
        await this.client.renameFile(
          targetDir.path,
          this.createBackupDirectoryName(targetName),
          bdstoken,
        );
        await this.client.renameFile(legacyDir.path, targetName, bdstoken);
        return { ...legacyDir, fileName: targetName, path: targetPath };
      }
    }

    if (targetDir) {
      return targetDir;
    }

    if (legacyDir) {
      await this.client.renameFile(legacyDir.path, targetName, bdstoken);
      return { ...legacyDir, fileName: targetName, path: targetPath };
    }

    return this.client.ensureDirectory(targetPath, bdstoken);
  }

  private async findDirectory(
    path: string,
    bdstoken: string,
  ): Promise<BaiduDriveFile | undefined> {
    const parentPath = this.dirname(path);
    const directoryName = this.basename(path);
    const siblings = await this.listFilesWithRetry(parentPath, bdstoken);
    return siblings.find((item) => item.isDir && item.fileName === directoryName);
  }

  private async renameFilesRecursively(
    files: BaiduDriveFile[],
    bdstoken: string,
  ): Promise<void> {
    for (const file of files) {
      const nextPath = await this.renameWithPrefix(file, bdstoken);
      if (!file.isDir) {
        continue;
      }

      const children = await this.listFilesWithRetry(nextPath, bdstoken);
      await this.renameFilesRecursively(children, bdstoken);
    }
  }

  private async listFilesWithRetry(
    path: string,
    bdstoken: string,
  ): Promise<BaiduDriveFile[]> {
    const maxAttempts =
      this.options.listRetryMaxAttempts ?? DEFAULT_LIST_RETRY_MAX_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.client.listFiles(path, bdstoken);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) {
          break;
        }

        await this.sleep(
          this.options.listRetryDelayMs ?? DEFAULT_LIST_RETRY_DELAY_MS,
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async renameWithPrefix(
    file: BaiduDriveFile,
    bdstoken: string,
  ): Promise<string> {
    const prefixedName = this.applyRenamePrefix(file.fileName);
    if (prefixedName === file.fileName) {
      return file.path;
    }

    await this.client.renameFile(file.path, prefixedName, bdstoken);
    return this.joinPath(this.dirname(file.path), prefixedName);
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
  ): ParsedBaiduShareUrl {
    const url = new URL(shareUrl);
    if (url.hostname !== "pan.baidu.com") {
      throw new Error(`Invalid Baidu share URL: ${shareUrl}`);
    }

    const normalizedPath = url.pathname.replace("/share/init", "/s/1");
    const normalizedUrl = new URL(`${url.origin}${normalizedPath}`);
    const passcode =
      originAccessCode ??
      url.searchParams.get("pwd") ??
      url.searchParams.get("password") ??
      "";

    return {
      shareUrl: normalizedUrl.toString(),
      passcode,
    };
  }

  private joinPath(root: string, name: string): string {
    return `${root.replace(/\/+$/u, "")}/${name}`.replace(/\/+/gu, "/");
  }

  private dirname(path: string): string {
    const normalized = path.replace(/\/+$/u, "");
    const index = normalized.lastIndexOf("/");
    return index <= 0 ? "/" : normalized.slice(0, index);
  }

  private basename(path: string): string {
    const normalized = path.replace(/\/+$/u, "");
    const index = normalized.lastIndexOf("/");
    return index < 0 ? normalized : normalized.slice(index + 1);
  }

  private sanitizeName(value: string): string {
    const sanitized = value
      .replace(/[<>|*?\\:]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);

    return sanitized || "未命名资源";
  }

  private getSharePasscode(): string {
    if (this.options.sharePasscode) {
      return this.options.sharePasscode;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private createBackupDirectoryName(targetName: string): string {
    const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
    return this.sanitizeName(`${targetName}-空目录-${timestamp}`);
  }
}
