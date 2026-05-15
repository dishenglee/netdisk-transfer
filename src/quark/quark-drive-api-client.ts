import {
  QuarkDriveClient,
  QuarkDriveFile,
  QuarkSaveSharedFilesInput,
  QuarkShareOptions,
  QuarkSharedFile,
} from "./quark-drive-client.js";

const QUARK_PC_BASE_URL = "https://drive-pc.quark.cn";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch";

interface QuarkDriveApiClientOptions {
  cookie: string;
  taskPollIntervalMs: number;
  taskMaxAttempts: number;
}

interface QuarkEnvelope<T> {
  code?: number;
  status?: number;
  message?: string;
  data?: T;
  metadata?: {
    _total?: number;
    _size?: number;
    _count?: number;
  };
}

interface QuarkShareTokenData {
  stoken?: string;
}

interface QuarkSharedFileData {
  fid: string;
  file_name: string;
  dir: boolean;
  share_fid_token: string;
}

interface QuarkDriveFileData {
  fid: string;
  file_name: string;
  dir: boolean;
}

interface QuarkShareDetailData {
  list?: QuarkSharedFileData[];
}

interface QuarkPathInfo {
  file_path: string;
  fid: string;
}

interface QuarkFileSortData {
  list?: QuarkDriveFileData[];
}

interface QuarkCreateDirectoryData {
  fid?: string;
}

interface QuarkTaskData {
  status?: number;
  task_title?: string;
  share_id?: string;
  save_as?: {
    save_as_top_fids?: string[];
  };
}

interface QuarkSaveTaskData {
  task_id?: string;
}

interface QuarkSubmitShareData {
  share_url?: string;
  title?: string;
  passcode?: string;
}

export class QuarkDriveApiClient implements QuarkDriveClient {
  constructor(private readonly options: QuarkDriveApiClientOptions) {}

  async getShareToken(pwdId: string, passcode: string): Promise<string> {
    const response = await this.request<QuarkShareTokenData>(
      "POST",
      "/1/clouddrive/share/sharepage/token",
      {
        searchParams: this.createBaseParams(),
        body: { pwd_id: pwdId, passcode },
      },
    );
    const stoken = response.data?.stoken;
    if (!stoken) {
      throw new Error("Quark share token response missing stoken");
    }

    return stoken;
  }

