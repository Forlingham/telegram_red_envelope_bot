import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletService } from './services/wallet.service';
import { EncryptionService } from './services/encryption.service';

@Module({
  imports: [ConfigModule],
  providers: [WalletService, EncryptionService],
  exports: [WalletService, EncryptionService],
})
export class WalletModule {}
