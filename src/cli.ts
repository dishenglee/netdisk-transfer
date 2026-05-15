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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("用法: npx tsx src/cli.ts <分享链接> [提取码] [资源名称]");
    console.log("");
    console.log("支持平台: 夸克、百度、UC、迅雷");
    console.log("示例:");
    console.log("  npx tsx src/cli.ts https://pan.quark.cn/s/xxxxx");
    console.log("  npx tsx src/cli.ts https://pan.baidu.com/s/xxxxx abcd");
    console.log("  npx tsx src/cli.ts https://drive.uc.cn/s/xxxxx");
    console.log('  npx tsx src/cli.ts "https://pan.xunlei.com/s/xxxxx?pwd=xxxx"');
    process.exit(0);
  }

  const shareUrl = args[0];
  const accessCodeArg = args[1];
  const resourceName = args[2] ?? "cli-transfer";

  const parsed = parseShareUrl(shareUrl);
  const accessCode = accessCodeArg ?? parsed.accessCode ?? null;

  const id = nextId++;
  records.set(id, {
    id,
    resourceName,
    softwareName: null,
    originPlatform: parsed.platform,
    originShareUrl: parsed.shareUrl,
    originAccessCode: accessCode,
    targetPlatform: null,
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

  console.log(`开始转存: ${parsed.platform} -> ${shareUrl}`);

  try {
    const result = await service.transferResource(String(id));
    console.log("转存成功!");
    console.log(`  目标平台: ${result.targetPlatform}`);
    if (result.targetShareUrl) {
      console.log(`  分享链接: ${result.targetShareUrl}`);
    }
    if (result.targetAccessCode) {
      console.log(`  提取码: ${result.targetAccessCode}`);
    }
    if (result.targetPath) {
      console.log(`  保存路径: ${result.targetPath}`);
    }
    console.log(`  消息: ${result.message}`);
  } catch (error) {
    console.error("转存失败:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
