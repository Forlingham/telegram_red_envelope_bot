import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { Utxo } from "@prisma/client";
import Big from "big.js";

interface UtxoSelectionResult {
  utxos: Utxo[];
  totalAmount: Big;
  changeAmount: Big;
}

interface UtxoWithConfirmations extends Utxo {
  confirmations: number;
}

@Injectable()
export class UtxoService {
  constructor(
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

  // 获取当前区块高度
  private async getCurrentBlockHeight(): Promise<number> {
    const syncState = await this.prisma.blockSync.findFirst();
    return syncState?.lastBlockHeight || 0;
  }

  // 计算确认数
  private calculateConfirmations(
    blockHeight: number,
    currentHeight: number,
  ): number {
    if (blockHeight === 0) return 0; // 未确认（内存池中）
    return currentHeight - blockHeight + 1;
  }

  // 获取地址余额
  async getBalance(
    address: string,
    includeUnconfirmed: boolean = false,
  ): Promise<Big> {
    const utxos = await this.getUtxos(address, includeUnconfirmed);

    // 如果包含未确认，也查询内存池中的 UTXO
    let mempoolAmount = new Big(0);
    if (includeUnconfirmed) {
      mempoolAmount = await this.getMempoolBalance(address);
    }

    const confirmedBalance = utxos.reduce((sum, utxo) => {
      return sum.plus(utxo.amount.toString());
    }, new Big(0));

    return confirmedBalance.plus(mempoolAmount);
  }

  // 获取内存池中某地址的余额
  private async getMempoolBalance(address: string): Promise<Big> {
    try {
      const mempoolTxs = await this.prisma.mempoolTransaction.findMany();
      let balance = new Big(0);

      for (const tx of mempoolTxs) {
        // 从 RPC 获取交易详情来解析输出
        try {
          const txDetail = await (this as any).rpcService?.getRawTransaction(
            tx.txid,
          );
          if (txDetail) {
            for (const vout of txDetail.vout) {
              if (vout.scriptPubKey?.address === address) {
                balance = balance.plus(vout.value);
              }
            }
          }
        } catch (e) {
          // 忽略错误
        }
      }

      return balance;
    } catch (error) {
      return new Big(0);
    }
  }

  // 获取地址的所有 UTXO
  async getUtxos(
    address: string,
    includeUnconfirmed: boolean = false,
    minConfirmations: number = 0,
  ): Promise<UtxoWithConfirmations[]> {
    const currentHeight = await this.getCurrentBlockHeight();

    const whereClause: any = {
      address,
      isSpent: false,
    };

    if (!includeUnconfirmed) {
      whereClause.isUnconfirmed = false;
    }

    // 如果需要最小确认数，通过区块高度过滤
    // 注意：当 minConfirmations = 0 时，不过滤，返回所有 UTXO（包括已确认的）
    if (minConfirmations > 0 && currentHeight > 0) {
      // blockHeight <= currentHeight - minConfirmations + 1
      whereClause.blockHeight = {
        lte: currentHeight - minConfirmations + 1,
        gt: 0, // 排除内存池中的 UTXO
      };
    }

    console.log(`[getUtxos] whereClause:`, JSON.stringify(whereClause));

    const utxos = await this.prisma.utxo.findMany({
      where: whereClause,
      orderBy: {
        amount: "asc", // 优先使用小额 UTXO
      },
    });

    console.log(`[getUtxos] found ${utxos.length} UTXOs`);

    // 添加计算后的确认数
    return utxos.map((utxo) => ({
      ...utxo,
      confirmations: this.calculateConfirmations(
        utxo.blockHeight,
        currentHeight,
      ),
    }));
  }

  // UTXO 选择算法 - 最小足够策略
  async selectUtxos(
    address: string,
    targetAmount: Big,
    feeRate: number = 1, // sat/byte
    includeUnconfirmed: boolean = true,
    minConfirmations: number = 100, // 默认需要100个确认（coinbase成熟需要）
  ): Promise<UtxoSelectionResult | null> {
    let utxos = await this.getUtxos(
      address,
      includeUnconfirmed,
      minConfirmations,
    );

    console.log(`[selectUtxos] getUtxos returned ${utxos.length} UTXOs`);
    for (const u of utxos) {
      console.log(
        `[selectUtxos] UTXO from getUtxos: ${u.txid}:${u.vout}, amount=${u.amount}, blockHeight=${u.blockHeight}, confirmations=${(u as any).confirmations}`,
      );
    }

    // 根据 minConfirmations 过滤 UTXO
    // 内存池 UTXO (blockHeight = 0) 可以直接使用
    // coinbase UTXO 需要 100 个确认才能使用
    // 非 coinbase UTXO 只需要 1 个确认即可使用
    if (minConfirmations > 0) {
      utxos = utxos.filter((utxo) => {
        // 内存池 UTXO (blockHeight = 0) 可以直接使用
        if (utxo.blockHeight === 0) {
          return true;
        }

        const confirmations = (utxo as any).confirmations || 0;

        // coinbase UTXO 需要 100 个确认
        if ((utxo as any).isCoinbase) {
          return confirmations >= 100;
        }

        // 非 coinbase UTXO 只需要 minConfirmations 确认（默认1个）
        return confirmations >= minConfirmations;
      });
    }

    console.log(
      `[selectUtxos] address=${address}, targetAmount=${targetAmount.toString()}, minConfirmations=${minConfirmations}, utxoCount=${utxos.length}`,
    );
    for (const u of utxos) {
      console.log(
        `[selectUtxos] UTXO: ${u.txid}:${u.vout}, amount=${u.amount}, confirmations=${(u as any).confirmations}`,
      );
    }

    if (utxos.length === 0) {
      return null;
    }

    // 计算目标金额 + 预估手续费
    // 预估输入: 148 bytes/输入 (P2WPKH)
    // 预估输出: 31 bytes/输出 (P2WPKH)
    // 固定开销: 11 bytes
    const estimatedSize = 11 + utxos.length * 148 + 2 * 31;
    const estimatedFee = new Big(estimatedSize * feeRate).div(100000000); // 转换为 SCASH
    const requiredAmount = targetAmount.plus(estimatedFee);

    // 选择最小的 UTXO 组合满足需求
    let selectedUtxos: Utxo[] = [];
    let selectedAmount = new Big(0);

    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      selectedAmount = selectedAmount.plus(utxo.amount.toString());

      // 重新计算实际手续费
      const actualSize = 11 + selectedUtxos.length * 148 + 2 * 31;
      const actualFee = new Big(actualSize * feeRate).div(100000000);
      const actualRequired = targetAmount.plus(actualFee);

      if (selectedAmount.gte(actualRequired)) {
        const changeAmount = selectedAmount.minus(actualRequired);
        return {
          utxos: selectedUtxos,
          totalAmount: selectedAmount,
          changeAmount,
        };
      }
    }

    // 余额不足
    return null;
  }

