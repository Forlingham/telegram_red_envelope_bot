# Scash Telegram 红包机器人 - 部署检查清单

## 前置检查

- [ ] Node.js 18+ 已安装 (`node --version`)
- [ ] PostgreSQL 14+ 已运行
- [ ] Scash Full Node (Regtest) 已运行且可访问
- [ ] Scash ZMQ 已配置 (zmqpubrawblock, zmqpubrawtx)
- [ ] Telegram Bot Token 已获取 (@BotFather)

## 环境配置

- [ ] 复制 `.env.example` 到 `.env`
- [ ] 配置 DATABASE_URL
- [ ] 配置 SCASH_RPC_URL / USER / PASS
- [ ] 配置 ZMQ_BLOCK_URL / ZMQ_TX_URL
- [ ] 配置 MASTER_KEY (32字节随机字符串)
- [ ] 配置 TELEGRAM_BOT_TOKEN
- [ ] 配置 POOLING_ACCOUNT_ADDRESS (统筹账户地址)
- [ ] 配置 POOLING_ACCOUNT_MNEMONIC (统筹账户助记词)
- [ ] 安装依赖: `npm install`
- [ ] 生成 Prisma 客户端: `npx prisma generate`

## 数据库初始化

- [ ] 数据库已创建: `createdb scash_bot`
- [ ] 应用迁移: `npx prisma migrate deploy`
- [ ] 验证表结构: `npx prisma studio`

## 启动验证

- [ ] 启动应用: `npm run start:dev`
- [ ] 检查日志无错误
- [ ] UTXO Indexer 正常同步区块
- [ ] ZMQ 服务正常连接
- [ ] Telegram Bot 连接成功
- [ ] 定时任务正常注册

## 功能测试

### 基础功能

- [ ] `/start` 命令响应正常
- [ ] `/help` 显示帮助信息
- [ ] `/balance` 查询余额

### 钱包功能

- [ ] 绑定只读钱包: `/bind <地址>`
- [ ] 创建完整钱包: `/create` (私聊)
- [ ] 导入助记词: `/import` (私聊)

### 红包功能

- [ ] 创建定向红包
- [ ] 创建均分红包
- [ ] 创建随机红包
- [ ] 创建活跃红包
- [ ] 创建抽奖红包
- [ ] 抢红包
- [ ] 查看红包详情

### 统筹账户

- [ ] 未绑定用户抢红包资金进入统筹账户
- [ ] 绑定完整钱包后自动触发转账
- [ ] 红包被抢完立即触发转账
- [ ] `/process` 手动触发转账

## 安全审计

- [ ] MASTER_KEY 强度足够（256位随机）
- [ ] MASTER_KEY 未提交到 Git
- [ ] .env 文件已添加到 .gitignore
- [ ] 助记词备份在离线安全位置
- [ ] 数据库连接使用独立用户（非 superuser）
- [ ] RPC 仅监听 localhost
- [ ] ZMQ 仅监听 localhost
- [ ] 防火墙已配置（如有）

## 性能检查

- [ ] UTXO 表已添加索引
- [ ] PostgreSQL 连接池配置合理
- [ ] 区块同步无延迟
- [ ] ZMQ 监听正常
- [ ] 定时任务执行时间合理

## 文档和交接

- [ ] README 已更新
- [ ] 快速启动指南已更新
- [ ] 部署检查清单已更新
- [ ] 应急响应流程已制定

## 上线前最后检查

- [ ] 所有测试通过
- [ ] 错误日志已清理
- [ ] 数据库已重置（如果是新部署）
- [ ] 环境变量已确认
- [ ] 监控已启用
- [ ] 回滚方案已准备

---

## 快速验证命令

```bash
# 1. 检查环境
node --version

# 2. 检查数据库
npx prisma db pull

# 3. 检查 Scash 节点
curl -u scash:scash http://127.0.0.1:18443 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":1}'

# 4. 检查 ZMQ 端口
nc -z 127.0.0.1 28444
nc -z 127.0.0.1 28445

# 5. 查看统筹账户余额
curl -u scash:scash http://127.0.0.1:18443 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"getbalance","params":["*", 0, true],"id":1}'
```

## 紧急联系

- 项目负责人: ****\_****
- 技术负责人: ****\_****
- 运维负责人: ****\_****
- Telegram Bot: @YourBotUsername

---

**部署日期**: ****\_\_\_****

**部署人员**: ****\_\_\_****

**审核人员**: ****\_\_\_****
