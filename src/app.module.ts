import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "./prisma/prisma.module";
import { BlockchainModule } from "./modules/blockchain/blockchain.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { RedpacketModule } from "./modules/redpacket/redpacket.module";
import { TelegramModule } from "./modules/telegram/telegram.module";
import { SchedulerModule } from "./modules/scheduler/scheduler.module";
import { AdminModule } from "./modules/admin/admin.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    BlockchainModule,
    WalletModule,
    RedpacketModule,
    TelegramModule,
    SchedulerModule,
    AdminModule,
  ],
})
export class AppModule {}
