export interface QuarkSharedFile {
  fid: string;
  fileName: string;
  dir: boolean;
  shareFidToken: string;
}

export interface QuarkDriveFile {
  fid: string;
  fileName: string;
  dir: boolean;
}

export interface QuarkSaveSharedFilesInput {
  pwdId: string;
  stoken: string;
  toPdirFid: string;
  files: Array<{
    fid: string;
    shareFidToken: string;
  }>;
}

export interface QuarkTaskResult {
  savedFids: string[];
}

export interface QuarkShareOptions {
  urlType: number;
  expiredType: number;
  passcode?: string;
}

export interface QuarkDownloadInfo {
  fid: string;
  downloadUrl: string;
}

export interface QuarkDriveClient {
  getDownloadUrl(fids: string[]): Promise<QuarkDownloadInfo[]>;
  getCookie(): string;
  getShareToken(pwdId: string, passcode: string): Promise<string>;
  listSharedFiles(
    pwdId: string,
    stoken: string,
    pdirFid: string,
  ): Promise<QuarkSharedFile[]>;
  findDirectory(path: string): Promise<string | undefined>;
  ensureDirectory(path: string): Promise<string>;
  listFiles(pdirFid: string): Promise<QuarkDriveFile[]>;
  saveSharedFiles(input: QuarkSaveSharedFilesInput): Promise<string>;
  waitTask(taskId: string): Promise<QuarkTaskResult>;
  renameFile(fid: string, fileName: string): Promise<void>;
  createShareTask(
    fid: string,
    title: string,
    options: QuarkShareOptions,
  ): Promise<string>;
  getShareId(taskId: string): Promise<string>;
  submitShare(shareId: string): Promise<{
    shareUrl: string;
    title: string;
    passcode?: string;
  }>;
}
