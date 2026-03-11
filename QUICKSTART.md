# 快速启动指南

## 环境要求

- Node.js 18+
- PostgreSQL 14+
- Scash Full Node (Regtest 模式)

## 已配置的服务

- **PostgreSQL**: 已运行在 localhost:5432
- **Scash Node**: 已配置在 localhost:18443 (Regtest)
- **统筹账户**: 已创建并生成测试资金

## 统筹账户信息

```
地址: bcrt1qrpd4qqhkfkdkj33v80ca644jp6kkawwaxrj36j
助记词: first put correct armed option anchor link ranch bubble crowd level income mom diagram turtle party victory slow alarm vapor soldier rubber crystal high
```

⚠️ **重要**: 请安全备份助记词！这是恢复统筹账户的唯一方式。

## 快速启动

### 1. 启动应用

```bash
npm run start:dev
```

应用将启动在 http://localhost:5000

### 2. Telegram Bot

Bot 已配置，启动后会自动连接 Telegram 并监听消息。

支持的命令:
- `/start` - 开始使用
- `/help` - 帮助信息
- `/balance` - 查询余额
- `/bind <地址>` - 绑定只读钱包
- `/create` - 创建新钱包
- `/import` - 导入助记词
- `/send` - 发送红包

### 3. 测试脚本

运行集成测试:

```bash
npx ts-node scripts/test-redpacket.ts
```

这将测试:
- 创建钱包
- 创建均分/随机红包
- 抢红包
- 查询红包详情

## 核心功能验证

### UTXO 索引服务

每 10 秒自动同步区块，每分钟检查内存池。

查看日志确认:
```
[UtxoIndexerService] Starting block synchronization...
[UtxoIndexerService] Block synchronization completed
```

### 定时任务

- **每 5 分钟**: 处理统筹账户转账
- **每小时**: 处理过期红包退款

### 内存池预判

交易广播后立即预存找零 UTXO，支持高频红包发放。

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
    "params": [],
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

解决方案:
- 检查余额是否足够
- 生成新区块确认交易

### 3. Telegram Bot 不响应

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
