import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ScashRpcService } from "../src/modules/blockchain/services/scash-rpc.service";
import { UtxoIndexerService } from "../src/modules/blockchain/services/utxo-indexer.service";

/**
 * 调试同步脚本 - 同步前 10 个区块并查看详细日志
 * 运行: npx ts-node scripts/debug-sync.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const prisma = app.get(PrismaService);
  const rpc = app.get(ScashRpcService);
  const indexer = app.get(UtxoIndexerService);

  console.log("=== 调试同步脚本 ===\n");

  try {
    // 清空数据
    console.log("1. 清空数据...");
    await prisma.utxo.deleteMany({});
    await prisma.blockSync.deleteMany({});
    console.log("   已清空");

    // 检查当前区块高度
    const currentHeight = await rpc.getBlockCount();
    console.log(`\n2. 当前区块链高度: ${currentHeight}`);

    // 查看区块 0 的结构
    console.log("\n3. 检查区块 0 结构...");
    const block0Hash = await rpc.getBlockHash(0);
    const block0 = await rpc.getBlock(block0Hash, 2);
    console.log(`   区块 0 哈希: ${block0Hash}`);
    console.log(`   交易数量: ${block0.tx.length}`);

    if (block0.tx.length > 0) {
      const firstTx = block0.tx[0];
      console.log(`   第一笔交易 ID: ${firstTx.txid}`);
      console.log(`   输出数量: ${firstTx.vout.length}`);

      if (firstTx.vout.length > 0) {
        const firstOutput = firstTx.vout[0];
        console.log(`   第一个输出:`);
        console.log(`     - 金额: ${firstOutput.value}`);
        console.log(
          `     - 地址: ${firstOutput.scriptPubKey?.address || "无"}`,
        );
        console.log(`     - 脚本类型: ${firstOutput.scriptPubKey?.type}`);
        console.log(
          `     - 脚本十六进制: ${firstOutput.scriptPubKey?.hex?.substring(0, 40)}...`,
        );
      }
    }

    // 查看区块 1（应该有 coinbase 奖励）
    console.log("\n4. 检查区块 1 结构...");
    const block1Hash = await rpc.getBlockHash(1);
    const block1 = await rpc.getBlock(block1Hash, 2);
    console.log(`   区块 1 哈希: ${block1Hash}`);
    console.log(`   交易数量: ${block1.tx.length}`);

    if (block1.tx.length > 0) {
      const coinbaseTx = block1.tx[0];
      console.log(`   Coinbase 交易 ID: ${coinbaseTx.txid}`);
      console.log(`   输出数量: ${coinbaseTx.vout.length}`);

      for (let i = 0; i < Math.min(coinbaseTx.vout.length, 3); i++) {
        const output = coinbaseTx.vout[i];
        console.log(`   输出 ${i}:`);
        console.log(`     - 金额: ${output.value}`);
        console.log(`     - 地址: ${output.scriptPubKey?.address || "无"}`);
        console.log(`     - 类型: ${output.scriptPubKey?.type}`);
      }
    }

    // 触发同步前几个区块
    console.log("\n5. 触发同步前 5 个区块...");

    // 手动创建区块 0 的同步记录
    await prisma.blockSync.create({
      data: {
        lastBlockHeight: 0,
        lastBlockHash: block0Hash,
      },
    });

    // 调用 forceSync 来同步
    const result = await indexer.forceSync();
    console.log("   同步结果:", result);

    // 检查结果
    console.log("\n6. 检查同步结果...");
    const utxoCount = await prisma.utxo.count();
    console.log(`   UTXO 总数: ${utxoCount}`);

    if (utxoCount > 0) {
      const utxos = await prisma.utxo.findMany({ take: 5 });
      console.log("   前 5 个 UTXO:");
      utxos.forEach((u, i) => {
        console.log(`   ${i + 1}. ${u.address} - ${u.amount} SCASH`);
      });
    } else {
      console.log("   ⚠️  没有 UTXO 被创建！");
    }

    console.log("\n=== 调试完成 ===");
  } catch (error) {
    console.error("\n❌ 调试失败:", error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
