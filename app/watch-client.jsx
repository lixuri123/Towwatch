"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/MajoSissi/animeko-source/main/dist/online.json";
const PREFERRED_SOURCE_NAME = "高清点播";

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatTime(date = Date.now()) {
  return new Date(date).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatWatchTime(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const rest = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatRelativeTime(timestamp) {
  const time = Number(timestamp || 0);
  if (!time) return "";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return `${Math.floor(diffHours / 24)} 天前`;
}

function coverFallback(name) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 450">
      <rect width="320" height="450" fill="#10201e"/>
      <rect x="24" y="24" width="272" height="402" rx="18" fill="#0f766e"/>
      <text x="160" y="226" text-anchor="middle" font-size="34" font-family="Arial" font-weight="700" fill="white">${String(name || "Anime").slice(0, 4)}</text>
    </svg>
  `)}`;
}

async function apiGet(path, params) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "请求失败。");
    error.data = data;
    error.url = url.toString();
    throw error;
  }
  return data;
}

function buildInviteLink(roomId) {
  if (typeof window === "undefined" || !roomId) return "";
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
}

export default function WatchClient() {
  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const lastLocalActionRef = useRef(0);
  const lastProgressSentRef = useRef(0);
  const stateRef = useRef(null);
  const clockOffsetRef = useRef(0);

  const [connection, setConnection] = useState({ text: "未连接", tone: "" });
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [members, setMembers] = useState([]);
  const [memberCount, setMemberCount] = useState("0/2");
  const [inviteLink, setInviteLink] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [manualVideoUrl, setManualVideoUrl] = useState("");
  const [emptyVideo, setEmptyVideo] = useState(true);
  const [driftText, setDriftText] = useState("等待校准");

  const [sourceStatus, setSourceStatus] = useState("加载源中");
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SOURCE_URL);
  const [sources, setSources] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchEmpty, setSearchEmpty] = useState("输入片名开始搜索");
  const [selectedItem, setSelectedItem] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyStatus, setHistoryStatus] = useState("加入房间后查看历史");
  const [sidePanel, setSidePanel] = useState("chat");
  const [operationLog, setOperationLog] = useState([]);
  const [loadingKey, setLoadingKey] = useState("");

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) || null,
    [sources, selectedSourceId]
  );

  function writeOperation(title, payload) {
    setOperationLog((entries) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        title: `${formatTime()} ${title}`,
        payload
      },
      ...entries
    ].slice(0, 40));
  }

  function appendMessage(message) {
    setMessages((items) => [
      ...items,
      {
        id: message.id || `${Date.now()}-${Math.random()}`,
        createdAt: message.createdAt || Date.now(),
        ...message
      }
    ].slice(-80));
  }

  function upsertHistoryItem(item) {
    if (!item?.videoUrl) return;
    const key = item.historyKey || item.videoUrl;
    setHistoryItems((items) => [
      item,
      ...items.filter((historyItem) => (historyItem.historyKey || historyItem.videoUrl) !== key)
    ].slice(0, 20));
  }

  async function loadHistory(nextRoomId = roomId) {
    const cleanRoomId = String(nextRoomId || "").trim();
    if (!cleanRoomId) {
      setHistoryStatus("加入房间后查看历史");
      setHistoryItems([]);
      return;
    }

    setHistoryStatus("读取历史中");
    try {
      const data = await apiGet("/api/history", { roomId: cleanRoomId });
      setHistoryItems(data.items || []);
      setHistoryStatus(data.items?.length ? "" : "这个房间还没有观看记录");
    } catch (error) {
      setHistoryStatus(error.message);
    }
  }

  function estimateCurrentTime(state) {
    if (!state?.isPlaying) return Number(state?.currentTime || 0);
    const serverNow = Date.now() + clockOffsetRef.current;
    return Number(state.currentTime || 0) + Math.max(0, serverNow - Number(state.updatedAt || serverNow)) / 1000;
  }

  function applyRemoteState(state, reason) {
    stateRef.current = state;
    setMembers(state.members || []);
    setMemberCount(`${(state.members || []).length}/2`);
    setEmptyVideo(!state.videoUrl);

    const video = videoRef.current;
    if (!video) return;

    applyingRemoteRef.current = true;
    if (state.videoUrl && video.src !== state.videoUrl) {
      video.src = state.videoUrl;
      setManualVideoUrl(state.videoUrl);
    }

    if (state.videoUrl) {
      const targetTime = estimateCurrentTime(state);
      if (Number.isFinite(targetTime) && Math.abs(video.currentTime - targetTime) > 0.75) {
        video.currentTime = targetTime;
      }

      if (state.isPlaying && video.paused) {
        video.play().catch(() => {
          appendMessage({ text: "浏览器阻止了自动播放，请手动点一下播放按钮。", system: true });
        });
      } else if (!state.isPlaying && !video.paused) {
        video.pause();
      }
    }

    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 120);

    if (reason === "video") appendMessage({ text: "房间视频已更新。", system: true });
  }

  function sendSocket(event, payload) {
    const socket = socketRef.current;
    if (!socket?.connected) return false;
    socket.emit(event, payload);
    return true;
  }

  function connectToRoom(nextRoomId, nextName) {
    if (socketRef.current) socketRef.current.disconnect();

    const cleanRoomId = nextRoomId.trim() || createRoomId();
    const cleanName = nextName.trim() || "观影伙伴";
    const socket = io({
      transports: ["websocket", "polling"],
      reconnectionAttempts: 8
    });
    socketRef.current = socket;

    setRoomId(cleanRoomId);
    setName(cleanName);
    setInviteLink(buildInviteLink(cleanRoomId));
    setMessages([]);
    setHistoryItems([]);
    setHistoryStatus("读取历史中");
    setConnection({ text: "连接中", tone: "" });

    socket.on("connect", () => {
      socket.emit("room:join", { roomId: cleanRoomId, name: cleanName });
      socket.emit("sync:ping", { clientSentAt: Date.now() });
    });

    socket.on("room:welcome", (message) => {
      setMemberId(message.memberId);
      clockOffsetRef.current = message.serverNow - Date.now();
      setConnection({ text: "已连接", tone: "is-online" });
      appendMessage({ text: `已加入房间 ${cleanRoomId}。`, system: true });
      applyRemoteState(message.state, "welcome");
      loadHistory(cleanRoomId);
    });

    socket.on("sync:pong", (message) => {
      const receivedAt = Date.now();
      const roundTrip = Math.max(0, receivedAt - Number(message.clientSentAt || receivedAt));
      clockOffsetRef.current = message.serverNow + roundTrip / 2 - receivedAt;
    });

    socket.on("room:state", ({ reason, state }) => {
      if (!stateRef.current || state.version >= stateRef.current.version) {
        applyRemoteState(state, reason);
      }
    });

    socket.on("chat:message", appendMessage);
    socket.on("history:updated", ({ item } = {}) => {
      if (item) {
        upsertHistoryItem(item);
        setHistoryStatus("");
      } else {
        loadHistory(cleanRoomId);
      }
    });
    socket.on("chat:history", ({ messages: history = [] } = {}) => {
      setMessages((items) => {
        const systemMessages = items.filter((item) => item.system);
        const merged = [...history, ...systemMessages];
        const unique = new Map();
        for (const item of merged) unique.set(item.id, item);
        return Array.from(unique.values()).slice(-80);
      });
    });
    socket.on("room:system", (message) => appendMessage({ ...message, system: true }));

    socket.on("room:error", (message) => {
      setConnection({ text: "错误", tone: "is-error" });
      appendMessage({ text: message.message || "发生错误。", system: true });
    });

    socket.on("disconnect", () => {
      setConnection({ text: "已断开", tone: "is-error" });
    });
  }

  function setRoomVideo(videoUrl, media = {}, currentTime = 0, duration = 0) {
    if (!videoUrl.trim()) return;
    if (!sendSocket("video:set", {
      videoUrl: videoUrl.trim(),
      media,
      currentTime,
      duration: duration || videoRef.current?.duration || 0
    })) {
      appendMessage({ text: "请先加入房间。", system: true });
    }
  }

  async function loadSources(nextSourceUrl = DEFAULT_SOURCE_URL) {
    setSourceStatus("加载源中");
    setSearchEmpty("输入片名开始搜索");
    writeOperation("加载源: 请求", { sourceUrl: nextSourceUrl, preferredSourceName: PREFERRED_SOURCE_NAME });

    try {
      const data = await apiGet("/api/sources", { url: nextSourceUrl });
      const allSources = data.sources || [];
      const preferredSource = allSources.find((source) => source.name === PREFERRED_SOURCE_NAME);
      const firstSource = preferredSource || allSources[0] || null;
      setSourceUrl(data.sourceUrl);
      setSources(allSources);
      setSelectedSourceId(firstSource?.id || "");
      setSourceStatus(firstSource ? `${allSources.length} 个源 · 当前 ${firstSource.name}` : "没有可用源");
      writeOperation("加载源: 结果", {
        totalCount: data.count,
        selectedSource: firstSource,
        availableSourceNames: (data.sources || []).map((source) => source.name).slice(0, 12),
        availableSourceNamesTruncated: Math.max(0, (data.sources || []).length - 12)
      });
      if (!allSources.length) setSearchEmpty("当前源列表里没有可搜索的源。");
    } catch (error) {
      setSourceStatus("加载失败");
      setSearchEmpty(error.message);
      writeOperation("加载源: 错误", { message: error.message, data: error.data, url: error.url });
    }
  }

  async function searchSelectedSource(event) {
    event?.preventDefault();
    const query = keyword.trim();
    if (!query || !selectedSourceId) return;

    setSourceStatus("搜索中");
    setSearchEmpty("搜索中");
    setSearchResults([]);
    setSelectedItem(null);
    setEpisodes([]);
    writeOperation("搜索: 请求", {
      sourceName: selectedSource?.name || selectedSourceId,
      sourceUrl,
      sourceId: selectedSourceId,
      query
    });

    try {
      const data = await apiGet("/api/search", {
        sourceUrl,
        sourceId: selectedSourceId,
        q: query
      });
      setSearchResults(data.items || []);
      setSourceStatus(`${data.items.length} 个结果`);
      if (!data.items.length) setSearchEmpty("没有搜索结果");
      writeOperation("搜索: 结果", data);
    } catch (error) {
      setSourceStatus("搜索失败");
      setSearchEmpty(error.message);
      writeOperation("搜索: 错误", { message: error.message, data: error.data, url: error.url });
    }
  }

  async function loadEpisodesForResult(item) {
    setLoadingKey(`episodes:${item.url}`);
    setSourceStatus("读取剧集");
    setSelectedItem(item);
    setEpisodes([]);
    writeOperation("选集: 点击结果", {
      sourceName: selectedSource?.name || selectedSourceId,
      sourceId: selectedSourceId,
      item
    });

    try {
      const episodeData = await apiGet("/api/episodes", {
        sourceUrl,
        sourceId: selectedSourceId,
        url: item.url
      });
      const nextEpisodes = episodeData.episodes || [];
      setEpisodes(nextEpisodes);
      setSourceStatus(nextEpisodes.length ? `${nextEpisodes.length} 集` : "没有剧集");
      writeOperation("选集: 剧集结果", episodeData);
    } catch (error) {
      setSourceStatus("读取失败");
      appendMessage({ text: error.message, system: true });
      writeOperation("选集: 错误", { message: error.message, data: error.data, url: error.url });
    } finally {
      setLoadingKey("");
    }
  }

  async function resolveEpisode(episode) {
    if (!selectedItem) return;
    setLoadingKey(`resolve:${episode.url}`);
    setSourceStatus("解析播放地址");
    writeOperation("播放: 点击剧集", {
      sourceName: selectedSource?.name || selectedSourceId,
      sourceId: selectedSourceId,
      item: selectedItem,
      episode
    });

    try {
      const videoData = await apiGet("/api/resolve", {
        sourceUrl,
        sourceId: selectedSourceId,
        url: episode.url,
        debug: "1"
      });
      writeOperation("播放: 解析结果", videoData);
      setRoomVideo(videoData.videoUrl, {
        title: selectedItem.name,
        episodeName: episode.name,
        sourceName: selectedSource?.name || "",
        imageUrl: selectedItem.imageUrl || "",
        episodeUrl: episode.url,
        historyKey: episode.url || videoData.videoUrl
      });
      setSourceStatus("已载入");
      writeOperation("播放: 载入视频", {
        itemName: selectedItem.name,
        episodeName: episode.name,
        videoUrl: videoData.videoUrl
      });
      appendMessage({ text: `已载入：${selectedItem.name} ${episode.name || ""}`, system: true });
    } catch (error) {
      setSourceStatus("解析失败");
      appendMessage({ text: error.message, system: true });
      writeOperation("播放: 错误", { message: error.message, data: error.data, url: error.url });
    } finally {
      setLoadingKey("");
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    if (roomFromUrl) setRoomId(roomFromUrl);
    loadSources();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      sendSocket("sync:ping", { clientSentAt: Date.now() });
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current;
      const state = stateRef.current;
      if (!video || !state?.videoUrl || !state.isPlaying || applyingRemoteRef.current) return;

      const drift = video.currentTime - estimateCurrentTime(state);
      setDriftText(`偏差 ${Math.abs(drift).toFixed(2)}s`);

      if (Date.now() - lastLocalActionRef.current < 800) return;
      if (Math.abs(drift) > 1.2) {
        applyingRemoteRef.current = true;
        video.currentTime = estimateCurrentTime(state);
        setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 120);
      } else if (Math.abs(drift) > 0.25) {
        video.playbackRate = drift > 0 ? 0.97 : 1.03;
      } else {
        video.playbackRate = 1;
      }
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => () => socketRef.current?.disconnect(), []);

  return (
    <main className="app-shell">
      <section className="watch-area" aria-label="同步观影">
        <header className="topbar">
          <div>
            <p className="eyebrow">Towwatch</p>
            <h1>双人同步观影</h1>
          </div>
          <div className={`connection-pill ${connection.tone}`}>{connection.text}</div>
        </header>

        <div className="video-shell">
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            onPlay={() => {
              if (applyingRemoteRef.current) return;
              lastLocalActionRef.current = Date.now();
              sendSocket("video:control", {
                action: "play",
                currentTime: videoRef.current?.currentTime || 0,
                isPlaying: true,
                duration: videoRef.current?.duration || 0
              });
            }}
            onPause={() => {
              if (applyingRemoteRef.current) return;
              lastLocalActionRef.current = Date.now();
              sendSocket("video:control", {
                action: "pause",
                currentTime: videoRef.current?.currentTime || 0,
                isPlaying: false,
                duration: videoRef.current?.duration || 0
              });
            }}
            onSeeked={() => {
              if (applyingRemoteRef.current) return;
              lastLocalActionRef.current = Date.now();
              sendSocket("video:control", {
                action: "seek",
                currentTime: videoRef.current?.currentTime || 0,
                isPlaying: !videoRef.current?.paused,
                duration: videoRef.current?.duration || 0
              });
            }}
            onTimeUpdate={() => {
              const video = videoRef.current;
              if (!video || applyingRemoteRef.current || !stateRef.current?.videoUrl) return;
              if (Date.now() - lastProgressSentRef.current < 15000) return;
              lastProgressSentRef.current = Date.now();
              sendSocket("video:progress", {
                currentTime: video.currentTime || 0,
                duration: video.duration || 0,
                isPlaying: !video.paused
              });
            }}
          />
          {emptyVideo ? (
            <div className="empty-video">
              <strong>搜索动漫，选集后自动同步</strong>
              <span>也可以粘贴浏览器可直接播放的视频 URL。</span>
            </div>
          ) : null}
        </div>

        <form className="video-form" onSubmit={(event) => {
          event.preventDefault();
          setRoomVideo(manualVideoUrl, {
            title: "手动视频",
            sourceName: "手动输入",
            historyKey: manualVideoUrl
          }, videoRef.current?.currentTime || 0);
        }}>
          <label className="field field-grow">
            <span>视频 URL</span>
            <input
              value={manualVideoUrl}
              onChange={(event) => setManualVideoUrl(event.target.value)}
              type="url"
              placeholder="https://example.com/movie.mp4"
              autoComplete="off"
            />
          </label>
          <button type="submit">载入视频</button>
        </form>

        <section className="anime-search" aria-label="搜索动漫">
          <div className="search-head">
            <div>
              <h2>搜索动漫</h2>
              <span>{sourceStatus}</span>
            </div>
            <label className="source-switch">
              <span>源</span>
              <select
                value={selectedSourceId}
                onChange={(event) => {
                  const nextSourceId = event.target.value;
                  const nextSource = sources.find((source) => source.id === nextSourceId);
                  setSelectedSourceId(nextSourceId);
                  setSearchResults([]);
                  setSelectedItem(null);
                  setEpisodes([]);
                  setSearchEmpty("输入片名开始搜索");
                  setSourceStatus(nextSource ? `当前 ${nextSource.name}` : "请选择源");
                  writeOperation("切换源", { selectedSource: nextSource || null });
                }}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.defaultResolution ? `${source.name} · ${source.defaultResolution}` : source.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <form className="anime-search-form" onSubmit={searchSelectedSource}>
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              type="search"
              placeholder="搜索动漫名称"
              autoComplete="off"
            />
            <button type="submit" disabled={!selectedSource}>
              搜索
            </button>
          </form>

          <div className="anime-results">
            {searchResults.length ? searchResults.map((item) => (
              <article className="anime-card" key={`${item.name}-${item.url}`}>
                <img
                  className="anime-cover"
                  alt={item.name}
                  src={item.imageUrl || coverFallback(item.name)}
                  onError={(event) => {
                    event.currentTarget.src = coverFallback(item.name);
                  }}
                />
                <div className="anime-card-body">
                  <h3>{item.name}</h3>
                  <button
                    type="button"
                    disabled={loadingKey === `episodes:${item.url}`}
                    onClick={() => loadEpisodesForResult(item)}
                  >
                    {loadingKey === `episodes:${item.url}` ? "读取中" : "选集"}
                  </button>
                </div>
              </article>
            )) : <div className="search-empty">{searchEmpty}</div>}
          </div>

          {selectedItem ? (
            <div className="episode-results is-visible">
              <div className="episode-heading">
                <h3>{selectedItem.name}</h3>
                <span>{episodes.length} 集</span>
              </div>
              {episodes.length ? (
                <div className="episode-grid">
                  {episodes.map((episode) => (
                    <button
                      className="episode-button"
                      key={episode.url}
                      type="button"
                      title={episode.name}
                      disabled={loadingKey === `resolve:${episode.url}`}
                      onClick={() => resolveEpisode(episode)}
                    >
                      {loadingKey === `resolve:${episode.url}` ? "解析中" : episode.name}
                    </button>
                  ))}
                </div>
              ) : <div className="search-empty">这个结果没有解析到剧集，请换一个搜索结果。</div>}
            </div>
          ) : null}
        </section>

        <details className="debug-panel">
          <summary className="debug-summary">
            <span>操作输出</span>
            <span>{operationLog.length} 条</span>
          </summary>
          <div className="section-title debug-tools">
            <h2>调试记录</h2>
            <button className="ghost-button" type="button" onClick={() => setOperationLog([])}>清空</button>
          </div>
          <div className="operation-log">
            {operationLog.map((entry) => (
              <div className="operation-entry" key={entry.id}>
                <strong>{entry.title}</strong>
                <code>{JSON.stringify(entry.payload, null, 2)}</code>
              </div>
            ))}
          </div>
        </details>

        <div className="sync-strip" aria-live="polite">
          <span>{driftText}</span>
          <span>{roomId ? `房间 ${roomId}` : "创建或加入房间后开始同步。"}</span>
        </div>
      </section>

      <aside className="side-panel" aria-label="房间、聊天与历史">
        <section className="side-dock">
          <div className="side-tabs" role="tablist" aria-label="侧边面板">
            {[
              { id: "room", label: "房间" },
              { id: "chat", label: "聊天", badge: memberCount },
              { id: "history", label: "历史", badge: historyItems.length || "" }
            ].map((tab) => (
              <button
                key={tab.id}
                className={`side-tab ${sidePanel === tab.id ? "is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={sidePanel === tab.id}
                onClick={() => setSidePanel(tab.id)}
              >
                <span>{tab.label}</span>
                {tab.badge ? <small>{tab.badge}</small> : null}
              </button>
            ))}
          </div>

          <div className="side-panel-content">
            {sidePanel === "room" ? (
              <section className="room-box side-section" aria-label="房间">
                <div className="section-title">
                  <h2>房间</h2>
                  <button className="ghost-button" type="button" onClick={() => setRoomId(createRoomId())}>创建</button>
                </div>

                <form className="room-form" onSubmit={(event) => {
                  event.preventDefault();
                  connectToRoom(roomId || createRoomId(), name);
                }}>
                  <label className="field">
                    <span>昵称</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      type="text"
                      maxLength={24}
                      placeholder="你的名字"
                      autoComplete="name"
                    />
                  </label>
                  <label className="field">
                    <span>房间号</span>
                    <input
                      value={roomId}
                      onChange={(event) => setRoomId(event.target.value)}
                      type="text"
                      maxLength={32}
                      placeholder="例如 A7K2Q9"
                      autoComplete="off"
                    />
                  </label>
                  <button type="submit">加入房间</button>
                </form>

                <div className="room-share">
                  <input value={inviteLink} readOnly placeholder="加入房间后生成邀请链接" />
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={async () => {
                      if (!inviteLink) return;
                      await navigator.clipboard.writeText(inviteLink);
                      appendMessage({ text: "邀请链接已复制。", system: true });
                    }}
                  >
                    复制
                  </button>
                </div>

                <div className="members">
                  {members.length ? members.map((member) => (
                    <div className="member" key={member.id}>
                      <span className="avatar">{(member.name || "?").slice(0, 1).toUpperCase()}</span>
                      <span>{member.id === memberId ? `${member.name}（你）` : member.name}</span>
                    </div>
                  )) : <div className="member-empty">还没有加入房间</div>}
                </div>
              </section>
            ) : null}

            {sidePanel === "chat" ? (
              <section className="chat-box side-section" aria-label="聊天">
                <div className="section-title">
                  <h2>聊天</h2>
                  <span>{memberCount}</span>
                </div>
                <div className="messages" aria-live="polite">
                  {messages.map((message) => {
                    const messageClassName = [
                      "message",
                      message.system ? "is-system" : "",
                      !message.system && message.memberId === memberId ? "is-mine" : "",
                      !message.system && message.memberId !== memberId ? "is-theirs" : ""
                    ].filter(Boolean).join(" ");

                    return (
                      <div className={messageClassName} key={message.id}>
                        <div className="message-meta">
                          <span>{message.system ? "系统" : message.name}</span>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <p>{message.text}</p>
                      </div>
                    );
                  })}
                </div>
                <form className="chat-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!chatText.trim()) return;
                  if (sendSocket("chat:send", { text: chatText })) setChatText("");
                }}>
                  <input
                    value={chatText}
                    onChange={(event) => setChatText(event.target.value)}
                    type="text"
                    maxLength={500}
                    placeholder="说点什么"
                    autoComplete="off"
                  />
                  <button type="submit">发送</button>
                </form>
              </section>
            ) : null}

            {sidePanel === "history" ? (
              <section className="history-box side-section" aria-label="观看历史">
                <div className="section-title">
                  <h2>观看历史</h2>
                  <button className="ghost-button" type="button" onClick={() => loadHistory()}>
                    刷新
                  </button>
                </div>
                <div className="history-list">
                  {historyItems.length ? historyItems.map((item) => {
                    const percent = item.duration ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) : 0;
                    return (
                      <article className="history-item" key={item.historyKey || item.videoUrl}>
                        <img
                          className="history-cover"
                          alt={item.title}
                          src={item.imageUrl || coverFallback(item.title)}
                          onError={(event) => {
                            event.currentTarget.src = coverFallback(item.title);
                          }}
                        />
                        <div className="history-body">
                          <h3>{item.title}</h3>
                          <p>{[item.episodeName, item.sourceName].filter(Boolean).join(" · ") || "手动视频"}</p>
                          <div className="history-progress" aria-label={`已观看 ${percent}%`}>
                            <span style={{ width: `${percent}%` }} />
                          </div>
                          <div className="history-meta">
                            <span>
                              {formatWatchTime(item.currentTime)}
                              {item.duration ? ` / ${formatWatchTime(item.duration)}` : ""}
                            </span>
                            <span>{formatRelativeTime(item.lastWatchedAt)}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setRoomVideo(item.videoUrl, item, item.currentTime, item.duration);
                              appendMessage({ text: `继续观看：${item.title}${item.episodeName ? ` ${item.episodeName}` : ""}`, system: true });
                            }}
                          >
                            继续观看
                          </button>
                        </div>
                      </article>
                    );
                  }) : <div className="history-empty">{historyStatus}</div>}
                </div>
              </section>
            ) : null}
          </div>
        </section>
      </aside>
    </main>
  );
}
