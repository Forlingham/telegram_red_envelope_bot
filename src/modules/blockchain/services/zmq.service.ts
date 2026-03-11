import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { ScashRpcService } from "./scash-rpc.service";
import { UtxoIndexerService } from "./utxo-indexer.service";

@Injectable()
export class ZmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZmqService.name);
  private zmq: any;
  private isRunning = false;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private rpcService: ScashRpcService,
    private utxoIndexerService: UtxoIndexerService,
  ) {}

  async onModuleInit() {
    await this.startListening();
  }

  async onModuleDestroy() {
    await this.stopListening();
  }

  private async startListening() {
    try {
      const zmq = await import("zeromq");

      const blockUrl = this.configService.get<string>("ZMQ_BLOCK_URL");
      const txUrl = this.configService.get<string>("ZMQ_TX_URL");

      if (!blockUrl || !txUrl) {
        this.logger.warn("ZMQ 配置未设置，跳过 ZMQ 监听");
        return;
      }

      this.zmq = zmq;
      this.isRunning = true;

      // 监听新区块
      const blockSocket = new zmq.Subscriber();
      await blockSocket.connect(blockUrl);
      blockSocket.subscribe("rawblock");
      this.logger.log(`已连接到区块 ZMQ: ${blockUrl}`);

      // 监听新交易
      const txSocket = new zmq.Subscriber();
      await txSocket.connect(txUrl);
      txSocket.subscribe("rawtx");
      this.logger.log(`已连接到交易 ZMQ: ${txUrl}`);

      // 处理新区块消息
      (async () => {
        for await (const [topic, msg] of blockSocket) {
          if (!this.isRunning) break;
          try {
            await this.handleNewBlock(msg);
          } catch (error) {
            this.logger.error(`处理新区块失败: ${error.message}`);
          }
        }
      })();

      // 处理新交易消息
      (async () => {
        for await (const [topic, msg] of txSocket) {
          if (!this.isRunning) break;
          try {
            await this.handleNewTransaction(msg);
          } catch (error) {
            this.logger.error(`处理新交易失败: ${error.message}`);
          }
        }
      })();

      this.logger.log("ZMQ 监听已启动");
    } catch (error) {
      this.logger.error(`启动 ZMQ 监听失败: ${error.message}`);
    }
  }

  private async stopListening() {
    this.isRunning = false;
    if (this.zmq) {
      this.logger.log("ZMQ 监听已停止");
    }
  }

  /**
   * 处理新区块
   */
  private async handleNewBlock(msg: Buffer) {
    this.logger.debug("收到新区块通知，触发 UTXO 同步");

    // 触发 UTXO 索引器同步新区块
    try {
      await this.utxoIndexerService.syncBlocks();
    } catch (error) {
      this.logger.error(`同步新区块失败: ${error.message}`);
    }
  }

  /**
   * 处理新交易
   */
  private async handleNewTransaction(msg: Buffer) {
    try {
      // 解析交易 hex
      const txHex = msg.toString("hex");

      // 从 hex 计算 txid（简单处理：直接从 hex 解析或使用 RPC）
      // 这里先存储 hex，之后再获取详情
      let txid: string;
      let size = 0;
      let fee = 0;

      try {
        // 尝试通过 RPC 获取交易信息
        // 由于 ZMQ 提供的是 hex，我们需要用其他方式获取 txid
        // 可以使用 Bitcoin 库的.Transaction.fromHex 来解析
        const bitcoin = await import("bitcoinjs-lib");
        const tx = bitcoin.Transaction.fromHex(txHex);
        txid = tx.getId();
        size = txHex.length / 2; // hex to bytes
        fee = 0; // 暂时不计算手续费
      } catch (e) {
        // 如果解析失败，使用 hex 的前 64 字符作为临时 txid
        this.logger.warn(`无法解析交易 hex: ${e.message}`);
        txid = txHex.substring(0, 64);
      }

      // 存储到数据库
      await this.prisma.mempoolTransaction.upsert({
        where: { txid },
        create: {
          txid,
          hex: txHex,
          fee,
          size,
          time: new Date(),
        },
        update: {
          hex: txHex,
          fee,
          size,
          time: new Date(),
          receivedAt: new Date(),
        },
      });

      this.logger.debug(`已同步内存池交易: ${txid}, fee: ${fee}`);
    } catch (error) {
      this.logger.error(`处理新交易失败: ${error.message}`);
    }
  }

  /**
   * 获取内存池交易
   */
  async getMempoolTransactions(): Promise<any[]> {
    return this.prisma.mempoolTransaction.findMany({
      orderBy: { receivedAt: "desc" },
    });
  }
}
