export interface BaiduDriveFile {
  fsId: string;
  fileName: string;
  path: string;
  isDir: boolean;
}

export interface BaiduShareTransferParams {
  shareId: string;
  shareUk: string;
  fsIds: string[];
  fileNames: string[];
  isDirs: boolean[];
}

export interface BaiduShareOptions {
  period: number;
  passcode: string;
}

export interface BaiduDriveClient {
  getBdstoken(): Promise<string>;
  ensureDirectory(path: string, bdstoken: string): Promise<BaiduDriveFile>;
  listFiles(path: string, bdstoken: string): Promise<BaiduDriveFile[]>;
  verifyPasscode(
    shareUrl: string,
    passcode: string,
    bdstoken: string,
  ): Promise<void>;
  getShareTransferParams(shareUrl: string): Promise<BaiduShareTransferParams>;
  transferSharedFiles(
    params: BaiduShareTransferParams,
    targetPath: string,
    bdstoken: string,
  ): Promise<void>;
  renameFile(path: string, newName: string, bdstoken: string): Promise<void>;
  createShare(
    fsId: string,
    options: BaiduShareOptions,
    bdstoken: string,
  ): Promise<string>;
}
