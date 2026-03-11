# Scash Telegram 红包机器人开发计划

## 一、项目概述

基于 Scash 链（BTC 架构）的 Telegram 去中心化红包机器人，支持双模式钱包、统筹账户机制和高频并发红包发放。

## 二、系统架构

### 2.1 技术栈

- **运行环境**: Node.js + Nest.js
- **数据库**: PostgreSQL + Prisma ORM
- **区块链**: Scash Full Node (Regtest 测试模式)
- **加密方案**: AES-256-GCM 对称加密助记词
- **网络参数**:
  - Regtest: bech32='bcrt', pubKeyHash=0x3c, scriptHash=0x7d

### 2.2 项目结构

```
telegram_red_envelope_bot/
├── src/
│   ├── modules/
│   │   ├── blockchain/        # UTXO Indexer + RPC + ZMQ
│   │   ├── wallet/            # 钱包管理（创建/导入/加密）
│   │   ├── redpacket/        # 红包核心逻辑
│   │   ├── telegram/          # Telegram Bot 命令和交互
│   │   └── scheduler/        # 定时任务
│   ├── prisma/
│   │   └── schema.prisma    # 数据库 Schema
│   └── main.ts
├── docker-compose.yml
├── .env
└── package.json
```

## 三、数据库设计

### 核心实体

1. **User** - 用户表
   - telegramId, username, isWatchOnly, createdAt

2. **Wallet** - 钱包表
   - address, encryptedMnemonic, derivationPath, publicKey

3. **Utxo** - UTXO 索引表（全链索引）
   - txid, vout, address, amount, blockHeight, isSpent, isUnconfirmed, isCoinbase
   - 支持内存池预判的找零 UTXO

4. **RedPacket** - 红包表
   - type(DIRECT/GROUP_EQUAL/GROUP_RANDOM/ACTIVITY_TOP/ACTIVITY_LOTTERY), strategy
   - totalAmount, count, status, fundingTxid

5. **RedPacketClaim** - 红包领取记录
   - 关联红包和用户，记录金额和转账状态

6. **PoolingTransfer** - 统筹账户转账
   - 记录从统筹账户到用户钱包的转账

7. **UserActivity** - 用户活跃度
   - 按天统计群消息数，支持活跃度红包

8. **BlockSync** - 区块同步状态
   - 记录已同步的最新区块高度

9. **SystemConfig** - 系统配置

10. **MempoolTransaction** - 内存池交易（ZMQ 实时同步）

## 四、核心机制

### 4.1 UTXO 索引服务 (Indexer)

- 后台守护进程轮询 Scash 节点
- 解析新区块交易，更新 UTXO 表
- 本地查询余额，毫秒级响应
- 通过 ZMQ 监听新区块和交易

### 4.2 UTXO 成熟机制

- coinbase（挖矿获得）：需要 100 个确认才能使用
- 普通转账 UTXO：只需要 1 个确认即可使用
- 内存池 UTXO：可直接使用（blockHeight = 0）
- 通过 `isCoinbase` 字段标记

### 4.3 内存池找零复用

- 交易广播成功后，立即将所有输出 UTXO 以 unconfirmed 状态入库
- 下一笔交易可直接使用该 UTXO
- 解决高频连发的并发问题

### 4.4 离线交易构造

- 本地选 UTXO、计算手续费、组装交易
- 内存中签名，私钥不落地
- 仅广播 Raw Transaction Hex
- 找零地址：使用原地址

### 4.5 统筹账户机制

- 群红包：资金先到统筹账户（+ 手续费储备）
- 用户抢红包后，创建转账记录
- 红包被抢完立即触发批量转账
- 用户绑定钱包后自动触发转账
- 手续费储备：每人 0.0023 SCASH

### 4.6 ZMQ 实时同步

- 监听新区块通知，触发 UTXO 同步
- 监听新交易，存储到 mempool_transactions 表

## 五、开发阶段

### Phase 1: 基础架构 ✅ 已完成

- [x] 项目初始化 (Nest.js + Prisma + 依赖安装)
- [x] 数据库 Schema 设计和迁移
- [x] Scash RPC 客户端封装
- [x] UTXO Indexer 服务 (区块同步)
- [x] ZMQ 监听服务
- [x] 配置文件和环境变量

### Phase 2: 钱包系统 ✅ 已完成

- [x] 助记词生成 (BIP39)
- [x] 地址派生 (BIP32, P2WPKH)
- [x] AES-256-GCM 加密实现
- [x] 只读模式绑定 (地址验证)
- [x] 完整模式导入 (助记词解密)

### Phase 3: 红包核心 ✅ 已完成

- [x] UTXO 选择算法
- [x] 交易构造器 (找零计算，手续费估算)
- [x] 内存池预判机制
- [x] 定向单发红包（直接转账给用户）
- [x] 均分/随机群发红包（统筹账户模式）
- [x] 活跃红包 (Top N)
- [x] 抽奖红包
- [x] 红包抢夺逻辑
- [x] 过期退款处理
- [x] 红包被抢完立即转账

### Phase 4: Telegram 界面 ✅ 已完成

- [x] Bot 初始化和命令注册
- [x] /start, /help, /balance 命令
- [x] /send 红包命令 (交互式)
- [x] /process 手动触发转账（管理员）
- [x] 抢红包按钮回调
- [x] 消息监听统计活跃度

### Phase 5: 待完成

- [ ] 抽奖红包抽取逻辑完善
- [ ] 红包过期自动退款完善
- [ ] 区块浏览器链接
- [ ] 错误消息国际化

## 六、关键技术决策

1. **UTXO 选择**: 优先使用小额 UTXO 组合，避免找零过大
2. **手续费率**: 固定费率 (1 sat/byte)
3. **找零地址**: 使用原地址（不回退到新地址）
4. **UTXO 成熟**: coinbase 100 确认，普通 1 确认
5. **统筹手续费储备**: 每人 0.0023 SCASH
6. **并发控制**: 数据库行级锁 + 乐观锁
7. **错误处理**: 交易失败自动重试 (最多 3 次)

## 七、安全考虑

1. Master Key 与数据库物理隔离 (环境变量)
2. 私钥仅在内存中短暂存在
3. 助记词使用 AES-256-GCM 加密存储
4. RPC 通信使用本地网络 (127.0.0.1)
5. 输入验证和防 SQL 注入 (Prisma ORM)
6. 统筹账户助记词存储在环境变量

## 八、环境变量

```env
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

## 九、部署清单

- PostgreSQL 数据库
- Scash Regtest 节点 + ZMQ
- Telegram Bot Token
- 服务器环境变量配置

## 十、后续扩展

1. 多语言支持 (i18n 框架)
2. 主网迁移
3. 更多红包策略 (拼图红包、口令红包)
4. Web 管理后台
5. 数据统计和报表
