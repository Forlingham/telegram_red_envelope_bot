import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { WalletService } from '../src/modules/wallet/services/wallet.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 测试钱包导入
 * 运行: npx ts-node scripts/test-import.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const walletService = app.get(WalletService);
  const prisma = app.get(PrismaService);

  console.log('=== 测试钱包导入 ===\n');

  try {
    // 创建测试用户
    const user = await prisma.user.create({
      data: {
        telegramId: 'TEST_IMPORT_' + Date.now(),
        username: 'test_import',
        isWatchOnly: true,
      },
    });
    
    console.log('✅ 测试用户创建成功:', user.id);
    
    // 导入钱包
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    console.log('导入助记词:', mnemonic.substring(0, 20) + '...');
    
    const wallet = await walletService.importWalletFromMnemonic(user.id, mnemonic);
    console.log('✅ 钱包导入成功!');
    console.log('   地址:', wallet.address);
    console.log('   公钥:', wallet.publicKey.substring(0, 30) + '...');
    
    // 验证用户状态已更新
    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    console.log('   用户模式:', updatedUser.isWatchOnly ? '只读' : '完整');
    
    // 清理测试数据
    await prisma.wallet.delete({
      where: { userId: user.id },
    });
    await prisma.user.delete({
      where: { id: user.id },
    });
    console.log('\n✅ 测试数据已清理');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
