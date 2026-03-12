import * as bitcoin from "bitcoinjs-lib";

// Scash Regtest 网络配置
export const ScashNetwork = {
  REGTEST: {
    messagePrefix: "\x18Scash Signed Message:\n",
    bech32: "bcrt",
    bip32: {
      public: 0x0488b21e,
      private: 0x0488ade4,
    },
    pubKeyHash: 0x3c,
    scriptHash: 0x7d,
    wif: 0x80,
  } as bitcoin.Network,
};

// 红包类型
export enum RedPacketType {
  DIRECT = "DIRECT",
  GROUP_EQUAL = "GROUP_EQUAL",
  GROUP_RANDOM = "GROUP_RANDOM",
  ACTIVITY_TOP = "ACTIVITY_TOP",
  ACTIVITY_LOTTERY = "ACTIVITY_LOTTERY",
}

// 红包分发策略
export enum RedPacketStrategy {
  EQUAL = "EQUAL",
  RANDOM = "RANDOM",
  RANK = "RANK",
}

// 红包状态
export enum RedPacketStatus {
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  EXPIRED = "EXPIRED",
  REFUNDED = "REFUNDED",
}

// 转账状态
export enum TransferStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  RETRYING = "RETRYING",
}

// 默认配置
export const DEFAULT_CONFIG = {
  REDPACKET_EXPIRY_HOURS: 24,
  FEE_RATE: 1, // sat/byte
  MIN_RED_PACKET_AMOUNT: 0.00001, // 最小红包金额
  MAX_RED_PACKET_COUNT: 100, // 最大红包份数
};
