# Scash Telegram 红包机器人

## 项目结构

```
src/
├── modules/
│   ├── blockchain/          # 区块链模块
│   │   ├── blockchain.module.ts
│   │   └── services/
│   │       ├── scash-rpc.service.ts      # Scash RPC 客户端
│   │       ├── utxo-indexer.service.ts   # UTXO 索引服务
│   │       └── utxo.service.ts           # UTXO 管理
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

```bash
cp .env.example .env
# 编辑 .env 文件，填入实际配置
```

### 3. 初始化数据库

```bash
# 生成 Prisma 客户端
npx prisma generate

# 执行数据库迁移
npx prisma migrate dev --name init
```

### 4. 初始化统筹账户

```bash
npx ts-node scripts/init-pooling-account.ts
```

### 5. 启动服务

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
- 解析交易更新 UTXO 表
- 内存池预判找零 UTXO
- 毫秒级余额查询

### 钱包系统

- 只读模式（绑定地址）
- 完整模式（助记词加密存储）
- BIP39/BIP32 标准派生
- AES-256-GCM 加密

### 红包系统

- 定向红包
- 均分/随机群发红包
- 活跃度红包
- 统筹账户机制

## 环境要求

- Node.js 18+
- PostgreSQL 14+
- Scash Full Node (Regtest)

## 测试网络

当前配置为 Scash Regtest 模式：
- RPC 端口: 18443
- bech32 前缀: bcrt

## 系统架构

### 核心机制

1. **UTXO 索引服务**: 自建全链 UTXO 索引，毫秒级查询余额
2. **内存池预判**: 交易广播后立即预存找零 UTXO，支持高频并发
3. **离线交易构造**: 本地选 UTXO、计算手续费、内存中签名
4. **统筹账户机制**: 未绑定用户资金暂存，绑定后自动划转

### 技术栈

- **框架**: Nest.js + TypeScript
- **数据库**: PostgreSQL + Prisma ORM
- **区块链**: Scash (BTC 架构)
- **加密**: AES-256-GCM
- **消息**: Telegram Bot API

## 文档

- [快速启动指南](QUICKSTART.md) - 5 分钟启动教程
- [部署检查清单](DEPLOYMENT_CHECKLIST.md) - 生产环境部署清单
- [开发计划](DEVELOPMENT_PLAN.md) - 详细开发路线图

## 测试

```bash
# 运行集成测试
npx ts-node scripts/test-redpacket.ts

# 启动开发服务器
npm run start:dev

# 查看数据库
npx prisma studio
```

## 统筹账户

首次运行必须初始化统筹账户：

```bash
npx ts-node scripts/init-pooling-account.ts
```

**警告**: 请务必备份生成的助记词，这是恢复统筹账户的唯一方式！

## 许可证

MIT
