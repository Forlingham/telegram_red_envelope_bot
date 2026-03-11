# Scash Telegram 红包机器人

基于 Scash 链（BTC 架构）的 Telegram 去中心化红包机器人。

## 项目结构

```
src/
├── modules/
│   ├── blockchain/          # 区块链模块
│   │   ├── blockchain.module.ts
│   │   └── services/
│   │       ├── scash-rpc.service.ts      # Scash RPC 客户端
│   │       ├── utxo-indexer.service.ts   # UTXO 索引服务
│   │       ├── utxo.service.ts           # UTXO 管理
│   │       └── zmq.service.ts            # ZMQ 实时同步
│   ├── wallet/              # 钱包模块
│   │   ├── wallet.module.ts
│   │   └── services/
│   │       ├── wallet.service.ts         # 钱包管理
│   │       └── encryption.service.ts     # 加密服务
│   ├── redpacket/           # 红包模块
│   │   ├── redpacket.module.ts
│   │   └── services/
│   │       ├── redpacket.service.ts
│   │       └── transaction-builder.service.ts
│   ├── telegram/            # Telegram 模块
│   │   ├── telegram.module.ts
│   │   └── services/
│   │       └── telegram-bot.service.ts
│   └── scheduler/           # 定时任务模块
│       ├── scheduler.module.ts
│       └── services/
│           └── transfer-scheduler.service.ts
├── prisma/
│   ├── prisma.module.ts
│   ├── prisma.service.ts
│   └── schema.prisma        # 数据库 Schema
├── shared/
│   └── constants/
│       └── network.constants.ts
├── app.module.ts
└── main.ts
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 到 `.env` 并配置：

```env
# 数据库
DATABASE_URL=postgresql://user:pass@localhost:5432/db

# Scash 节点 RPC
SCASH_RPC_URL=http://localhost:18443
SCASH_RPC_USER=scash
SCASH_RPC_PASS=scash

# ZMQ 配置
ZMQ_BLOCK_URL=tcp://127.0.0.1:28444
ZMQ_TX_URL=tcp://127.0.0.1:28445

# Telegram Bot
TELEGRAM_BOT_TOKEN=xxx

# 统筹账户配置
POOLING_ACCOUNT_ADDRESS=bcrt1q...
POOLING_ACCOUNT_MNEMONIC="24 words..."
```

### 3. 初始化数据库

```bash
# 生成 Prisma 客户端
npx prisma generate

# 执行数据库迁移
npx prisma migrate deploy
```

### 4. 启动服务

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

## 核心功能

### UTXO 索引服务

- 自动同步 Scash 区块
- 通过 ZMQ 实时监听新区块和交易
- 解析交易更新 UTXO 表
- 内存池预判找零 UTXO
- 毫秒级余额查询

### UTXO 成熟机制

- coinbase（挖矿）：需要 100 个确认才能使用
- 普通转账 UTXO：只需要 1 个确认即可使用
- 内存池 UTXO：可直接使用

### 钱包系统

- 只读模式（绑定地址）
- 完整模式（助记词加密存储）
- BIP39/BIP32 标准派生
- AES-256-GCM 加密

### 红包系统

- **定向红包** - 直接转账给指定用户
- **均分红包** - 均分给抢红包的用户
- **随机红包** - 随机金额分配
- **活跃红包** - 奖励群内活跃用户
- **抽奖红包** - 随机抽取活跃用户

### 统筹账户机制

- 群红包资金先到统筹账户
- 发红包时预留手续费储备（每人 0.0023 SCASH）
- 用户抢红包后创建转账记录
- 红包被抢完立即触发批量转账
- 用户绑定钱包后自动触发转账

## 环境要求

- Node.js 18+
- PostgreSQL 14+
- Scash Full Node (Regtest)
- ZMQ (zmqpubrawblock, zmqpubrawtx)

## 系统架构

### 核心机制

1. **UTXO 索引服务**: 自建全链 UTXO 索引，毫秒级查询余额
2. **ZMQ 实时同步**: 监听新区块和交易，实时更新内存池数据
3. **内存池预判**: 交易广播后立即预存所有输出 UTXO，支持高频并发
4. **UTXO 成熟**: coinbase 100 确认，普通 1 确认，内存池直接可用
5. **离线交易构造**: 本地选 UTXO、计算手续费、内存中签名
6. **统筹账户机制**: 未绑定用户资金暂存，绑定后自动划转

### 技术栈

- **框架**: Nest.js + TypeScript
- **数据库**: PostgreSQL + Prisma ORM
- **区块链**: Scash (BTC 架构)
- **加密**: AES-256-GCM
- **消息**: Telegram Bot API

## 文档

- [快速启动指南](QUICKSTART.md) - 5 分钟启动教程
- [部署检查清单](DEVELOPMENT_CHECKLIST.md) - 生产环境部署清单
- [开发进度](DEVELOPMENT_PROGRESS.md) - 当前开发进度

## Telegram 命令

- `/start` - 开始使用
- `/help` - 帮助信息
- `/balance` - 查询余额
- `/bind <地址>` - 绑定只读钱包
- `/create` - 创建新钱包
- `/import` - 导入助记词
- `/send` - 发送红包
- `/process` - 手动触发统筹账户转账（管理员）

## 统筹账户

统筹账户配置在环境变量中：

```env
POOLING_ACCOUNT_ADDRESS=bcrt1q...
POOLING_ACCOUNT_MNEMONIC="24 words..."
```

⚠️ **警告**: 请务必备份助记词，这是恢复统筹账户的唯一方式！

## 开发

```bash
# 运行开发服务器
npm run start:dev

# 查看数据库
npx prisma studio

# 构建
npm run build
```

## 许可证

MIT
