export interface XunleiSharedFile {
  id: string;
  name: string;
  isDir: boolean;
}

export interface XunleiShareDetail {
  shareId: string;
  title: string;
  passCodeToken: string;
  files: XunleiSharedFile[];
}

export interface XunleiDriveFile {
  id: string;
  name: string;
  isDir: boolean;
}

export interface XunleiRestoreTaskResult {
  fileIds: string[];
}

export interface XunleiShareOptions {
  expirationDays: number;
  title: string;
}

export interface XunleiCreatedShare {
  shareUrl: string;
  passCode?: string;
}

export interface XunleiDriveClient {
  getDownloadUrl(fileId: string): Promise<string>;
  getShareDetail(
    shareId: string,
    passCode: string,
  ): Promise<XunleiShareDetail>;
  ensureDirectory(path: string): Promise<XunleiDriveFile>;
  listFiles(parentId: string): Promise<XunleiDriveFile[]>;
  restoreSharedFiles(
    shareId: string,
    detail: XunleiShareDetail,
    parentId: string,
  ): Promise<string>;
  waitTask(taskId: string): Promise<XunleiRestoreTaskResult>;
  renameFile(fileId: string, name: string): Promise<void>;
  createShare(
    fileIds: string[],
    options: XunleiShareOptions,
  ): Promise<XunleiCreatedShare>;
}
