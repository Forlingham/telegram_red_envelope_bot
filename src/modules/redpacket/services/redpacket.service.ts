import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { TransactionBuilderService } from "./transaction-builder.service";
import { WalletService } from "../../wallet/services/wallet.service";
import { UtxoService } from "../../blockchain/services/utxo.service";
import { ScashRpcService } from "../../blockchain/services/scash-rpc.service";
import {
  DEFAULT_CONFIG,
  RedPacketType,
  RedPacketStrategy,
  RedPacketStatus,
  TransferStatus,
} from "../../../shared/constants/network.constants";
import Big from "big.js";
import { RedPacket, RedPacketClaim, User, Prisma } from "@prisma/client";

interface CreateRedPacketInput {
  senderId: number;
  type: RedPacketType;
  totalAmount: string;
  count: number;
  message?: string;
  chatId: string;
  chatTitle?: string;
  strategy?: RedPacketStrategy;
  targetUsers?: string[]; // 定向红包时使用
  topN?: number; // 活跃红包时使用
}

interface ClaimRedPacketInput {
  redPacketId: number;
  userId: number;
  telegramUsername?: string;
}

@Injectable()
export class RedpacketService {
  private readonly logger = new Logger(RedpacketService.name);

  constructor(
    private prisma: PrismaService,
    private txBuilder: TransactionBuilderService,
    private walletService: WalletService,
    private utxoService: UtxoService,
    private rpcService: ScashRpcService,
    private configService: ConfigService,
  ) {}

  /**
   * 获取统筹账户地址
   * 优先从环境变量读取，其次从数据库读取
   */
  private async getPoolingAccountAddress(): Promise<string | null> {
    // 优先从环境变量读取
    const envAddress = this.configService.get<string>(
      "POOLING_ACCOUNT_ADDRESS",
    );
    if (envAddress) {
      return envAddress;
    }

    // 其次从数据库读取
    const config = await this.prisma.systemConfig.findUnique({
      where: { key: "POOLING_ACCOUNT_ADDRESS" },
    });
    return config?.value || null;
  }

  /**
   * 创建红包
   *
   * 红包类型处理逻辑：
   * - DIRECT (定向红包): 直接转账给目标用户，不经过统筹账户
   * - ACTIVITY_TOP (活跃红包): 直接转账给活跃用户，不经过统筹账户
   * - GROUP_EQUAL/GROUP_RANDOM/ACTIVITY_LOTTERY (群红包): 先转到统筹账户，用户抢红包后再分配
   */
  async createRedPacket(input: CreateRedPacketInput): Promise<{
    success: boolean;
    redPacket?: RedPacket;
    message?: string;
    txid?: string;
    recipients?: {
      telegramId: string;
      username: string | null;
      amount: string;
    }[];
  }> {
    try {
      // 验证参数
      const validation = this.validateRedPacketInput(input);
      if (!validation.valid) {
        return { success: false, message: validation.message };
      }

      const totalAmount = new Big(input.totalAmount);

      // 检查发送者余额
      const senderWallet = await this.walletService.getWalletByUserId(
        input.senderId,
      );
      if (!senderWallet) {
        return { success: false, message: "请先绑定或创建钱包" };
      }

      const balance = await this.utxoService.getBalance(
        senderWallet.address,
        true,
      );

      // 根据红包类型选择处理方式
      const isDirectTransfer =
        input.type === RedPacketType.DIRECT ||
        input.type === RedPacketType.ACTIVITY_TOP;

      if (isDirectTransfer) {
        // 定向红包和活跃红包：直接转账给目标用户
        return this.createDirectTransferRedPacket(
          input,
          senderWallet,
          totalAmount,
          balance,
        );
      } else {
        // 群红包：先转到统筹账户
        return this.createPoolingRedPacket(
          input,
          senderWallet,
          totalAmount,
          balance,
        );
      }
    } catch (error) {
      this.logger.error(`创建红包失败: ${error.message}`, error.stack);
      return { success: false, message: `创建红包失败: ${error.message}` };
    }
  }

