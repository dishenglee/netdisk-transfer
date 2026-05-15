import {
  UcDriveClient,
  UcDriveFile,
  UcSaveSharedFilesInput,
  UcShareOptions,
  UcSharedFile,
} from "./uc-drive-client.js";

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

export class UcDriveApiClient implements UcDriveClient {
  constructor(private readonly options: UcDriveApiClientOptions) {}

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
