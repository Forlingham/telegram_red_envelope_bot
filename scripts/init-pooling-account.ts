import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { WalletService } from "../src/modules/wallet/services/wallet.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScashRpcService } from "../src/modules/blockchain/services/scash-rpc.service";
import { ConfigService } from "@nestjs/config";

/**
 * 初始化脚本 - 设置统筹账户
 *
 * 优先从环境变量读取配置，如果不存在则生成新的
 *
 * 运行: npx ts-node scripts/init-pooling-account.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const walletService = app.get(WalletService);
  const prisma = app.get(PrismaService);
  const rpcService = app.get(ScashRpcService);
  const configService = app.get(ConfigService);

  console.log("=== 初始化统筹账户 ===\n");

  // 检查是否已存在统筹账户配置
  const existingConfig = await prisma.systemConfig.findUnique({
    where: { key: "POOLING_ACCOUNT_ADDRESS" },
  });

  if (existingConfig) {
    console.log("统筹账户已存在:", existingConfig.value);
    await app.close();
    return;
  }

  // 从环境变量读取配置
  const envMnemonic = configService.get<string>("POOLING_ACCOUNT_MNEMONIC");
  const envAddress = configService.get<string>("POOLING_ACCOUNT_ADDRESS");

  let walletInfo: { address: string; mnemonic?: string };

  try {
    if (envMnemonic) {
      // 从环境变量导入
      console.log("从环境变量导入统筹账户...");

      // 查找或创建系统用户
      let systemUser = await prisma.user.findFirst({
        where: { telegramId: "SYSTEM_POOLING" },
      });

      if (!systemUser) {
        systemUser = await prisma.user.create({
          data: {
            telegramId: "SYSTEM_POOLING",
            username: "system_pooling",
            isWatchOnly: false,
          },
        });
      }

      // 导入钱包
      const fullWalletInfo = await walletService.importWalletFromMnemonic(
        systemUser.id,
        envMnemonic,
      );
      walletInfo = {
        address: fullWalletInfo.address,
        mnemonic: envMnemonic,
      };

      console.log("✅ 统筹账户从环境变量导入成功！");
    } else {
      // 生成新账户
      console.log("环境变量未配置，生成新的统筹账户...");

      const systemUser = await prisma.user.create({
        data: {
          telegramId: "SYSTEM_POOLING",
          username: "system_pooling",
          isWatchOnly: false,
        },
      });

      const fullWalletInfo = await walletService.createWallet(systemUser.id);
      walletInfo = fullWalletInfo;

      console.log("✅ 统筹账户创建成功！");
      console.log("\n⚠️  请务必安全备份以下信息！\n");
      console.log("助记词:", walletInfo.mnemonic);
      console.log("\n请将以上信息添加到 .env 文件:\n");
      console.log(`POOLING_ACCOUNT_MNEMONIC="${walletInfo.mnemonic}"`);
      console.log(`POOLING_ACCOUNT_ADDRESS="${walletInfo.address}"`);
    }

    console.log("\n地址:", walletInfo.address);

    // 保存到系统配置
    await prisma.systemConfig.create({
      data: {
        key: "POOLING_ACCOUNT_ADDRESS",
        value: walletInfo.address,
      },
    });

    // 如果是 Regtest 模式且是新创建的账户，自动生成测试资金
    if (!envMnemonic) {
      const blockchainInfo = await rpcService.getBlockchainInfo();
      if (blockchainInfo.chain === "regtest") {
        console.log("\nRegtest 模式: 正在为统筹账户生成测试资金...");
        await rpcService.generateToAddress(101, walletInfo.address);
        console.log("已生成 101 个区块，统筹账户已获得 50 SCASH");
      }
    }

    console.log("\n=== 初始化完成 ===");
  } catch (error) {
    console.error("初始化失败:", error.message);
  }

  await app.close();
}

bootstrap();
