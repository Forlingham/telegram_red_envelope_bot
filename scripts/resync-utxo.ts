import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { UtxoIndexerService } from '../src/modules/blockchain/services/utxo-indexer.service';

/**
 * 强制重新同步 UTXO
 * 运行: npx ts-node scripts/resync-utxo.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const indexer = app.get(UtxoIndexerService);

  console.log('=== 强制重新同步 UTXO ===\n');
  
  try {
    console.log('开始重新同步...');
    const result = await indexer.forceSync();
    console.log('结果:', result);
  } catch (error) {
    console.error('同步失败:', error.message);
  }

  await app.close();
  console.log('\n完成');
}

bootstrap();
