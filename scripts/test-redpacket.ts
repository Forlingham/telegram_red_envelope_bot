import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { WalletService } from '../src/modules/wallet/services/wallet.service';
import { RedpacketService } from '../src/modules/redpacket/services/redpacket.service';
import { UtxoService } from '../src/modules/blockchain/services/utxo.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScashRpcService } from '../src/modules/blockchain/services/scash-rpc.service';
import { UtxoIndexerService } from '../src/modules/blockchain/services/utxo-indexer.service';
import { RedPacketType, RedPacketStrategy } from '../src/shared/constants/network.constants';

/**
 * 测试脚本 - 测试红包功能
 * 
 * 运行: npx ts-node scripts/test-redpacket.ts
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const walletService = app.get(WalletService);
  const redpacketService = app.get(RedpacketService);
  const utxoService = app.get(UtxoService);
  const prisma = app.get(PrismaService);
  const rpcService = app.get(ScashRpcService);
  const indexerService = app.get(UtxoIndexerService);

  console.log('=== 开始测试红包功能 ===\n');

  try {
    // 1. 创建测试用户
    console.log('1. 创建测试用户...');
    const testUser = await prisma.user.create({
      data: {
        telegramId: 'TEST_USER_001',
        username: 'test_user',
        firstName: 'Test',
        lastName: 'User',
        isWatchOnly: false,
      },
    });
    console.log(`   测试用户创建成功: ID=${testUser.id}`);

    // 2. 为测试用户创建钱包
    console.log('\n2. 创建测试用户钱包...');
    const wallet = await walletService.createWallet(testUser.id);
    console.log(`   钱包地址: ${wallet.address}`);
    console.log(`   助记词: ${wallet.mnemonic}`);

    // 3. 为测试用户生成资金
    console.log('\n3. 生成测试资金...');
    const coinbaseAddress = wallet.address;
    await rpcService.generateToAddress(101, coinbaseAddress);
    console.log('   已生成 101 个区块，钱包获得 5050 SCASH');

    // 4. 等待区块同步
    console.log('\n4. 等待区块同步...');
    await indexerService.forceSync();
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. 检查余额
    console.log('\n5. 检查余额...');
    const balance = await utxoService.getBalance(wallet.address, true);
    console.log(`   余额: ${balance.toFixed(8)} SCASH`);

    if (balance.lte(0)) {
      console.log('   警告: 余额为0，等待更长时间后重试...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balance2 = await utxoService.getBalance(wallet.address, true);
      console.log(`   重新检查余额: ${balance2.toFixed(8)} SCASH`);
      
      if (balance2.lte(0)) {
        console.log('   错误: 余额仍为0，可能需要手动触发区块同步');
      }
    }

    // 6. 创建均分红包
    console.log('\n6. 创建均分红包 (0.1 SCASH, 2份)...');
    const equalResult = await redpacketService.createRedPacket({
      senderId: testUser.id,
      type: RedPacketType.GROUP_EQUAL,
      totalAmount: '0.1',
      count: 2,
      message: '测试均分红包',
      chatId: '-1001234567890',
      chatTitle: '测试群组',
      strategy: RedPacketStrategy.EQUAL,
    });

    if (equalResult.success) {
      console.log(`   ✓ 红包创建成功: ID=${equalResult.redPacket.id}`);
      console.log(`   ✓ 交易哈希: ${equalResult.txid}`);
    } else {
      console.log(`   ✗ 创建失败: ${equalResult.message}`);
    }

    // 7. 创建随机红包
    console.log('\n7. 创建随机红包 (0.05 SCASH, 3份)...');
    const randomResult = await redpacketService.createRedPacket({
      senderId: testUser.id,
      type: RedPacketType.GROUP_RANDOM,
      totalAmount: '0.05',
      count: 3,
      message: '测试随机红包',
      chatId: '-1001234567890',
      chatTitle: '测试群组',
      strategy: RedPacketStrategy.RANDOM,
    });

    if (randomResult.success) {
      console.log(`   ✓ 红包创建成功: ID=${randomResult.redPacket.id}`);
      console.log(`   ✓ 交易哈希: ${randomResult.txid}`);
    } else {
      console.log(`   ✗ 创建失败: ${randomResult.message}`);
    }

    // 8. 模拟抢红包
    console.log('\n8. 模拟抢红包...');
    if (equalResult.success) {
      // 创建另一个用户抢红包
      const claimUser = await prisma.user.create({
        data: {
          telegramId: 'CLAIM_USER_001',
          username: 'claim_user',
          isWatchOnly: true,
        },
      });

      // 绑定钱包
      await walletService.bindWatchOnlyAddress(claimUser.id, wallet.address);

      const claimResult = await redpacketService.claimRedPacket({
        redPacketId: equalResult.redPacket.id,
        userId: claimUser.id,
      });

      if (claimResult.success) {
        console.log(`   ✓ 抢红包成功: 抢到 ${claimResult.amount} SCASH`);
      } else {
        console.log(`   ✗ 抢红包失败: ${claimResult.message}`);
      }
    }

    // 9. 查看红包详情
    console.log('\n9. 查看红包详情...');
    if (equalResult.success) {
      const details = await redpacketService.getRedPacketDetails(equalResult.redPacket.id);
      console.log(`   红包状态: ${details.redPacket.status}`);
      console.log(`   剩余金额: ${details.redPacket.remainingAmount} SCASH`);
      console.log(`   剩余份数: ${details.redPacket.remainingCount}`);
      console.log(`   已领取: ${details.totalClaimed} SCASH (${details.claims.length} 人)`);
    }

    // 10. 测试统筹账户转账
    console.log('\n10. 测试统筹账户批量转账...');
    const transferResult = await redpacketService.processPoolingTransfers();
    console.log(`   处理转账: ${transferResult.processed} 笔`);
    console.log(`   成功: ${transferResult.succeeded}`);
    console.log(`   失败: ${transferResult.failed}`);

    console.log('\n=== 测试完成 ===');
    console.log('\n提示: 清理测试数据...');
    
    // 清理测试数据（可选）
    await prisma.poolingTransfer.deleteMany({
      where: { userId: { in: [testUser.id] } },
    });
    await prisma.redPacketClaim.deleteMany({
      where: { userId: { in: [testUser.id] } },
    });
    await prisma.redPacket.deleteMany({
      where: { senderId: testUser.id },
    });
    await prisma.wallet.deleteMany({
      where: { userId: { in: [testUser.id] } },
    });
    await prisma.user.deleteMany({
      where: { telegramId: { in: ['TEST_USER_001', 'CLAIM_USER_001'] } },
    });
    
    console.log('测试数据已清理');

  } catch (error) {
    console.error('\n测试失败:', error.message);
    console.error(error.stack);
  }

  await app.close();
}

bootstrap();
