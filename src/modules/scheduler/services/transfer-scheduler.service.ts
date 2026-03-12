import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RedpacketService } from "../../redpacket/services/redpacket.service";
import { PrismaService } from "../../../prisma/prisma.service";

@Injectable()
export class TransferSchedulerService {
  private readonly logger = new Logger(TransferSchedulerService.name);

  constructor(
    private redpacketService: RedpacketService,
    private prisma: PrismaService,
  ) {}

  /**
   * 每5分钟处理一次统筹账户转账
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processPoolingTransfers() {
    this.logger.log("开始处理统筹账户转账...");

    try {
      const result = await this.redpacketService.processPoolingTransfers();

      this.logger.log(
        `处理完成: ${result.processed} 笔, ` +
          `成功: ${result.succeeded}, ` +
          `失败: ${result.failed}`,
      );

      if (result.errors.length > 0) {
        this.logger.warn(`处理中的错误: ${result.errors.join(", ")}`);
      }
    } catch (error) {
      this.logger.error(`处理统筹账户转账失败: ${error.message}`);
    }
  }

  /**
   * 每小时检查并处理过期红包
   */
  @Cron(CronExpression.EVERY_HOUR)
  async processExpiredRedPackets() {
    this.logger.log("开始处理过期红包...");

    try {
      const result = await this.redpacketService.processExpiredRedPackets();

      this.logger.log(
        `处理完成: ${result.processed} 个过期红包, ` +
          `退款: ${result.refunded}`,
      );

      if (result.errors.length > 0) {
        this.logger.warn(`处理中的错误: ${result.errors.join(", ")}`);
      }
    } catch (error) {
      this.logger.error(`处理过期红包失败: ${error.message}`);
    }
  }

  /**
   * 每天清理失败次数过多的转账记录
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupFailedTransfers() {
    this.logger.log("清理失败转账记录...");
    // 实现清理逻辑
  }

  /**
   * 每天清理24小时前的活跃记录
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupOldActivityRecords() {
    this.logger.log("清理24小时前的活跃记录...");

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await this.prisma.userActivityRecord.deleteMany({
      where: {
        createdAt: {
          lt: yesterday,
        },
      },
    });

    this.logger.log(`清理了 ${result.count} 条活跃记录`);
  }
}