  async listSharedFiles(
    pwdId: string,
    stoken: string,
    pdirFid: string,
  ): Promise<QuarkSharedFile[]> {
    const files: QuarkSharedFile[] = [];
    let page = 1;

    while (true) {
      const response = await this.request<QuarkShareDetailData>(
        "GET",
        "/1/clouddrive/share/sharepage/detail",
        {
          searchParams: {
            ...this.createBaseParams(),
            pwd_id: pwdId,
            stoken,
            pdir_fid: pdirFid,
            force: "0",
            _page: page.toString(),
            _size: "50",
            _fetch_banner: "0",
            _fetch_share: "0",
            _fetch_total: "1",
            _sort: "file_type:asc,updated_at:desc",
            ver: "2",
            fetch_share_full_path: "0",
          },
        },
      );
      const list = response.data?.list ?? [];
      files.push(
        ...list.map((file) => ({
          fid: file.fid,
          fileName: file.file_name,
          dir: file.dir,
          shareFidToken: file.share_fid_token,
        })),
      );

      const total = response.metadata?._total ?? files.length;
      if (files.length >= total || list.length === 0) {
        return files;
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

    const response = await this.request<QuarkCreateDirectoryData>(
      "POST",
      "/1/clouddrive/file",
      {
        searchParams: this.createBaseParams(),
        body: {
          pdir_fid: "0",
          file_name: "",
          dir_path: normalized,
          dir_init_lock: false,
        },
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
      throw new Error(`Quark directory response missing fid: ${normalized}`);
    }

    return fid;
  }

  async listFiles(pdirFid: string): Promise<QuarkDriveFile[]> {
    const files: QuarkDriveFile[] = [];
    let page = 1;

    while (true) {
      const response = await this.request<QuarkFileSortData>(
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
            fetch_all_file: "1",
            fetch_risk_file_name: "1",
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

  async saveSharedFiles(input: QuarkSaveSharedFilesInput): Promise<string> {
    const response = await this.request<QuarkSaveTaskData>(
      "POST",
      "/1/clouddrive/share/sharepage/save",
      {
        searchParams: {
          ...this.createBaseParams(),
          app: "clouddrive",
        },
        body: {
          fid_list: input.files.map((file) => file.fid),
          fid_token_list: input.files.map((file) => file.shareFidToken),
          to_pdir_fid: input.toPdirFid,
          pwd_id: input.pwdId,
          stoken: input.stoken,
          pdir_fid: "0",
          scene: "link",
        },
      },
    );
    const taskId = response.data?.task_id;
    if (!taskId) {
      throw new Error("Quark save response missing task_id");
    }

    return taskId;
  }

  async waitTask(taskId: string): Promise<{ savedFids: string[] }> {
    for (let retryIndex = 0; retryIndex < this.options.taskMaxAttempts; retryIndex += 1) {
      const response = await this.request<QuarkTaskData>(
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

      await this.sleep(this.options.taskPollIntervalMs);
    }

    throw new Error(`Quark task timed out: ${taskId}`);
  }

  async renameFile(fid: string, fileName: string): Promise<void> {
    await this.request(
      "POST",
      "/1/clouddrive/file/rename",
      {
        searchParams: this.createBaseParams(),
        body: {
          fid,
          file_name: fileName,
        },
      },
    );
  }

  async createShareTask(
    fid: string,
    title: string,
    options: QuarkShareOptions,
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

    const response = await this.request<QuarkSaveTaskData>(
      "POST",
      "/1/clouddrive/share",
      {
        searchParams: this.createBaseParams(),
        body,
      },
    );
    const taskId = response.data?.task_id;
    if (!taskId) {
      throw new Error("Quark share response missing task_id");
    }

    return taskId;
  }

  async getShareId(taskId: string): Promise<string> {
    const response = await this.request<QuarkTaskData>(
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
      throw new Error("Quark task response missing share_id");
    }

    return shareId;
  }

  async submitShare(shareId: string): Promise<{
    shareUrl: string;
    title: string;
    passcode?: string;
  }> {
    const response = await this.request<QuarkSubmitShareData>(
      "POST",
      "/1/clouddrive/share/password",
      {
        searchParams: this.createBaseParams(),
        body: { share_id: shareId },
      },
    );
    const shareUrl = response.data?.share_url;
    const title = response.data?.title;
    if (!shareUrl || !title) {
      throw new Error("Quark submit share response missing share_url or title");
    }

    return {
      shareUrl,
      title,
      passcode: response.data?.passcode,
    };
  }

  async findDirectory(path: string): Promise<string | undefined> {
    const response = await this.request<QuarkPathInfo[]>(
      "POST",
      "/1/clouddrive/file/info/path_list",
      {
        searchParams: this.createBaseParams(),
        body: {
          file_path: [path],
          namespace: "0",
        },
      },
    );

    return response.data?.find((item) => item.file_path === path)?.fid;
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    options: {
      searchParams: Record<string, string>;
      body?: unknown;
    },
    allowedErrorCodes: number[] = [],
  ): Promise<QuarkEnvelope<T>> {
    const url = new URL(`${QUARK_PC_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(options.searchParams)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method,
      headers: {
        cookie: this.options.cookie,
        "content-type": "application/json",
        "user-agent": DEFAULT_USER_AGENT,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = (await response.json()) as QuarkEnvelope<T>;
    const code = json.code ?? json.status;
    if (code && allowedErrorCodes.includes(code)) {
      return json;
    }

    if (!response.ok || !this.isSuccess(json)) {
      throw new Error(json.message ?? `Quark request failed: ${pathname}`);
    }

    return json;
  }

  private createBaseParams(): Record<string, string> {
    return {
      pr: "ucpro",
      fr: "pc",
      uc_param_str: "",
      __dt: Math.floor(Math.random() * 9000 + 1000).toString(),
      __t: Date.now().toString(),
    };
  }

  private isSuccess<T>(json: QuarkEnvelope<T>): boolean {
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
