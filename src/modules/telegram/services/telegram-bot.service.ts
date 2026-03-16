import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import TelegramBot = require("node-telegram-bot-api");
import { PrismaService } from "../../../prisma/prisma.service";
import { WalletService } from "../../wallet/services/wallet.service";
import { RedpacketService } from "../../redpacket/services/redpacket.service";
import { TransactionBuilderService } from "../../redpacket/services/transaction-builder.service";
import { UtxoService } from "../../blockchain/services/utxo.service";
import {
  RedPacketType,
  RedPacketStrategy,
} from "../../../shared/constants/network.constants";
import Big from "big.js";

interface SessionData {
  step: string;
  data: any;
  lastMessageId?: number;
  userMessageIds?: number[];
}

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;
  private userSessions: Map<number, SessionData> = new Map();

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private walletService: WalletService,
    private redpacketService: RedpacketService,
    private transactionBuilder: TransactionBuilderService,
    private utxoService: UtxoService,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN");

    if (!token) {
      this.logger.warn("TELEGRAM_BOT_TOKEN not configured, bot will not start");
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

    this.setupCommandHandlers();
    this.setupCallbackHandlers();
    this.setupMessageHandlers();

    this.logger.log("Telegram bot started successfully");
  }

  private setupCommandHandlers() {
    // /start 命令
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      const welcomeMessage = `
🎉 欢迎使用 Scash 红包机器人！

我是基于 Scash 区块链的去中心化红包助手。

📋 可用命令：
/help - 显示帮助信息
/balance - 查询钱包余额
/send - 发送红包
/transfer - 普通转账
/bind <地址> - 绑定只读钱包
/create - 创建完整钱包
/import - 导入已有钱包
/delete - 删除钱包

💡 提示：你可以先使用只读模式抢红包，稍后再绑定完整钱包提取资金。
      `;

      this.bot.sendMessage(chatId, welcomeMessage);
    });

    // /help 命令
    this.bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      const helpMessage = `
📖 Scash 红包机器人帮助

🧧 红包功能：
• /send - 发送红包（定向/均分/随机）
• /transfer - 普通转账到指定地址
• 在群内点击红包消息抢红包

💬 群排行：
• /rank - 查看最近30分钟活跃排行

💰 钱包管理：
• /balance - 查询钱包余额
• /bind <地址> - 绑定只读钱包
• /create - 创建新钱包（含助记词）
• /import - 导入已有钱包
• /delete - 删除钱包（⚠️ 需先备份助记词）

🔒 钱包模式：
• 只读模式：仅绑定地址，可抢红包但无法发送
• 完整模式：拥有私钥，可收发红包和转账

⚠️ 重要提示：
• 助记词是恢复钱包的唯一方式，请务必安全备份
• 删除钱包前必须备份助记词，否则将永久丢失资产
• 转账前请仔细核对地址，转账后无法撤销

💬 有问题？联系开发者
      `;
      this.bot.sendMessage(chatId, helpMessage);
    });

    // /process 命令 - 手动处理待处理转账（管理员命令）
    this.bot.onText(/\/process/, async (msg) => {
      const chatId = msg.chat.id;

      // 简单验证：只有特定用户可以执行
      if (msg.from.id.toString() !== "7179825743") {
        this.bot.sendMessage(chatId, "❌ 无权限");
        return;
      }

      this.bot.sendMessage(chatId, "⏳ 正在处理转账...");

      try {
        const result = await this.redpacketService.processPoolingTransfers();

        let message = `✅ 转账处理完成\n\n`;
        message += `处理: ${result.processed} 笔\n`;
        message += `成功: ${result.succeeded} 笔\n`;
        message += `失败: ${result.failed} 笔\n`;

        if (result.errors.length > 0) {
          message += `\n错误: ${result.errors.join("\n")}`;
        }

        this.bot.sendMessage(chatId, message);
      } catch (error) {
        this.bot.sendMessage(chatId, `❌ 处理失败: ${error.message}`);
      }
    });

    // /balance 命令
    this.bot.onText(/\/balance/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      const wallet = await this.walletService.getWalletByUserId(user.id);

      if (!wallet) {
        const pendingClaims = await this.prisma.redPacketClaim.findMany({
          where: {
            userId: user.id,
            status: "PENDING",
          },
        });

        let pendingAmount = new Big(0);
        for (const claim of pendingClaims) {
          pendingAmount = pendingAmount.add(new Big(claim.amount.toString()));
        }

        let message = "💰 红包待领取\n\n";

        if (pendingClaims.length > 0) {
          message += `📥 你已抢到但未转账的金额: ${pendingAmount.toFixed(8)} SCASH\n`;
          message += `\n⚠️ 绑定钱包后将自动转账到你的地址`;
        } else {
          message += `📭 你还没有抢到红包`;
        }

        message += `\n\n💡 绑定钱包后可收发红包\n使用 /bind <地址> 绑定只读钱包\n或使用 /create 创建新钱包`;

        this.bot.sendMessage(chatId, message);
        return;
      }

      try {
        const confirmedBalance = await this.utxoService.getBalance(
          wallet.address,
          false,
        );
        const unconfirmedBalance = await this.utxoService.getBalance(
          wallet.address,
          true,
        );

        let message = `
💰 钱包余额

地址: \`${wallet.address}\`

✅ 已确认: ${confirmedBalance.toFixed(8)} SCASH
⏳ 未确认: ${unconfirmedBalance.minus(confirmedBalance).toFixed(8)} SCASH
📊 总计: ${unconfirmedBalance.toFixed(8)} SCASH
        `;

        if (user.isWatchOnly) {
          message +=
            "\n\n⚠️ 当前为只读模式，无法发送红包\n使用 /import 导入助记词解锁完整功能";
        }

        this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      } catch (error) {
        this.logger.error(`查询余额失败: ${error.message}`);
        this.bot.sendMessage(chatId, "❌ 查询余额失败，请稍后重试");
      }
    });

    // /rank 命令 - 查看群活跃排行
    this.bot.onText(/\/rank/, async (msg) => {
      const chatId = msg.chat.id;

      if (msg.chat.type === "private") {
        this.bot.sendMessage(chatId, "❌ 请在群聊中使用此命令");
        return;
      }

      this.bot.sendMessage(chatId, "⏳ 查询活跃排行...");

      try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const chatIdStr = chatId.toString();

        const rankings = await this.prisma.$queryRaw`
          SELECT 
            u.username,
            u.first_name as "firstName",
            COUNT(uar.id)::int as "messageCount"
          FROM user_activity_records uar
          JOIN users u ON u.id = uar.user_id
          WHERE uar.chat_id = ${chatIdStr}
            AND uar.created_at > ${thirtyMinutesAgo}
          GROUP BY u.id, u.username, u.first_name
          ORDER BY "messageCount" DESC
          LIMIT 10
        `;

        const results = rankings as any[];

        if (results.length === 0) {
          this.bot.sendMessage(
            chatId,
            "📊 最近30分钟暂无活跃用户\n\n快来发言吧！",
          );
          return;
        }

        let message = "📊 群活跃排行（最近30分钟）\n\n";

        results.forEach((r, index) => {
          const name = r.username || r.firstName || "未知用户";
          const displayName = r.username ? `@${r.username}` : name;
          message += `${index + 1}. ${displayName}: ${r.messageCount} 条消息\n`;
        });

        this.bot.sendMessage(chatId, message);
      } catch (error) {
        this.logger.error(`查询活跃排行失败: ${error.message}`);
        this.bot.sendMessage(chatId, "❌ 查询活跃排行失败，请稍后重试");
      }
    });

    // /bind 命令 - 绑定只读地址
    this.bot.onText(/\/bind (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const address = match[1].trim();
      const user = await this.getOrCreateUser(msg.from);

      try {
        await this.walletService.bindWatchOnlyAddress(user.id, address);
        this.bot.sendMessage(
          chatId,
          `✅ 钱包绑定成功！\n\n地址: \`${address}\`\n\n你现在可以抢红包了。`,
          { parse_mode: "Markdown" },
        );
      } catch (error) {
        this.bot.sendMessage(chatId, `❌ 绑定失败: ${error.message}`);
      }
    });

    // /create 命令 - 创建新钱包
    this.bot.onText(/\/create/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      // 检查是否已有完整钱包
      if (!user.isWatchOnly) {
        this.bot.sendMessage(
          chatId,
          "❌ 你已经有一个完整钱包了\n使用 /balance 查看地址",
        );
        return;
      }

      // 私密回复，不要在群里展示助记词
      if (msg.chat.type !== "private") {
        this.bot.sendMessage(
          chatId,
          "⚠️ 为了安全起见，请在私聊中使用此命令创建钱包\n\n👉 [点击私聊我](https://t.me/" +
            this.bot.getMe().then((me) => me.username) +
            ")",
          {
            parse_mode: "Markdown",
          },
        );
        return;
      }

      try {
        const walletInfo = await this.walletService.createWallet(user.id);

        const message = `
✅ 钱包创建成功！

📍 地址: \`${walletInfo.address}\`

🔐 助记词（用于恢复钱包）:
\`${walletInfo.mnemonic}\`

⚠️ 警告：
1. 助记词是恢复钱包的唯一方式
2. 请勿截图或拍照保存
3. 建议手抄在安全的地方
4. 不要向任何人透露助记词

✨ 你现在可以发送和接收红包了！
        `;

        this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      } catch (error) {
        this.logger.error(`创建钱包失败: ${error.message}`);
        this.bot.sendMessage(chatId, `❌ 创建钱包失败: ${error.message}`);
      }
    });

    // /import 命令 - 导入钱包
    this.bot.onText(/\/import/, async (msg) => {
      const chatId = msg.chat.id;

      if (msg.chat.type !== "private") {
        this.bot.sendMessage(chatId, "⚠️ 请在私聊中导入助记词");
        return;
      }

      // 启动导入会话
      this.userSessions.set(msg.from.id, {
        step: "import_wallet",
        data: {},
      });

      this.bot.sendMessage(
        chatId,
        `🔐 导入钱包

请输入你的 12 或 24 个单词助记词，用空格分隔：

⚠️ 提示：助记词将被加密存储，请确保在安全的环境中操作。`,
      );
    });

    // /delete 命令 - 删除钱包
    this.bot.onText(/\/delete/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      if (user.isWatchOnly) {
        this.bot.sendMessage(chatId, "❌ 只读钱包无需删除，直接取消绑定即可");
        return;
      }

      // 启动删除确认会话
      this.userSessions.set(msg.from.id, {
        step: "delete_wallet_confirm",
        data: {},
      });

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ 我已备份助记词，确认删除",
                callback_data: "confirm_delete_wallet",
              },
            ],
            [{ text: "❌ 取消", callback_data: "cancel_delete_wallet" }],
          ],
        },
      };

      this.bot.sendMessage(
        chatId,
        `
🗑️ 删除钱包

⚠️ 警告：删除钱包前请确保已经备份助记词！

删除后：
• 钱包地址将从系统移除
• 您将回到只读模式
• 无法使用此钱包发送红包
• 如果未备份助记词，您将永久失去钱包权限！

请在删除前确保：
✅ 已安全备份 12/24 个单词的助记词
✅ 钱包余额已转出或确认放弃
✅ 没有待处理的交易

点击"确认删除"将无法撤销！
      `,
        keyboard,
      );
    });

    // /transfer 命令 - 普通转账
    this.bot.onText(/\/transfer/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      if (user.isWatchOnly) {
        this.bot.sendMessage(
          chatId,
          "❌ 只读钱包无法转账\n使用 /import 导入助记词解锁完整功能",
        );
        return;
      }

      // 启动转账会话
      const transferSession: SessionData = {
        step: "transfer_address",
        data: {
          chatId: chatId.toString(),
        },
      };
      this.userSessions.set(msg.from.id, transferSession);

      await this.sendAndDeleteOld(
        chatId,
        transferSession,
        `
💸 普通转账

请输入收款地址（Scash 地址）：

格式: bcrt1... 或 bc1...

💡 提示：请仔细核对地址，转账后无法撤销！
      `,
      );
    });

    // /send 命令 - 发送红包
    this.bot.onText(/\/send/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getOrCreateUser(msg.from);

      if (user.isWatchOnly) {
        this.bot.sendMessage(
          chatId,
          "❌ 只读钱包无法发送红包\n使用 /import 导入助记词解锁完整功能",
        );
        return;
      }

      // 启动发红包会话
      const session: SessionData = {
        step: "send_packet_type",
        data: {
          chatId: chatId.toString(),
          chatTitle: msg.chat.title || "Private Chat",
        },
      };
      this.userSessions.set(msg.from.id, session);

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎯 定向红包", callback_data: "packet_type:DIRECT" }],
            [{ text: "⚖️ 均分红包", callback_data: "packet_type:GROUP_EQUAL" }],
            [
              {
                text: "🎲 随机红包",
                callback_data: "packet_type:GROUP_RANDOM",
              },
            ],
            [
              {
                text: "🔥 活跃红包",
                callback_data: "packet_type:ACTIVITY_TOP",
              },
            ],
            [
              {
                text: "🎰 抽奖红包",
                callback_data: "packet_type:ACTIVITY_LOTTERY",
              },
            ],
          ],
        },
      };

      this.bot
        .sendMessage(chatId, "🧧 请选择红包类型：", keyboard)
        .then((msg) => {
          session.lastMessageId = msg.message_id;
        });
    });
  }

  private setupCallbackHandlers() {
    this.bot.on("callback_query", async (query) => {
      const chatId = query.message.chat.id;
      const userId = query.from.id;
      const data = query.data;

      // 处理红包类型选择
      if (data.startsWith("packet_type:")) {
        const type = data.split(":")[1] as RedPacketType;

        const session = this.userSessions.get(userId);
        if (session) {
          session.data.type = type;

          // 定向红包需要先选择目标用户
          if (type === RedPacketType.DIRECT) {
            session.step = "send_packet_target_users";
            await this.sendAndDeleteOld(
              chatId,
              session,
              `
🎯 请输入目标用户的 Telegram 用户名（@username）

示例: @username
              `,
            );
          } else if (type === RedPacketType.ACTIVITY_TOP) {
            // 活跃红包需要输入中奖人数
            session.step = "send_packet_topn";
            await this.sendAndDeleteOld(
              chatId,
              session,
              `
🔥 活跃红包 请输入中奖人数：

示例: 3
              `,
            );
          } else if (type === RedPacketType.ACTIVITY_LOTTERY) {
            // 抽奖红包先选择范围
            session.step = "send_packet_lottery_scope";
            const keyboard = {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "📢 全群抽奖",
                      callback_data: "lottery_scope:ALL",
                    },
                  ],
                  [
                    {
                      text: "🏆 活跃度前50",
                      callback_data: "lottery_scope:TOP50",
                    },
                  ],
                  [
                    {
                      text: "🥇 活跃度前100",
                      callback_data: "lottery_scope:TOP100",
                    },
                  ],
                ],
              },
            };
            await this.sendAndDeleteOld(
              chatId,
              session,
              "🎰 抽奖红包 请选择抽奖范围：",
              keyboard,
            );
          } else {
            // 群红包直接问金额
            session.step = "send_packet_amount";
            await this.sendAndDeleteOld(
              chatId,
              session,
              `
💰 请输入红包总金额（单位：SCASH）：

示例: 0.1
              `,
            );
          }
        }
      }

      // 处理抢红包
      if (data.startsWith("claim_packet:")) {
        const packetId = parseInt(data.split(":")[1]);
        const user = await this.getOrCreateUser(query.from);

        const result = await this.redpacketService.claimRedPacket({
          redPacketId: packetId,
          userId: user.id,
          telegramUsername: query.from.username,
        });

        if (result.success) {
          this.bot.answerCallbackQuery(query.id, {
            text: `🎉 抢到 ${result.amount} SCASH！`,
            show_alert: true,
          });

          // 更新红包消息显示已领取人数
          await this.updateRedPacketMessage(packetId, query.message);
        } else {
          this.bot.answerCallbackQuery(query.id, {
            text: result.message,
            show_alert: true,
          });
        }
      }

      // 处理删除钱包确认
      if (data === "confirm_delete_wallet") {
        const user = await this.getOrCreateUser(query.from);
        const result = await this.walletService.deleteWallet(user.id);

        if (result.success) {
          this.bot.sendMessage(
            chatId,
            `✅ ${result.message}\n\n您的钱包已安全删除。如需恢复完整功能，请使用 /import 导入助记词。`,
          );
        } else {
          this.bot.sendMessage(chatId, `❌ ${result.message}`);
        }

        // 清除会话
        this.userSessions.delete(userId);

        this.bot.answerCallbackQuery(query.id, {
          text: result.success ? "已删除" : "删除失败",
        });
      }

      // 取消删除钱包
      if (data === "cancel_delete_wallet") {
        this.userSessions.delete(userId);
        this.bot.sendMessage(chatId, "✅ 已取消删除钱包");
        this.bot.answerCallbackQuery(query.id, {
          text: "已取消",
        });
      }

      // 确认发送红包
      if (data === "confirm_send_packet") {
        const session = this.userSessions.get(userId);
        if (session && session.step === "send_packet_confirm") {
          // 删除确认消息
          if (query.message) {
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {}
          }

          const user = await this.getOrCreateUser(query.from);

          const result = await this.redpacketService.createRedPacket({
            senderId: user.id,
            type: session.data.type,
            totalAmount: session.data.amount,
            count: session.data.count,
            message: session.data.message,
            chatId: session.data.chatId,
            chatTitle: session.data.chatTitle,
            strategy: session.data.strategy,
            targetUsers: session.data.targetUsers,
            topN: session.data.topN,
            lotteryScope: session.data.lotteryScope,
          });

          if (result.success) {
            if (session.data.chatId.startsWith("-")) {
              let recipients = result.recipients;

              // 定向红包需要特殊处理，查询目标用户的 firstName
              if (
                result.redPacket.type === RedPacketType.DIRECT &&
                session.data.targetUsers?.[0]
              ) {
                const targetUser = await this.prisma.user.findUnique({
                  where: { telegramId: session.data.targetUsers[0] },
                });
                if (targetUser) {
                  recipients = [
                    {
                      telegramId: targetUser.telegramId,
                      username: targetUser.username,
                      firstName: targetUser.firstName,
                      amount: result.redPacket.totalAmount.toString(),
                    },
                  ];
                }
              }

              await this.sendRedPacketToGroup(
                result.redPacket,
                session.data.chatId,
                result.txid,
                recipients,
              );
              await this.deleteUserMessages(session.data.chatId, session);
            } else {
              this.bot.sendMessage(
                chatId,
                `✅ 红包创建成功！\n\n交易哈希: \`${result.txid}\``,
                {
                  parse_mode: "Markdown",
                },
              );
            }

            this.userSessions.delete(userId);
          } else {
            this.bot.sendMessage(chatId, `❌ 创建失败: ${result.message}`);
          }
        }
      }

      // 处理抽奖红包范围选择
      if (data.startsWith("lottery_scope:")) {
        const scope = data.split(":")[1];
        const session = this.userSessions.get(userId);

        if (session && session.step === "send_packet_lottery_scope") {
          // 删除选择消息
          if (query.message) {
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {}
          }

          // 设置范围和最大人数
          const scopeMap: Record<string, { label: string; maxN: number }> = {
            ALL: { label: "全群", maxN: 100 },
            TOP50: { label: "活跃度前50", maxN: 49 },
            TOP100: { label: "活跃度前100", maxN: 99 },
          };

          session.data.lotteryScope = scope;
          session.data.lotteryScopeLabel = scopeMap[scope].label;
          session.data.lotteryMaxN = scopeMap[scope].maxN;
          session.step = "send_packet_topn";

          await this.sendAndDeleteOld(
            chatId,
            session,
            `
🎰 抽奖红包（${scopeMap[scope].label}）

请输入中奖人数（1-${scopeMap[scope].maxN}）：
            `,
          );
        }
      }

      // 处理活跃红包分配方式选择
      if (data.startsWith("strategy:")) {
        const strategy = data.split(":")[1];
        const session = this.userSessions.get(userId);

        if (session && session.step === "send_packet_strategy") {
          // 删除选择消息
          if (query.message) {
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {}
          }

          if (strategy === "EQUAL") {
            session.data.strategy = RedPacketStrategy.EQUAL;
          } else if (strategy === "RANK") {
            session.data.strategy = RedPacketStrategy.RANK;
          } else {
            session.data.strategy = RedPacketStrategy.RANDOM;
          }

          session.step = "send_packet_message";
          await this.sendAndDeleteOld(
            chatId,
            session,
            "💬 请输入红包留言（可选）：",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "跳过", callback_data: "skip_message" }],
                ],
              },
            },
          );
        }
      }

      // 跳过留言
      if (data === "skip_message") {
        const session = this.userSessions.get(userId);
        if (session && session.step === "send_packet_message") {
          session.data.message = "恭喜发财，大吉大利！";

          // 活跃红包/抽奖红包设置 count = topN
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            session.data.count = session.data.topN;
          }

          if (
            session.data.type === RedPacketType.GROUP_EQUAL ||
            session.data.type === RedPacketType.GROUP_RANDOM ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            session.data.strategy =
              session.data.type === RedPacketType.GROUP_EQUAL
                ? RedPacketStrategy.EQUAL
                : RedPacketStrategy.RANDOM;
          }

          session.step = "send_packet_confirm";

          // 删除确认消息
          if (query.message) {
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {}
          }

          // 显示确认信息
          let confirmMessage = `
📋 请确认红包信息：

类型: ${this.getPacketTypeLabel(session.data.type)}
金额: ${session.data.amount} SCASH
`;

          // 定向红包显示目标用户
          if (
            session.data.type === RedPacketType.DIRECT &&
            session.data.targetUsers
          ) {
            const displayTarget =
              session.data.targetUsername || session.data.targetUsers[0];
            confirmMessage += `\n目标用户: @${displayTarget}`;
          }

          // 活跃红包/抽奖红包显示中奖人数和范围
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            if (session.data.topN) {
              confirmMessage += `\n中奖人数: ${session.data.topN}`;
            }
            // 抽奖红包显示范围
            if (
              session.data.type === RedPacketType.ACTIVITY_LOTTERY &&
              session.data.lotteryScopeLabel
            ) {
              confirmMessage += `\n抽奖范围: ${session.data.lotteryScopeLabel}`;
            }
          } else if (session.data.type !== RedPacketType.DIRECT) {
            // 普通群红包显示份数
            confirmMessage += `\n份数: ${session.data.count}`;
          }

          // 显示分配方式
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            let strategyLabel = "⚖️ 均分";
            if (session.data.strategy === RedPacketStrategy.RANDOM) {
              strategyLabel = "🎲 随机分配";
            } else if (session.data.strategy === RedPacketStrategy.RANK) {
              strategyLabel = "🔥 按活跃度排序";
            }
            confirmMessage += `\n分配方式: ${strategyLabel}`;
          }

          confirmMessage += `\n留言: ${session.data.message}`;

          const networkFee = 0.00001;
          const isGroupRedPacket =
            session.data.type === RedPacketType.GROUP_EQUAL ||
            session.data.type === RedPacketType.GROUP_RANDOM ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY;

          let reserveFee = 0;
          if (isGroupRedPacket) {
            reserveFee = session.data.count * 0.0023;
          }

          const totalFee = networkFee + reserveFee;
          const totalAmount = parseFloat(session.data.amount) + totalFee;

          confirmMessage += `\n\n预估手续费: ~${totalFee.toFixed(4)} SCASH`;
          confirmMessage += `\n总金额: ${totalAmount.toFixed(4)} SCASH`;

          await this.sendAndDeleteOld(chatId, session, confirmMessage, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 确认发送", callback_data: "confirm_send_packet" },
                  { text: "❌ 取消", callback_data: "cancel_send_packet" },
                ],
              ],
            },
          });
        }
      }

      // 取消发送
      if (data === "cancel_send_packet") {
        const session = this.userSessions.get(userId);
        if (session && session.data.chatId) {
          await this.deleteUserMessages(session.data.chatId, session);
        }
        this.userSessions.delete(userId);
        this.bot.sendMessage(chatId, "❌ 已取消发送红包");
      }

      // 确认转账
      if (data === "confirm_transfer") {
        const session = this.userSessions.get(userId);
        if (session && session.step === "transfer_confirm") {
          // 删除确认消息
          if (query.message) {
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {}
          }

          const user = await this.getOrCreateUser(query.from);

          // 使用 redpacketService 的 createRedPacket 方法发送转账
          // 实际上是直接转账到指定地址
          this.bot.sendMessage(chatId, "⏳ 正在处理转账...");

          // 使用 TransactionBuilderService 进行直接转账
          try {
            const buildResult = await this.transactionBuilder.buildTransaction(
              user.id,
              [
                {
                  address: session.data.recipientAddress,
                  amount: new Big(session.data.amount),
                },
              ],
            );

            if (!buildResult) {
              this.bot.sendMessage(
                chatId,
                "❌ 构建交易失败：余额不足或手续费不够",
              );
              return;
            }

            // 广播交易
            const broadcastResult =
              await this.transactionBuilder.broadcastTransaction(
                user.id,
                buildResult,
              );

            if (broadcastResult.success) {
              await this.deleteUserMessages(session.data.chatId, session);
              this.bot.sendMessage(
                chatId,
                `✅ 转账成功！\n\n收款地址: \`${session.data.recipientAddress}\`\n金额: ${session.data.amount} SCASH\n手续费: ${buildResult.fee.toFixed(8)} SCASH\n交易哈希: \`${broadcastResult.txid}\``,
                { parse_mode: "Markdown" },
              );
              this.userSessions.delete(userId);
            } else {
              this.bot.sendMessage(
                chatId,
                `❌ 转账失败: ${broadcastResult.message}`,
              );
            }
          } catch (error) {
            this.logger.error(`转账失败: ${error.message}`);
            this.bot.sendMessage(chatId, `❌ 转账失败: ${error.message}`);
          }
        }
      }

      // 取消转账
      if (data === "cancel_transfer") {
        const session = this.userSessions.get(userId);
        if (session && session.data.chatId) {
          await this.deleteUserMessages(session.data.chatId, session);
        }
        this.userSessions.delete(userId);
        this.bot.sendMessage(chatId, "❌ 已取消转账");
      }
    });
  }

  private setupMessageHandlers() {
    this.bot.on("message", async (msg) => {
      const userId = msg.from.id;
      const session = this.userSessions.get(userId);

      // 记录用户在群组的活跃度
      if (msg.chat.type !== "private" && msg.from) {
        const user = await this.getOrCreateUser(msg.from);
        await this.recordUserActivity(user.id, msg.chat.id.toString());
      }

      // 保存用户在群组中的输入消息ID，稍后批量删除
      if (msg.chat.type !== "private" && msg.message_id && session) {
        session.userMessageIds = session.userMessageIds || [];
        session.userMessageIds.push(msg.message_id);
      }

      if (!session) return;

      const text = msg.text;

      // 导入钱包 - 输入助记词
      if (session.step === "import_wallet") {
        try {
          const user = await this.getOrCreateUser(msg.from);
          const walletInfo = await this.walletService.importWalletFromMnemonic(
            user.id,
            text,
          );

          this.bot.sendMessage(
            msg.chat.id,
            `
✅ 钱包导入成功！

📍 地址: \`${walletInfo.address}\`

你现在可以发送红包了。
          `,
            { parse_mode: "Markdown" },
          );

          this.userSessions.delete(userId);
        } catch (error) {
          this.bot.sendMessage(msg.chat.id, `❌ 导入失败: ${error.message}`);
        }
        return;
      }

      // 发红包流程
      switch (session.step) {
        // 定向红包 - 输入目标用户
        case "send_packet_target_users":
          const targetUsersText = text.trim();
          if (!targetUsersText) {
            this.bot.sendMessage(msg.chat.id, "❌ 请输入目标用户用户名");
            return;
          }

          // 解析用户名
          const usernames = targetUsersText
            .split(/[,，]/)
            .map((u) => u.trim())
            .filter((u) => u.length > 0)
            .map((u) => (u.startsWith("@") ? u.substring(1) : u));

          if (usernames.length === 0) {
            this.bot.sendMessage(msg.chat.id, "❌ 请输入有效的用户名");
            return;
          }

          // 定向红包只能有一个目标用户
          if (usernames.length > 1) {
            this.bot.sendMessage(msg.chat.id, "❌ 定向红包只能发给一个用户");
            return;
          }

          // 验证目标用户是否存在于数据库
          const targetUsername = usernames[0];
          const targetUser = await this.prisma.user.findFirst({
            where: {
              OR: [{ username: targetUsername }, { firstName: targetUsername }],
            },
          });

          if (!targetUser) {
            this.bot.sendMessage(
              msg.chat.id,
              `❌ 未找到用户 @${targetUsername}\n\n请确认对方是否已使用过机器人（需要先与机器人交互过）`,
            );
            return;
          }

          session.data.targetUsers = [targetUser.telegramId];
          session.data.targetUsername = targetUsername;
          session.data.count = 1; // 定向红包固定 1 份

          // 定向红包输入金额
          session.step = "send_packet_amount";
          await this.sendAndDeleteOld(
            msg.chat.id,
            session,
            `
💰 请输入红包总金额（单位：SCASH）：

示例: 0.1
            `,
          );
          break;

        // 活跃红包/抽奖红包 - 输入中奖人数
        case "send_packet_topn":
          const topN = parseInt(text);

          // 如果是抽奖红包，验证范围
          if (session.data.lotteryScope) {
            const maxN = session.data.lotteryMaxN || 100;
            if (isNaN(topN) || topN <= 0 || topN > maxN) {
              this.bot.sendMessage(
                msg.chat.id,
                `❌ 请输入 1-${maxN} 之间的有效数字`,
              );
              return;
            }
          } else {
            if (isNaN(topN) || topN <= 0 || topN > 100) {
              this.bot.sendMessage(
                msg.chat.id,
                "❌ 请输入 1-100 之间的有效数字",
              );
              return;
            }
          }

          session.data.topN = topN;
          session.step = "send_packet_amount";
          await this.sendAndDeleteOld(
            msg.chat.id,
            session,
            `
💰 请输入红包总金额（单位：SCASH）：

示例: 0.1
            `,
          );
          break;

        case "send_packet_amount":
          const amount = parseFloat(text);
          if (isNaN(amount) || amount <= 0) {
            this.bot.sendMessage(msg.chat.id, "❌ 请输入有效的金额");
            return;
          }
          session.data.amount = text;

          // 定向红包不需要输入份数（固定1份）
          if (session.data.type === RedPacketType.DIRECT) {
            session.step = "send_packet_message";
            await this.sendAndDeleteOld(
              msg.chat.id,
              session,
              "💬 请输入红包留言（可选）：",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "跳过", callback_data: "skip_message" }],
                  ],
                },
              },
            );
          } else if (session.data.type === RedPacketType.ACTIVITY_TOP) {
            // 活跃红包：选择分配方式
            session.step = "send_packet_strategy";
            const keyboard = {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⚖️ 均分",
                      callback_data: "strategy:EQUAL",
                    },
                  ],
                  [
                    {
                      text: "🔥 按活跃度排序",
                      callback_data: "strategy:RANK",
                    },
                  ],
                ],
              },
            };
            await this.sendAndDeleteOld(
              msg.chat.id,
              session,
              "💡 请选择分配方式：",
              keyboard,
            );
          } else if (session.data.type === RedPacketType.ACTIVITY_LOTTERY) {
            // 抽奖红包：根据人数和范围决定
            if (session.data.topN && session.data.topN > 1) {
              // 多人：选择分配方式
              session.step = "send_packet_strategy";

              // 全群抽奖不能选按活跃度排序（因为是随机抽取，不是按活跃度）
              const isAllScope = session.data.lotteryScope === "ALL";

              const keyboard = {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "⚖️ 均分",
                        callback_data: "strategy:EQUAL",
                      },
                    ],
                    [
                      {
                        text: "🎲 随机分配",
                        callback_data: "strategy:RANDOM",
                      },
                    ],
                    ...(isAllScope
                      ? []
                      : [
                          [
                            {
                              text: "🔥 按活跃度排序",
                              callback_data: "strategy:RANK",
                            },
                          ],
                        ]),
                  ],
                },
              };
              await this.sendAndDeleteOld(
                msg.chat.id,
                session,
                "💡 请选择分配方式：",
                keyboard,
              );
            } else {
              // 只有1人，直接设置默认分配方式
              session.data.strategy = RedPacketStrategy.EQUAL;
              session.step = "send_packet_message";
              await this.sendAndDeleteOld(
                msg.chat.id,
                session,
                "💬 请输入红包留言（可选）：",
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "跳过", callback_data: "skip_message" }],
                    ],
                  },
                },
              );
            }
          } else {
            session.step = "send_packet_count";
            await this.sendAndDeleteOld(
              msg.chat.id,
              session,
              "📦 请输入红包份数：",
            );
          }
          break;

        case "send_packet_count":
          const count = parseInt(text);
          if (isNaN(count) || count <= 0 || count > 100) {
            this.bot.sendMessage(msg.chat.id, "❌ 请输入 1-100 之间的份数");
            return;
          }
          session.data.count = count;
          session.step = "send_packet_message";
          await this.sendAndDeleteOld(
            msg.chat.id,
            session,
            "💬 请输入红包留言（可选）：",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "跳过", callback_data: "skip_message" }],
                ],
              },
            },
          );
          break;

        case "send_packet_message":
          session.data.message = text || "恭喜发财，大吉大利！";

          // 活跃红包/抽奖红包设置 count = topN
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            session.data.count = session.data.topN;
          }

          // 根据类型处理不同逻辑
          if (
            session.data.type === RedPacketType.GROUP_EQUAL ||
            session.data.type === RedPacketType.GROUP_RANDOM ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            session.data.strategy =
              session.data.type === RedPacketType.GROUP_EQUAL
                ? RedPacketStrategy.EQUAL
                : RedPacketStrategy.RANDOM;
          }

          session.step = "send_packet_confirm";

          // 显示确认信息
          let confirmMessage = `
📋 请确认红包信息：

类型: ${this.getPacketTypeLabel(session.data.type)}
金额: ${session.data.amount} SCASH
`;

          // 定向红包显示目标用户
          if (
            session.data.type === RedPacketType.DIRECT &&
            session.data.targetUsers
          ) {
            const displayTarget =
              session.data.targetUsername || session.data.targetUsers[0];
            confirmMessage += `\n目标用户: @${displayTarget}`;
          }

          // 活跃红包/抽奖红包显示中奖人数和范围
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            if (session.data.topN) {
              confirmMessage += `\n中奖人数: ${session.data.topN}`;
            }
            // 抽奖红包显示范围
            if (
              session.data.type === RedPacketType.ACTIVITY_LOTTERY &&
              session.data.lotteryScopeLabel
            ) {
              confirmMessage += `\n抽奖范围: ${session.data.lotteryScopeLabel}`;
            }
          } else if (session.data.type === RedPacketType.DIRECT) {
            // 定向红包不需要显示份数
          } else {
            // 普通群红包显示份数
            confirmMessage += `\n份数: ${session.data.count}`;
          }

          // 显示分配方式
          if (
            session.data.type === RedPacketType.ACTIVITY_TOP ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY
          ) {
            let strategyLabel = "⚖️ 均分";
            if (session.data.strategy === RedPacketStrategy.RANDOM) {
              strategyLabel = "🎲 随机分配";
            } else if (session.data.strategy === RedPacketStrategy.RANK) {
              strategyLabel = "🔥 按活跃度排序";
            }
            confirmMessage += `\n分配方式: ${strategyLabel}`;
          }

          confirmMessage += `\n留言: ${session.data.message}`;

          // 计算预估手续费
          const networkFee = 0.00001; // 网络手续费
          const isGroupRedPacket =
            session.data.type === RedPacketType.GROUP_EQUAL ||
            session.data.type === RedPacketType.GROUP_RANDOM ||
            session.data.type === RedPacketType.ACTIVITY_LOTTERY;

          let reserveFee = 0; // 统筹账户手续费储备

          if (isGroupRedPacket) {
            reserveFee = session.data.count * 0.0023;
          }

          const totalFee = networkFee + reserveFee;
          const totalAmount = parseFloat(session.data.amount) + totalFee;

          confirmMessage += `\n\n预估手续费: ~${totalFee.toFixed(4)} SCASH`;
          confirmMessage += `\n总金额: ${totalAmount.toFixed(4)} SCASH`;

          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 确认发送", callback_data: "confirm_send_packet" },
                  { text: "❌ 取消", callback_data: "cancel_send_packet" },
                ],
              ],
            },
          };

          await this.sendAndDeleteOld(msg.chat.id, session, confirmMessage, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 确认发送", callback_data: "confirm_send_packet" },
                  { text: "❌ 取消", callback_data: "cancel_send_packet" },
                ],
              ],
            },
          });
          break;

        // 普通转账流程
        case "transfer_address":
          // 验证地址格式
          const address = text.trim();
          try {
            // 简单的地址格式验证（bcrt1... 开头）
            if (!address.match(/^bcrt1[a-z0-9]{39,59}$/)) {
              this.bot.sendMessage(
                msg.chat.id,
                "❌ 无效的 Scash 地址格式\n\n地址应以 bcrt1 开头",
              );
              return;
            }
            session.data.recipientAddress = address;
            session.step = "transfer_amount";
            await this.sendAndDeleteOld(
              msg.chat.id,
              session,
              `
📤 转账到: \`${address}\`

请输入转账金额（单位：SCASH）：

示例: 0.1
            `,
              { parse_mode: "Markdown" },
            );
          } catch (error) {
            this.bot.sendMessage(
              msg.chat.id,
              "❌ 地址验证失败，请检查地址格式",
            );
          }
          break;

        case "transfer_amount":
          const transferAmount = parseFloat(text);
          if (isNaN(transferAmount) || transferAmount <= 0) {
            this.bot.sendMessage(msg.chat.id, "❌ 请输入有效的金额");
            return;
          }
          session.data.amount = text;
          session.step = "transfer_confirm";

          const transferConfirmMsg = `
📋 请确认转账信息：

收款地址: \`${session.data.recipientAddress}\`
转账金额: ${transferAmount} SCASH
预估手续费: ~0.00001 SCASH

⚠️ 警告：转账后无法撤销，请仔细核对地址！
          `;

          await this.sendAndDeleteOld(
            msg.chat.id,
            session,
            transferConfirmMsg,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ 确认转账", callback_data: "confirm_transfer" },
                    { text: "❌ 取消", callback_data: "cancel_transfer" },
                  ],
                ],
              },
            },
          );
          break;
      }
    });
  }

  private async getOrCreateUser(telegramUser: TelegramBot.User): Promise<any> {
    // 先尝试通过 telegramId 查找
    let user = await this.prisma.user.findUnique({
      where: { telegramId: telegramUser.id.toString() },
    });

    if (!user) {
      // 如果没找到，检查是否有该用户的临时记录需要更新
      // 通过 username 或 firstName 查找临时用户
      if (telegramUser.username) {
        // 先尝试通过 username 精确匹配临时用户
        const tempUser = await this.prisma.user.findFirst({
          where: {
            username: telegramUser.username,
            telegramId: {
              startsWith: "temp_",
            },
          },
        });

        if (tempUser) {
          user = await this.prisma.user.update({
            where: { id: tempUser.id },
            data: {
              telegramId: telegramUser.id.toString(),
              firstName: telegramUser.first_name,
              lastName: telegramUser.last_name,
              isWatchOnly: false,
            },
          });
        }
      }

      // 如果仍然没有用户，创建新用户
      if (!user) {
        user = await this.prisma.user.create({
          data: {
            telegramId: telegramUser.id.toString(),
            username: telegramUser.username,
            firstName: telegramUser.first_name,
            lastName: telegramUser.last_name,
          },
        });
      }
    }

    return user;
  }

  private async sendRedPacketToGroup(
    redPacket: any,
    chatId: string,
    txid?: string,
    recipients?: {
      telegramId: string;
      username?: string | null;
      firstName?: string | null;
      amount?: string;
    }[],
  ) {
    const typeLabels = {
      [RedPacketType.DIRECT]: "🎯 定向红包",
      [RedPacketType.GROUP_EQUAL]: "⚖️ 均分红包",
      [RedPacketType.GROUP_RANDOM]: "🎲 随机红包",
      [RedPacketType.ACTIVITY_TOP]: "🔥 活跃红包",
      [RedPacketType.ACTIVITY_LOTTERY]: "🎰 抽奖红包",
    };

    const strategyLabels = {
      [RedPacketStrategy.EQUAL]: "⚖️ 均分",
      [RedPacketStrategy.RANDOM]: "🎲 随机",
      [RedPacketStrategy.RANK]: "🔥 按活跃度排序",
    };

    let message: string;
    let options: TelegramBot.SendMessageOptions = {};

    const sender = (redPacket as any).sender;
    const senderInfo = sender?.username
      ? `@${sender.username}`
      : sender?.telegramId
        ? sender.telegramId
        : "未知";

    // 活跃红包/抽奖红包：直接显示获得者和金额，不需要抢
    if (
      redPacket.type === RedPacketType.ACTIVITY_TOP ||
      redPacket.type === RedPacketType.ACTIVITY_LOTTERY
    ) {
      let recipientsText = "";
      if (recipients && recipients.length > 0) {
        recipientsText = "\n🎉 获得者：\n";
        recipients.forEach((r, index) => {
          const displayName = r.username
            ? `@${r.username}`
            : (r as any).firstName || `用户${r.telegramId.slice(-4)}`;
          const statusText =
            (r as any).status === "待绑定" ? " (待绑定地址)" : "";
          recipientsText += `${index + 1}. ${displayName}: ${r.amount} SCASH${statusText}\n`;
        });
      }

      message = `
🧧 ${typeLabels[redPacket.type] || "红包"}

👤 发红包: ${senderInfo}
💰 总金额: ${redPacket.totalAmount} SCASH
👥 中奖人数: ${redPacket.count}
📊 分配方式: ${strategyLabels[redPacket.strategy] || "⚖️ 均分"}
💬 ${redPacket.message}
${txid ? `\n🔗 交易: \`${txid}\`` : ""}
${recipientsText}
      `;
    } else if (redPacket.type === RedPacketType.DIRECT) {
      const targetUsers = redPacket.targetUsers
        ? JSON.parse(redPacket.targetUsers)
        : [];
      let targetDisplay = targetUsers[0] || "未知";
      if (recipients && recipients[0]) {
        targetDisplay =
          recipients[0].firstName ||
          `@${recipients[0].username || targetUsers[0]}`;
      }
      message = `
🎯 定向红包

👤 发红包: ${senderInfo}
💰 金额: ${redPacket.totalAmount} SCASH
👤 接收: ${targetDisplay}
💬 ${redPacket.message}
${txid ? `\n🔗 交易: \`${txid}\`` : ""}
      `;
    } else {
      message = `
🧧 ${typeLabels[redPacket.type] || "红包"}

👤 发红包: ${senderInfo}
💰 总金额: ${redPacket.totalAmount} SCASH
📦 份数: ${redPacket.count}
💬 ${redPacket.message}
${txid ? `\n🔗 交易: \`${txid}\`` : ""}

⬇️ 点击下方按钮抢红包！
      `;

      options = {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎁 抢红包",
                callback_data: `claim_packet:${redPacket.id}`,
              },
            ],
          ],
        },
      };
    }

    await this.bot.sendMessage(chatId, message, options);
  }

  private async updateRedPacketMessage(
    packetId: number,
    message: TelegramBot.Message,
  ) {
    const details = await this.redpacketService.getRedPacketDetails(packetId);

    if (!details.redPacket) return;

    const remainingCount = details.redPacket.remainingCount;
    const totalCount = details.redPacket.count;
    const claimedCount = totalCount - remainingCount;
    const typeLabels = {
      DIRECT: "🎯 定向红包",
      GROUP_EQUAL: "⚖️ 均分红包",
      GROUP_RANDOM: "🎲 随机红包",
      ACTIVITY_TOP: "🔥 活跃红包",
      ACTIVITY_LOTTERY: "🎰 抽奖红包",
    };

    const sender = details.redPacket.sender;
    const senderInfo = sender?.username
      ? `@${sender.username}`
      : sender?.telegramId
        ? sender.telegramId
        : "未知";

    let messageText = `
🧧 ${typeLabels[details.redPacket.type] || "红包"}

👤 发红包: ${senderInfo}
💰 总金额: ${details.redPacket.totalAmount} SCASH
📦 份数: ${totalCount}
💬 ${details.redPacket.message}
    `;

    if (details.claims.length > 0) {
      const claimedList = details.claims
        .slice(0, 10)
        .map(
          (c) =>
            `• @${c.user.username || c.user.telegramId}: ${c.amount} SCASH`,
        )
        .join("\n");

      messageText += `\n`;
      messageText += `\n✅ 已抢到 (${claimedCount}/${totalCount}):\n${claimedList}`;

      if (details.claims.length > 10) {
        messageText += `\n... 还有 ${details.claims.length - 10} 人`;
      }
    }

    if (remainingCount > 0) {
      messageText += `\n\n⬇️ 点击下方按钮抢红包！`;
    }

    const keyboard: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text:
              remainingCount > 0
                ? `🎁 抢红包 (${claimedCount}/${totalCount})`
                : `🎁 已抢完 (${claimedCount}/${totalCount})`,
            callback_data: `claim_packet:${packetId}`,
          },
        ],
      ],
    };

    try {
      await this.bot.editMessageText(messageText, {
        chat_id: message.chat.id,
        message_id: message.message_id,
        parse_mode: "Markdown",
      });
      await this.bot.editMessageReplyMarkup(keyboard, {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
    } catch (error) {
      // 忽略编辑失败
    }
  }

  private async sendAndDeleteOld(
    chatId: number | string,
    session: SessionData,
    message: string,
    options?: TelegramBot.SendMessageOptions,
  ): Promise<number> {
    if (session.lastMessageId && chatId.toString().startsWith("-")) {
      try {
        await this.bot.deleteMessage(chatId, session.lastMessageId);
      } catch (e) {}
    }
    const msg = await this.bot.sendMessage(chatId, message, options);
    session.lastMessageId = msg.message_id;
    return msg.message_id;
  }

  private async deleteUserMessages(chatId: string, session: SessionData) {
    if (!session.userMessageIds || !chatId.startsWith("-")) return;
    for (const msgId of session.userMessageIds) {
      try {
        await this.bot.deleteMessage(chatId, msgId);
      } catch (e) {}
    }
  }

  private async recordUserActivity(userId: number, chatId: string) {
    try {
      await this.prisma.userActivityRecord.create({
        data: {
          userId,
          chatId,
        },
      });
    } catch (error) {
      this.logger.error(`记录用户活跃度失败: ${error.message}`);
    }
  }

  private getPacketTypeLabel(type: RedPacketType): string {
    const labels = {
      [RedPacketType.DIRECT]: "定向红包",
      [RedPacketType.GROUP_EQUAL]: "均分红包",
      [RedPacketType.GROUP_RANDOM]: "随机红包",
      [RedPacketType.ACTIVITY_TOP]: "活跃红包",
      [RedPacketType.ACTIVITY_LOTTERY]: "抽奖红包",
    };
    return labels[type] || type;
  }
}