  // 预存内存池找零 UTXO
  async prestoreChangeUtxo(
    txid: string,
    vout: number,
    address: string,
    amount: number,
    scriptPubKey: string,
    walletId?: number,
  ): Promise<Utxo> {
    // 检查是否已存在
    const existing = await this.prisma.utxo.findUnique({
      where: {
        txid_vout: {
          txid,
          vout,
        },
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.utxo.create({
      data: {
        txid,
        vout,
        address,
        scriptPubKey,
        amount,
        blockHeight: 0, // 内存池中的 UTXO，区块高度为 0
        isSpent: false,
        isUnconfirmed: true,
        isCoinbase: false, // 内存池中的交易不是 coinbase
        walletId: walletId || null,
      },
    });
  }

  // 标记 UTXO 为已花费
  async markUtxoAsSpent(
    txid: string,
    vout: number,
    spentByTxid: string,
  ): Promise<void> {
    await this.prisma.utxo.updateMany({
      where: {
        txid,
        vout,
      },
      data: {
        isSpent: true,
        spentByTxid,
        updatedAt: new Date(),
      },
    });
  }

  // 获取统筹账户 UTXO
  async getPoolingAccountUtxos(
    includeUnconfirmed: boolean = false,
  ): Promise<UtxoWithConfirmations[]> {
    const poolingAddress = await this.getPoolingAccountAddress();
    if (!poolingAddress) {
      return [];
    }
    return this.getUtxos(poolingAddress, includeUnconfirmed);
  }
}
