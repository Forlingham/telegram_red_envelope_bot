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
  topN?: number; // 活跃红包/抽奖红包时使用
  lotteryScope?: string; // 抽奖红包范围：ALL/TOP50/TOP100
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
   */
  async createRedPacket(input: CreateRedPacketInput): Promise<{
    success: boolean;
    redPacket?: RedPacket & {
      sender: { username: string | null; telegramId: string } | null;
    };
    message?: string;
    txid?: string;
    recipients?: {
      telegramId: string;
      username: string | null;
      firstName: string | null;
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
        input.type === RedPacketType.ACTIVITY_TOP ||
        input.type === RedPacketType.ACTIVITY_LOTTERY;

      if (isDirectTransfer) {
        // 定向红包、活跃红包、抽奖红包：直接转账给目标用户
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
    redPacket?: RedPacket & {
      sender: { username: string | null; telegramId: string } | null;
    };
    message?: string;
    txid?: string;
    recipients?: {
      telegramId: string;
      username: string | null;
      firstName: string | null;
      amount: string;
    }[];
  }> {
    // 确定目标用户列表
    let targetTelegramIds: string[] = [];
    let activityMap: Record<string, number> = {};
    if (input.type === RedPacketType.DIRECT && input.targetUsers) {
      targetTelegramIds = input.targetUsers;
    } else if (input.type === RedPacketType.ACTIVITY_TOP && input.topN) {
      // 获取活跃用户列表（排除发送者）
      const activeUsers = await this.getTopActiveUsers(
        input.chatId,
        input.topN,
        input.senderId,
      );
      targetTelegramIds = activeUsers.map((u) => u.telegramId);
      activityMap = activeUsers.reduce(
        (map, u) => {
          map[u.telegramId] = u.messageCount;
          return map;
        },
        {} as Record<string, number>,
      );
    } else if (input.type === RedPacketType.ACTIVITY_LOTTERY && input.topN) {
      // 抽奖红包：根据范围获取用户
      const scope = (input.lotteryScope as "ALL" | "TOP50" | "TOP100") || "ALL";
      const users = await this.getTopActiveUsers(
        input.chatId,
        input.topN,
        input.senderId,
        scope,
      );
      targetTelegramIds = users.map((u) => u.telegramId);
      activityMap = users.reduce(
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
    const { recipients, usersWithoutAddress, userAmounts } =
      await this.getTargetUserAddresses(
        targetTelegramIds,
        totalAmount,
        input.count,
        input.strategy,
        activityMap,
      );

    if (recipients.length === 0 && usersWithoutAddress.length === 0) {
      return { success: false, message: "没有找到目标用户" };
    }

    // 计算需要转账的总金额（只转给有地址的用户）
    const transferAmount = recipients.reduce(
      (sum, r) => sum.plus(r.amount),
      new Big(0),
    );

    // 获取统筹账户地址
    const poolingAddress = await this.getPoolingAccountAddress();

    // 如果有没绑定地址的用户，需要把他们的金额转到统筹账户
    let poolingAmount = new Big(0);
    if (usersWithoutAddress.length > 0 && poolingAddress) {
      // 没地址用户的金额总和
      poolingAmount = usersWithoutAddress.reduce((sum, telegramId) => {
        const amount = userAmounts.get(telegramId) || new Big(0);
        return sum.plus(amount);
      }, new Big(0));
    }

    // 估算手续费
    const estimatedFee = this.txBuilder.estimateFee(
      1,
      recipients.length + (poolingAmount.gt(0) ? 1 : 0), // 如果转统筹账户需要额外的输出
      DEFAULT_CONFIG.FEE_RATE,
    );

    // 统筹账户手续费储备
    const feeReserve =
      usersWithoutAddress.length > 0
        ? new Big(usersWithoutAddress.length).mul(0.0023)
        : new Big(0);

    const requiredBalance = transferAmount
      .plus(poolingAmount)
      .plus(estimatedFee)
      .plus(feeReserve);

    if (balance.lt(requiredBalance)) {
      return {
        success: false,
        message: `余额不足，需要 ${requiredBalance.toFixed(8)} SCASH`,
      };
    }

    // 构建交易输出列表
    let txOutputs: { address: string; amount: Big }[] = [...recipients];

    // 如果有没绑定地址的用户，需要把他们的金额转到统筹账户
    if (poolingAmount.gt(0) && poolingAddress) {
      txOutputs.push({
        address: poolingAddress,
        amount: poolingAmount.plus(feeReserve),
      });
    }

    // 构建并广播交易
    const buildResult = await this.txBuilder.buildTransaction(
      input.senderId,
      txOutputs,
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

    // 如果有用户没绑定钱包，状态保持 ACTIVE；否则 COMPLETED
    const hasPendingUsers = usersWithoutAddress.length > 0;
    const remainingAmount = hasPendingUsers
      ? poolingAmount.plus(feeReserve).toFixed(8)
      : "0";

    const redPacket = await this.prisma.redPacket.create({
      data: {
        senderId: input.senderId,
        type: input.type,
        totalAmount: totalAmount.toFixed(8),
        remainingAmount,
        count: input.count,
        remainingCount: hasPendingUsers ? usersWithoutAddress.length : 0,
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
        status: hasPendingUsers
          ? RedPacketStatus.ACTIVE
          : RedPacketStatus.COMPLETED,
        expiredAt,
      },
      include: {
        sender: {
          select: {
            username: true,
            telegramId: true,
          },
        },
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
      //尝试通过 telegramId 查找用户
      let user = await this.prisma.user.findUnique({
        where: { telegramId },
      });

      // 如果没找到，尝试通过 username 查找
      if (!user) {
        user = await this.prisma.user.findFirst({
          where: { username: telegramId },
        });
      }

      // 如果用户仍然不存在，需要创建临时用户记录
      if (!user) {
        const tempId = `temp_${telegramId}_${Date.now()}`;
        user = await this.prisma.user.create({
          data: {
            telegramId: tempId,
            username: telegramId,
            firstName: "Unknown",
            isWatchOnly: true,
          },
        });
      }

      // 使用原始 telegramId 获取金额
      const userAmount = userAmounts.get(telegramId)?.toFixed(8) || "0";

      // 创建红包领取记录（等待中）
      await this.prisma.redPacketClaim.create({
        data: {
          redPacketId: redPacket.id,
          userId: user.id,
          amount: userAmount,
          status: TransferStatus.PENDING,
        },
      });

      // 创建统筹转账记录
      await this.prisma.poolingTransfer.create({
        data: {
          userId: user.id,
          type: "REDPACKET_CLAIM",
          amount: userAmount,
          status: TransferStatus.PENDING,
          errorMessage: "用户未绑定钱包地址，等待绑定后转账",
        },
      });
    }

    // 获取所有目标用户的信息（用于显示）
    const allRecipientUsers = await Promise.all(
      targetTelegramIds.map(async (telegramId) => {
        // 通过 telegramId 查找用户
        const user = await this.prisma.user.findUnique({
          where: { telegramId },
        });
        return {
          telegramId,
          username: user?.username || null,
          firstName: user?.firstName || null,
        };
      }),
    );

    // 构建返回的所有用户列表（包括有地址的和没地址的）
    const allRecipientsDisplay = allRecipientUsers.map((ru) => {
      const hasAddress = recipients.some((r) => r.telegramId === ru.telegramId);
      // 使用 userAmounts 获取每个用户的金额
      const amount = userAmounts.get(ru.telegramId)?.toFixed(8) || "0";

      return {
        telegramId: ru.telegramId,
        username: ru.username,
        firstName: ru.firstName,
        amount,
        status: hasAddress ? "已转账" : "待绑定",
      };
    });

    return {
      success: true,
      redPacket,
      txid: broadcastResult.txid,
      message: `红包创建成功，已转账给 ${recipients.length} 位用户，${usersWithoutAddress.length} 位用户等待绑定地址`,
      recipients: allRecipientsDisplay,
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
    redPacket?: RedPacket & {
      sender: { username: string | null; telegramId: string } | null;
    };
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
      include: {
        sender: {
          select: {
            username: true,
            telegramId: true,
          },
        },
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
   * 返回：有地址的用户、没地址的用户列表、每个用户应得的金额
   */
  private async getTargetUserAddresses(
    telegramIds: string[],
    totalAmount: Big,
    count: number,
    strategy?: RedPacketStrategy,
    activityMap?: Record<string, number>,
  ): Promise<{
    recipients: { telegramId: string; address: string; amount: Big }[];
    usersWithoutAddress: string[];
    userAmounts: Map<string, Big>; // 每个用户应得的金额
  }> {
    const recipients: { telegramId: string; address: string; amount: Big }[] =
      [];
    const usersWithoutAddress: string[] = [];
    const userAmounts = new Map<string, Big>();

    // 先收集所有用户信息
    const allUsers: { telegramId: string; address?: string }[] = [];
    for (const telegramId of telegramIds) {
      let user = await this.prisma.user.findUnique({
        where: { telegramId },
        include: { wallet: true },
      });

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
          amount: new Big(0),
        });
        // 使用原始的 telegramId 作为 key
        allUsers.push({
          telegramId: telegramId,
          address: user.wallet.address,
        });
      } else {
        usersWithoutAddress.push(telegramId);
        // 使用原始的 telegramId 作为 key
        allUsers.push({ telegramId: telegramId, address: undefined });
      }
    }

    if (allUsers.length === 0) {
      return { recipients: [], usersWithoutAddress: [], userAmounts };
    }

    // 计算每个用户应得的金额（基于所有用户）
    if (strategy === RedPacketStrategy.EQUAL) {
      // 均分（按总人数）
      const equalAmount = totalAmount.div(allUsers.length);
      allUsers.forEach((u) => userAmounts.set(u.telegramId, equalAmount));
    } else if (strategy === RedPacketStrategy.RANK && activityMap) {
      // 按活跃度排序分配
      const totalActivity = allUsers.reduce((sum, u) => {
        const activity = activityMap[u.telegramId] || 1;
        return sum + activity;
      }, 0);

      const sortedUsers = [...allUsers].sort((a, b) => {
        const activityA = activityMap[a.telegramId] || 0;
        const activityB = activityMap[b.telegramId] || 0;
        return activityB - activityA;
      });

      let remainingAmount = totalAmount;
      sortedUsers.forEach((u, index) => {
        const activity = activityMap[u.telegramId] || 1;
        let amount: Big;
        if (index === sortedUsers.length - 1) {
          amount = remainingAmount;
        } else {
          const ratio = activity / totalActivity;
          amount = totalAmount.mul(ratio);
          remainingAmount = remainingAmount.minus(amount);
        }
        userAmounts.set(u.telegramId, amount);
      });
    } else if (strategy === RedPacketStrategy.RANDOM) {
      // 随机分配（二倍均值法）
      const amounts = this.calculateRandomAmounts(totalAmount, allUsers.length);
      allUsers.forEach((u, i) => userAmounts.set(u.telegramId, amounts[i]));
    } else {
      // 默认均分
      const equalAmount = totalAmount.div(allUsers.length);
      allUsers.forEach((u) => userAmounts.set(u.telegramId, equalAmount));
    }

    // 为有地址的用户设置金额
    recipients.forEach((r) => {
      r.amount = userAmounts.get(r.telegramId) || new Big(0);
    });

    return { recipients, usersWithoutAddress, userAmounts };
  }

  /**
   * 计算随机金额（二倍均值法）
   */
  private calculateRandomAmounts(totalAmount: Big, count: number): Big[] {
    const amounts: Big[] = [];
    let remaining = totalAmount;
    const countBig = new Big(count);

    for (let i = 0; i < count - 1; i++) {
      const max = remaining.mul(2).div(countBig).toNumber();
      const amount = Math.floor(Math.random() * max * 100000000) / 100000000;
      const bigAmount = new Big(amount.toFixed(8));
      amounts.push(bigAmount);
      remaining = remaining.minus(bigAmount);
    }
    amounts.push(remaining);

    return amounts;
  }

  /**
   * 获取活跃用户列表（最近30分钟）
   * scope = ALL: 获取群里所有有过发言的用户（打乱顺序，随机抽取）
   * scope = TOP50/TOP100: 按活跃度排序
   */
  private async getTopActiveUsers(
    chatId: string,
    topN: number,
    excludeUserId?: number,
    scope: "ALL" | "TOP50" | "TOP100" = "ALL",
  ): Promise<{ userId: number; telegramId: string; messageCount: number }[]> {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    // 根据范围确定查询数量限制
    const scopeLimit: Record<string, number> = {
      ALL: 500, // 全群取足够多用于随机抽取
      TOP50: 50,
      TOP100: 100,
    };
    const limit = Math.min(scopeLimit[scope] || 500, topN);

    let activities;
    if (excludeUserId) {
      activities = await this.prisma.$queryRaw`
        SELECT 
          u.id as "userId",
          u.telegram_id as "telegramId",
          COUNT(uar.id)::int as "messageCount"
        FROM user_activity_records uar
        JOIN users u ON u.id = uar.user_id
        WHERE uar.chat_id = ${chatId}
          AND uar.created_at > ${thirtyMinutesAgo}
          AND uar.user_id != ${excludeUserId}
        GROUP BY u.id, u.telegram_id
        LIMIT ${limit}
      `;
    } else {
      activities = await this.prisma.$queryRaw`
        SELECT 
          u.id as "userId",
          u.telegram_id as "telegramId",
          COUNT(uar.id)::int as "messageCount"
        FROM user_activity_records uar
        JOIN users u ON u.id = uar.user_id
        WHERE uar.chat_id = ${chatId}
          AND uar.created_at > ${thirtyMinutesAgo}
        GROUP BY u.id, u.telegram_id
        LIMIT ${limit}
      `;
    }

    const result = (activities as any[]).map((a) => ({
      userId: a.userId,
      telegramId: a.telegramId,
      messageCount: a.messageCount,
    }));

    // 全群范围：打乱顺序随机抽取
    if (scope === "ALL") {
      return result.sort(() => Math.random() - 0.5).slice(0, topN);
    }

    // TOP50/TOP100：按活跃度排序
    return result
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, topN);
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
    redPacket:
      | (RedPacket & {
          sender: { username: string | null; telegramId: string } | null;
        })
      | null;
    claims: (RedPacketClaim & {
      user: { username: string | null; telegramId: string };
    })[];
    totalClaimed: string;
  }> {
    const redPacket = await this.prisma.redPacket.findUnique({
      where: { id: redPacketId },
      include: { sender: true },
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
