export interface UcSharedFile {
  fid: string;
  fileName: string;
  dir: boolean;
  shareFidToken: string;
}

export interface UcDriveFile {
  fid: string;
  fileName: string;
  dir: boolean;
}

export interface UcSaveSharedFilesInput {
  pwdId: string;
  stoken: string;
  toPdirFid: string;
  files: Array<{
    fid: string;
    shareFidToken: string;
  }>;
}

export interface UcTaskResult {
  savedFids: string[];
}

export interface UcShareOptions {
  urlType: number;
  expiredType: number;
  passcode?: string;
}

export interface UcDriveClient {
  getShareTokenAndFiles(
    pwdId: string,
    passcode: string,
  ): Promise<{ stoken: string; files: UcSharedFile[] }>;
  findDirectory(path: string): Promise<string | undefined>;
  ensureDirectory(path: string): Promise<string>;
  listFiles(pdirFid: string): Promise<UcDriveFile[]>;
  saveSharedFiles(input: UcSaveSharedFilesInput): Promise<string>;
  saveSharedFilesAll(
    pwdId: string,
    stoken: string,
    toPdirFid: string,
  ): Promise<string>;
  waitTask(taskId: string): Promise<UcTaskResult>;
  renameFile(fid: string, fileName: string): Promise<void>;
  createShareTask(
    fid: string,
    title: string,
    options: UcShareOptions,
  ): Promise<string>;
  getShareId(taskId: string): Promise<string>;
  submitShare(shareId: string): Promise<{
    shareUrl: string;
    title: string;
    passcode?: string;
  }>;
}
