import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { WalletService } from "../src/modules/wallet/services/wallet.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { TransactionBuilderService } from "../src/modules/redpacket/services/transaction-builder.service";
import { ScashRpcService } from "../src/modules/blockchain/services/scash-rpc.service";
import Big from "big.js";

/**
 * 调试广播交易问题
 * 运行: npx ts-node scripts/debug-broadcast.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const walletService = app.get(WalletService);
  const prisma = app.get(PrismaService);
  const txBuilder = app.get(TransactionBuilderService);
  const rpcService = app.get(ScashRpcService);

  console.log("=== 调试广播交易 ===\n");

  try {
    // 1. 获取现有用户的钱包
    console.log("1. 获取用户钱包...");
    const user = await prisma.user.findFirst({
      where: { telegramId: "7179825743" },
    });

    if (!user) {
      console.log("   ❌ 用户不存在");
      await app.close();
      return;
    }

    const wallet = await walletService.getWalletByUserId(user.id);
    if (!wallet) {
      console.log("   ❌ 钱包不存在");
      await app.close();
      return;
    }

    console.log(`   用户 ID: ${user.id}`);
    console.log(`   钱包地址: ${wallet.address}`);

    // 2. 检查余额
    console.log("\n2. 检查余额...");
    const utxos = await prisma.utxo.findMany({
      where: {
        address: wallet.address,
        isSpent: false,
      },
    });

    console.log(`   UTXO 数量: ${utxos.length}`);
    utxos.forEach((utxo, i) => {
      console.log(
        `   ${i + 1}. ${utxo.txid}:${utxo.vout} - ${utxo.amount} SCASH`,
      );
    });

    if (utxos.length === 0) {
      console.log("   ❌ 没有可用 UTXO");
      await app.close();
      return;
    }

    // 3. 构建小额转账交易（用于测试）
    console.log("\n3. 构建交易...");
    const recipientAddress = wallet.address; // 转账给自己做测试
    const amount = "0.001";

    console.log(`   收款地址: ${recipientAddress}`);
    console.log(`   转账金额: ${amount} SCASH`);

    const buildResult = await txBuilder.buildTransaction(user.id, [
      {
        address: recipientAddress,
        amount: new Big(amount),
      },
    ]);

    if (!buildResult) {
      console.log("   ❌ 构建交易失败：余额不足");
      await app.close();
      return;
    }

    console.log(`   ✅ 交易构建成功`);
    console.log(`   交易 ID: ${buildResult.txid}`);
    console.log(`   手续费: ${buildResult.fee.toFixed(8)} SCASH`);
    console.log(`   找零: ${buildResult.changeAmount.toFixed(8)} SCASH`);
    console.log(`   输入数量: ${buildResult.inputs.length}`);
    console.log(`   输出数量: ${buildResult.outputs.length}`);
    console.log(
      `   交易 Hex: ${buildResult.rawTransaction.substring(0, 100)}...`,
    );

    // 4. 尝试解码交易
    console.log("\n4. 解码交易...");
    try {
      const decoded = await rpcService.decodeRawTransaction(
        buildResult.rawTransaction,
      );
      console.log(`   ✅ 解码成功`);
      console.log(`   版本: ${decoded.version}`);
      console.log(`   输入数量: ${decoded.vin?.length || 0}`);
      console.log(`   输出数量: ${decoded.vout?.length || 0}`);

      if (decoded.vin && decoded.vin.length > 0) {
        console.log("   输入详情:");
        decoded.vin.forEach((input: any, i: number) => {
          console.log(`     ${i + 1}. ${input.txid}:${input.vout}`);
        });
      }

      if (decoded.vout && decoded.vout.length > 0) {
        console.log("   输出详情:");
        decoded.vout.forEach((output: any, i: number) => {
          console.log(
            `     ${i + 1}. ${output.scriptPubKey?.address || "无地址"} - ${output.value} SCASH`,
          );
        });
      }
    } catch (error) {
      console.log(`   ❌ 解码失败: ${error.message}`);
    }

    // 5. 广播交易
    console.log("\n5. 广播交易...");
    const broadcastResult = await txBuilder.broadcastTransaction(
      user.id,
      buildResult,
    );

    if (broadcastResult.success) {
      console.log(`   ✅ 广播成功`);
      console.log(`   交易哈希: ${broadcastResult.txid}`);
    } else {
      console.log(`   ❌ 广播失败`);
      console.log(`   错误信息: ${broadcastResult.message}`);
    }

    console.log("\n=== 调试完成 ===");
  } catch (error) {
    console.error("\n❌ 调试失败:", error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
