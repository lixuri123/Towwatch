const DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/MajoSissi/animeko-source/main/dist/online.json";
const ONLY_SOURCE_NAME = "高清点播";
const MAX_DRIFT_SOFT = 0.28;
const MAX_DRIFT_HARD = 1.1;
const DRIFT_CHECK_MS = 1800;
const CLOCK_SYNC_MS = 5000;

const dom = {
  video: document.querySelector("#video"),
  emptyVideo: document.querySelector("#emptyVideo"),
  connectionStatus: document.querySelector("#connectionStatus"),
  roomHint: document.querySelector("#roomHint"),
  driftText: document.querySelector("#driftText"),
  videoForm: document.querySelector("#videoForm"),
  videoUrl: document.querySelector("#videoUrl"),
  sourceStatus: document.querySelector("#sourceStatus"),
  sourceSearchForm: document.querySelector("#sourceSearchForm"),
  sourceSelect: document.querySelector("#sourceSelect"),
  sourceKeyword: document.querySelector("#sourceKeyword"),
  searchResults: document.querySelector("#searchResults"),
  episodeResults: document.querySelector("#episodeResults"),
  clearLogButton: document.querySelector("#clearLogButton"),
  operationLog: document.querySelector("#operationLog"),
  createRoomButton: document.querySelector("#createRoomButton"),
  roomForm: document.querySelector("#roomForm"),
  nameInput: document.querySelector("#nameInput"),
  roomInput: document.querySelector("#roomInput"),
  shareLink: document.querySelector("#shareLink"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  members: document.querySelector("#members"),
  memberCount: document.querySelector("#memberCount"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput")
};

const appState = {
  socket: null,
  memberId: "",
  roomId: "",
  clockOffset: 0,
  currentState: null,
  applyingRemote: false,
  localActionTimer: 0,
  sourceUrl: DEFAULT_SOURCE_URL,
  sources: [],
  selectedSourceId: ""
};

function createRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function setConnectionStatus(text, mode = "") {
  dom.connectionStatus.textContent = text;
  dom.connectionStatus.className = `connection-pill ${mode}`.trim();
}

function setSourceStatus(text) {
  dom.sourceStatus.textContent = text;
}

function appendMessage({ name = "系统", text, createdAt = Date.now(), system = false }) {
  const item = document.createElement("article");
  item.className = `message ${system ? "is-system" : ""}`.trim();

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.textContent = name;
  const time = document.createElement("time");
  time.textContent = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.append(author, time);

  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = text;

  item.append(meta, body);
  dom.messages.append(item);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function send(message) {
  if (!appState.socket || appState.socket.readyState !== WebSocket.OPEN) return false;
  appState.socket.send(JSON.stringify(message));
  return true;
}

async function apiGet(path, params) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || "请求失败");
    error.data = data;
    error.url = url.toString();
    throw error;
  }
  return data;
}

function compactForLog(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(compactForLog);
  }

  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.length > 500) {
      output[key] = `${item.slice(0, 500)}...`;
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 12).map(compactForLog);
      if (item.length > 12) output[`${key}Truncated`] = item.length - 12;
    } else if (item && typeof item === "object") {
      output[key] = compactForLog(item);
    } else {
      output[key] = item;
    }
  }
  return output;
}

function writeOperation(title, payload) {
  const entry = document.createElement("div");
  entry.className = "operation-entry";
  const heading = document.createElement("strong");
  heading.textContent = `${new Date().toLocaleTimeString()} ${title}`;
  const body = document.createElement("code");
  body.textContent = JSON.stringify(compactForLog(payload), null, 2);
  entry.append(heading, body);
  dom.operationLog.prepend(entry);
}

function estimatedServerNow() {
  return Date.now() + appState.clockOffset;
}

function effectiveRemoteTime(state = appState.currentState) {
  if (!state) return 0;
  if (!state.isPlaying) return state.currentTime;
  return state.currentTime + Math.max(0, estimatedServerNow() - state.updatedAt) / 1000;
}

function markLocalAction() {
  appState.localActionTimer = Date.now();
}

function isRecentLocalAction() {
  return Date.now() - appState.localActionTimer < 700;
}

function setLocalVideo(videoUrl) {
  appState.applyingRemote = true;
  dom.video.src = videoUrl;
  dom.videoUrl.value = videoUrl;
  dom.emptyVideo.classList.add("is-hidden");
  window.setTimeout(() => {
    appState.applyingRemote = false;
  }, 120);
}

function setRoomVideo(videoUrl) {
  if (send({ type: "set_video", videoUrl })) {
    return true;
  }

  setLocalVideo(videoUrl);
  appendMessage({ text: "未加入房间，已先在本机载入视频。", system: true });
  return false;
}

