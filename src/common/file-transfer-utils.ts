import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface DownloadFileOptions {
  url: string;
  headers: Record<string, string>;
  destPath: string;
  onProgress?: (downloaded: number, total: number) => void;
}

export async function downloadFile(options: DownloadFileOptions): Promise<void> {
  let url = options.url;
  let resp: Response | undefined;

  for (let i = 0; i < 10; i++) {
    try {
      resp = await fetch(url, {
        headers: options.headers,
        redirect: "manual",
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
      throw new Error(
        `Download network error: ${err instanceof Error ? err.message : err} | cause: ${cause instanceof Error ? cause.message : cause} (${url.slice(0, 150)})`,
      );
    }
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) break;
      url = new URL(location, url).href;
      continue;
    }
    break;
  }

  if (!resp || !resp.ok) {
    throw new Error(
      `Download failed: ${resp?.status} ${resp?.statusText} (${url.slice(0, 120)})`,
    );
  }

  if (!resp.body) {
    throw new Error("Download response has no body");
  }

  const total = Number(resp.headers.get("content-length") ?? 0);
  let downloaded = 0;

  const reader = resp.body.getReader();
  const nodeStream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
        return;
      }
      downloaded += value.byteLength;
      if (options.onProgress && total > 0) {
        options.onProgress(downloaded, total);
      }
      this.push(Buffer.from(value));
    },
  });

  const ws = createWriteStream(options.destPath);
  await pipeline(nodeStream, ws);
}

export async function createTempDir(prefix = "netdisk-xfer-"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

export async function readFileChunk(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const { open } = await import("node:fs/promises");
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead < length ? buf.subarray(0, bytesRead) : buf;
  } finally {
    await fh.close();
  }
}

export async function computeFileHashes(
  filePath: string,
): Promise<{ md5: string; sha1: string }> {
  const content = await readFile(filePath);
  const md5 = createHash("md5").update(content).digest("hex");
  const sha1 = createHash("sha1").update(content).digest("hex");
  return { md5, sha1 };
}
