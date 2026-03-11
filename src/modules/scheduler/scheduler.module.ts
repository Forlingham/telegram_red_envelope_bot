import { Module } from '@nestjs/common';
import { TransferSchedulerService } from './services/transfer-scheduler.service';
import { RedpacketModule } from '../redpacket/redpacket.module';

@Module({
  imports: [RedpacketModule],
  providers: [TransferSchedulerService],
})
export class SchedulerModule {}
