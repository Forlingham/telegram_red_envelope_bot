# 快速启动指南

## 环境要求

- Node.js 18+
- PostgreSQL 14+
- Scash Full Node (Regtest 模式) + ZMQ

## 已配置的服务

- **PostgreSQL**: 已运行在 localhost:5432
- **Scash Node**: 已配置在 localhost:18443 (Regtest)
- **ZMQ**: 已配置在 localhost:28444 (区块) 和 28445 (交易)

## 统筹账户配置

在 `.env` 中配置：

```
POOLING_ACCOUNT_ADDRESS=bcrt1q8vdrfmwd4gmu23phh2t8xgutulu9ht2njefl9c
POOLING_ACCOUNT_MNEMONIC="catch flame party diagram coral jump mother dizzy amateur apple final canoe jaguar session photo soon fix fiscal cousin abstract rich marble census burst"
```

⚠️ **重要**: 请安全备份助记词！这是恢复统筹账户的唯一方式。

## 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 生成 Prisma 客户端

```bash
npx prisma generate
```

### 3. 启动应用

```bash
npm run start:dev
```

应用将启动在 http://localhost:5000

### 4. Telegram Bot

Bot 已配置，启动后会自动连接 Telegram 并监听消息。

支持的功能:

- `/start` - 开始使用
- `/help` - 帮助信息
- `/balance` - 查询余额
- `/bind <地址>` - 绑定只读钱包
- `/create` - 创建新钱包
- `/import` - 导入助记词
- `/send` - 发送红包
- `/process` - 手动触发统筹账户转账（管理员）

## 红包类型

1. **定向红包** - 直接转账给指定用户
2. **均分红包** - 均分给抢红包的用户（经过统筹账户）
3. **随机红包** - 随机金额分配（经过统筹账户）
4. **活跃红包** - 奖励群内活跃用户
5. **抽奖红包** - 随机抽取活跃用户

## 核心功能验证

### UTXO 索引服务

每 10 秒自动同步区块，通过 ZMQ 实时监听。

查看日志确认:

```
[UtxoIndexerService] Starting block synchronization...
[UtxoIndexerService] Block synchronization completed
[ZmqService] ZMQ 监听已启动
```

### 定时任务

- **每 5 分钟**: 处理统筹账户转账
- **每小时**: 处理过期红包退款

### 内存池预判

交易广播后立即预存所有输出 UTXO，支持高频红包发放。

### UTXO 成熟机制

- coinbase（挖矿）: 需要 100 确认
- 普通转账: 只需要 1 确认
- 内存池: 直接可用

### 统筹账户手续费储备

发群红包时，会额外预留每人 0.0023 SCASH 作为后续转账手续费。

## 开发调试

### 查看数据库

```bash
npx prisma studio
```

### 生成新区块 (Regtest)

```bash
# 生成 1 个区块到指定地址
curl -u scash:scash \
  -X POST http://127.0.0.1:18443 \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "method": "generatetoaddress",
    "params": [1, "<address>"],
    "id": 1
  }'
```

### 查看统筹账户余额

```bash
curl -u scash:scash \
  -X POST http://127.0.0.1:18443 \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "method": "getbalance",
    "params": ["*", 0, true],
    "id": 1
  }'
```

## 常见问题

### 1. 余额查询为 0

可能原因:

- 区块尚未同步完成
- UTXO Indexer 未追踪该地址

解决方案:

- 等待几秒钟让 Indexer 同步
- 检查日志确认地址已被追踪

### 2. 交易广播失败

可能原因:

- 余额不足（包括手续费）
- UTXO 已被花费
- coinbase 未成熟（需要 100 确认）

解决方案:

- 检查余额是否足够
- 检查是否是 coinbase 未成熟
- 生成新区块确认交易

### 3. 统筹账户转账失败

可能原因:

- 统筹账户余额不足
- 手续费储备不足

解决方案:

- 发红包时已预留手续费储备
- 检查统筹账户余额

### 4. Telegram Bot 不响应

检查:

- TELEGRAM_BOT_TOKEN 是否正确
- Bot 是否与 @BotFather 设置正确
- 是否有 webhook 冲突

## 下一步

1. 在 Telegram 中搜索并启动你的 Bot
2. 发送 `/start` 命令测试
3. 创建钱包并尝试发送红包
4. 邀请朋友加入群组测试抢红包

## 安全提示

1. 生产环境请使用主网而非 Regtest
2. 妥善保管 MASTER_KEY 和统筹账户助记词
3. 定期备份数据库
4. 启用 Telegram Bot 的隐私模式（群组中只响应 @提及）

## 性能优化建议

- 使用 Redis 缓存热点数据
- 对 UTXO 表按地址分区
- 启用 PostgreSQL 连接池
- 配置监控和告警
