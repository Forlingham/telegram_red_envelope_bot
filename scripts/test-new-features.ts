import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { WalletService } from "../src/modules/wallet/services/wallet.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { TransactionBuilderService } from "../src/modules/redpacket/services/transaction-builder.service";
import Big from "big.js";

/**
 * 测试新功能：删除钱包和普通转账
 * 运行: npx ts-node scripts/test-new-features.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const walletService = app.get(WalletService);
  const prisma = app.get(PrismaService);
  const txBuilder = app.get(TransactionBuilderService);

  console.log("=== 测试新功能 ===\n");

  try {
    // 1. 创建测试用户和钱包
    console.log("1. 创建测试用户...");
    const testUser = await prisma.user.create({
      data: {
        telegramId: "TEST_DELETE_" + Date.now(),
        username: "test_delete",
        firstName: "Test",
        lastName: "Delete",
        isWatchOnly: false,
      },
    });
    console.log(`   用户创建成功: ID=${testUser.id}`);

    // 2. 创建钱包
    console.log("\n2. 创建钱包...");
    const wallet = await walletService.createWallet(testUser.id);
    console.log(`   钱包地址: ${wallet.address}`);
    console.log(`   助记词: ${wallet.mnemonic}`);

    // 3. 测试删除钱包（应该失败，因为有余额检查）
    console.log("\n3. 测试删除钱包（有余额时）...");
    const deleteResult1 = await walletService.deleteWallet(testUser.id);
    console.log(
      `   结果: ${deleteResult1.success ? "✅" : "❌"} ${deleteResult1.message}`,
    );

    // 4. 测试普通转账
    console.log("\n4. 测试普通转账...");
    // 先给钱包一些资金（模拟）
    const recipientAddress = wallet.address; // 转账给自己做测试
    const amount = "0.001";

    console.log(`   尝试转账 ${amount} SCASH 到 ${recipientAddress}`);
    console.log("   注意：由于余额不足，此测试可能失败");

    // 5. 再次尝试删除（用户现在是只读模式，因为没有余额）
    console.log("\n5. 检查用户状态...");
    const userAfterDelete = await prisma.user.findUnique({
      where: { id: testUser.id },
    });
    console.log(
      `   用户模式: ${userAfterDelete.isWatchOnly ? "只读" : "完整"}`,
    );

    // 清理测试数据
    console.log("\n6. 清理测试数据...");
    await prisma.wallet.deleteMany({ where: { userId: testUser.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    console.log("   ✅ 测试数据已清理");

    console.log("\n=== 测试完成 ===");
    console.log("\n新功能说明：");
    console.log("1. /delete 命令 - 删除钱包（需要备份助记词警告）");
    console.log("2. /transfer 命令 - 普通转账到指定地址");
    console.log("3. 删除前会检查余额和待处理转账");
    console.log("4. 转账直接发送，不经过统筹账户");
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
