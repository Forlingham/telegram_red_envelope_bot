import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TelegramBotService } from "./services/telegram-bot.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { WalletModule } from "../wallet/wallet.module";
import { RedpacketModule } from "../redpacket/redpacket.module";
import { BlockchainModule } from "../blockchain/blockchain.module";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WalletModule,
    RedpacketModule,
    BlockchainModule,
  ],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramModule {}