function applyRemoteState(state, reason = "state") {
  appState.currentState = state;
  renderMembers(state.members || []);
  dom.memberCount.textContent = `${(state.members || []).length}/2`;

  if (state.videoUrl && dom.video.src !== state.videoUrl) {
    setLocalVideo(state.videoUrl);
  }

  if (!state.videoUrl) {
    dom.emptyVideo.classList.remove("is-hidden");
    return;
  }

  const targetTime = effectiveRemoteTime(state);
  const drift = targetTime - dom.video.currentTime;

  appState.applyingRemote = true;

  if (Math.abs(drift) > 0.42 || reason === "seek" || reason === "video") {
    dom.video.currentTime = Math.max(0, targetTime);
  }

  if (state.isPlaying && dom.video.paused) {
    dom.video.play().catch(() => {
      appendMessage({
        text: "浏览器阻止了自动播放，请手动点一下播放按钮。",
        system: true
      });
    });
  } else if (!state.isPlaying && !dom.video.paused) {
    dom.video.pause();
  }

  window.setTimeout(() => {
    appState.applyingRemote = false;
  }, 120);
}

function renderMembers(members) {
  dom.members.replaceChildren();

  if (!members.length) {
    const empty = document.createElement("div");
    empty.className = "member";
    empty.textContent = "还没有加入房间";
    dom.members.append(empty);
    return;
  }

  for (const member of members) {
    const item = document.createElement("div");
    item.className = "member";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (member.name || "?").slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.textContent = member.id === appState.memberId ? `${member.name}（你）` : member.name;
    item.append(avatar, name);
    dom.members.append(item);
  }
}

function renderSearchEmpty(text) {
  dom.searchResults.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "search-empty";
  empty.textContent = text;
  dom.searchResults.append(empty);
}

function clearEpisodes() {
  dom.episodeResults.replaceChildren();
  dom.episodeResults.classList.remove("is-visible");
}

function renderEpisodeResults(item, episodes) {
  dom.episodeResults.replaceChildren();
  dom.episodeResults.classList.add("is-visible");

  const heading = document.createElement("div");
  heading.className = "episode-heading";
  const title = document.createElement("h3");
  title.textContent = item.name;
  const count = document.createElement("span");
  count.textContent = `${episodes.length} 集`;
  heading.append(title, count);

  const grid = document.createElement("div");
  grid.className = "episode-grid";

  if (!episodes.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = "这个结果没有解析到剧集，请换一个搜索结果。";
    dom.episodeResults.append(heading, empty);
    return;
  }

  for (const episode of episodes) {
    const button = document.createElement("button");
    button.className = "episode-button";
    button.type = "button";
    button.textContent = episode.name;
    button.title = episode.name;
    button.addEventListener("click", () => resolveEpisode(item, episode, button));
    grid.append(button);
  }

  dom.episodeResults.append(heading, grid);
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

function renderSearchResults(items) {
  dom.searchResults.replaceChildren();

  if (!items.length) {
    renderSearchEmpty("没有搜索结果");
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "anime-card";

    const image = document.createElement("img");
    image.className = "anime-cover";
    image.alt = item.name;
    image.loading = "lazy";
    image.src = item.imageUrl || coverFallback(item.name);
    image.addEventListener("error", () => {
      image.src = coverFallback(item.name);
    }, { once: true });

    const body = document.createElement("div");
    body.className = "anime-card-body";
    const title = document.createElement("h3");
    title.textContent = item.name;
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "选集";
    play.addEventListener("click", () => loadEpisodesForResult(item, play));
    body.append(title, play);

    card.append(image, body);
    dom.searchResults.append(card);
  }
}

function renderSources(sources) {
  dom.sourceSelect.replaceChildren();

  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.defaultResolution ? `${source.name} · ${source.defaultResolution}` : source.name;
    dom.sourceSelect.append(option);
  }

  appState.selectedSourceId = sources[0]?.id || "";
  dom.sourceSelect.value = appState.selectedSourceId;
}

