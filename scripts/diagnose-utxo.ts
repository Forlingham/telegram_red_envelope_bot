import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UtxoIndexerService } from '../src/modules/blockchain/services/utxo-indexer.service';
import { ScashRpcService } from '../src/modules/blockchain/services/scash-rpc.service';

/**
 * 诊断脚本 - 检查 UTXO 数据丢失问题
 * 运行: npx ts-node scripts/diagnose-utxo.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const prisma = app.get(PrismaService);
  const indexer = app.get(UtxoIndexerService);
  const rpc = app.get(ScashRpcService);

  console.log('=== UTXO 诊断工具 ===\n');

  try {
    // 1. 检查 UTXO 表
    console.log('1. 检查 UTXO 表状态...');
    const utxoCount = await prisma.utxo.count();
    console.log(`   UTXO 总数: ${utxoCount}`);
    
    if (utxoCount > 0) {
      const sample = await prisma.utxo.findFirst();
      console.log(`   示例 UTXO: ${sample?.txid}:${sample?.vout}`);
      console.log(`   地址: ${sample?.address}`);
    }

    // 2. 检查追踪的地址
    console.log('\n2. 检查追踪的地址...');
    const wallets = await prisma.wallet.findMany({
      select: { address: true },
    });
    console.log(`   钱包数量: ${wallets.length}`);
    wallets.forEach((w, i) => {
      console.log(`   ${i + 1}. ${w.address}`);
    });

    const poolingConfig = await prisma.systemConfig.findUnique({
      where: { key: 'POOLING_ACCOUNT_ADDRESS' },
    });
    console.log(`   统筹账户: ${poolingConfig?.value || '未配置'}`);

    // 3. 检查区块同步状态
    console.log('\n3. 检查区块同步状态...');
    const syncState = await prisma.blockSync.findFirst();
    if (syncState) {
      console.log(`   最后同步区块: ${syncState.lastBlockHeight}`);
      console.log(`   最后同步时间: ${syncState.updatedAt}`);
    } else {
      console.log('   区块同步状态: 未初始化');
    }

    const currentHeight = await rpc.getBlockCount();
    console.log(`   当前区块链高度: ${currentHeight}`);

    // 4. 检查最近的区块
    console.log('\n4. 检查最近区块的交易...');
    if (syncState) {
      const recentBlockHash = await rpc.getBlockHash(syncState.lastBlockHeight);
      const block = await rpc.getBlock(recentBlockHash, 2);
      console.log(`   区块 ${syncState.lastBlockHeight} 包含 ${block.tx.length} 笔交易`);
      
      // 检查是否有交易涉及追踪的地址
      const trackedAddresses = wallets.map(w => w.address);
      if (poolingConfig?.value) {
        trackedAddresses.push(poolingConfig.value);
      }
      
      let foundUtxo = 0;
      for (const tx of block.tx) {
        for (const output of tx.vout) {
          if (output.scriptPubKey?.address && trackedAddresses.includes(output.scriptPubKey.address)) {
            foundUtxo++;
            console.log(`   找到 UTXO: ${tx.txid}:${output.n} -> ${output.scriptPubKey.address} (${output.value} SCASH)`);
          }
        }
      }
      
      if (foundUtxo === 0) {
        console.log('   该区块中没有涉及追踪地址的 UTXO');
      }
    }

    // 5. 建议修复
    console.log('\n5. 诊断结果和建议...');
    if (utxoCount === 0) {
      console.log('   ⚠️  UTXO 表为空！');
      
      if (!poolingConfig?.value) {
        console.log('   ❌ 统筹账户未配置');
        console.log('   💡 建议: 运行 npx ts-node scripts/init-pooling-account.ts 初始化统筹账户');
      }
      
      if (wallets.length === 0) {
        console.log('   ❌ 没有追踪的钱包地址');
        console.log('   💡 建议: 在 Telegram 中使用 /bind 或 /create 命令创建钱包');
      }
      
      if (syncState && currentHeight > syncState.lastBlockHeight) {
        console.log('   ℹ️  有未同步的区块');
        console.log('   💡 建议: 等待自动同步完成，或手动调用 forceSync');
      }
    }

    // 6. 强制重新同步（可选）
    console.log('\n6. 是否强制重新同步？ (y/N)');
    // 注意：在实际脚本中，这里应该读取用户输入
    // 现在只是显示信息
    console.log('   如需强制重新同步，请运行:');
    console.log('   npx ts-node -e "');
    console.log('     const { NestFactory } = require(\"@nestjs/core\");');
    console.log('     const { AppModule } = require(\"./src/app.module\");');
    console.log('     const { UtxoIndexerService } = require(\"./src/modules/blockchain/services/utxo-indexer.service\");');
    console.log('     async function main() {');
    console.log('       const app = await NestFactory.createApplicationContext(AppModule);');
    console.log('       const indexer = app.get(UtxoIndexerService);');
    console.log('       await indexer.forceSync();');
    console.log('       await app.close();');
    console.log('     }');
    console.log('     main();');
    console.log('   "');

    console.log('\n=== 诊断完成 ===');

  } catch (error) {
    console.error('\n❌ 诊断失败:', error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
