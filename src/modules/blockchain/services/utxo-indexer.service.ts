import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScashRpcService } from "./scash-rpc.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ScashNetwork } from "../../../shared/constants/network.constants";

interface RpcTxOut {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    hex: string;
    address?: string;
    type: string;
  };
}

interface RpcVin {
  txid: string;
  vout: number;
  scriptSig?: {
    asm: string;
    hex: string;
  };
  txinwitness?: string[];
  sequence: number;
}

interface RpcVout extends RpcTxOut {}

interface RpcTransaction {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: RpcVin[];
  vout: RpcVout[];
  hex: string;
}

interface RpcBlock {
  hash: string;
  confirmations: number;
  size: number;
  strippedsize: number;
  weight: number;
  height: number;
  version: number;
  versionHex: string;
  merkleroot: string;
  tx: RpcTransaction[];
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  nTx: number;
  previousblockhash: string;
}

@Injectable()
export class UtxoIndexerService implements OnModuleInit {
  private readonly logger = new Logger(UtxoIndexerService.name);
  private isSyncing = false;
  private readonly MAX_CONCURRENT_INSERTS = 100;

  constructor(
    private rpcService: ScashRpcService,
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  /**
   * 获取统筹账户地址
   * 优先从环境变量读取，其次从数据库读取
   */
  private async getPoolingAccountAddress(): Promise<string | null> {
    const envAddress = this.configService.get<string>(
      "POOLING_ACCOUNT_ADDRESS",
    );
    if (envAddress) {
      return envAddress;
    }
    const config = await this.prisma.systemConfig.findUnique({
      where: { key: "POOLING_ACCOUNT_ADDRESS" },
    });
    return config?.value || null;
  }

  async onModuleInit() {
    this.logger.log("UTXO Indexer service initialized");
    // 启动时执行一次同步
    await this.syncBlocks();
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async handleCron() {
    if (this.isSyncing) {
      return;
    }
    await this.syncBlocks();
  }

  async syncBlocks(): Promise<void> {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    this.logger.log("Starting block synchronization...");

    try {
      const currentHeight = await this.rpcService.getBlockCount();
      let syncState = await this.prisma.blockSync.findFirst();

      if (!syncState) {
        // 首次同步，从区块 0 开始
        this.logger.log("首次同步，从区块 0 开始...");
        const genesisHash = await this.rpcService.getBlockHash(0);
        syncState = await this.prisma.blockSync.create({
          data: {
            lastBlockHeight: 0,
            lastBlockHash: genesisHash,
          },
        });
        this.logger.log(`Initialized sync state at block 0`);
      }

      const lastSyncedHeight = syncState.lastBlockHeight;

      if (lastSyncedHeight >= currentHeight) {
        this.logger.debug("Already up to date");
        return;
      }

      this.logger.log(
        `Syncing from block ${lastSyncedHeight + 1} to ${currentHeight}`,
      );

      // 批量同步区块
      for (
        let height = lastSyncedHeight + 1;
        height <= currentHeight;
        height++
      ) {
        await this.processBlock(height);

        // 更新同步状态
        const blockHash = await this.rpcService.getBlockHash(height);
        await this.prisma.blockSync.update({
          where: { id: syncState.id },
          data: {
            lastBlockHeight: height,
            lastBlockHash: blockHash,
          },
        });

        if (height % 100 === 0) {
          this.logger.log(`Synced block ${height}/${currentHeight}`);
        }
      }

      this.logger.log(
        `Block synchronization completed. Current height: ${currentHeight}`,
      );
    } catch (error) {
      this.logger.error(
        `Block synchronization failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isSyncing = false;
    }
  }

  private async processBlock(height: number): Promise<void> {
    const blockHash = await this.rpcService.getBlockHash(height);
    const block: RpcBlock = await this.rpcService.getBlock(blockHash, 2);

    let utxoCount = 0;
    for (const tx of block.tx) {
      const created = await this.processTransaction(tx, block.height);
      utxoCount += created;
    }

    if (utxoCount > 0) {
      this.logger.debug(
        `Block ${height}: 处理了 ${block.tx.length} 笔交易, 创建了 ${utxoCount} 个 UTXO`,
      );
    }
  }

  private async processTransaction(
    tx: RpcTransaction,
    blockHeight: number,
  ): Promise<number> {
    const txid = tx.txid;
    let createdCount = 0;

    // 检测是否是 coinbase 交易（挖矿获得）
    const isCoinbase =
      tx.vin && tx.vin.length > 0 && !!(tx.vin[0] as any).coinbase;

    // 处理输入（标记已花费的 UTXO）
    for (const input of tx.vin) {
      if (input.txid && input.vout !== undefined) {
        await this.prisma.utxo.updateMany({
          where: {
            txid: input.txid,
            vout: input.vout,
          },
          data: {
            isSpent: true,
            spentByTxid: txid,
            updatedAt: new Date(),
          },
        });
      }
    }

    // 处理输出（新增 UTXO）- 全链索引，不过滤地址
    for (let i = 0; i < tx.vout.length; i++) {
      const output = tx.vout[i];

      // 调试：记录输出信息
      if (blockHeight <= 5) {
        this.logger.debug(
          `Tx ${txid} output ${i}: address=${output.scriptPubKey?.address}, type=${output.scriptPubKey?.type}, isCoinbase=${isCoinbase}`,
        );
      }

      if (!output.scriptPubKey.address) {
        continue;
      }

      const address = output.scriptPubKey.address;

      // 检查该地址是否已绑定钱包
      const wallet = await this.prisma.wallet.findUnique({
        where: { address },
      });

      // 检查该 UTXO 是否已存在
      const existingUtxo = await this.prisma.utxo.findUnique({
        where: {
          txid_vout: {
            txid,
            vout: output.n,
          },
        },
      });

      if (!existingUtxo) {
        await this.prisma.utxo.create({
          data: {
            txid,
            vout: output.n,
            address,
            scriptPubKey: output.scriptPubKey.hex,
            amount: output.value,
            blockHeight, // 记录区块高度
            isSpent: false,
            isUnconfirmed: false,
            isCoinbase, // 标记是否是 coinbase
            walletId: wallet?.id || null,
          },
        });
        createdCount++;
      } else if (existingUtxo.isUnconfirmed) {
        // 如果是之前预存的内存池 UTXO，更新为已确认
        await this.prisma.utxo.update({
          where: { id: existingUtxo.id },
          data: {
            isUnconfirmed: false,
            blockHeight, // 记录区块高度
            isCoinbase, // 更新 coinbase 标记
            updatedAt: new Date(),
          },
        });
      }
    }

    return createdCount;
  }

  // 内存池监控 - 预判找零 UTXO
  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitorMempool(): Promise<void> {
    try {
      const mempoolTxids = await this.rpcService.getRawMempool();

      for (const txid of mempoolTxids.slice(0, 100)) {
        // 限制每次处理数量
        // 检查该交易是否已处理过
        const existingCount = await this.prisma.utxo.count({
          where: { txid },
        });

        if (existingCount > 0) {
          continue;
        }

        const tx = await this.rpcService.getRawTransaction(txid, true);

        if (!tx || !tx.vout) {
          continue;
        }

        await this.processMempoolTransaction(tx);
      }
    } catch (error) {
      this.logger.error(`Mempool monitoring error: ${error.message}`);
    }
  }

  private async processMempoolTransaction(tx: any): Promise<void> {
    const txid = tx.txid;

    for (let i = 0; i < tx.vout.length; i++) {
      const output = tx.vout[i];

      if (!output.scriptPubKey || !output.scriptPubKey.address) {
        continue;
      }

      const address = output.scriptPubKey.address;

      // 检查该地址是否已绑定钱包
      const wallet = await this.prisma.wallet.findUnique({
        where: { address },
      });

      // 预存为未确认的 UTXO
      await this.prisma.utxo.create({
        data: {
          txid,
          vout: output.n,
          address,
          scriptPubKey: output.scriptPubKey.hex,
          amount: output.value,
          blockHeight: 0,
          isSpent: false,
          isUnconfirmed: true, // 标记为未确认（内存池中）
          walletId: wallet?.id || null,
        },
      });

      this.logger.log(
        `Pre-stored mempool UTXO: ${txid}:${output.n} for address ${address}`,
      );
    }
  }

  // 手动触发同步（用于管理接口）
  async forceSync(): Promise<{ success: boolean; message: string }> {
    try {
      // 重置同步状态到最新区块
      const currentHeight = await this.rpcService.getBlockCount();
      let syncState = await this.prisma.blockSync.findFirst();

      if (!syncState) {
        syncState = await this.prisma.blockSync.create({
          data: {
            lastBlockHeight: currentHeight,
            lastBlockHash: await this.rpcService.getBlockHash(currentHeight),
          },
        });
      } else {
        // 重新扫描最近100个区块以获取新地址的UTXO
        const scanFromHeight = Math.max(0, currentHeight - 100);
        await this.prisma.blockSync.update({
          where: { id: syncState.id },
          data: {
            lastBlockHeight: scanFromHeight,
            lastBlockHash: await this.rpcService.getBlockHash(scanFromHeight),
          },
        });
      }

      await this.syncBlocks();
      return { success: true, message: "Synchronization completed" };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  // 回滚到指定高度（处理链重组）
  async rollbackToHeight(height: number): Promise<void> {
    this.logger.warn(`Rolling back to block height ${height}`);

    // 删除高于该高度的所有 UTXO（未确认的保留）
    await this.prisma.utxo.deleteMany({
      where: {
        isUnconfirmed: false,
        createdAt: {
          // 这里简化处理，实际应该根据区块时间精确删除
          gt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    });

    // 更新同步状态
    const syncState = await this.prisma.blockSync.findFirst();
    if (syncState) {
      const blockHash = await this.rpcService.getBlockHash(height);
      await this.prisma.blockSync.update({
        where: { id: syncState.id },
        data: {
          lastBlockHeight: height,
          lastBlockHash: blockHash,
        },
      });
    }
  }
}
