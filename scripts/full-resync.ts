import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScashRpcService } from '../src/modules/blockchain/services/scash-rpc.service';

/**
 * 全量重新同步所有区块
 * 运行: npx ts-node scripts/full-resync.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const prisma = app.get(PrismaService);
  const rpc = app.get(ScashRpcService);

  console.log('=== 全量重新同步 UTXO ===\n');

  try {
    // 1. 清空 UTXO 表
    console.log('1. 清空现有 UTXO 数据...');
    const deleted = await prisma.utxo.deleteMany({});
    console.log(`   已删除 ${deleted.count} 条记录`);

    // 2. 重置区块同步状态
    console.log('\n2. 重置区块同步状态...');
    await prisma.blockSync.deleteMany({});
    console.log('   区块同步状态已重置');

    // 3. 触发全量同步
    console.log('\n3. 开始全量同步...');
    console.log('   请等待应用自动同步完成...');
    console.log('   或者启动应用: npm run start:dev');
    console.log('   应用会自动从区块 0 开始同步所有 UTXO');

    console.log('\n=== 准备完成 ===');
    console.log('提示: 现在启动应用将自动全量同步所有区块');

  } catch (error) {
    console.error('\n❌ 操作失败:', error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
