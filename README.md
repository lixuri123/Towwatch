# Towwatch

轻量双人同步观影 Web 应用，支持房间创建、在线视频 URL 播放、播放/暂停/seek 同步和实时聊天。

## 启动

```bash
npm start
```

打开 <http://localhost:3000>，创建房间后把邀请链接发给另一位观影伙伴。

## 实现要点

- `server.js` 使用 Node 原生 `http` 和轻量 WebSocket 握手/帧处理，无需安装依赖。
- 房间状态维护 `videoUrl`、`currentTime`、`isPlaying`、`members`、`updatedAt` 和 `version`。
- 在线源默认加载 `https://raw.githubusercontent.com/MajoSissi/animeko-source/main/dist/online.json`，支持源列表、搜索、剧集提取和播放地址解析。
- 客户端通过 `sync_ping/sync_pong` 估算本地时钟与服务端时钟偏移，再用 `updatedAt` 计算远端有效播放时间。
- 播放中周期性校准 drift：小偏差调整 `playbackRate`，大偏差直接 seek 到服务端基准时间。
- 播放器基于 HTML5 Video API，并用远端状态事件驱动本地 `play()`、`pause()` 和 `currentTime`。
