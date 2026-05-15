import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { loginQuarkByQrCode } from "./quark/quark-qr-login.js";
import { loginBaiduByQrCode } from "./baidu/baidu-qr-login.js";
import { loginUcByQrCode } from "./uc/uc-qr-login.js";
import { loginXunleiByQrCode } from "./xunlei/xunlei-qr-login.js";

config();

const PLATFORMS = {
  quark: { name: "夸克网盘", method: "扫码" },
  baidu: { name: "百度网盘", method: "扫码" },
  uc: { name: "UC网盘", method: "扫码" },
  xunlei: { name: "迅雷网盘", method: "扫码" },
} as const;

type Platform = keyof typeof PLATFORMS;

async function main() {
  const arg = process.argv[2] as Platform | undefined;

  let platform: Platform;

  if (arg && arg in PLATFORMS) {
    platform = arg;
  } else {
    console.log("网盘登录工具\n");
    console.log("用法: npx tsx src/login.ts <平台>\n");
    console.log("支持平台:");
    for (const [key, info] of Object.entries(PLATFORMS)) {
      console.log(`  ${key.padEnd(8)} ${info.name} (${info.method})`);
    }

    if (!arg) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question("\n请选择平台 (quark/baidu/uc/xunlei): ");
        platform = answer.trim().toLowerCase() as Platform;
      } finally {
        rl.close();
      }
    } else {
      console.error(`\n未知平台: ${arg}`);
      process.exit(1);
    }
  }

  if (!(platform in PLATFORMS)) {
    console.error(`未知平台: ${platform}`);
    process.exit(1);
  }

  console.log(`\n开始 ${PLATFORMS[platform].name} 登录...\n`);

  try {
    switch (platform) {
      case "quark":
        await loginQuarkByQrCode({ writeEnv: true });
        break;
      case "baidu":
        await loginBaiduByQrCode({ writeEnv: true });
        break;
      case "uc":
        await loginUcByQrCode({ writeEnv: true });
        break;
      case "xunlei":
        await loginXunleiByQrCode({ writeEnv: true });
        break;
    }
    console.log("\nCookie/Token 已保存到 .env 文件");
  } catch (error) {
    console.error("\n登录失败:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
