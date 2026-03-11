import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { ScashRpcService } from "../src/modules/blockchain/services/scash-rpc.service";

/**
 * 生成区块使 coinbase 交易成熟
 * 运行: npx ts-node scripts/generate-blocks.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const rpcService = app.get(ScashRpcService);

  console.log("=== 生成区块 ===\n");

  try {
    // 获取当前区块高度
    const currentHeight = await rpcService.getBlockCount();
    console.log(`当前区块高度: ${currentHeight}`);

    // 获取统筹账户地址（用于生成区块奖励）
    const poolingAddress = "bcrt1qdy9w8xj4wyqhzayt4xsj058fhejrcpasfxhym9"; // 使用已有地址

    // 生成 101 个区块（coinbase 需要 100 个确认）
    console.log(`\n正在生成 101 个区块到地址 ${poolingAddress}...`);
    const blockHashes = await rpcService.generateToAddress(101, poolingAddress);
    console.log(`✅ 已生成 ${blockHashes.length} 个区块`);
    console.log(`第一个区块: ${blockHashes[0]}`);
    console.log(`最后一个区块: ${blockHashes[blockHashes.length - 1]}`);

    // 检查新区块高度
    const newHeight = await rpcService.getBlockCount();
    console.log(`\n新区块高度: ${newHeight}`);

    console.log("\n=== 完成 ===");
    console.log("现在 coinbase 交易应该已经成熟，可以花费了");
  } catch (error) {
    console.error("\n❌ 生成区块失败:", error.message);
  }

  await app.close();
}

bootstrap();
