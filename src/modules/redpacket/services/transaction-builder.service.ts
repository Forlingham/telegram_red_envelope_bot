import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { UtxoService } from "../../blockchain/services/utxo.service";
import { WalletService } from "../../wallet/services/wallet.service";
import { ScashRpcService } from "../../blockchain/services/scash-rpc.service";
import {
  ScashNetwork,
  DEFAULT_CONFIG,
  RedPacketType,
  RedPacketStrategy,
} from "../../../shared/constants/network.constants";
import * as bitcoin from "bitcoinjs-lib";
import * as bip39 from "bip39";
import * as bip32 from "bip32";
import Big from "big.js";
import { Utxo } from "@prisma/client";
import { ECPairFactory } from "ecpair";
import * as tinysecp from "tiny-secp256k1";

const ECPair = ECPairFactory(tinysecp);

interface TransactionInput {
  txid: string;
  vout: number;
  scriptPubKey: string;
  value: number;
}

interface TransactionOutput {
  address: string;
  value: number;
}

interface BuildTransactionResult {
  rawTransaction: string;
  txid: string;
  fee: Big;
  changeAmount: Big;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
}

@Injectable()
export class TransactionBuilderService {
  private readonly logger = new Logger(TransactionBuilderService.name);
  private readonly network: bitcoin.Network;

  constructor(
    private prisma: PrismaService,
    private utxoService: UtxoService,
    private walletService: WalletService,
    private rpcService: ScashRpcService,
    private configService: ConfigService,
  ) {
    this.network = ScashNetwork.REGTEST;
  }

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

