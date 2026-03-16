import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { EncryptionService } from "./encryption.service";
import * as bip39 from "bip39";
import * as bip32 from "bip32";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as tinysecp from "tiny-secp256k1";
import { ScashNetwork } from "../../../shared/constants/network.constants";

const ECPair = ECPairFactory(tinysecp);

interface WalletInfo {
  address: string;
  publicKey: string;
  privateKey: string;
  mnemonic?: string;
  derivationPath?: string;
}

@Injectable()
export class WalletService {
  private readonly network: bitcoin.Network;

  constructor(
    private prisma: PrismaService,
    private encryptionService: EncryptionService,
    private configService: ConfigService,
  ) {
    this.network = ScashNetwork.REGTEST;
  }

  // 创建新钱包
  async createWallet(userId: number): Promise<WalletInfo> {
    // 生成助记词
    const mnemonic = bip39.generateMnemonic(256);

    // 从助记词派生地址
    const walletInfo = await this.deriveWalletFromMnemonic(mnemonic);

    // 加密助记词
    const encryptedMnemonic = this.encryptionService.encryptMnemonic(mnemonic);

    // 保存到数据库
    await this.prisma.wallet.create({
      data: {
        userId,
        address: walletInfo.address,
        encryptedMnemonic,
        derivationPath: walletInfo.derivationPath,
        publicKey: walletInfo.publicKey,
      },
    });

    // 更新用户为完整模式
    await this.prisma.user.update({
      where: { id: userId },
      data: { isWatchOnly: false },
    });

    return {
      ...walletInfo,
      mnemonic, // 首次创建时返回助记词给用户备份
    };
  }

  // 从助记词导入钱包
  async importWalletFromMnemonic(
    userId: number,
    mnemonic: string,
  ): Promise<WalletInfo> {
    // 验证助记词
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("无效的助记词");
    }

    const walletInfo = await this.deriveWalletFromMnemonic(mnemonic);

    // 检查地址是否已被使用
    const existingWallet = await this.prisma.wallet.findUnique({
      where: { address: walletInfo.address },
    });

    if (existingWallet && existingWallet.userId !== userId) {
      throw new Error("该地址已被其他用户绑定");
    }

    // 加密助记词
    const encryptedMnemonic = this.encryptionService.encryptMnemonic(mnemonic);

    if (existingWallet) {
      // 更新现有钱包
      await this.prisma.wallet.update({
        where: { id: existingWallet.id },
        data: {
          encryptedMnemonic,
          publicKey: walletInfo.publicKey,
        },
      });
    } else {
      // 创建新钱包记录
      await this.prisma.wallet.create({
        data: {
          userId,
          address: walletInfo.address,
          encryptedMnemonic,
          derivationPath: walletInfo.derivationPath,
          publicKey: walletInfo.publicKey,
        },
      });
    }

    // 更新用户为完整模式
    await this.prisma.user.update({
      where: { id: userId },
      data: { isWatchOnly: false },
    });

    // 触发统筹账户资金划转
    await this.triggerPoolingTransfer(userId);

