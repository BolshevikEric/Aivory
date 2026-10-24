<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<picture>
  <source media="(max-width: 600px)" srcset="docs/brand/readme-header-compact.svg">
  <img src="docs/brand/readme-header.svg" alt="Aivory — 自部署 AI 工作空间" width="100%">
</picture>

# Aivory

Aivory 是一个可自部署的 AI 工作空间，提供多模型对话、知识检索、工具协作和团队功能。支持个人与团队部署，数据保存在你管理的基础设施中。

[部署指南](deploy/README.zh-CN.md) · [产品文档](https://docs.aivorygo.com) · [在线体验](https://demo.aivorygo.com)

## 部署

需要 Docker 24 或更新版本及 Docker Compose 插件。个人版使用 SQLite，适合单机部署；完整版使用 PostgreSQL、Redis、Qdrant，并包含 Python 沙箱。

### 完整版

```bash
git clone https://github.com/hjxwz123/Aivory.git
cd Aivory/deploy
cp .env.example .env
```

编辑 `.env`，为 `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 和 `JWT_SECRET` 设置强密码。使用域名或 HTTPS 反向代理时，还要将 `ALLOWED_ORIGINS` 设置为网站的准确 Origin，例如 `https://chat.example.com`。

```bash
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
```

打开服务器地址进入初始化页面。第一个创建的账号会成为管理员，然后在「管理后台 → 渠道」中添加模型服务商凭据。

### 个人版

```bash
git clone https://github.com/hjxwz123/Aivory.git
cd Aivory/deploy
cp .env.personal.example .env.personal
```

在 `.env.personal` 中设置 `JWT_SECRET`；使用域名或 HTTPS 反向代理时，也要设置 `ALLOWED_ORIGINS`。

```bash
docker compose --env-file .env.personal -f docker-compose.personal.yml pull
docker compose --env-file .env.personal -f docker-compose.personal.yml up -d
```

个人版使用单个 SQLite 数据库，适用于单个 app 实例。持久化数据位于 `DATA_DIR`，默认是 `deploy/data-personal`。

### 升级与恢复

部署指定版本时，在正在使用的环境文件中将 `IMAGE_TAG` 设置为版本号（不带开头的 `v`）。如果设置了 `APP_IMAGE_TAG` 或 `SANDBOX_IMAGE_TAG`，也要改成同一版本。保留现有数据卷和 `DATA_DIR`。

```bash
# 完整版
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d --no-build

# 个人版
docker compose --env-file .env.personal -f docker-compose.personal.yml pull
docker compose --env-file .env.personal -f docker-compose.personal.yml up -d --no-build
```

恢复全量备份时，将 ZIP 放入 `BACKUP_DIR`。完整版的默认宿主机目录是 `deploy/data/backups`，个人版是 `deploy/data-personal/backups`。进入「管理后台 → 备份与迁移」，选择「从服务器目录恢复」并输入 `REPLACE`。恢复会替换当前全部数据；请先单独备份目标服务器，并保留原归档副本。

指定版本部署、代理配置、存储目录和恢复处理步骤见[部署指南](deploy/README.zh-CN.md)。

## 参与贡献

较大的改动建议先提交 issue 讨论。Pull Request 请说明用户可见的变化，并附上相关测试。根据改动范围运行检查，例如：

```bash
npm run lint
npm run build
cd server && go test ./... && go vet ./...
```

## 致谢

感谢 [Qdrant](https://qdrant.tech/)、[Radix UI](https://www.radix-ui.com/) 背后的开源社区，以及所有参与改进 Aivory 的项目和贡献者。

## 开源协议

[Apache License 2.0](./LICENSE)。
