# Scash Telegram 红包机器人开发进度

## 项目状态: 开发中 (Beta)

---

## 一、项目概述

基于 Scash 链（BTC 架构）的 Telegram 去中心化红包机器人，支持：

- 双模式钱包（只读模式 / 完整模式）
- 统筹账户机制
- 多种红包类型（定向、均分、随机、活跃、抽奖）

### 技术栈

- **运行环境**: Node.js + Nest.js
- **数据库**: PostgreSQL + Prisma ORM
- **区块链**: Scash Full Node (Regtest)
- **加密方案**: AES-256-GCM 对称加密

---

## 二、功能完成进度

### ✅ 已完成

#### 1. 基础架构

- [x] 项目初始化 (Nest.js + Prisma)
- [x] 数据库 Schema 设计和迁移
- [x] Scash RPC 客户端封装
- [x] UTXO Indexer 服务 (区块同步)
- [x] 配置文件和环境变量

#### 2. 钱包系统

- [x] 助记词生成 (BIP39)
- [x] 地址派生 (BIP32, P2WPKH)
- [x] AES-256-GCM 加密实现
- [x] 只读模式绑定 (地址验证)
- [x] 完整模式导入 (助记词解密)

#### 3. 红包核心

- [x] UTXO 选择算法（最小足够策略）
- [x] 交易构造器（找零计算、手续费估算）
- [x] 内存池预判机制
- [x] 定向单发红包（直接转账给用户）
- [x] 均分/随机群发红包（统筹账户模式）
- [x] 活跃红包（Top N 发放）
- [x] 抽奖红包
- [x] 红包抢夺逻辑
- [x] 过期退款处理

#### 4. Telegram 界面

- [x] Bot 初始化和命令注册
- [x] /start, /help 命令
- [x] /balance 查询余额
- [x] /create 创建红包（交互式）
- [x] 抢红包按钮回调
- [x] 消息监听统计活跃度

#### 5. 统筹账户

- [x] 统筹账户转账机制
- [x] 未绑定钱包用户抢红包记录
- [x] 用户绑定钱包后自动转账
- [x] 批量处理转账（节省手续费）

---

## 三、红包类型说明

### 定向红包 (DIRECT)

- 创建时直接转账给目标用户
- 不经过统筹账户
- 目标用户需要绑定钱包地址

### 活跃红包 (ACTIVITY_TOP)

- 创建时直接转账给 Top N 活跃用户
- 不经过统筹账户
- 根据群消息统计确定活跃用户

### 均分红包 (GROUP_EQUAL)

- 发红包时先转到统筹账户
- 用户抢红包后从统筹账户转账
- 红包被抢完后批量转账

### 随机红包 (GROUP_RANDOM)

- 同均分红包流程
- 金额随机分配（二倍均值法）

### 抽奖红包 (ACTIVITY_LOTTERY)

- 从活跃用户中随机抽取
- 金额随机分配

---

## 四、数据库设计

### 表结构

```
users                  - 用户表
wallets                - 钱包表
utxos                  - UTXO 索引表 (全链索引)
red_packets            - 红包表
red_packet_claims      - 红包领取记录
pooling_transfers      - 统筹账户转账记录
user_activities       - 用户活跃度记录
block_sync            - 区块同步状态
system_configs         - 系统配置
mempool_transactions  - 内存池交易（通过 ZMQ 实时同步）
```

### 关键字段

**Utxo 表 (优化后)**

- `txid`, `vout` - UTXO 唯一标识
- `address` - 地址
- `amount` - 金额
- `block_height` - 所在区块高度（用于计算确认数）
- `is_spent` - 是否已花费
- `is_unconfirmed` - 是否未确认（内存池）
- `is_coinbase` - 是否是 coinbase（挖矿获得），coinbase 需要 100 确认才能使用

**RedPacket 表**

- `type` - 红包类型
- `strategy` - 分发策略
- `total_amount`, `remaining_amount` - 金额
- `count`, `remaining_count` - 份数
- `funding_txid` - 资金来源交易
- `status` - 状态 (ACTIVE/COMPLETED/EXPIRED/REFUNDED)

---

## 五、核心机制说明

### 5.1 UTXO 索引服务

- 后台守护进程轮询 Scash 节点
- 解析新区块交易，更新 UTXO 表
- 本地查询余额，毫秒级响应
- 确认数通过 `current_height - block_height + 1` 动态计算

### 5.2 内存池找零复用

- 交易广播成功后，立即将找零 UTXO 以 unconfirmed 状态入库
- 下一笔交易可直接使用该 UTXO
- 解决高频连发的并发问题

### 5.3 离线交易构造

- 本地选 UTXO、计算手续费、组装交易
- 内存中签名，私钥不落地
- 仅广播 Raw Transaction Hex
- **找零地址：使用原地址（不回退到新地址）**

### 5.4 统筹账户机制