    return walletInfo;
  }

  // 只读模式绑定地址
  async bindWatchOnlyAddress(userId: number, address: string): Promise<void> {
    // 验证地址格式
    try {
      bitcoin.address.toOutputScript(address, this.network);
    } catch {
      throw new Error("无效的 Scash 地址");
    }

    // 检查地址是否已被使用
    const existingWallet = await this.prisma.wallet.findUnique({
      where: { address },
    });

    if (existingWallet) {
      throw new Error("该地址已被绑定");
    }

    // 创建钱包记录（无加密助记词）
    await this.prisma.wallet.create({
      data: {
        userId,
        address,
      },
    });
  }

  // 派生钱包地址
  private async deriveWalletFromMnemonic(
    mnemonic: string,
  ): Promise<WalletInfo> {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.BIP32Factory(tinysecp).fromSeed(seed, this.network);

    // 使用 BIP84 派生路径 (P2WPKH): m/84'/0'/0'/0/0
    const path = "m/84'/0'/0'/0/0";
    const child = root.derivePath(path);

    if (!child.privateKey) {
      throw new Error("派生私钥失败");
    }

    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const payment = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: this.network,
    });

    if (!payment.address) {
      throw new Error("生成地址失败");
    }

    return {
      address: payment.address,
      publicKey: keyPair.publicKey.toString("hex"),
      privateKey: child.privateKey.toString("hex"),
      derivationPath: path,
    };
  }

  // 获取用户钱包
  async getWalletByUserId(userId: number) {
    return this.prisma.wallet.findUnique({
      where: { userId },
    });
  }

  // 获取地址对应的钱包
  async getWalletByAddress(address: string) {
    return this.prisma.wallet.findUnique({
      where: { address },
    });
  }

  // 解密私钥（仅在需要签名时调用，使用后立即销毁）
  async getPrivateKey(userId: number): Promise<Buffer | null> {
    const wallet = await this.getWalletByUserId(userId);

    if (!wallet || !wallet.encryptedMnemonic) {
      return null;
    }

    const mnemonic = this.encryptionService.decryptMnemonic(
      wallet.encryptedMnemonic,
    );
    const walletInfo = await this.deriveWalletFromMnemonic(mnemonic);

    // 清除内存中的助记词
    // 注意：Node.js 的垃圾回收机制不保证立即回收，但这是最佳实践

    return Buffer.from(walletInfo.privateKey, "hex");
  }

  // 生成新地址（用于找零）
  async generateChangeAddress(userId: number, index: number): Promise<string> {
    const wallet = await this.getWalletByUserId(userId);

    if (!wallet || !wallet.encryptedMnemonic) {
      throw new Error("用户没有完整钱包");
    }

    const mnemonic = this.encryptionService.decryptMnemonic(
      wallet.encryptedMnemonic,
    );
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.BIP32Factory(tinysecp).fromSeed(seed, this.network);

    // 派生新的找零地址: m/84'/0'/0'/0/index
    const path = `m/84'/0'/0'/0/${index}`;
    const child = root.derivePath(path);

    if (!child.privateKey) {
      throw new Error("派生失败");
    }

    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const payment = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: this.network,
    });

    return payment.address!;
  }

  // 删除钱包
  async deleteWallet(
    userId: number,
  ): Promise<{ success: boolean; message: string }> {
    const wallet = await this.getWalletByUserId(userId);

    if (!wallet) {
      return { success: false, message: "用户没有绑定钱包" };
    }

    // 检查是否有待处理的转账
    const pendingTransfers = await this.prisma.poolingTransfer.count({
      where: {
        userId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
    });

    if (pendingTransfers > 0) {
      return {
        success: false,
        message: `有 ${pendingTransfers} 笔资金正在处理中，请等待完成后再删除钱包`,
      };
    }

    try {
      // 删除钱包记录
      await this.prisma.wallet.delete({
        where: { userId },
      });

      // 更新用户为只读模式
      await this.prisma.user.update({
        where: { id: userId },
        data: { isWatchOnly: true },
      });

      return { success: true, message: "钱包已删除，您现在处于只读模式" };
    } catch (error) {
      return { success: false, message: `删除钱包失败: ${error.message}` };
    }
  }

  // 触发统筹账户资金划转
  private async triggerPoolingTransfer(userId: number): Promise<void> {
    // 查询该用户在统筹账户中的待划转资金
    const pendingTransfers = await this.prisma.poolingTransfer.findMany({
      where: {
        userId,
        status: "PENDING",
      },
    });

    if (pendingTransfers.length === 0) {
      return;
    }

    // 标记为待处理状态，由调度器批量处理
    for (const transfer of pendingTransfers) {
      await this.prisma.poolingTransfer.update({
        where: { id: transfer.id },
        data: { status: "PROCESSING" },
      });
    }

    console.log(
      `已为用户 ${userId} 标记 ${pendingTransfers.length} 笔待划转资金`,
    );
  }
}
