import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";


import {
  UcDownloadInfo,
  UcDriveClient,
  UcDriveFile,
  UcSaveSharedFilesInput,
  UcShareOptions,
  UcSharedFile,
} from "./uc-drive-client.js";
import { computeFileHashes, getFileSize } from "../common/file-transfer-utils.js";

const UC_PC_BASE_URL = "https://pc-api.uc.cn";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

interface UcDriveApiClientOptions {
  cookie: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
}

interface UcEnvelope<T> {
  code?: number;
  status?: number;
  message?: string;
  data?: T;
  metadata?: {
    _total?: number;
    _size?: number;
    _count?: number;
    tq_gap?: number;
  };
}

interface UcShareDetailData {
  token_info?: {
    stoken?: string;
  };
  detail_info?: {
    list?: Array<{
      fid: string;
      file_name: string;
      dir: boolean;
      share_fid_token: string;
    }>;
  };
}

interface UcDriveFileData {
  fid: string;
  file_name: string;
  dir: boolean;
}

interface UcPathInfo {
  file_path: string;
  fid: string;
}

interface UcFileSortData {
  list?: UcDriveFileData[];
}

interface UcCreateDirectoryData {
  fid?: string;
}

interface UcTaskData {
  status?: number;
  task_title?: string;
  share_id?: string;
  save_as?: {
    save_as_top_fids?: string[];
  };
}

interface UcSaveTaskData {
  task_id?: string;
}

interface UcSubmitShareData {
  share_url?: string;
  title?: string;
  passcode?: string;
}

interface UcDownloadData {
  download_url?: string;
  fid?: string;
}

interface UcUpPreData {
  task_id?: string;
  finish?: boolean;
  upload_id?: string;
  obj_key?: string;
  upload_url?: string;
  fid?: string;
  bucket?: string;
  callback?: { callbackUrl?: string; callbackBody?: string };
  format_type?: string;
  size?: number;
  auth_info?: string;
}

interface UcUpPreMetadata {
  part_thread?: number;
  part_size?: number;
}

interface UcHashData {
  finish?: boolean;
  fid?: string;
}

interface UcUpAuthData {
  auth_key?: string;
}

const OSS_USER_AGENT =
  "aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit";

export class UcDriveApiClient implements UcDriveClient {
  constructor(private readonly options: UcDriveApiClientOptions) {}

  getCookie(): string {
    return this.options.cookie;
  }

  async getDownloadUrl(fids: string[]): Promise<UcDownloadInfo[]> {
    const response = await this.request<UcDownloadData[]>(
      "POST",
      "/1/clouddrive/file/download",
      { searchParams: this.createBaseParams() },
      { fids },
    );
    const list = response.data ?? [];
    return list
      .filter((item) => item.download_url && item.fid)
      .map((item) => ({
        fid: item.fid!,
        downloadUrl: item.download_url!,
      }));
  }

  async uploadFile(
    localPath: string,
    fileName: string,
    pdirFid: string,
  ): Promise<string> {
    const fileSize = await getFileSize(localPath);
    const { md5, sha1 } = await computeFileHashes(localPath);
    const mimeType = this.guessMimeType(fileName);

    // Step 1: pre-upload
    const pre = await this.upPre(fileName, fileSize, mimeType, pdirFid);
    if (pre.data?.finish) {
      return pre.data.fid ?? "";
    }

    const taskId = pre.data?.task_id;
    if (!taskId || !pre.data?.upload_id || !pre.data?.obj_key) {
      throw new Error("UC upload pre response missing required fields");
    }

    // Step 2: hash check (秒传)
    const hashResp = await this.upHash(md5, sha1, taskId);
    if (hashResp.data?.finish) {
      return hashResp.data.fid ?? pre.data.fid ?? "";
    }

    // Step 3: multipart upload
    const partSize = pre.metadata?.part_size ?? 10 * 1024 * 1024; // default 10MB
    const partCount = Math.ceil(fileSize / partSize);
    const etags: string[] = [];

    for (let i = 0; i < partCount; i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, fileSize);
      const partNumber = i + 1;

      const etag = await this.upPart(pre, mimeType, partNumber, localPath, start, end);
      etags.push(etag);
    }