- 群红包：资金先到统筹账户
- 用户抢红包后，创建转账记录
- 批量处理转账，节省手续费
- 用户绑定钱包后自动触发转账
- 发红包时预留手续费储备（每人 0.0023 SCASH）

### 5.5 UTXO 成熟机制

- coinbase（挖矿获得）：需要 100 个确认才能使用
- 普通转账 UTXO：只需要 1 个确认即可使用
- 内存池 UTXO：可直接使用（blockHeight = 0）
- 通过 `is_coinbase` 字段标记

### 5.6 ZMQ 实时同步

- 监听新区块通知，触发 UTXO 同步
- 监听新交易，存储到 mempool_transactions 表
- 支持内存池 UTXO 实时查询

---

## 六、待解决问题

### 高优先级

1. [ ] 抽奖红包抽取逻辑
2. [ ] 红包过期自动退款

### 中优先级

1. [ ] 区块浏览器链接生成
2. [ ] 错误消息国际化
3. [ ] 并发测试
4. [ ] 单元测试覆盖

### 低优先级

1. [ ] Web 管理后台
2. [ ] 数据统计和报表
3. [ ] 更多红包策略（拼图、口令）

---

## 七、环境变量配置

```
# 数据库
DATABASE_URL=postgresql://user:pass@localhost:5432/db

# Scash 节点 RPC
SCASH_RPC_URL=http://localhost:18443
SCASH_RPC_USER=xxx
SCASH_RPC_PASS=xxx

# ZMQ 配置
ZMQ_BLOCK_URL=tcp://127.0.0.1:28444
ZMQ_TX_URL=tcp://127.0.0.1:28445

# Telegram Bot
TELEGRAM_BOT_TOKEN=xxx

# 统筹账户配置
POOLING_ACCOUNT_ADDRESS=bcrt1q...
POOLING_ACCOUNT_MNEMONIC="24 words..."
```

---

## 八、手动命令

- `/process` - 手动触发统筹账户转账（管理员）

---

最后更新: 2026-03-11

---

## 七、API 参考

### 主要服务

**WalletService** (`src/modules/wallet/services/wallet.service.ts`)

- `createWallet()` - 创建钱包
- `importWallet()` - 导入钱包
- `getWalletByUserId()` - 获取用户钱包
- `getPrivateKey()` - 获取私钥

**UtxoService** (`src/modules/blockchain/services/utxo.service.ts`)

- `getBalance()` - 获取余额
- `getUtxos()` - 获取 UTXO 列表
- `selectUtxos()` - 选择 UTXO
- `markUtxoAsSpent()` - 标记已花费

**TransactionBuilderService** (`src/modules/redpacket/services/transaction-builder.service.ts`)

- `buildTransaction()` - 构建交易
- `broadcastTransaction()` - 广播交易
- `buildPoolingTransferTransaction()` - 统筹账户批量转账

**RedpacketService** (`src/modules/redpacket/services/redpacket.service.ts`)

- `createRedPacket()` - 创建红包
- `claimRedPacket()` - 抢红包
- `processExpiredRedPackets()` - 处理过期红包
- `processPoolingTransfers()` - 处理统筹转账

---

## 八、配置文件

### 环境变量 (.env)

```
DATABASE_URL=postgresql://user:pass@localhost:5432/db
TELEGRAM_BOT_TOKEN=xxx
ENCRYPTION_KEY=xxx
SCASH_RPC_URL=http://localhost:18332
SCASH_RPC_USER=xxx
SCASH_RPC_PASSWORD=xxx
```

### 系统配置 (system_configs 表)

- `POOLING_ACCOUNT_ADDRESS` - 统筹账户地址
- 其他配置可通过表管理

---

## 九、运行命令

```bash
# 安装依赖
npm install

# 生成 Prisma Client
npx prisma generate

# 应用数据库迁移
npx prisma migrate deploy

# 运行开发服务器
npm run start:dev

# 构建
npm run build

# 运行测试
npm run test
```

---

## 十、相关文件

### 核心文件

- `prisma/schema.prisma` - 数据库 Schema
- `src/modules/wallet/` - 钱包模块
- `src/modules/blockchain/` - 区块链模块（UTXO、RPC）
- `src/modules/redpacket/` - 红包模块
- `src/modules/telegram/` - Telegram Bot 模块
- `src/modules/scheduler/` - 定时任务模块

### 配置文件

- `.env` - 环境变量
- `docker-compose.yml` - Docker 配置
- `tsconfig.json` - TypeScript 配置
- `nest-cli.json` - NestJS 配置

---

## 十一、开发注意事项

1. **找零地址**: 当前设计为找零回原地址，不生成新地址
2. **Coinbase 确认数**: 需要 100 个确认才能使用
3. **UTXO 效率**: 使用 block_height 计算确认数，避免每次更新所有记录
4. **手续费**: 固定费率 1 sat/byte (Regtest)
5. **红包过期**: 24 小时过期

---

最后更新: 2026-03-11
