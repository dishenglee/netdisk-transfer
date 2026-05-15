import { config } from "dotenv";
import { TransferService, TransferServiceConfig } from "./transfer-service.js";
import { ResourceTransferRecord, ResourceTransferRepository, ResourceTransferUpdate } from "./resource-transfer.types.js";

config();

const envConfig: TransferServiceConfig = {
  get<T extends string>(key: string): T | undefined {
    return process.env[key] as T | undefined;
  },
};

const records = new Map<bigint, ResourceTransferRecord>();
let nextId = 1n;

const inMemoryRepository: ResourceTransferRepository = {
  async findResourceById(id) {
    return records.get(id) ?? null;
  },
  async updateResourceTransfer(id, data) {
    const existing = records.get(id);
    if (!existing) throw new Error(`Resource ${id} not found`);
    const updated = { ...existing, ...stripUndefined(data) };
    records.set(id, updated);
    return updated;
  },
};

function stripUndefined(obj: ResourceTransferUpdate): Partial<ResourceTransferRecord> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result as Partial<ResourceTransferRecord>;
}

function parseShareUrl(url: string): { platform: string; shareUrl: string; accessCode?: string } {
  if (url.includes("pan.quark.cn")) return { platform: "quark", shareUrl: url };
  if (url.includes("pan.baidu.com")) return { platform: "baidu", shareUrl: url };
  if (url.includes("drive.uc.cn")) return { platform: "uc", shareUrl: url };
  if (url.includes("pan.xunlei.com")) {
    const match = url.match(/pwd=([^#&\s]+)/);
    return { platform: "xunlei", shareUrl: url, accessCode: match?.[1] };
  }
  throw new Error(`Unsupported share URL: ${url}`);
}

function parseCliArgs(args: string[]): {
  shareUrl: string;
  accessCode: string | null;
  resourceName: string;
  targetPlatform: string | null;
} {
  let targetPlatform: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" || args[i] === "-t") {
      targetPlatform = args[i + 1] ?? null;
      i++; // skip next arg
    } else {
      positional.push(args[i]);
    }
  }

  return {
    shareUrl: positional[0] ?? "",
    accessCode: positional[1] ?? null,
    resourceName: positional[2] ?? "cli-transfer",
    targetPlatform,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("用法: npx tsx src/cli.ts <分享链接> [提取码] [资源名称] [--target 目标平台]");
    console.log("");
    console.log("支持平台: 夸克(quark)、百度(baidu)、UC(uc)、迅雷(xunlei)");
    console.log("");
    console.log("同平台转存:");
    console.log("  npx tsx src/cli.ts https://pan.quark.cn/s/xxxxx");
    console.log("  npx tsx src/cli.ts https://pan.baidu.com/s/xxxxx abcd");
    console.log("  npx tsx src/cli.ts https://drive.uc.cn/s/xxxxx");
    console.log('  npx tsx src/cli.ts "https://pan.xunlei.com/s/xxxxx?pwd=xxxx"');
    console.log("");
    console.log("跨平台转存 (转到UC网盘):");
    console.log("  npx tsx src/cli.ts https://pan.quark.cn/s/xxxxx --target uc");
    console.log("  npx tsx src/cli.ts https://pan.baidu.com/s/xxxxx abcd --target uc");
    console.log('  npx tsx src/cli.ts "https://pan.xunlei.com/s/xxxxx?pwd=xxxx" --target uc');
    process.exit(0);
  }

  const { shareUrl, accessCode: accessCodeArg, resourceName, targetPlatform } = parseCliArgs(args);

  if (!shareUrl) {
    console.error("错误: 缺少分享链接");
    process.exit(1);
  }

  const parsed = parseShareUrl(shareUrl);
  const accessCode = accessCodeArg || parsed.accessCode || null;

  const id = nextId++;
  records.set(id, {
    id,
    resourceName,
    softwareName: null,
    originPlatform: parsed.platform,
    originShareUrl: parsed.shareUrl,
    originAccessCode: accessCode,
    targetPlatform: targetPlatform,
    targetShareUrl: null,
    targetAccessCode: null,
    targetFileId: null,
    targetPath: null,
    transferStatus: "pending",
    remark: null,
  });

  const service = new TransferService({
    config: envConfig,
    repository: inMemoryRepository,
  });

  const isCross = targetPlatform && targetPlatform !== parsed.platform;
  console.log(
    isCross
      ? `开始跨平台转存: ${parsed.platform} -> ${targetPlatform}`
      : `开始转存: ${parsed.platform} -> ${shareUrl}`,
  );

  try {
    const result = await service.transferResource(String(id));
    console.log("转存成功!");
    console.log(`  目标平台: ${result.targetPlatform}`);
    if (result.targetShareUrl) {
      console.log(`  分享链接: ${result.targetShareUrl}`);
    }
    if (result.targetAccessCode && !result.targetShareUrl?.includes(result.targetAccessCode)) {
      console.log(`  提取码: ${result.targetAccessCode}`);
    }
    if (result.targetPath) {
      console.log(`  保存路径: ${result.targetPath}`);
    }
    console.log(`  消息: ${result.message}`);
  } catch (error) {
    console.error("转存失败:", error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  }
}

main();
