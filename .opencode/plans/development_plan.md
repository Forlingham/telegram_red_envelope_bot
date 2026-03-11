# Scash Telegram 红包机器人开发计划

## 一、项目概述
基于 Scash 链（BTC 架构）的 Telegram 去中心化红包机器人，支持双模式钱包、统筹账户机制和高频并发红包发放。

## 二、系统架构

### 2.1 技术栈
- **运行环境**: Node.js / Bun + Nest.js
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
│   │   ├── blockchain/        # UTXO Indexer + RPC 封装
│   │   ├── wallet/            # 钱包管理（创建/导入/加密）
│   │   ├── redpacket/         # 红包核心逻辑
│   │   ├── telegram/          # Telegram Bot 命令和交互
│   │   └── scheduler/         # 定时任务
│   ├── prisma/
│   │   └── schema.prisma      # 数据库 Schema
│   └── main.ts
├── docker-compose.yml
└── package.json
```

## 三、数据库设计

### 核心实体
1. **User** - 用户表
   - telegramId, username, isWatchOnly, createdAt

2. **Wallet** - 钱包表
   - address, encryptedMnemonic, derivationPath, publicKey

3. **Utxo** - UTXO 索引表（全链索引）
   - txid, vout, address, amount, confirmations, isSpent, isUnconfirmed
   - 支持内存池预判的找零 UTXO

4. **RedPacket** - 红包表
   - type(DIRECT/GROUP_EQUAL/GROUP_RANDOM/ACTIVITY), strategy
   - totalAmount, count, status, fundingTxid

5. **RedPacketClaim** - 红包领取记录
   - 关联红包和用户，记录金额和转账状态

6. **统筹AccountTransfer** - 统筹账户转账
   - 记录从统筹账户到用户钱包的转账

7. **UserActivity** - 用户活跃度
   - 按天统计群消息数，支持活跃度红包

8. **BlockSync** - 区块同步状态
   - 记录已同步的最新区块高度

## 四、核心机制

### 4.1 UTXO 索引服务 (Indexer)
- 后台守护进程轮询 Scash 节点
- 解析新区块交易，更新 UTXO 表
- 本地查询余额，毫秒级响应

### 4.2 内存池找零复用
- 交易广播成功后，立即将找零 UTXO 以 unconfirmed 状态入库
- 下一笔交易可直接使用该 UTXO
- 解决高频连发的并发问题

### 4.3 离线交易构造
- 本地选 UTXO、计算手续费、组装交易
- 内存中签名，私钥不落地
- 仅广播 Raw Transaction Hex

### 4.4 统筹账户机制
- 未绑定钱包用户抢红包 → 资金记入统筹账户
- 用户后续绑定钱包 → 自动触发链上转账
- 定期批量处理转账，节省手续费

## 五、开发阶段

### Phase 1: 基础架构 (预计 2-3 天)
- [ ] 项目初始化 (Nest.js + Prisma + 依赖安装)
- [ ] 数据库 Schema 设计和迁移
- [ ] Scash RPC 客户端封装
- [ ] UTXO Indexer 服务 (区块同步)
- [ ] 配置文件和环境变量

### Phase 2: 钱包系统 (预计 2-3 天)
- [ ] 助记词生成 (BIP39)
- [ ] 地址派生 (BIP32, P2WPKH)
- [ ] AES-256-GCM 加密实现
- [ ] 只读模式绑定 (地址验证)
- [ ] 完整模式导入 (助记词解密)

### Phase 3: 红包核心 (预计 4-5 天)
- [ ] UTXO 选择算法
- [ ] 交易构造器 (找零计算、手续费估算)
- [ ] 内存池预判机制
- [ ] 定向单发红包
- [ ] 均分/随机群发红包
- [ ] 红包抢夺逻辑
- [ ] 过期退款处理

### Phase 4: Telegram 界面 (预计 3-4 天)
- [ ] Bot 初始化和命令注册
- [ ] /start, /help, /balance 命令
- [ ] /send 红包命令 (交互式)
- [ ] 抢红包按钮回调
- [ ] TxHash 区块浏览器链接
- [ ] WebApp 助记词导入弹窗

### Phase 5: 高级功能 (预计 3-4 天)
- [ ] 消息监听统计活跃度
- [ ] 活跃度红包 (Top N 发放)
- [ ] 活跃度抽奖 (随机抽取)
- [ ] 统筹账户自动划转
- [ ] 多语言框架预留 (当前全中文)

### Phase 6: 测试与优化 (预计 2-3 天)
- [ ] 单元测试覆盖核心逻辑
- [ ] 并发压力测试
- [ ] 安全审计 (密钥管理)
- [ ] 性能优化

**总预计工期: 16-22 天**

## 六、关键技术决策

1. **UTXO 选择**: 优先使用小额 UTXO 组合，避免找零过大
2. **手续费率**: 固定费率 (Regtest 可设为 1 sat/byte)
3. **找零地址**: 每次交易生成新地址 (BIP32 派生)
4. **并发控制**: 数据库行级锁 + 乐观锁
5. **错误处理**: 交易失败自动重试 (最多 3 次)

## 七、安全考虑

1. Master Key 与数据库物理隔离 (环境变量)
2. 私钥仅在内存中短暂存在
3. 助记词使用 AES-256-GCM 加密存储
4. RPC 通信使用本地网络 (127.0.0.1)
5. 输入验证和防 SQL 注入 (Prisma ORM)

## 八、部署清单

- PostgreSQL 数据库
- Scash Regtest 节点 (已配置)
- Telegram Bot Token (已配置)
- 服务器环境变量配置

## 九、后续扩展

1. 多语言支持 (i18n 框架)
2. 主网迁移
3. 更多红包策略 (拼图红包、口令红包)
4. Web 管理后台
5. 数据统计和报表