async function loadSources(sourceUrl = DEFAULT_SOURCE_URL) {
  setSourceStatus("加载源中");
  renderSearchEmpty("输入片名开始搜索");
  writeOperation("加载源: 请求", { sourceUrl, onlySourceName: ONLY_SOURCE_NAME });

  try {
    const data = await apiGet("/api/sources", { url: sourceUrl });
    const matchedSource = (data.sources || []).find((source) => source.name === ONLY_SOURCE_NAME);
    appState.sourceUrl = data.sourceUrl;
    appState.sources = matchedSource ? [matchedSource] : [];
    renderSources(appState.sources);
    setSourceStatus(matchedSource ? ONLY_SOURCE_NAME : "未找到高清点播");
    writeOperation("加载源: 结果", {
      totalCount: data.count,
      matchedSource,
      availableSourceNames: (data.sources || []).map((source) => source.name)
    });

    if (!matchedSource) {
      renderSearchEmpty("当前源列表里没有找到“高清点播”。");
    }
  } catch (error) {
    setSourceStatus("加载失败");
    renderSearchEmpty(error.message);
    writeOperation("加载源: 错误", { message: error.message, data: error.data });
  }
}

async function searchSelectedSource() {
  const query = dom.sourceKeyword.value.trim();
  if (!query) return;

  const sourceId = dom.sourceSelect.value;
  appState.selectedSourceId = sourceId;
  setSourceStatus("搜索中");
  renderSearchEmpty("搜索中");
  clearEpisodes();
  writeOperation("搜索: 请求", {
    sourceName: ONLY_SOURCE_NAME,
    sourceUrl: appState.sourceUrl,
    sourceId,
    query
  });

  try {
    const data = await apiGet("/api/search", {
      sourceUrl: appState.sourceUrl,
      sourceId,
      q: query
    });

    setSourceStatus(`${data.items.length} 个结果`);
    renderSearchResults(data.items || []);
    writeOperation("搜索: 结果", data);
  } catch (error) {
    setSourceStatus("搜索失败");
    renderSearchEmpty(error.message);
    writeOperation("搜索: 错误", { message: error.message, data: error.data, url: error.url });
  }
}

