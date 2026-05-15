import { spawn } from "node:child_process";
import {
  NetdiskTransferAdapter,
  NetdiskTransferResult,
  ResourceTransferRecord,
} from "./resource-transfer.types.js";

interface ExternalCommandNetdiskTransferAdapterOptions {
  platform: string;
  command?: string;
  targetRoot: string;
  timeoutMs: number;
}

interface ExternalCommandPayload {
  platform: string;
  resourceId: string;
  resourceName: string;
  softwareName?: string;
  targetName: string;
  targetRoot: string;
  targetPath: string;
  originShareUrl: string;
  originAccessCode?: string;
}

export class ExternalCommandNetdiskTransferAdapter
  implements NetdiskTransferAdapter
{
  readonly platform: string;

  constructor(
    private readonly options: ExternalCommandNetdiskTransferAdapterOptions,
  ) {
    this.platform = options.platform;
  }

  supports(resource: ResourceTransferRecord): boolean {
    return (
      Boolean(this.options.command) &&
      resource.originPlatform === this.options.platform &&
      Boolean(resource.originShareUrl)
    );
  }

  async transfer(
    resource: ResourceTransferRecord,
  ): Promise<NetdiskTransferResult> {
    if (!resource.originShareUrl) {
      throw new Error("originShareUrl is required");
    }

    const payload = this.createPayload(resource);
    const stdout = await this.runCommand(payload);
    const parsed = this.parseOutput(stdout);

    return {
      targetPlatform: parsed.targetPlatform ?? this.platform,
      targetShareUrl: parsed.targetShareUrl,
      targetAccessCode: parsed.targetAccessCode,
      targetFileId: parsed.targetFileId,
      targetPath: parsed.targetPath ?? payload.targetPath,
      message: parsed.message,
    };
  }

  private createPayload(
    resource: ResourceTransferRecord,
  ): ExternalCommandPayload {
    const targetName = this.sanitizeName(
      resource.softwareName ?? resource.resourceName,
    );
    const targetRoot = this.options.targetRoot.replace(/\/+$/u, "");

    return {
      platform: this.platform,
      resourceId: resource.id.toString(),
      resourceName: resource.resourceName,
      softwareName: resource.softwareName ?? undefined,
      targetName,
      targetRoot,
      targetPath: `${targetRoot}/${targetName}`,
      originShareUrl: resource.originShareUrl ?? "",
      originAccessCode: resource.originAccessCode ?? undefined,
    };
  }

  private runCommand(payload: ExternalCommandPayload): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command ?? "", {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${this.platform} transfer command timed out`));
      }, this.options.timeoutMs);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code !== 0) {
          reject(
            new Error(
              stderr || `${this.platform} transfer command exited with ${code}`,
            ),
          );
          return;
        }

        resolve(stdout);
      });

      child.stdin.end(JSON.stringify(payload));
    });
  }

  private parseOutput(stdout: string): NetdiskTransferResult {
    if (!stdout) {
      throw new Error(`${this.platform} transfer command returned empty output`);
    }

    const parsed = JSON.parse(stdout) as Partial<NetdiskTransferResult>;
    if (!parsed.targetShareUrl && !parsed.targetFileId) {
      throw new Error(
        `${this.platform} transfer command must return targetShareUrl or targetFileId`,
      );
    }

    return {
      targetPlatform: parsed.targetPlatform ?? this.platform,
      targetShareUrl: parsed.targetShareUrl,
      targetAccessCode: parsed.targetAccessCode,
      targetFileId: parsed.targetFileId,
      targetPath: parsed.targetPath,
      message: parsed.message,
    };
  }

  private sanitizeName(value: string): string {
    return value
      .replace(/[\\/:*?"<>|]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);
  }
}
