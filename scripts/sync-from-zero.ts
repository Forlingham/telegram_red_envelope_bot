import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UtxoIndexerService } from '../src/modules/blockchain/services/utxo-indexer.service';

/**
 * 从区块 0 开始全量同步
 * 运行: npx ts-node scripts/sync-from-zero.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const prisma = app.get(PrismaService);
  const indexer = app.get(UtxoIndexerService);

  console.log('=== 从区块 0 开始全量同步 ===\n');

  try {
    // 1. 清空 UTXO 表
    console.log('1. 清空 UTXO 表...');
    const deleted = await prisma.utxo.deleteMany({});
    console.log(`   已删除 ${deleted.count} 条记录`);

    // 2. 删除区块同步状态
    console.log('\n2. 删除区块同步状态...');
    await prisma.blockSync.deleteMany({});
    console.log('   已删除');

    // 3. 触发同步（会从区块 0 开始）
    console.log('\n3. 开始全量同步...');
    console.log('   这可能需要一些时间...\n');
    
    const result = await indexer.forceSync();
    console.log('\n同步结果:', result);

    // 4. 检查结果
    console.log('\n4. 检查结果...');
    const utxoCount = await prisma.utxo.count();
    console.log(`   UTXO 总数: ${utxoCount}`);

    if (utxoCount > 0) {
      const sample = await prisma.utxo.findFirst();
      console.log(`   示例: ${sample?.address} - ${sample?.amount} SCASH`);
    }

    console.log('\n=== 同步完成 ===');

  } catch (error) {
    console.error('\n❌ 同步失败:', error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
