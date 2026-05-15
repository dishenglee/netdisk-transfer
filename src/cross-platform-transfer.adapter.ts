import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  NetdiskTransferAdapter,
  NetdiskTransferResult,
  ResourceTransferRecord,
} from "./resource-transfer.types.js";
import {
  downloadFile,
  createTempDir,
  cleanupTempDir,
} from "./common/file-transfer-utils.js";
import { QuarkDriveClient } from "./quark/quark-drive-client.js";
import { BaiduDriveClient } from "./baidu/baidu-drive-client.js";
import { UcDriveClient } from "./uc/uc-drive-client.js";
import { XunleiDriveClient } from "./xunlei/xunlei-drive-client.js";

type SourcePlatform = "quark" | "baidu" | "xunlei";

interface SourceFileEntry {
  id: string;
  name: string;
  isDir: false;
  relativePath: string;
}

export interface CrossPlatformTransferOptions {
  targetPlatform: string;
  targetRoot: string;
  shareUrlType: number;
  shareExpiredType: number;
  sharePasscode?: string;
  renamePrefix?: string;
}

interface SourceConfig {
  platform: SourcePlatform;
  quarkClient?: QuarkDriveClient;
  baiduClient?: BaiduDriveClient;
  xunleiClient?: XunleiDriveClient;
}

/**
 * Cross-platform transfer adapter: downloads files from the source platform
 * (Quark/Baidu/Xunlei) via local relay and uploads to the target platform (UC).
 */
export class CrossPlatformTransferAdapter implements NetdiskTransferAdapter {
  readonly platform: string;

  constructor(
    private readonly sources: SourceConfig[],
    private readonly ucClient: UcDriveClient,
    private readonly options: CrossPlatformTransferOptions,
  ) {
    this.platform = options.targetPlatform;
  }

  supports(resource: ResourceTransferRecord): boolean {
    const origin = resource.originPlatform;
    if (!origin || !resource.originShareUrl) return false;
    // Only handle cross-platform when targetPlatform is explicitly set on the resource
    if (!resource.targetPlatform || resource.targetPlatform !== this.options.targetPlatform) return false;
    if (origin === this.options.targetPlatform) return false;
    return this.sources.some((s) => s.platform === origin);
  }

