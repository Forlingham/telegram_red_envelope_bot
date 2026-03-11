import { Module } from '@nestjs/common';
import { RedpacketService } from './services/redpacket.service';
import { TransactionBuilderService } from './services/transaction-builder.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, BlockchainModule, WalletModule],
  providers: [RedpacketService, TransactionBuilderService],
  exports: [RedpacketService, TransactionBuilderService],
})
export class RedpacketModule {}