  /**
   * 创建直接转账类型的红包（定向红包、活跃红包）
   * 直接转账给目标用户，不经过统筹账户
   */
  private async createDirectTransferRedPacket(
    input: CreateRedPacketInput,
    senderWallet: any,
    totalAmount: Big,
    balance: Big,
  ): Promise<{
    success: boolean;
    redPacket?: RedPacket;
    message?: string;
    txid?: string;
    recipients?: {
      telegramId: string;
      username: string | null;
      amount: string;
    }[];
  }> {
    // 确定目标用户列表
    let targetTelegramIds: string[] = [];
    let activityMap: Record<string, number> = {};
    if (input.type === RedPacketType.DIRECT && input.targetUsers) {
      targetTelegramIds = input.targetUsers;
    } else if (input.type === RedPacketType.ACTIVITY_TOP && input.topN) {
      // 获取活跃用户列表
      const activeUsers = await this.getTopActiveUsers(
        input.chatId,
        input.topN,
      );
      targetTelegramIds = activeUsers.map((u) => u.telegramId);
      activityMap = activeUsers.reduce(
        (map, u) => {
          map[u.telegramId] = u.messageCount;
          return map;
        },
        {} as Record<string, number>,
      );
    }

    if (targetTelegramIds.length === 0) {
      return { success: false, message: "没有找到目标用户" };
    }

    // 获取目标用户的钱包地址
    const recipients = await this.getTargetUserAddresses(
      targetTelegramIds,
      totalAmount,
      input.count,
      input.strategy,
      activityMap,
    );

    if (recipients.length === 0) {
      return { success: false, message: "目标用户没有绑定钱包地址" };
    }

    // 计算需要转账的总金额（只转给有地址的用户）
    const transferAmount = recipients.reduce(
      (sum, r) => sum.plus(r.amount),
      new Big(0),
    );

    // 估算手续费
    const estimatedFee = this.txBuilder.estimateFee(
      1,
      recipients.length,
      DEFAULT_CONFIG.FEE_RATE,
    );
    const requiredBalance = transferAmount.plus(estimatedFee);

    if (balance.lt(requiredBalance)) {
      return {
        success: false,
        message: `余额不足，需要 ${requiredBalance.toFixed(8)} SCASH`,
      };
    }

    // 构建并广播交易
    const buildResult = await this.txBuilder.buildTransaction(
      input.senderId,
      recipients,
      DEFAULT_CONFIG.FEE_RATE,
    );

    if (!buildResult) {
      return { success: false, message: "构建交易失败" };
    }

    const broadcastResult = await this.txBuilder.broadcastTransaction(
      input.senderId,
      buildResult,
    );

    if (!broadcastResult.success) {
      return {
        success: false,
        message: `广播交易失败: ${broadcastResult.message}`,
      };
    }

    // 为没有地址的用户创建待处理记录
    const usersWithAddress = new Set(recipients.map((r) => r.telegramId));
    const usersWithoutAddress = targetTelegramIds.filter(
      (id) => !usersWithAddress.has(id),
    );

    // 创建红包记录
    const expiredAt = new Date();
    expiredAt.setHours(
      expiredAt.getHours() + DEFAULT_CONFIG.REDPACKET_EXPIRY_HOURS,
    );

    const redPacket = await this.prisma.redPacket.create({
      data: {
        senderId: input.senderId,
        type: input.type,
        totalAmount: totalAmount.toFixed(8),
        remainingAmount: "0", // 直接转账类型的红包，创建时就已全部分配
        count: input.count,
        remainingCount: 0,
        message: input.message || "",
        chatId: input.chatId,
        chatTitle: input.chatTitle,
        strategy: input.strategy || RedPacketStrategy.EQUAL,
        targetUsers: input.targetUsers
          ? JSON.stringify(input.targetUsers)
          : null,
        topN: input.topN,
        fundingTxid: broadcastResult.txid,
        rawTransaction: buildResult.rawTransaction,
        status: RedPacketStatus.COMPLETED, // 直接转账类型直接标记为完成
        expiredAt,
      },
    });

    // 创建领取记录（给有地址的用户）
    for (const recipient of recipients) {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: recipient.telegramId },
      });

      if (user) {
        await this.prisma.redPacketClaim.create({
          data: {
            redPacketId: redPacket.id,
            userId: user.id,
            amount: recipient.amount.toFixed(8),
            status: TransferStatus.COMPLETED,
            txid: broadcastResult.txid,
          },
        });
      }
    }

    // 为没有地址的用户创建待处理转账记录
    for (const telegramId of usersWithoutAddress) {
      const user = await this.prisma.user.findUnique({
        where: { telegramId },
      });

      if (user) {
        // 计算该用户应得的金额
        const userAmount =
          input.strategy === RedPacketStrategy.EQUAL
            ? totalAmount.div(input.count)
            : totalAmount.div(targetTelegramIds.length); // 简化处理，平均分配

        await this.prisma.poolingTransfer.create({
          data: {
            userId: user.id,
            type: "REDPACKET_CLAIM",
            amount: userAmount.toFixed(8),
            status: TransferStatus.PENDING,
            errorMessage: "用户未绑定钱包地址，等待绑定后转账",
          },
        });
      }
    }

    // 获取 recipients 的用户信息
    const recipientUserIds = await Promise.all(
      recipients.map(async (r) => {
        const user = await this.prisma.user.findFirst({
          where: {
            OR: [{ telegramId: r.telegramId }, { username: r.telegramId }],
          },
        });
        return user;
      }),
    );

    return {
      success: true,
      redPacket,
      txid: broadcastResult.txid,
      message: `红包创建成功，已转账给 ${recipients.length} 位用户，${usersWithoutAddress.length} 位用户等待绑定地址`,
      recipients: recipients.map((r, index) => ({
        telegramId: r.telegramId,
        username: recipientUserIds[index]?.username || null,
        amount: r.amount.toFixed(8),
      })),
    };
  }

  /**
   * 创建群红包（均分、随机、抽奖）
   * 先转到统筹账户，用户抢红包后再从统筹账户分配
   */
  private async createPoolingRedPacket(
    input: CreateRedPacketInput,
    senderWallet: any,
    totalAmount: Big,
    balance: Big,
  ): Promise<{
    success: boolean;
    redPacket?: RedPacket;
    message?: string;
    txid?: string;
  }> {
    // 获取统筹账户地址
    const poolingAddress = await this.getPoolingAccountAddress();

    if (!poolingAddress) {
      return { success: false, message: "系统配置错误：统筹账户未设置" };
    }

    // 手续费储备：每人 0.0023 SCASH，用于后续从统筹账户转账时的手续费
    const feeReserve = new Big(input.count).mul(0.0023);

    // 估算当前交易手续费
    const estimatedFee = this.txBuilder.estimateFee(
      1,
      1,
      DEFAULT_CONFIG.FEE_RATE,
    );

    // 需要转给统筹的总金额 = 红包金额 + 手续费储备
    const totalToPooling = totalAmount.plus(feeReserve);
    const requiredBalance = totalToPooling.plus(estimatedFee);

    if (balance.lt(requiredBalance)) {
      return {
        success: false,
        message: `余额不足，需要 ${requiredBalance.toFixed(8)} SCASH（包含 ${feeReserve.toFixed(8)} SCASH 作为手续费储备）`,
      };
    }

    // 构建交易：发送者 -> 统筹账户
    const recipients = [
      {
        address: poolingAddress,
        amount: totalToPooling,
      },
    ];

    const buildResult = await this.txBuilder.buildTransaction(
      input.senderId,
      recipients,
      DEFAULT_CONFIG.FEE_RATE,
    );

    if (!buildResult) {
      return { success: false, message: "构建交易失败" };
    }

    const broadcastResult = await this.txBuilder.broadcastTransaction(
      input.senderId,
      buildResult,
    );

    if (!broadcastResult.success) {
      return {
        success: false,
        message: `广播交易失败: ${broadcastResult.message}`,
      };
    }

    // 创建红包记录
    const expiredAt = new Date();
    expiredAt.setHours(
      expiredAt.getHours() + DEFAULT_CONFIG.REDPACKET_EXPIRY_HOURS,
    );

    const redPacket = await this.prisma.redPacket.create({
      data: {
        senderId: input.senderId,
        type: input.type,
        totalAmount: totalAmount.toFixed(8),
        remainingAmount: totalAmount.toFixed(8),
        count: input.count,
        remainingCount: input.count,
        message: input.message || "",
        chatId: input.chatId,
        chatTitle: input.chatTitle,
        strategy: input.strategy || RedPacketStrategy.EQUAL,
        targetUsers: input.targetUsers
          ? JSON.stringify(input.targetUsers)
          : null,
        topN: input.topN,
        fundingTxid: broadcastResult.txid,
        rawTransaction: buildResult.rawTransaction,
        status: RedPacketStatus.ACTIVE,
        expiredAt,
      },
    });

    return {
      success: true,
      redPacket,
      txid: broadcastResult.txid,
      message: "红包创建成功",
    };
  }

  /**
   * 获取目标用户的钱包地址和分配金额
   */
  private async getTargetUserAddresses(
    telegramIds: string[],
    totalAmount: Big,
    count: number,
    strategy?: RedPacketStrategy,
    activityMap?: Record<string, number>,
  ): Promise<{ telegramId: string; address: string; amount: Big }[]> {
    const recipients: { telegramId: string; address: string; amount: Big }[] =
      [];

    for (const telegramId of telegramIds) {
      // 先尝试通过 telegramId（数字ID）查找
      let user = await this.prisma.user.findUnique({
        where: { telegramId },
        include: { wallet: true },
      });

      // 如果没找到，尝试通过 username 查找
      if (!user) {
        user = await this.prisma.user.findFirst({
          where: { username: telegramId },
          include: { wallet: true },
        });
      }

      if (user?.wallet?.address) {
        recipients.push({
          telegramId: user.telegramId,
          address: user.wallet.address,
          amount: new Big(0), // 稍后计算具体金额
        });
      }
    }

    if (recipients.length === 0) {
      return [];
    }

    // 计算每人应得的金额
    if (strategy === RedPacketStrategy.EQUAL) {
      // 均分
      const equalAmount = totalAmount.div(count);
      recipients.forEach((r) => (r.amount = equalAmount));
    } else if (strategy === RedPacketStrategy.RANK && activityMap) {
      // 按活跃度排序分配
      const totalActivity = recipients.reduce((sum, r) => {
        const activity = activityMap[r.telegramId] || 1;
        return sum + activity;
      }, 0);

      let remainingAmount = totalAmount;
      const sortedRecipients = [...recipients].sort((a, b) => {
        const activityA = activityMap[a.telegramId] || 0;
        const activityB = activityMap[b.telegramId] || 0;
        return activityB - activityA;
      });

      sortedRecipients.forEach((r, index) => {
        const activity = activityMap[r.telegramId] || 1;
        if (index === sortedRecipients.length - 1) {
          r.amount = remainingAmount;
        } else {
          const ratio = activity / totalActivity;
          const amount = totalAmount.mul(ratio);
          r.amount = amount;
          remainingAmount = remainingAmount.minus(amount);
        }
      });
    } else {
      // 默认均分
      const avgAmount = totalAmount.div(recipients.length);
      recipients.forEach((r) => (r.amount = avgAmount));
    }

    return recipients;
  }

  /**
   * 获取活跃用户列表（最近30分钟）
   */
  private async getTopActiveUsers(
    chatId: string,
    topN: number,
  ): Promise<{ userId: number; telegramId: string; messageCount: number }[]> {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const activities = await this.prisma.$queryRaw`
      SELECT 
        u.id as "userId",
        u.telegram_id as "telegramId",
        COUNT(uar.id)::int as "messageCount"
      FROM user_activity_records uar
      JOIN users u ON u.id = uar.user_id
      WHERE uar.chat_id = ${chatId}
        AND uar.created_at > ${thirtyMinutesAgo}
      GROUP BY u.id, u.telegram_id
      ORDER BY "messageCount" DESC
      LIMIT ${topN}
    `;

    return (activities as any[]).map((a) => ({
      userId: a.userId,
      telegramId: a.telegramId,
      messageCount: a.messageCount,
    }));
  }

  /**
   * 抢红包
   */
  async claimRedPacket(input: ClaimRedPacketInput): Promise<{
    success: boolean;
    amount?: string;
    message?: string;
    claim?: RedPacketClaim;
  }> {
    try {
      // 获取红包
      const redPacket = await this.prisma.redPacket.findUnique({
        where: { id: input.redPacketId },
      });

      if (!redPacket) {
        return { success: false, message: "红包不存在" };
      }

      // 检查状态
      if (redPacket.status !== RedPacketStatus.ACTIVE) {
        const statusMap = {
          [RedPacketStatus.COMPLETED]: "已被抢完",
          [RedPacketStatus.EXPIRED]: "已过期",
          [RedPacketStatus.REFUNDED]: "已退款",
        };
        return {
          success: false,
          message: statusMap[redPacket.status] || "红包无效",
        };
      }

      // 检查是否过期
      if (new Date() > redPacket.expiredAt) {
        await this.prisma.redPacket.update({
          where: { id: redPacket.id },
          data: { status: RedPacketStatus.EXPIRED },
        });
        return { success: false, message: "红包已过期" };
      }

      // 检查是否已抢过
      const existingClaim = await this.prisma.redPacketClaim.findUnique({
        where: {
          redPacketId_userId: {
            redPacketId: input.redPacketId,
            userId: input.userId,
          },
        },
      });

      if (existingClaim) {
        return { success: false, message: "你已经抢过这个红包了" };
      }

      // 计算红包金额
      const claimAmount = this.calculateClaimAmount(redPacket);

      // 检查红包是否还有剩余
      const remainingAmount = new Big(redPacket.remainingAmount.toString());
      if (remainingAmount.lt(claimAmount)) {
        return { success: false, message: "红包已被抢完" };
      }

      // 检查定向红包权限
      if (redPacket.type === RedPacketType.DIRECT) {
        const targetUsers = redPacket.targetUsers
          ? JSON.parse(redPacket.targetUsers)
          : [];
        const user = await this.prisma.user.findUnique({
          where: { id: input.userId },
        });
        if (!targetUsers.includes(user?.telegramId)) {
          return { success: false, message: "这个红包不是发给你的" };
        }
      }

      // 创建领取记录
      const remainingCount = redPacket.remainingCount - 1;
      const newRemainingAmount = remainingAmount.minus(claimAmount);

      const [claim] = await this.prisma.$transaction([
        // 创建领取记录
        this.prisma.redPacketClaim.create({
          data: {
            redPacketId: input.redPacketId,
            userId: input.userId,
            amount: claimAmount.toFixed(8),
            status: TransferStatus.PENDING,
          },
        }),
        // 更新红包状态
        this.prisma.redPacket.update({
          where: { id: redPacket.id },
          data: {
            remainingAmount: newRemainingAmount.toFixed(8),
            remainingCount,
            status:
              remainingCount === 0
                ? RedPacketStatus.COMPLETED
                : redPacket.status,
          },
        }),
      ]);

      // 处理群红包的转账（从统筹账户转账给用户）
      const isGroupRedPacket =
        redPacket.type === RedPacketType.GROUP_EQUAL ||
        redPacket.type === RedPacketType.GROUP_RANDOM ||
        redPacket.type === RedPacketType.ACTIVITY_LOTTERY;

      if (isGroupRedPacket) {
        await this.processGroupRedPacketClaim(
          input.userId,
          claim.id,
          claimAmount,
        );

        // 如果红包已被抢完，立即处理转账
        if (remainingCount === 0) {
          this.processPoolingTransfers().catch((err) => {
            this.logger.error(`立即处理转账失败: ${err.message}`);
          });
        }
      }

      return {
        success: true,
        amount: claimAmount.toFixed(8),
        message: `恭喜！抢到 ${claimAmount.toFixed(8)} SCASH`,
        claim,
      };
    } catch (error) {
      this.logger.error(`抢红包失败: ${error.message}`, error.stack);
      return { success: false, message: `抢红包失败: ${error.message}` };
    }
  }

  /**
   * 计算红包金额
   */
  private calculateClaimAmount(redPacket: RedPacket): Big {
    const remainingAmount = new Big(redPacket.remainingAmount.toString());
    const remainingCount = redPacket.remainingCount;

    if (remainingCount === 1) {
      // 最后一个，拿全部剩余
      return remainingAmount;
    }

    if (redPacket.strategy === RedPacketStrategy.EQUAL) {
      // 均分
      return new Big(redPacket.totalAmount.toString()).div(redPacket.count);
    } else {
      // 随机金额（二倍均值法）
      const avg = remainingAmount.div(remainingCount);
      const max = avg.mul(2);
      const random = Math.random();
      const amount = new Big(random).mul(max);
      // 确保不小于最小金额
      const minAmount = new Big("0.00001");
      if (amount.lt(minAmount)) {
        return minAmount;
      }
      return amount;
    }
  }

  /**
   * 处理群红包的领取转账
   * 从统筹账户转账给用户
   */
  private async processGroupRedPacketClaim(
    userId: number,
    claimId: number,
    amount: Big,
  ): Promise<void> {
    try {
      // 获取用户钱包
      const userWallet = await this.walletService.getWalletByUserId(userId);

      if (userWallet && userWallet.address) {
        // 用户有地址，创建转账记录待批量处理
        await this.prisma.poolingTransfer.create({
          data: {
            userId,
            type: "REDPACKET_CLAIM",
            amount: amount.toFixed(8),
            claimId,
            status: TransferStatus.PENDING,
          },
        });
        this.logger.debug(
          `创建群红包转账记录: userId=${userId}, amount=${amount.toFixed(8)}`,
        );
      } else {
        // 用户没有绑定地址，创建待处理记录
        await this.prisma.poolingTransfer.create({
          data: {
            userId,
            type: "REDPACKET_CLAIM",
            amount: amount.toFixed(8),
            claimId,
            status: TransferStatus.PENDING,
            errorMessage: "用户未绑定钱包地址，等待绑定后转账",
          },
        });
        this.logger.debug(`用户 ${userId} 未绑定地址，创建待处理转账记录`);
      }
    } catch (error) {
      this.logger.error(`处理群红包领取转账失败: ${error.message}`);
      // 不抛出错误，不影响用户领取红包的体验
    }
  }

  /**
   * 处理过期红包退款
   */
  async processExpiredRedPackets(): Promise<{
    processed: number;
    refunded: number;
    errors: string[];
  }> {
    const result = {
      processed: 0,
      refunded: 0,
      errors: [] as string[],
    };

    try {
      // 获取已过期的活跃红包
      const expiredPackets = await this.prisma.redPacket.findMany({
        where: {
          status: RedPacketStatus.ACTIVE,
          expiredAt: {
            lt: new Date(),
          },
        },
        include: {
          sender: true,
        },
      });

      for (const packet of expiredPackets) {
        try {
          result.processed++;

          const remainingAmount = new Big(packet.remainingAmount.toString());
          if (remainingAmount.lte(0)) {
            // 没有剩余，直接标记为完成
            await this.prisma.redPacket.update({
              where: { id: packet.id },
              data: { status: RedPacketStatus.COMPLETED },
            });
            continue;
          }

          // 获取发送者钱包
          const senderWallet = await this.walletService.getWalletByUserId(
            packet.senderId,
          );
          if (!senderWallet) {
            result.errors.push(`红包 ${packet.id}: 发送者钱包不存在`);
            continue;
          }

          // 构建退款交易（从统筹账户退回给发送者）
          const recipients = [
            {
              address: senderWallet.address,
              amount: remainingAmount,
            },
          ];

          // 使用统筹账户构建交易
          const buildResult =
            await this.txBuilder.buildPoolingTransferTransaction(
              [
                {
                  userId: packet.senderId,
                  address: senderWallet.address,
                  amount: remainingAmount,
                },
              ],
              DEFAULT_CONFIG.FEE_RATE,
            );

          if (!buildResult) {
            result.errors.push(`红包 ${packet.id}: 构建退款交易失败`);
            continue;
          }

          // 广播交易
          const broadcastResult = await this.txBuilder.broadcastTransaction(
            packet.senderId, // 这里实际上不应该用 senderId，而是用系统用户的 ID
            buildResult,
          );

          if (!broadcastResult.success) {
            result.errors.push(
              `红包 ${packet.id}: 广播退款交易失败: ${broadcastResult.message}`,
            );
            continue;
          }

          // 更新红包状态
          await this.prisma.redPacket.update({
            where: { id: packet.id },
            data: {
              status: RedPacketStatus.REFUNDED,
              remainingAmount: "0",
              remainingCount: 0,
            },
          });

          // 创建退款转账记录
          await this.prisma.poolingTransfer.create({
            data: {
              userId: packet.senderId,
              type: "REFUND",
              amount: remainingAmount.toFixed(8),
              txid: broadcastResult.txid,
              status: TransferStatus.COMPLETED,
              processedAt: new Date(),
            },
          });

          result.refunded++;
        } catch (error) {
          result.errors.push(`红包 ${packet.id}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`处理过期红包失败: ${error.message}`);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * 处理统筹账户转账（批量）
   */
  async processPoolingTransfers(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    errors: string[];
  }> {
    const result = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [] as string[],
    };

    try {
      // 获取待处理的转账
      const pendingTransfers = await this.prisma.poolingTransfer.findMany({
        where: {
          status: {
            in: [TransferStatus.PENDING, TransferStatus.RETRYING],
          },
          retryCount: {
            lt: 3,
          },
        },
        take: 50, // 每批最多处理50笔
        orderBy: {
          createdAt: "asc",
        },
      });

      if (pendingTransfers.length === 0) {
        return result;
      }

      // 按用户分组转账
      const transferByUser = new Map<number, typeof pendingTransfers>();
      for (const transfer of pendingTransfers) {
        const userTransfers = transferByUser.get(transfer.userId) || [];
        userTransfers.push(transfer);
        transferByUser.set(transfer.userId, userTransfers);
      }

      // 处理每个用户的转账
      for (const [userId, transfers] of transferByUser) {
        try {
          // 获取用户钱包
          const userWallet = await this.walletService.getWalletByUserId(userId);
          if (!userWallet) {
            // 用户没有完整钱包，跳过
            for (const transfer of transfers) {
              await this.prisma.poolingTransfer.update({
                where: { id: transfer.id },
                data: {
                  status: TransferStatus.PENDING,
                  retryCount: { increment: 1 },
                },
              });
            }
            continue;
          }

          // 合并同一用户的所有转账
          const totalAmount = transfers.reduce(
            (sum, t) => sum.plus(t.amount.toString()),
            new Big(0),
          );

          // 构建批量转账交易
          const buildResult =
            await this.txBuilder.buildPoolingTransferTransaction(
              transfers.map((t) => ({
                userId: t.userId,
                address: userWallet.address,
                amount: new Big(t.amount.toString()),
              })),
              DEFAULT_CONFIG.FEE_RATE,
            );

          if (!buildResult) {
            throw new Error("构建转账交易失败");
          }

          // 广播交易（使用统筹账户私钥）
          const broadcastResult =
            await this.txBuilder.broadcastPoolingTransaction(buildResult);

          if (!broadcastResult.success) {
            throw new Error(`广播失败: ${broadcastResult.message}`);
          }

          // 更新转账记录
          for (const transfer of transfers) {
            await this.prisma.poolingTransfer.update({
              where: { id: transfer.id },
              data: {
                status: TransferStatus.COMPLETED,
                txid: broadcastResult.txid,
                processedAt: new Date(),
              },
            });

            // 更新红包领取记录
            if (transfer.claimId) {
              await this.prisma.redPacketClaim.update({
                where: { id: transfer.claimId },
                data: {
                  status: TransferStatus.COMPLETED,
                  txid: broadcastResult.txid,
                },
              });
            }

            result.succeeded++;
          }

          result.processed += transfers.length;
        } catch (error) {
          this.logger.error(`处理用户 ${userId} 的转账失败: ${error.message}`);

          // 标记为失败或重试
          for (const transfer of transfers) {
            const newRetryCount = transfer.retryCount + 1;
            await this.prisma.poolingTransfer.update({
              where: { id: transfer.id },
              data: {
                status:
                  newRetryCount >= 3
                    ? TransferStatus.FAILED
                    : TransferStatus.RETRYING,
                retryCount: newRetryCount,
                errorMessage: error.message,
              },
            });
            result.failed++;
          }

          result.errors.push(`用户 ${userId}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`处理统筹账户转账失败: ${error.message}`);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * 验证红包输入参数
   */
  private validateRedPacketInput(input: CreateRedPacketInput): {
    valid: boolean;
    message?: string;
  } {
    if (!input.senderId) {
      return { valid: false, message: "发送者不能为空" };
    }

    if (!input.type) {
      return { valid: false, message: "红包类型不能为空" };
    }

    if (!input.totalAmount || new Big(input.totalAmount).lte(0)) {
      return { valid: false, message: "红包金额必须大于0" };
    }

    if (new Big(input.totalAmount).lt(DEFAULT_CONFIG.MIN_RED_PACKET_AMOUNT)) {
      return {
        valid: false,
        message: `红包金额不能小于 ${DEFAULT_CONFIG.MIN_RED_PACKET_AMOUNT} SCASH`,
      };
    }

    if (!input.count || input.count <= 0) {
      return { valid: false, message: "红包份数必须大于0" };
    }

    if (input.count > DEFAULT_CONFIG.MAX_RED_PACKET_COUNT) {
      return {
        valid: false,
        message: `红包份数不能超过 ${DEFAULT_CONFIG.MAX_RED_PACKET_COUNT}`,
      };
    }

    if (
      input.type === RedPacketType.DIRECT &&
      (!input.targetUsers || input.targetUsers.length === 0)
    ) {
      return { valid: false, message: "定向红包需要指定接收者" };
    }

    return { valid: true };
  }

  /**
   * 获取红包详情
   */
  async getRedPacketDetails(redPacketId: number): Promise<{
    redPacket: RedPacket | null;
    claims: RedPacketClaim[];
    totalClaimed: string;
  }> {
    const redPacket = await this.prisma.redPacket.findUnique({
      where: { id: redPacketId },
    });

    if (!redPacket) {
      return { redPacket: null, claims: [], totalClaimed: "0" };
    }

    const claims = await this.prisma.redPacketClaim.findMany({
      where: { redPacketId },
      include: { user: true },
      orderBy: { claimedAt: "desc" },
    });

    const totalClaimed = claims.reduce(
      (sum, c) => sum.plus(c.amount.toString()),
      new Big(0),
    );

    return {
      redPacket,
      claims,
      totalClaimed: totalClaimed.toFixed(8),
    };
  }

  /**
   * 获取用户红包列表
   */
  async getUserRedPackets(
    userId: number,
    type: "sent" | "received",
  ): Promise<RedPacket[] | RedPacketClaim[]> {
    if (type === "sent") {
      return this.prisma.redPacket.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: "desc" },
      });
    } else {
      return this.prisma.redPacketClaim.findMany({
        where: { userId },
        include: { redPacket: true },
        orderBy: { claimedAt: "desc" },
      });
    }
  }
}
