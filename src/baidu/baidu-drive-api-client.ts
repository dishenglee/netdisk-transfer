import {
  BaiduDriveClient,
  BaiduDriveFile,
  BaiduShareOptions,
  BaiduShareTransferParams,
} from "./baidu-drive-client.js";

export type BaiduFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const BAIDU_BASE_URL = "https://pan.baidu.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
const LIST_PAGE_SIZE = 1000;

interface BaiduDriveApiClientOptions {
  cookie: string;
  fetchFn?: BaiduFetch;
}

interface BaiduEnvelope<T> {
  errno?: number;
  error_code?: number;
  err_msg?: string;
  show_msg?: string;
  errmsg?: string;
  result?: T;
}

interface BaiduBdstokenData {
  bdstoken?: string;
}

interface BaiduListData {
  list?: BaiduFileData[];
}

interface BaiduFileData {
  fs_id: number | string;
  server_filename: string;
  path?: string;
  isdir: number;
}

interface BaiduVerifyData {
  randsk?: string;
}

interface BaiduShareData {
  link?: string;
}

export class BaiduDriveApiClient implements BaiduDriveClient {
  private cookie: string;
  private readonly fetchFn: BaiduFetch;

  constructor(options: BaiduDriveApiClientOptions) {
    this.cookie = options.cookie;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getDownloadUrl(path: string, _bdstoken: string): Promise<string> {
    return `https://pcs.baidu.com/rest/2.0/pcs/file?method=download&path=${encodeURIComponent(path)}&app_id=250528`;
  }

  async getBdstoken(): Promise<string> {
    const url = this.createUrl("/api/gettemplatevariable", {
      clienttype: "0",
      app_id: "38824127",
      web: "1",
      fields: '["bdstoken","token","uk","isdocuser","servertime"]',
    });
    const json = await this.requestJson<BaiduBdstokenData>(url);
    const bdstoken = json.result?.bdstoken;
    if (!bdstoken) {
      throw new Error("Baidu gettemplatevariable response missing bdstoken");
    }

    return bdstoken;
  }

  async ensureDirectory(
    path: string,
    bdstoken: string,
  ): Promise<BaiduDriveFile> {
    const normalized = this.normalizeDirectoryPath(path);
    const segments = normalized.split("/").filter(Boolean);
    let parentPath = "/";
    let current: BaiduDriveFile | undefined;

    for (const segment of segments) {
      const currentPath = this.joinPath(parentPath, segment);
      const siblings = await this.listFiles(parentPath, bdstoken);
      current = siblings.find(
        (item) => item.isDir && item.fileName === segment,
      );

      if (!current) {
        await this.createDirectory(currentPath, bdstoken);
        const nextSiblings = await this.listFiles(parentPath, bdstoken);
        current = nextSiblings.find(
          (item) => item.isDir && item.fileName === segment,
        );
      }

      if (!current) {
        throw new Error(`Baidu directory not found after create: ${currentPath}`);
      }

      parentPath = current.path;
    }

    if (!current) {
      throw new Error("Baidu target directory cannot be root");
    }

    return current;
  }

  async listFiles(path: string, bdstoken: string): Promise<BaiduDriveFile[]> {
    const normalized = this.normalizeDirectoryPath(path);
    const files: BaiduDriveFile[] = [];
    let page = 1;

    while (true) {
      const url = this.createUrl("/api/list", {
        order: "time",
        desc: "1",
        showempty: "0",
        web: "1",
        page: page.toString(),
        num: LIST_PAGE_SIZE.toString(),
        dir: normalized,
        bdstoken,
      });
      const json = await this.requestJson<BaiduListData>(url);
      const list = json.list ?? [];
      files.push(...list.map((item) => this.mapFileData(item, normalized)));

      if (list.length < LIST_PAGE_SIZE) {
        return files;
      }

      page += 1;
    }
  }

  async verifyPasscode(
    shareUrl: string,
    passcode: string,
    bdstoken: string,
  ): Promise<void> {
    if (!passcode) {
      return;
    }

    const url = this.createUrl("/share/verify", {
      surl: this.extractSurl(shareUrl),
      bdstoken,
      t: Date.now().toString(),
      channel: "chunlei",
      web: "1",
      clienttype: "0",
    });
    const body = new URLSearchParams({
      pwd: passcode,
      vcode: "",
      vcode_str: "",
    });
    const json = await this.requestJson<BaiduVerifyData>(url, {
      method: "POST",
      body,
    });
    const randsk = json.randsk;
    if (!randsk) {
      throw new Error("Baidu share verify response missing randsk");
    }

    this.updateCookie("BDCLND", randsk);
  }

  async getShareTransferParams(
    shareUrl: string,
  ): Promise<BaiduShareTransferParams> {
    const response = await this.fetchFn(shareUrl, {
      method: "GET",
      headers: this.createHeaders(),
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Baidu share page failed: ${response.status}`);
    }

    return this.parseSharePage(html);
  }

  async transferSharedFiles(
    params: BaiduShareTransferParams,
    targetPath: string,
    bdstoken: string,
  ): Promise<void> {
    const url = this.createUrl("/share/transfer", {
      shareid: params.shareId,
      from: params.shareUk,
      bdstoken,
      channel: "chunlei",
      web: "1",
      clienttype: "0",
    });
    const body = new URLSearchParams({
      fsidlist: `[${params.fsIds.join(",")}]`,
      path: this.normalizeDirectoryPath(targetPath),
    });

    await this.requestJson(url, {
      method: "POST",
      body,
    });
  }

  async renameFile(
    path: string,
    newName: string,
    bdstoken: string,
  ): Promise<void> {
    const url = this.createUrl("/api/filemanager", {
      opera: "rename",
      async: "2",
      onnest: "fail",
      channel: "chunlei",
      web: "1",
      app_id: "250528",
      bdstoken,
      clienttype: "0",
    });
    const body = new URLSearchParams({
      filelist: JSON.stringify([{ path, newname: newName }]),
    });

    await this.requestJson(url, {
      method: "POST",
      body,
    });
  }

  async createShare(
    fsId: string,
    options: BaiduShareOptions,
    bdstoken: string,
  ): Promise<string> {
    const url = this.createUrl("/share/set", {
      channel: "chunlei",
      bdstoken,
      clienttype: "0",
      app_id: "250528",
      web: "1",
    });
    const body = new URLSearchParams({
      period: options.period.toString(),
      pwd: options.passcode,
      eflag_disable: "true",
      channel_list: "[]",
      schannel: "4",
      fid_list: `[${fsId}]`,
    });
    const json = await this.requestJson<BaiduShareData>(url, {
      method: "POST",
      body,
    });
    const link = json.link;
    if (!link) {
      throw new Error("Baidu share response missing link");
    }

    return link;
  }

  private async createDirectory(
    path: string,
    bdstoken: string,
  ): Promise<void> {
    const url = this.createUrl("/api/create", {
      a: "commit",
      bdstoken,
    });
    const body = new URLSearchParams({
      path: this.normalizeDirectoryPath(path),
      isdir: "1",
      block_list: "[]",
    });

    await this.requestJson(url, {
      method: "POST",
      body,
    });
  }

  private async requestJson<T>(
    url: URL | string,
    init: RequestInit = {},
  ): Promise<BaiduEnvelope<T> & T> {
    const response = await this.fetchFn(url, {
      ...init,
      headers: {
        ...this.createHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    const json = JSON.parse(text) as BaiduEnvelope<T> & T;
    const errno = json.errno ?? json.error_code;

    if (!response.ok || (typeof errno === "number" && errno !== 0)) {
      const message =
        json.show_msg ??
        json.err_msg ??
        json.errmsg ??
        `Baidu request failed: ${url.toString()} errno=${errno ?? "unknown"}`;
      throw new Error(message);
    }

    return json;
  }

  private createHeaders(): Record<string, string> {
    return {
      cookie: this.cookie,
      referer: BAIDU_BASE_URL,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": DEFAULT_USER_AGENT,
    };
  }

  private createUrl(pathname: string, params: Record<string, string>): URL {
    const url = new URL(`${BAIDU_BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url;
  }

  private parseSharePage(html: string): BaiduShareTransferParams {
    const shareId = html.match(/"shareid":\s*"?(\d+)"?/u)?.[1];
    const shareUk = html.match(/"share_uk":\s*"?(\d+)"?/u)?.[1];
    const fsIds = Array.from(html.matchAll(/"fs_id":\s*"?(\d+)"?/gu)).map(
      (match) => match[1],
    );
    const fileNames = Array.from(
      html.matchAll(/"server_filename":\s*"((?:\\.|[^"\\])*)"/gu),
    ).map((match) => this.parseJsonStringFragment(match[1]));
    const isDirs = Array.from(html.matchAll(/"isdir":\s*"?([01])"?/gu)).map(
      (match) => match[1] === "1",
    );

    if (!shareId || !shareUk || fsIds.length === 0 || isDirs.length === 0) {
      throw new Error("Baidu share page missing transfer params");
    }

    return {
      shareId,
      shareUk,
      fsIds,
      fileNames,
      isDirs,
    };
  }

  private parseJsonStringFragment(value: string): string {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      return value;
    }
  }

  private extractSurl(shareUrl: string): string {
    const url = new URL(shareUrl);
    const directMatch = url.pathname.match(/^\/s\/1(.+)$/u);
    if (directMatch?.[1]) {
      return directMatch[1];
    }

    const initSurl = url.searchParams.get("surl");
    if (initSurl) {
      return initSurl.replace(/^1/u, "");
    }

    throw new Error(`Invalid Baidu share URL: ${shareUrl}`);
  }

  private updateCookie(name: string, value: string): void {
    const cookies = new Map<string, string>();
    for (const item of this.cookie.split(";")) {
      const [key, ...valueParts] = item.trim().split("=");
      if (!key || valueParts.length === 0) {
        continue;
      }

      cookies.set(key, valueParts.join("="));
    }
    cookies.set(name, value);

    this.cookie = Array.from(cookies.entries())
      .map(([key, cookieValue]) => `${key}=${cookieValue}`)
      .join("; ");
  }

  private mapFileData(
    item: BaiduFileData,
    parentPath: string,
  ): BaiduDriveFile {
    return {
      fsId: item.fs_id.toString(),
      fileName: item.server_filename,
      path: item.path ?? this.joinPath(parentPath, item.server_filename),
      isDir: item.isdir === 1,
    };
  }

  private normalizeDirectoryPath(path: string): string {
    const normalized = path.replace(/\/+/gu, "/").replace(/\/$/u, "");
    if (!normalized || normalized === "/") {
      return "/";
    }

    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private joinPath(root: string, name: string): string {
    return `${root.replace(/\/+$/u, "")}/${name}`.replace(/\/+/gu, "/");
  }
}
