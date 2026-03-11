# Scash Telegram 红包机器人 - 部署检查清单

## 前置检查

- [ ] Node.js 18+ 已安装 (`node --version`)
- [ ] PostgreSQL 14+ 已运行
- [ ] Scash Full Node (Regtest) 已运行且可访问
- [ ] Telegram Bot Token 已获取 (@BotFather)

## 环境配置

- [ ] 复制 `.env.example` 到 `.env`
- [ ] 配置 DATABASE_URL
- [ ] 配置 SCASH_RPC_URL / USER / PASS
- [ ] 配置 MASTER_KEY (32字节随机字符串)
- [ ] 配置 TELEGRAM_BOT_TOKEN
- [ ] 安装依赖: `npm install`
- [ ] 生成 Prisma 客户端: `npx prisma generate`

## 数据库初始化

- [ ] 数据库已创建: `createdb scash_bot`
- [ ] 应用迁移: `npx prisma migrate deploy`
- [ ] 验证表结构: `npx prisma studio`

## 统筹账户设置

- [ ] 运行初始化脚本: `npx ts-node scripts/init-pooling-account.ts`
- [ ] 备份助记词（非常重要！）
- [ ] 记录统筹账户地址
- [ ] 更新 .env 的 POOLING_ACCOUNT_ADDRESS
- [ ] （Regtest）生成测试资金

## 启动验证

- [ ] 启动应用: `npm run start:dev`
- [ ] 检查日志无错误
- [ ] UTXO Indexer 正常同步区块
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
- [ ] 创建均分红包
- [ ] 创建随机红包
- [ ] 抢红包
- [ ] 查看红包详情
- [ ] 过期退款（等待24小时或使用测试脚本）

### 统筹账户
- [ ] 未绑定用户抢红包资金进入统筹账户
- [ ] 绑定完整钱包后自动触发转账
- [ ] 批量转账处理正常

## 安全审计

- [ ] MASTER_KEY 强度足够（256位随机）
- [ ] MASTER_KEY 未提交到 Git
- [ ] .env 文件已添加到 .gitignore
- [ ] 助记词备份在离线安全位置
- [ ] 数据库连接使用独立用户（非 superuser）
- [ ] RPC 仅监听 localhost
- [ ] 防火墙已配置（如有）

## 生产环境额外检查

- [ ] 使用 PM2/ systemd 管理进程
- [ ] 配置日志轮转
- [ ] 配置监控告警
- [ ] 设置 SSL/TLS (如使用 Webhook)
- [ ] 配置 Telegram Webhook URL
- [ ] 禁用 polling 模式（生产环境推荐 Webhook）
- [ ] 配置错误告警（Sentry/Logrocket）
- [ ] 配置数据库备份
- [ ] 配置冷钱包备份

## 性能检查

- [ ] UTXO 表已添加索引
- [ ] PostgreSQL 连接池配置合理
- [ ] 区块同步无延迟
- [ ] 内存池监控正常
- [ ] 定时任务执行时间合理

## 文档和交接

- [ ] README 已更新
- [ ] API 文档已编写（如有）
- [ ] 运维手册已编写
- [ ] 应急响应流程已制定
- [ ] 密钥保管人已指定
- [ ] 团队成员已培训

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
npm --version

# 2. 检查数据库连接
npx prisma db pull

# 3. 检查 Scash 节点
curl -u scash:scash http://127.0.0.1:18443 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":1}'

# 4. 运行测试
npx ts-node scripts/test-redpacket.ts

# 5. 检查统筹账户余额
curl -u scash:scash http://127.0.0.1:18443 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"getbalance","params":[],"id":1}'
```

## 紧急联系

- 项目负责人: _________
- 技术负责人: _________
- 运维负责人: _________
- Telegram Bot: @YourBotUsername

---

**部署日期**: ___________

**部署人员**: ___________

**审核人员**: ___________