async function loadEpisodesForResult(item, button) {
  const sourceId = dom.sourceSelect.value;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "读取中";
  setSourceStatus("读取剧集");
  clearEpisodes();
  writeOperation("选集: 点击结果", {
    sourceName: ONLY_SOURCE_NAME,
    sourceId,
    item
  });

  try {
    const episodeData = await apiGet("/api/episodes", {
      sourceUrl: appState.sourceUrl,
      sourceId,
      url: item.url
    });
    writeOperation("选集: 剧集结果", episodeData);

    const episodes = episodeData.episodes || [];
    if (!episodes.length) {
      setSourceStatus("没有剧集");
      renderEpisodeResults(item, []);
      return;
    }

    setSourceStatus(`${episodes.length} 集`);
    renderEpisodeResults(item, episodes);
  } catch (error) {
    setSourceStatus("读取失败");
    writeOperation("选集: 错误", { message: error.message, data: error.data, url: error.url });
    appendMessage({ text: error.message, system: true });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function resolveEpisode(item, episode, button) {
  const sourceId = dom.sourceSelect.value;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "解析中";
  setSourceStatus("解析播放地址");
  writeOperation("播放: 点击剧集", {
    sourceName: ONLY_SOURCE_NAME,
    sourceId,
    item,
    episode
  });

  try {
    const videoData = await apiGet("/api/resolve", {
      sourceUrl: appState.sourceUrl,
      sourceId,
      url: episode.url,
      debug: "1"
    });
    writeOperation("播放: 解析结果", videoData);

    setRoomVideo(videoData.videoUrl);
    setSourceStatus("已载入");
    writeOperation("播放: 载入视频", {
      itemName: item.name,
      episodeName: episode.name,
      videoUrl: videoData.videoUrl
    });
    appendMessage({ text: `已载入：${item.name}${episode.name ? ` ${episode.name}` : ""}`, system: true });
  } catch (error) {
    setSourceStatus("解析失败");
    writeOperation("播放: 错误", { message: error.message, data: error.data, url: error.url });
    appendMessage({ text: error.message, system: true });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function syncClock() {
  send({
    type: "sync_ping",
    clientSentAt: Date.now()
  });
}

function calibrateDrift() {
  const state = appState.currentState;
  if (!state || !state.videoUrl || isRecentLocalAction()) return;

  const targetTime = effectiveRemoteTime(state);
  const drift = targetTime - dom.video.currentTime;
  const absDrift = Math.abs(drift);

  if (absDrift > MAX_DRIFT_HARD || (!state.isPlaying && absDrift > 0.42)) {
    appState.applyingRemote = true;
    dom.video.currentTime = Math.max(0, targetTime);
    dom.video.playbackRate = 1;
    window.setTimeout(() => {
      appState.applyingRemote = false;
    }, 120);
  } else if (state.isPlaying && absDrift > MAX_DRIFT_SOFT) {
    dom.video.playbackRate = Math.max(0.95, Math.min(1.05, 1 + drift * 0.08));
  } else {
    dom.video.playbackRate = 1;
  }

  dom.driftText.textContent = `偏差 ${absDrift.toFixed(2)}s`;
}

function connectToRoom(roomId, name) {
  if (appState.socket) appState.socket.close();

  appState.roomId = roomId;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`;
  const socket = new WebSocket(wsUrl);
  appState.socket = socket;

  setConnectionStatus("连接中");
  dom.roomHint.textContent = `房间 ${roomId}`;
  dom.shareLink.value = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;

  socket.addEventListener("open", () => {
    setConnectionStatus("已连接", "is-online");
    appendMessage({ text: `已加入房间 ${roomId}。`, system: true });
    syncClock();
  });

  socket.addEventListener("close", () => {
    if (appState.socket === socket) {
      setConnectionStatus("已断开", "is-error");
      appendMessage({ text: "连接已断开。", system: true });
    }
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("连接错误", "is-error");
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "welcome") {
      appState.memberId = message.memberId;
      appState.clockOffset = message.serverNow - Date.now();
      applyRemoteState(message.state, "welcome");
      return;
    }

    if (message.type === "sync_pong") {
      const receivedAt = Date.now();
      const roundTrip = Math.max(0, receivedAt - Number(message.clientSentAt || receivedAt));
      appState.clockOffset = message.serverNow + roundTrip / 2 - receivedAt;
      return;
    }

    if (message.type === "state") {
      if (!appState.currentState || message.state.version >= appState.currentState.version) {
        applyRemoteState(message.state, message.reason);
      }
      return;
    }

    if (message.type === "chat") {
      appendMessage(message);
      return;
    }

    if (message.type === "system") {
      appendMessage({ text: message.text, createdAt: message.createdAt, system: true });
      return;
    }

    if (message.type === "error") {
      setConnectionStatus("错误", "is-error");
      appendMessage({ text: message.message || "发生错误。", system: true });
    }
  });
}

dom.createRoomButton.addEventListener("click", () => {
  dom.roomInput.value = createRoomId();
  dom.roomInput.focus();
});

dom.roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomId = dom.roomInput.value.trim() || createRoomId();
  const name = dom.nameInput.value.trim() || "观影伙伴";
  dom.roomInput.value = roomId;
  connectToRoom(roomId, name);
});

dom.videoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const videoUrl = dom.videoUrl.value.trim();
  if (!videoUrl) return;
  setRoomVideo(videoUrl);
});

dom.sourceSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchSelectedSource();
});

dom.sourceSelect.addEventListener("change", () => {
  appState.selectedSourceId = dom.sourceSelect.value;
  renderSearchEmpty("输入片名开始搜索");
  clearEpisodes();
  writeOperation("切换源", {
    selectedSource: appState.sources.find((source) => source.id === appState.selectedSourceId) || null
  });
});

dom.clearLogButton.addEventListener("click", () => {
  dom.operationLog.replaceChildren();
});

dom.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dom.chatInput.value.trim();
  if (!text) return;
  if (send({ type: "chat", text })) {
    dom.chatInput.value = "";
  }
});

dom.copyLinkButton.addEventListener("click", async () => {
  if (!dom.shareLink.value) return;
  await navigator.clipboard.writeText(dom.shareLink.value);
  appendMessage({ text: "邀请链接已复制。", system: true });
});

dom.video.addEventListener("play", () => {
  if (appState.applyingRemote) return;
  markLocalAction();
  send({ type: "control", action: "play", currentTime: dom.video.currentTime, isPlaying: true });
});

dom.video.addEventListener("pause", () => {
  if (appState.applyingRemote) return;
  markLocalAction();
  send({ type: "control", action: "pause", currentTime: dom.video.currentTime, isPlaying: false });
});

dom.video.addEventListener("seeked", () => {
  if (appState.applyingRemote) return;
  markLocalAction();
  send({
    type: "control",
    action: "seek",
    currentTime: dom.video.currentTime,
    isPlaying: !dom.video.paused
  });
});

dom.video.addEventListener("loadedmetadata", () => {
  dom.emptyVideo.classList.add("is-hidden");
});

window.setInterval(syncClock, CLOCK_SYNC_MS);
window.setInterval(calibrateDrift, DRIFT_CHECK_MS);

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get("room");
if (roomFromUrl) {
  dom.roomInput.value = roomFromUrl;
}

const sourceFromUrl = params.get("sourceUrl") || DEFAULT_SOURCE_URL;
renderMembers([]);
renderSearchEmpty("输入片名开始搜索");
setConnectionStatus("未连接");
loadSources(sourceFromUrl);
