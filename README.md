# Towwatch

双人同步观影 Web 应用。当前版本使用 Next.js + Socket.IO，并可接入 Redis 和 PostgreSQL。

## 本地启动

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>，创建或输入房间号后加入房间，页面会生成邀请链接。

## 生产构建

```bash
npm run build
npm start
```

## Docker

只运行应用：

```bash
docker build -t towwatch:latest .
docker run -d --name towwatch --restart unless-stopped -p 3000:3000 towwatch:latest
```

同时运行应用、Redis、PostgreSQL：

```bash
docker compose up -d --build
```

## 环境变量

- `PORT`: 应用端口，默认 `3000`
- `FETCH_TIMEOUT_MS`: 抓取在线源/页面的超时时间，默认 `60000`
- `SOURCE_FALLBACK_URLS`: 额外源列表备用地址，多个地址用英文逗号分隔
- `REDIS_URL`: Redis 地址，例如 `redis://redis:6379`
- `DATABASE_URL`: PostgreSQL 地址，例如 `postgres://towwatch:towwatch@postgres:5432/towwatch`
- `DATABASE_SSL`: 设为 `true` 时启用 PostgreSQL SSL

未配置 Redis/PostgreSQL 时，应用会自动使用内存房间状态，适合本地开发。

## 实现要点

- Next.js App Router 提供页面和 `/api/sources`、`/api/search`、`/api/episodes`、`/api/resolve`。
- Socket.IO 负责房间成员、聊天、视频 URL、播放/暂停/seek 同步。
- Redis 用于跨实例 Socket.IO adapter 和房间状态缓存。
- PostgreSQL 用于保存房间状态快照和聊天消息。
- 播放器基于 HTML5 Video API，通过时间戳补偿和周期性 drift 校准降低多端进度偏差。