  /**
   * 构建交易
   * @param senderId 发送者用户ID
   * @param recipients 接收者列表 [{address, amount}]
   * @param feeRate 手续费率 (sat/byte)
   */
  async buildTransaction(
    senderId: number,
    recipients: { address: string; amount: Big }[],
    feeRate: number = DEFAULT_CONFIG.FEE_RATE,
  ): Promise<BuildTransactionResult | null> {
    // 获取发送者钱包
    const wallet = await this.walletService.getWalletByUserId(senderId);
    if (!wallet) {
      throw new Error("发送者没有绑定钱包");
    }

    // 计算总金额
    const totalOutput = recipients.reduce(
      (sum, r) => sum.plus(r.amount),
      new Big(0),
    );

    // 估算交易大小计算手续费
    // P2WPKH 输入: 约 68 vbytes (41 bytes txid/vout/sequence + 27 bytes witness)
    // P2WPKH 输出: 约 31 vbytes
    // 基础开销: 11 vbytes
    const estimatedInputCount = 1; // 先假设需要1个输入
    const outputCount = recipients.length + 1; // +1 是找零
    const estimatedVSize = 11 + estimatedInputCount * 68 + outputCount * 31;
    const estimatedFeeSat = estimatedVSize * feeRate;
    const estimatedFee = new Big(estimatedFeeSat).div(100000000); // 转换为 SCASH

    // 选择 UTXO（包含未确认的，使用0确认以便使用内存池中的UTXO）
    const requiredAmount = totalOutput.plus(estimatedFee);
    const selectionResult = await this.utxoService.selectUtxos(
      wallet.address,
      requiredAmount,
      feeRate,
      true, // 包含未确认的 UTXO（内存池找零）
      0, // 使用 0 确认（可以使用内存池中的 UTXO）
    );

    if (!selectionResult) {
      throw new Error("余额不足");
    }

    // 重新计算实际交易大小和手续费
    const actualInputCount = selectionResult.utxos.length;
    const actualVSize = 11 + actualInputCount * 68 + outputCount * 31;
    const actualFeeSat = actualVSize * feeRate;
    const actualFee = new Big(actualFeeSat).div(100000000);
    const actualChangeAmount = selectionResult.totalAmount
      .minus(totalOutput)
      .minus(actualFee);

    // 找零不能为负数
    if (actualChangeAmount.lt(0)) {
      throw new Error("余额不足以支付手续费");
    }

    // 构建交易
    const psbt = new bitcoin.Psbt({ network: this.network });

    // 添加输入
    for (const utxo of selectionResult.utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptPubKey, "hex"),
          value: Math.round(parseFloat(utxo.amount.toString()) * 100000000),
        },
      });
    }

    // 添加输出（红包金额）
    for (const recipient of recipients) {
      psbt.addOutput({
        address: recipient.address,
        value: Math.round(parseFloat(recipient.amount.toString()) * 100000000),
      });
    }

    // 添加找零输出
    if (actualChangeAmount.gte(0.00001)) {
      // 找零大于 dust limit
      // 找零回原地址（不生成新地址）
      psbt.addOutput({
        address: wallet.address,
        value: Math.round(
          parseFloat(actualChangeAmount.toString()) * 100000000,
        ),
      });
    }

    // 签名交易
    const privateKey = await this.walletService.getPrivateKey(senderId);
    if (!privateKey) {
      throw new Error("无法获取私钥");
    }

    const keyPair = ECPair.fromPrivateKey(privateKey);

    for (let i = 0; i < selectionResult.utxos.length; i++) {
      psbt.signInput(i, keyPair);
    }

    psbt.finalizeAllInputs();

    const rawTransaction = psbt.extractTransaction().toHex();
    const txid = psbt.extractTransaction().getId();

    return {
      rawTransaction,
      txid,
      fee: actualFee,
      changeAmount: actualChangeAmount,
      inputs: selectionResult.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        scriptPubKey: u.scriptPubKey,
        value: parseFloat(u.amount.toString()),
      })),
      outputs: recipients.map((r) => ({
        address: r.address,
        value: parseFloat(r.amount.toString()),
      })),
    };
  }

  /**
   * 广播交易并预存找零 UTXO
   */
  async broadcastTransaction(
    senderId: number,
    buildResult: BuildTransactionResult,
  ): Promise<{ success: boolean; txid: string; message?: string }> {
    try {
      // 先测试交易是否会被接受
      this.logger.debug(`正在测试交易...`);
      this.logger.debug(
        `交易 hex: ${buildResult.rawTransaction.substring(0, 100)}...`,
      );
      this.logger.debug(`输入数量: ${buildResult.inputs.length}`);
      this.logger.debug(`输出数量: ${buildResult.outputs.length}`);

      // 广播交易
      this.logger.debug(`正在广播交易...`);
      const txid = await this.rpcService.sendRawTransaction(
        buildResult.rawTransaction,
      );
      this.logger.debug(`交易广播成功，txid: ${txid}`);

      // 获取交易详情，解析所有输出
      const decoded = await this.rpcService.decodeRawTransaction(
        buildResult.rawTransaction,
      );

      // 预存所有输出 UTXO（内存池预判）
      const wallet = await this.walletService.getWalletByUserId(senderId);

      // 找零输出是最后一个输出
      const changeOutputIndex = buildResult.outputs.length;

      for (let i = 0; i < decoded.vout.length; i++) {
        const vout = decoded.vout[i];

        // 跳过找零输出（单独处理）
        if (i === changeOutputIndex) {
          continue;
        }

        if (vout && vout.scriptPubKey && vout.scriptPubKey.address) {
          // 判断是否是发给统筹账户的
          const poolingAddress = await this.getPoolingAccountAddress();
          const isPoolingOutput = vout.scriptPubKey.address === poolingAddress;

          await this.utxoService.prestoreChangeUtxo(
            txid,
            i,
            vout.scriptPubKey.address,
            vout.value,
            vout.scriptPubKey.hex,
            isPoolingOutput ? null : wallet?.id || null, // 统筹地址没有关联钱包
          );
          this.logger.debug(
            `预存输出 UTXO: ${txid}:${i}, 地址: ${vout.scriptPubKey.address}, 金额: ${vout.value}`,
          );
        }
      }

      // 预存找零 UTXO（内存池预判）
      if (buildResult.changeAmount.gt(0) && wallet) {
        const changeOutputIndex = buildResult.outputs.length;
        const changeAmountNum = parseFloat(buildResult.changeAmount.toString());
        const changeOutput = decoded.vout[changeOutputIndex];

        if (
          changeOutput &&
          changeOutput.scriptPubKey &&
          changeOutput.scriptPubKey.address
        ) {
          await this.utxoService.prestoreChangeUtxo(
            txid,
            changeOutputIndex,
            changeOutput.scriptPubKey.address,
            changeAmountNum,
            changeOutput.scriptPubKey.hex,
            wallet.id,
          );
          this.logger.debug(`预存找零 UTXO: ${txid}:${changeOutputIndex}`);
        }
      }

      // 标记已使用的 UTXO
      for (const input of buildResult.inputs) {
        await this.utxoService.markUtxoAsSpent(input.txid, input.vout, txid);
        this.logger.debug(`标记 UTXO 为已花费: ${input.txid}:${input.vout}`);
      }

      return { success: true, txid };
    } catch (error) {
      this.logger.error(`广播交易失败: ${error.message}`);

      let errorMessage = "交易广播失败";

      // 检测内存池交易过多错误
      if (error.response?.data?.error?.message) {
        const rpcError = error.response.data.error.message;
        if (rpcError.includes("too-long-mempool-chain")) {
          errorMessage = "当前网络交易较多，建议稍等1-2分钟后重试发红包";
        } else if (rpcError.includes("dust")) {
          errorMessage = "金额过低，请增加红包金额后重试";
        } else {
          errorMessage = rpcError;
        }
      } else if (error.message) {
        if (error.message.includes("too-long-mempool-chain")) {
          errorMessage = "当前网络交易较多，建议稍等1-2分钟后重试发红包";
        } else if (error.message.includes("dust")) {
          errorMessage = "金额过低，请增加红包金额后重试";
        } else {
          errorMessage = error.message;
        }
      }

      if (error.response) {
        this.logger.error(`RPC 响应状态: ${error.response.status}`);
        this.logger.error(
          `RPC 响应数据: ${JSON.stringify(error.response.data)}`,
        );
      }
      return { success: false, txid: "", message: errorMessage };
    }
  }

  /**
   * 广播统筹账户交易（不需要用户ID，从环境变量获取私钥）
   */
  async broadcastPoolingTransaction(
    buildResult: BuildTransactionResult,
  ): Promise<{ success: boolean; txid: string; message?: string }> {
    try {
      this.logger.debug(`正在广播统筹账户交易...`);
      this.logger.debug(
        `交易 hex: ${buildResult.rawTransaction.substring(0, 100)}...`,
      );

      const txid = await this.rpcService.sendRawTransaction(
        buildResult.rawTransaction,
      );
      this.logger.debug(`统筹账户交易广播成功，txid: ${txid}`);

      // 获取交易详情，解析所有输出
      const decoded = await this.rpcService.decodeRawTransaction(
        buildResult.rawTransaction,
      );

      // 预存所有输出 UTXO（内存池预判）
      const poolingAddress = await this.getPoolingAccountAddress();
      const changeOutputIndex = buildResult.outputs.length;

      for (let i = 0; i < decoded.vout.length; i++) {
        const vout = decoded.vout[i];

        // 跳过找零输出（单独处理）
        if (i === changeOutputIndex) {
          continue;
        }

        if (vout && vout.scriptPubKey && vout.scriptPubKey.address) {
          await this.utxoService.prestoreChangeUtxo(
            txid,
            i,
            vout.scriptPubKey.address,
            vout.value,
            vout.scriptPubKey.hex,
            null,
          );
          this.logger.debug(
            `预存统筹账户输出 UTXO: ${txid}:${i}, 地址: ${vout.scriptPubKey.address}, 金额: ${vout.value}`,
          );
        }
      }

      // 预存找零 UTXO
      if (buildResult.changeAmount.gt(0) && poolingAddress) {
        const changeOutputIndex = buildResult.outputs.length;
        const changeAmountNum = parseFloat(buildResult.changeAmount.toString());
        const changeOutput = decoded.vout[changeOutputIndex];

        if (
          changeOutput &&
          changeOutput.scriptPubKey &&
          changeOutput.scriptPubKey.address
        ) {
          await this.utxoService.prestoreChangeUtxo(
            txid,
            changeOutputIndex,
            changeOutput.scriptPubKey.address,
            changeAmountNum,
            changeOutput.scriptPubKey.hex,
            null,
          );
          this.logger.debug(
            `预存统筹账户找零 UTXO: ${txid}:${changeOutputIndex}`,
          );
        }
      }

      // 标记已使用的 UTXO
      for (const input of buildResult.inputs) {
        await this.utxoService.markUtxoAsSpent(input.txid, input.vout, txid);
        this.logger.debug(`标记 UTXO 为已花费: ${input.txid}:${input.vout}`);
      }

      return { success: true, txid };
    } catch (error) {
      this.logger.error(`广播交易失败: ${error.message}`);

      let errorMessage = error.message;

      // 检测内存池交易过多错误
      if (error.response?.data?.error?.message) {
        const rpcError = error.response.data.error.message;
        if (rpcError.includes("too-long-mempool-chain")) {
          errorMessage = "当前网络交易较多，建议稍等1-2分钟后重试发红包";
        } else {
          errorMessage = rpcError;
        }
      }

      if (error.response) {
        this.logger.error(`RPC 响应状态: ${error.response.status}`);
        this.logger.error(
          `RPC 响应数据: ${JSON.stringify(error.response.data)}`,
        );
      }
      return { success: false, txid: "", message: errorMessage };
    }
  }

  /**
   * 构建统筹账户批量转账交易
   * @param transfers 转账列表 [{userId, address, amount}]
   */
  async buildPoolingTransferTransaction(
    transfers: { userId: number; address: string; amount: Big }[],
    feeRate: number = DEFAULT_CONFIG.FEE_RATE,
  ): Promise<BuildTransactionResult | null> {
    // 获取统筹账户地址
    const poolingAddress = await this.getPoolingAccountAddress();

    if (!poolingAddress) {
      throw new Error("统筹账户未配置");
    }

    // 尝试从数据库获取钱包
    let poolingWallet = await this.prisma.wallet.findUnique({
      where: { address: poolingAddress },
    });

    // 如果数据库中没有，尝试从环境变量获取助记词并派生地址
    if (!poolingWallet) {
      const mnemonic = this.configService.get<string>(
        "POOLING_ACCOUNT_MNEMONIC",
      );
      if (!mnemonic) {
        throw new Error("统筹账户钱包不存在且环境变量未配置助记词");
      }

      // 派生地址
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const root = bip32.BIP32Factory(tinysecp).fromSeed(seed, this.network);
      const child = root.derivePath("m/84'/0'/0'/0/0");

      if (!child.privateKey) {
        throw new Error("派生私钥失败");
      }

      const keyPair = ECPair.fromPrivateKey(child.privateKey);
      const payment = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: this.network,
      });

      const derivedAddress = payment.address;
      if (derivedAddress !== poolingAddress) {
        throw new Error(
          `地址不匹配: 环境变量地址 ${poolingAddress}, 派生地址 ${derivedAddress}`,
        );
      }

      poolingWallet = {
        id: 0,
        userId: 0,
        address: poolingAddress,
        encryptedMnemonic: "",
        derivationPath: "m/84'/0'/0'/0/0",
        publicKey: keyPair.publicKey.toString("hex"),
        createdAt: new Date(),
      } as any;
    }

    // 计算总金额
    const totalOutput = transfers.reduce(
      (sum, t) => sum.plus(t.amount),
      new Big(0),
    );

    // 估算手续费
    const estimatedInputCount = Math.ceil(transfers.length / 3); // 估算输入数
    const outputCount = transfers.length + 1;
    const estimatedVSize = 11 + estimatedInputCount * 68 + outputCount * 31;
    const estimatedFeeSat = estimatedVSize * feeRate;
    const estimatedFee = new Big(estimatedFeeSat).div(100000000);

    // 选择 UTXO（包含未确认的，使用0确认以便使用内存池中的UTXO）
    const requiredAmount = totalOutput.plus(estimatedFee);
    const selectionResult = await this.utxoService.selectUtxos(
      poolingAddress,
      requiredAmount,
      feeRate,
      true, // 包含未确认的 UTXO
      0, // 使用 0 确认（可以使用内存池中的 UTXO）
    );

    if (!selectionResult) {
      throw new Error("统筹账户余额不足");
    }

    // 重新计算手续费
    const actualInputCount = selectionResult.utxos.length;
    const actualVSize = 11 + actualInputCount * 68 + outputCount * 31;
    const actualFeeSat = actualVSize * feeRate;
    const actualFee = new Big(actualFeeSat).div(100000000);
    const actualChangeAmount = selectionResult.totalAmount
      .minus(totalOutput)
      .minus(actualFee);

    if (actualChangeAmount.lt(0)) {
      throw new Error("统筹账户余额不足以支付手续费");
    }

    // 构建交易
    const psbt = new bitcoin.Psbt({ network: this.network });

    // 添加输入
    for (const utxo of selectionResult.utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptPubKey, "hex"),
          value: Math.round(parseFloat(utxo.amount.toString()) * 100000000),
        },
      });
    }

    // 添加输出
    for (const transfer of transfers) {
      psbt.addOutput({
        address: transfer.address,
        value: Math.round(parseFloat(transfer.amount.toString()) * 100000000),
      });
    }

    // 添加找零
    if (actualChangeAmount.gte(0.00001)) {
      psbt.addOutput({
        address: poolingAddress,
        value: Math.round(
          parseFloat(actualChangeAmount.toString()) * 100000000,
        ),
      });
    }

    // 签名
    let keyPair;

    // 优先从数据库获取私钥
    if (poolingWallet.userId > 0) {
      const privateKey = await this.walletService.getPrivateKey(
        poolingWallet.userId,
      );
      if (!privateKey) {
        throw new Error("无法获取统筹账户私钥");
      }
      keyPair = ECPair.fromPrivateKey(privateKey);
    } else {
      // 从环境变量助记词派生私钥
      const mnemonic = this.configService.get<string>(
        "POOLING_ACCOUNT_MNEMONIC",
      );
      if (!mnemonic) {
        throw new Error("环境变量未配置统筹账户助记词");
      }
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const root = bip32.BIP32Factory(tinysecp).fromSeed(seed, this.network);
      const child = root.derivePath(
        poolingWallet.derivationPath || "m/84'/0'/0'/0/0",
      );

      if (!child.privateKey) {
        throw new Error("派生私钥失败");
      }
      keyPair = ECPair.fromPrivateKey(child.privateKey);
    }

    for (let i = 0; i < selectionResult.utxos.length; i++) {
      psbt.signInput(i, keyPair);
    }

    psbt.finalizeAllInputs();

    const rawTransaction = psbt.extractTransaction().toHex();
    const txid = psbt.extractTransaction().getId();

    return {
      rawTransaction,
      txid,
      fee: actualFee,
      changeAmount: actualChangeAmount,
      inputs: selectionResult.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        scriptPubKey: u.scriptPubKey,
        value: parseFloat(u.amount.toString()),
      })),
      outputs: transfers.map((t) => ({
        address: t.address,
        value: parseFloat(t.amount.toString()),
      })),
    };
  }

  /**
   * 估算交易手续费
   */
  estimateFee(
    inputCount: number,
    outputCount: number,
    feeRate: number = DEFAULT_CONFIG.FEE_RATE,
  ): Big {
    const vSize = 11 + inputCount * 68 + outputCount * 31;
    const feeSat = vSize * feeRate;
    return new Big(feeSat).div(100000000);
  }
}