  async transfer(
    resource: ResourceTransferRecord,
  ): Promise<NetdiskTransferResult> {
    const origin = resource.originPlatform as SourcePlatform;
    const log = console.log.bind(console);

    // Step 1: Save shared files to own drive on source platform + get file list
    log(`[跨平台] 从 ${origin} 保存分享文件到源网盘...`);
    const sourceFiles = this.unwrapSingleDirectory(
      await this.saveAndListSourceFiles(resource),
    );
    if (sourceFiles.length === 0) {
      throw new Error("Source share is empty");
    }
    log(`[跨平台] 获取到 ${sourceFiles.length} 个文件`);

    // Step 2: Ensure target directory on UC
    const rawTargetName = this.sanitizeName(
      resource.softwareName ?? resource.resourceName,
    );
    const targetName = this.applyRenamePrefix(rawTargetName);
    const targetPath = this.joinPath(this.options.targetRoot, targetName);
    const targetDirFid = await this.ucClient.ensureDirectory(targetPath);
    log(`[跨平台] UC目标目录: ${targetPath}`);

    // Step 3: Download from source + upload to UC
    const tempDir = await createTempDir();
    let transferredCount = 0;
    try {
      const dirFidCache = new Map<string, string>();
      dirFidCache.set("", targetDirFid);

      for (const file of sourceFiles) {
        const parentRelDir = file.relativePath.includes("/")
          ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))
          : "";

        let uploadDirFid = dirFidCache.get(parentRelDir);
        if (!uploadDirFid) {
          const subDirPath = this.joinPath(targetPath, parentRelDir);
          uploadDirFid = await this.ucClient.ensureDirectory(subDirPath);
          dirFidCache.set(parentRelDir, uploadDirFid);
        }

        log(`[跨平台] 下载: ${file.relativePath}`);
        const safeLocalName = file.name.replace(/[/\\]/gu, "_");
        const localPath = join(tempDir, `${transferredCount}_${safeLocalName}`);
        const { url, headers } = await this.getSourceDownloadInfo(
          origin,
          file,
        );
        await downloadFile({ url, headers, destPath: localPath });

        log(`[跨平台] 上传到UC: ${file.relativePath}`);
        await this.ucClient.uploadFile(localPath, file.name, uploadDirFid);
        transferredCount++;

        await unlink(localPath).catch(() => {});
      }
    } finally {
      await cleanupTempDir(tempDir);
    }

    // Step 4: Rename files on UC
    const ucFiles = await this.ucClient.listFiles(targetDirFid);
    for (const file of ucFiles) {
      const prefixedName = this.applyRenamePrefix(file.fileName);
      if (prefixedName !== file.fileName) {
        await this.ucClient.renameFile(file.fid, prefixedName);
      }
    }

    // Step 5: Share on UC
    log(`[跨平台] 创建UC分享链接...`);
    const shareTaskId = await this.ucClient.createShareTask(
      targetDirFid,
      targetName,
      {
        urlType: this.options.shareUrlType,
        expiredType: this.options.shareExpiredType,
        passcode: this.getSharePasscode(),
      },
    );
    await this.ucClient.waitTask(shareTaskId);
    const shareId = await this.ucClient.getShareId(shareTaskId);
    const share = await this.ucClient.submitShare(shareId);

    return {
      targetPlatform: this.options.targetPlatform,
      targetShareUrl: share.passcode
        ? `${share.shareUrl}?pwd=${share.passcode}`
        : share.shareUrl,
      targetAccessCode: share.passcode,
      targetFileId: targetDirFid,
      targetPath,
      message: `Cross-platform transfer: ${origin} -> ${this.options.targetPlatform}, ${transferredCount} file(s)`,
    };
  }

  private async saveAndListSourceFiles(
    resource: ResourceTransferRecord,
  ): Promise<SourceFileEntry[]> {
    const origin = resource.originPlatform as SourcePlatform;
    const source = this.sources.find((s) => s.platform === origin);
    if (!source) {
      throw new Error(`No source client configured for ${origin}`);
    }

    switch (origin) {
      case "quark":
        return this.saveAndListQuark(resource, source.quarkClient!);
      case "baidu":
        return this.saveAndListBaidu(resource, source.baiduClient!);
      case "xunlei":
        return this.saveAndListXunlei(resource, source.xunleiClient!);
      default:
        throw new Error(`Unsupported source platform: ${origin}`);
    }
  }

  private async saveAndListQuark(
    resource: ResourceTransferRecord,
    client: QuarkDriveClient,
  ): Promise<SourceFileEntry[]> {
    const { pwdId, passcode, pdirFid } = this.parseQuarkShareUrl(
      resource.originShareUrl!,
      resource.originAccessCode,
    );
    const stoken = await client.getShareToken(pwdId, passcode);
    const sharedFiles = await client.listSharedFiles(pwdId, stoken, pdirFid);

    const tempPath = `/__cross_transfer_temp/${Date.now()}`;
    const tempFid = await client.ensureDirectory(tempPath);

    for (let i = 0; i < sharedFiles.length; i += 100) {
      const chunk = sharedFiles.slice(i, i + 100);
      const taskId = await client.saveSharedFiles({
        pwdId,
        stoken,
        toPdirFid: tempFid,
        files: chunk.map((f) => ({
          fid: f.fid,
          shareFidToken: f.shareFidToken,
        })),
      });
      await client.waitTask(taskId);
    }

    const savedFiles = await client.listFiles(tempFid);
    return this.flattenQuarkFiles(client, savedFiles, "");
  }

  private async flattenQuarkFiles(
    client: QuarkDriveClient,
    files: Array<{ fid: string; fileName: string; dir: boolean }>,
    prefix: string,
  ): Promise<SourceFileEntry[]> {
    const result: SourceFileEntry[] = [];
    for (const f of files) {
      const relPath = prefix ? `${prefix}/${f.fileName}` : f.fileName;
      if (f.dir) {
        const children = await client.listFiles(f.fid);
        result.push(...await this.flattenQuarkFiles(client, children, relPath));
      } else {
        result.push({ id: f.fid, name: f.fileName, isDir: false, relativePath: relPath });
      }
    }
    return result;
  }

  private async saveAndListBaidu(
    resource: ResourceTransferRecord,
    client: BaiduDriveClient,
  ): Promise<SourceFileEntry[]> {
    const bdstoken = await client.getBdstoken();
    const shareUrl = resource.originShareUrl!;
    const passcode = resource.originAccessCode;

    if (passcode) {
      await client.verifyPasscode(shareUrl, passcode, bdstoken);
    }

    const params = await client.getShareTransferParams(shareUrl);
    const tempPath = `/__cross_transfer_temp/${Date.now()}`;
    await client.ensureDirectory(tempPath, bdstoken);
    await client.transferSharedFiles(params, tempPath, bdstoken);

    const savedFiles = await client.listFiles(tempPath, bdstoken);
    return this.flattenBaiduFiles(client, bdstoken, savedFiles, "");
  }

  private async flattenBaiduFiles(
    client: BaiduDriveClient,
    bdstoken: string,
    files: Array<{ path: string; fileName: string; isDir: boolean }>,
    prefix: string,
  ): Promise<SourceFileEntry[]> {
    const result: SourceFileEntry[] = [];
    for (const f of files) {
      const relPath = prefix ? `${prefix}/${f.fileName}` : f.fileName;
      if (f.isDir) {
        const children = await client.listFiles(f.path, bdstoken);
        result.push(...await this.flattenBaiduFiles(client, bdstoken, children, relPath));
      } else {
        result.push({ id: f.path, name: f.fileName, isDir: false, relativePath: relPath });
      }
    }
    return result;
  }

  private async saveAndListXunlei(
    resource: ResourceTransferRecord,
    client: XunleiDriveClient,
  ): Promise<SourceFileEntry[]> {
    const { shareId, passCode } = this.parseXunleiShareUrl(
      resource.originShareUrl!,
      resource.originAccessCode,
    );
    const detail = await client.getShareDetail(shareId, passCode);

    const tempPath = `/__cross_transfer_temp/${Date.now()}`;
    const tempDir = await client.ensureDirectory(tempPath);
    const taskId = await client.restoreSharedFiles(
      shareId,
      detail,
      tempDir.id,
    );
    await client.waitTask(taskId);

    const savedFiles = await client.listFiles(tempDir.id);
    return this.flattenXunleiFiles(client, savedFiles, "");
  }

  private async flattenXunleiFiles(
    client: XunleiDriveClient,
    files: Array<{ id: string; name: string; isDir: boolean }>,
    prefix: string,
  ): Promise<SourceFileEntry[]> {
    const result: SourceFileEntry[] = [];
    for (const f of files) {
      const relPath = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.isDir) {
        const children = await client.listFiles(f.id);
        result.push(...await this.flattenXunleiFiles(client, children, relPath));
      } else {
        result.push({ id: f.id, name: f.name, isDir: false, relativePath: relPath });
      }
    }
    return result;
  }

  private async getSourceDownloadInfo(
    origin: SourcePlatform,
    file: { id: string; name: string },
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const source = this.sources.find((s) => s.platform === origin)!;

    switch (origin) {
      case "quark": {
        const client = source.quarkClient!;
        const [info] = await client.getDownloadUrl([file.id]);
        if (!info?.downloadUrl) {
          throw new Error(`Failed to get download URL for ${file.name}`);
        }
        return {
          url: info.downloadUrl,
          headers: {
            cookie: client.getCookie(),
            referer: "https://pan.quark.cn/",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36",
          },
        };
      }
      case "baidu": {
        const client = source.baiduClient!;
        const bdstoken = await client.getBdstoken();
        const url = await client.getDownloadUrl(file.id, bdstoken);
        return {
          url,
          headers: {
            cookie: client.getCookie(),
            "user-agent": "pan.baidu.com",
          },
        };
      }
      case "xunlei": {
        const client = source.xunleiClient!;
        const url = await client.getDownloadUrl(file.id);
        return {
          url,
          headers: {
            "user-agent":
              "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)",
          },
        };
      }
    }
  }

  private parseQuarkShareUrl(
    shareUrl: string,
    accessCode: string | null,
  ): { pwdId: string; passcode: string; pdirFid: string } {
    const url = new URL(shareUrl);
    const match = url.pathname.match(/\/s\/([A-Za-z0-9_-]+)/u);
    const pwdId = match?.[1];
    if (!pwdId) throw new Error(`Invalid Quark share URL: ${shareUrl}`);

    const pdirFid =
      Array.from(url.pathname.matchAll(/\/([A-Za-z0-9]{32})-?[^/]*/gu))
        .at(-1)?.[1] ?? "0";

    return {
      pwdId,
      passcode: accessCode ?? url.searchParams.get("pwd") ?? "",
      pdirFid,
    };
  }

  private parseXunleiShareUrl(
    shareUrl: string,
    accessCode: string | null,
  ): { shareId: string; passCode: string } {
    const url = new URL(shareUrl);
    const match = url.pathname.match(/\/s\/([A-Za-z0-9_-]+)/u);
    const shareId = match?.[1];
    if (!shareId) throw new Error(`Invalid Xunlei share URL: ${shareUrl}`);

    return {
      shareId,
      passCode:
        accessCode ??
        url.searchParams.get("pwd") ??
        url.hash.replace(/^#/, "").trim(),
    };
  }

  private unwrapSingleDirectory(files: SourceFileEntry[]): SourceFileEntry[] {
    if (files.length === 0) return files;
    const first = files[0].relativePath.split("/")[0];
    if (!first || !files.every((f) => f.relativePath.startsWith(first + "/"))) {
      return files;
    }
    const prefixLen = first.length + 1;
    return files.map((f) => ({ ...f, relativePath: f.relativePath.slice(prefixLen) }));
  }

  private applyRenamePrefix(fileName: string): string {
    const prefix = this.options.renamePrefix?.trim();
    if (!prefix) return fileName;

    const withoutPrefix = fileName.startsWith(prefix)
      ? fileName.slice(prefix.length)
      : fileName;
    return `${prefix}${withoutPrefix.trim() || "未命名资源"}`;
  }

  private sanitizeName(value: string): string {
    return (
      value
        .replace(/[\\/:*?"<>|]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 120) || "未命名资源"
    );
  }

  private joinPath(root: string, name: string): string {
    return `${root.replace(/\/+$/u, "")}/${name}`.replace(/\/+/gu, "/");
  }

  private getSharePasscode(): string | undefined {
    if (this.options.sharePasscode) return this.options.sharePasscode;
    if (this.options.shareUrlType !== 2) return undefined;
    const chars =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let passcode = "";
    for (let i = 0; i < 4; i++) {
      passcode += chars[Math.floor(Math.random() * chars.length)];
    }
    return passcode;
  }
}