    // Step 4: commit
    await this.upCommit(pre, etags);

    // Step 5: finish
    await this.upFinish(pre);

    return pre.data.fid ?? "";
  }

  private async upPre(
    fileName: string,
    fileSize: number,
    mimeType: string,
    pdirFid: string,
  ): Promise<UcEnvelope<UcUpPreData> & { metadata?: UcUpPreMetadata }> {
    const now = Date.now();
    return this.request<UcUpPreData>(
      "POST",
      "/1/clouddrive/file/upload/pre",
      { searchParams: this.createBaseParams() },
      {
        ccp_hash_update: true,
        dir_name: "",
        file_name: fileName,
        format_type: mimeType,
        l_created_at: now,
        l_updated_at: now,
        pdir_fid: pdirFid,
        size: fileSize,
      },
    ) as Promise<UcEnvelope<UcUpPreData> & { metadata?: UcUpPreMetadata }>;
  }

  private async upHash(
    md5: string,
    sha1: string,
    taskId: string,
  ): Promise<UcEnvelope<UcHashData>> {
    return this.request<UcHashData>(
      "POST",
      "/1/clouddrive/file/update/hash",
      { searchParams: this.createBaseParams() },
      { md5, sha1, task_id: taskId },
    );
  }

  private async upPart(
    pre: UcEnvelope<UcUpPreData> & { metadata?: UcUpPreMetadata },
    mimeType: string,
    partNumber: number,
    localPath: string,
    start: number,
    end: number,
  ): Promise<string> {
    const timeStr = new Date().toUTCString();
    const authMeta = [
      "PUT",
      "",
      mimeType,
      timeStr,
      `x-oss-date:${timeStr}`,
      `x-oss-user-agent:${OSS_USER_AGENT}`,
      `/${pre.data!.bucket}/${pre.data!.obj_key}?partNumber=${partNumber}&uploadId=${pre.data!.upload_id}`,
    ].join("\n");

    const authResp = await this.request<UcUpAuthData>(
      "POST",
      "/1/clouddrive/file/upload/auth",
      { searchParams: this.createBaseParams() },
      {
        auth_info: pre.data!.auth_info,
        auth_meta: authMeta,
        task_id: pre.data!.task_id,
      },
    );

    const authKey = authResp.data?.auth_key;
    if (!authKey) {
      throw new Error("UC upload auth response missing auth_key");
    }

    // Read the chunk
    const chunkSize = end - start;
    const { readFileChunk } = await import("../common/file-transfer-utils.js");
    const chunk = new Uint8Array(await readFileChunk(localPath, start, chunkSize));

    // Upload to OSS
    const ossUrl = `https://${pre.data!.bucket}.${pre.data!.upload_url!.slice(7)}/${pre.data!.obj_key}`;
    const ossResp = await fetch(ossUrl + `?partNumber=${partNumber}&uploadId=${pre.data!.upload_id}`, {
      method: "PUT",
      headers: {
        Authorization: authKey,
        "Content-Type": mimeType,
        Referer: "https://drive.uc.cn/",
        "x-oss-date": timeStr,
        "x-oss-user-agent": OSS_USER_AGENT,
      },
      body: chunk,
    });

    if (!ossResp.ok) {
      const text = await ossResp.text();
      throw new Error(`UC OSS upload failed: ${ossResp.status} ${text.slice(0, 200)}`);
    }

    return ossResp.headers.get("Etag") ?? "";
  }

  private async upCommit(
    pre: UcEnvelope<UcUpPreData> & { metadata?: UcUpPreMetadata },
    etags: string[],
  ): Promise<void> {
    const timeStr = new Date().toUTCString();

    // Build CompleteMultipartUpload XML
    const parts = etags.map(
      (etag, i) =>
        `<Part>\n<PartNumber>${i + 1}</PartNumber>\n<ETag>${etag}</ETag>\n</Part>`,
    );
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n${parts.join("\n")}\n</CompleteMultipartUpload>`;

    const contentMd5 = createHash("md5").update(xml).digest("base64");
    const callbackBytes = JSON.stringify(pre.data!.callback);
    const callbackBase64 = Buffer.from(callbackBytes).toString("base64");

    const authMeta = [
      "POST",
      contentMd5,
      "application/xml",
      timeStr,
      `x-oss-callback:${callbackBase64}`,
      `x-oss-date:${timeStr}`,
      `x-oss-user-agent:${OSS_USER_AGENT}`,
      `/${pre.data!.bucket}/${pre.data!.obj_key}?uploadId=${pre.data!.upload_id}`,
    ].join("\n");

    const authResp = await this.request<UcUpAuthData>(
      "POST",
      "/1/clouddrive/file/upload/auth",
      { searchParams: this.createBaseParams() },
      {
        auth_info: pre.data!.auth_info,
        auth_meta: authMeta,
        task_id: pre.data!.task_id,
      },
    );

    const authKey = authResp.data?.auth_key;
    if (!authKey) {
      throw new Error("UC upload commit auth failed");
    }

    const ossUrl = `https://${pre.data!.bucket}.${pre.data!.upload_url!.slice(7)}/${pre.data!.obj_key}`;
    const ossResp = await fetch(ossUrl + `?uploadId=${pre.data!.upload_id}`, {
      method: "POST",
      headers: {
        Authorization: authKey,
        "Content-MD5": contentMd5,
        "Content-Type": "application/xml",
        Referer: "https://drive.uc.cn/",
        "x-oss-callback": callbackBase64,
        "x-oss-date": timeStr,
        "x-oss-user-agent": OSS_USER_AGENT,
      },
      body: xml,
    });

    if (!ossResp.ok) {
      const text = await ossResp.text();
      throw new Error(`UC OSS commit failed: ${ossResp.status} ${text.slice(0, 200)}`);
    }
  }

  private async upFinish(
    pre: UcEnvelope<UcUpPreData> & { metadata?: UcUpPreMetadata },
  ): Promise<void> {
    await this.request<Record<string, never>>(
      "POST",
      "/1/clouddrive/file/upload/finish",
      { searchParams: this.createBaseParams() },
      { obj_key: pre.data!.obj_key, task_id: pre.data!.task_id },
    );
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      pdf: "application/pdf",
      zip: "application/zip",
      rar: "application/x-rar-compressed",
      "7z": "application/x-7z-compressed",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      mp4: "video/mp4",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      mp3: "audio/mpeg",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      txt: "text/plain",
      exe: "application/x-msdownload",
      dmg: "application/x-apple-diskimage",
      iso: "application/x-iso9660-image",
      apk: "application/vnd.android.package-archive",
    };
    return mimeMap[ext] ?? "application/octet-stream";
  }

  async getShareTokenAndFiles(
    pwdId: string,
    passcode: string,
  ): Promise<{ stoken: string; files: UcSharedFile[] }> {
    const allFiles: UcSharedFile[] = [];
    let stoken = "";
    let page = 1;

    while (true) {
      const response = await this.request<UcShareDetailData>(
        "POST",
        "/1/clouddrive/share/sharepage/v2/detail",
        { searchParams: this.createBaseParams() },
        {
          pwd_id: pwdId,
          passcode,
          force: 0,
          page,
          size: 50,
          fetch_banner: 0,
          fetch_share: 1,
          fetch_total: 1,
          sort: "file_type:asc,file_name:asc",
        },
      );

      if (page === 1) {
        stoken = response.data?.token_info?.stoken ?? "";
        if (!stoken) {
          throw new Error("UC share detail response missing stoken");
        }
      }

      const list = response.data?.detail_info?.list ?? [];
      allFiles.push(
        ...list.map((file) => ({
          fid: file.fid,
          fileName: file.file_name,
          dir: file.dir,
          shareFidToken: file.share_fid_token,
        })),
      );

      const total = response.metadata?._total ?? allFiles.length;
      if (allFiles.length >= total || list.length === 0) {
        return { stoken, files: allFiles };
      }

      page += 1;
    }
  }

  async ensureDirectory(path: string): Promise<string> {
    const normalized = this.normalizeDirectoryPath(path);
    const existing = await this.findDirectory(normalized);
    if (existing) {
      return existing;
    }

    const response = await this.request<UcCreateDirectoryData>(
      "POST",
      "/1/clouddrive/file",
      { searchParams: this.createBaseParams() },
      {
        pdir_fid: "0",
        file_name: "",
        dir_path: normalized,
        dir_init_lock: false,
      },
      [23008],
    );
    if (response.code === 23008) {
      const conflicted = await this.findDirectory(normalized);
      if (conflicted) {
        return conflicted;
      }
    }

    const fid = response.data?.fid;
    if (!fid) {
      throw new Error(`UC directory response missing fid: ${normalized}`);
    }

    return fid;
  }

  async listFiles(pdirFid: string): Promise<UcDriveFile[]> {
    const files: UcDriveFile[] = [];
    let page = 1;

    while (true) {
      const response = await this.request<UcFileSortData>(
        "GET",
        "/1/clouddrive/file/sort",
        {
          searchParams: {
            ...this.createBaseParams(),
            pdir_fid: pdirFid,
            _page: page.toString(),
            _size: "50",
            _fetch_total: "1",
            _fetch_sub_dirs: "0",
            _sort: "file_type:asc,updated_at:desc",
          },
        },
      );
      const list = response.data?.list ?? [];
      files.push(
        ...list.map((file) => ({
          fid: file.fid,
          fileName: file.file_name,
          dir: file.dir,
        })),
      );

      const total = response.metadata?._total ?? files.length;
      if (files.length >= total || list.length === 0) {
        return files;
      }

      page += 1;
    }
  }

  async saveSharedFiles(input: UcSaveSharedFilesInput): Promise<string> {
    const response = await this.request<UcSaveTaskData>(
      "POST",
      "/1/clouddrive/share/sharepage/save",
      { searchParams: this.createBaseParams() },
      {
        fid_list: input.files.map((file) => file.fid),
        fid_token_list: input.files.map((file) => file.shareFidToken),
        to_pdir_fid: input.toPdirFid,
        pwd_id: input.pwdId,
        stoken: input.stoken,
        pdir_fid: "0",
        scene: "link",
      },
    );
    const taskId = response.data?.task_id;
    if (!taskId) {
      throw new Error("UC save response missing task_id");
    }

    return taskId;
  }

  async saveSharedFilesAll(
    pwdId: string,
    stoken: string,
    toPdirFid: string,
  ): Promise<string> {
    const response = await this.request<UcSaveTaskData>(
      "POST",
      "/1/clouddrive/share/sharepage/save",
      { searchParams: this.createBaseParams() },
      {
        to_pdir_fid: toPdirFid,
        pwd_id: pwdId,
        stoken,
        pdir_fid: "0",
        scene: "link",
        save_all: true,
      },
    );
    const taskId = response.data?.task_id;
    if (!taskId) {
      throw new Error("UC save-all response missing task_id");
    }

    return taskId;
  }

  async waitTask(taskId: string): Promise<{ savedFids: string[] }> {
    for (
      let retryIndex = 0;
      retryIndex < this.options.taskMaxAttempts;
      retryIndex += 1
    ) {
      const response = await this.request<UcTaskData>(
        "GET",
        "/1/clouddrive/task",
        {
          searchParams: {
            ...this.createBaseParams(),
            task_id: taskId,
            retry_index: retryIndex.toString(),
          },
        },
      );

      if (response.data?.status === 2) {
        return {
          savedFids: response.data.save_as?.save_as_top_fids ?? [],
        };
      }

      if (response.data?.status === 3) {
        throw new Error(
          response.message ?? `UC task failed: ${taskId}`,
        );
      }

      await this.sleep(this.options.taskPollIntervalMs);
    }

    throw new Error(`UC task timed out: ${taskId}`);
  }

  async renameFile(fid: string, fileName: string): Promise<void> {
    await this.request<Record<string, never>>(
      "POST",
      "/1/clouddrive/file/rename",
      { searchParams: this.createBaseParams() },
      { fid, file_name: fileName },
    );
  }

  async createShareTask(
    fid: string,
    title: string,
    options: UcShareOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      fid_list: [fid],
      title,
      url_type: options.urlType,
      expired_type: options.expiredType,
    };
    if (options.passcode) {
      body.passcode = options.passcode;
    }

    const response = await this.request<UcSaveTaskData>(
      "POST",
      "/1/clouddrive/share",
      { searchParams: this.createBaseParams() },
      body,
    );

    const taskId = response.data?.task_id;
    if (!taskId) {
      throw new Error("UC share response missing task_id");
    }

    return taskId;
  }

  async getShareId(taskId: string): Promise<string> {
    const response = await this.request<UcTaskData>(
      "GET",
      "/1/clouddrive/task",
      {
        searchParams: {
          ...this.createBaseParams(),
          task_id: taskId,
          retry_index: "0",
        },
      },
    );
    const shareId = response.data?.share_id;
    if (!shareId) {
      throw new Error("UC task response missing share_id");
    }

    return shareId;
  }

  async submitShare(
    shareId: string,
  ): Promise<{ shareUrl: string; title: string; passcode?: string }> {
    const response = await this.request<UcSubmitShareData>(
      "POST",
      "/1/clouddrive/share/password",
      { searchParams: this.createBaseParams() },
      { share_id: shareId },
    );
    const shareUrl = response.data?.share_url;
    const title = response.data?.title;
    if (!shareUrl || !title) {
      throw new Error(
        "UC submit share response missing share_url or title",
      );
    }

    return {
      shareUrl,
      title,
      passcode: response.data?.passcode,
    };
  }

  async findDirectory(path: string): Promise<string | undefined> {
    const response = await this.request<UcPathInfo[]>(
      "POST",
      "/1/clouddrive/file/info/path_list",
      { searchParams: this.createBaseParams() },
      { file_path: [path], namespace: "0" },
    );

    return response.data?.find((item) => item.file_path === path)?.fid;
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    options: { searchParams: Record<string, string> },
    body?: unknown,
    allowedErrorCodes: number[] = [],
  ): Promise<UcEnvelope<T>> {
    const url = new URL(`${UC_PC_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(options.searchParams)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method,
      headers: {
        cookie: this.options.cookie,
        "content-type": "application/json",
        "user-agent": DEFAULT_USER_AGENT,
        origin: "https://drive.uc.cn",
        referer: "https://drive.uc.cn/",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json()) as UcEnvelope<T>;
    const code = json.code ?? json.status;
    if (code && allowedErrorCodes.includes(code)) {
      return json;
    }

    if (!response.ok || !this.isSuccess(json)) {
      throw new Error(json.message ?? `UC request failed: ${pathname}`);
    }

    return json;
  }

  private createBaseParams(): Record<string, string> {
    return {
      pr: "UCBrowser",
      fr: "pc",
    };
  }

  private isSuccess<T>(json: UcEnvelope<T>): boolean {
    return json.code === 0 || json.status === 200 || json.message === "ok";
  }

  private normalizeDirectoryPath(path: string): string {
    const normalized = path.replace(/\/+/gu, "/").replace(/\/$/u, "");
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
