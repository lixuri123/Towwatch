const { randomBytes, randomUUID } = require("crypto");
const { createAdapter } = require("@socket.io/redis-adapter");
const {
  loadChatMessages,
  loadRoomState,
  saveChatMessage,
  saveRoomState,
  saveWatchEvent,
  saveWatchHistory
} = require("./database");

const MAX_MEMBERS = 2;
const ROOM_TTL_SECONDS = 24 * 60 * 60;

const memoryRooms = new Map();

let redisStateClient = null;
let redisReady = false;

function createId(bytes = 8) {
  return randomBytes(bytes).toString("hex");
}

function normalizeRoomId(roomId) {
  return String(roomId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

function sanitizeName(name) {
  const safeName = String(name || "").trim().slice(0, 24);
  return safeName || "观影伙伴";
}

function clampTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 24 * 60 * 60);
}

function sanitizeVideoUrl(value) {
  const url = String(value || "").trim();
  if (!url || url.length > 4096) return "";

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function createEmptyState() {
  return {
    videoUrl: "",
    currentTime: 0,
    isPlaying: false,
    duration: 0,
    media: null,
    updatedAt: Date.now(),
    version: 0
  };
}

function publicState(room) {
  return {
    roomId: room.id,
    videoUrl: room.state.videoUrl,
    currentTime: room.state.currentTime,
    isPlaying: room.state.isPlaying,
    duration: room.state.duration,
    media: room.state.media,
    updatedAt: room.state.updatedAt,
    version: room.state.version,
    members: Array.from(room.members.values()).map((member) => ({
      id: member.id,
      name: member.name,
      joinedAt: member.joinedAt,
      lastSeen: member.lastSeen
    }))
  };
}

async function loadStateFromRedis(roomId) {
  if (!redisReady || !redisStateClient) return null;

  try {
    const raw = await redisStateClient.get(`room:${roomId}:state`);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn(`Redis state read failed: ${error.message}`);
    return null;
  }
}

async function loadStateFromDatabase(roomId) {
  try {
    return await loadRoomState(roomId);
  } catch (error) {
    console.warn(`PostgreSQL room read failed: ${error.message}`);
    return null;
  }
}

async function persistState(room) {
  const state = publicState(room);

  if (redisReady && redisStateClient) {
    try {
      await redisStateClient.set(`room:${room.id}:state`, JSON.stringify(room.state), {
        EX: ROOM_TTL_SECONDS
      });
    } catch (error) {
      console.warn(`Redis state write failed: ${error.message}`);
    }
  }

  await saveRoomState(room.id, state).catch((error) => {
    console.warn(`PostgreSQL room write failed: ${error.message}`);
  });
}

function sanitizeMetadata(value, videoUrl) {
  const metadata = value && typeof value === "object" ? value : {};
  const title = String(metadata.title || metadata.itemName || "手动视频").trim().slice(0, 160);
  const episodeName = String(metadata.episodeName || metadata.name || "").trim().slice(0, 160);
  const sourceName = String(metadata.sourceName || "").trim().slice(0, 120);
  const imageUrl = sanitizeVideoUrl(metadata.imageUrl);
  const episodeUrl = sanitizeVideoUrl(metadata.episodeUrl);
  const historyKey = String(metadata.historyKey || episodeUrl || videoUrl).trim().slice(0, 4096);

  return {
    title,
    episodeName,
    sourceName,
    imageUrl,
    episodeUrl,
    historyKey
  };
}

function clampDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 24 * 60 * 60);
}

function estimateRoomCurrentTime(room) {
  const baseTime = clampTime(room.state.currentTime);
  if (!room.state.isPlaying) return baseTime;
  const elapsed = Math.max(0, Date.now() - Number(room.state.updatedAt || Date.now())) / 1000;
  const duration = clampDuration(room.state.duration);
  const estimated = baseTime + elapsed;
  return duration ? Math.min(estimated, duration) : clampTime(estimated);
}

async function persistHistory(io, room) {
  if (!room.state.videoUrl) return;

  const item = await saveWatchHistory(room.id, {
    ...room.state,
    currentTime: estimateRoomCurrentTime(room)
  }).catch((error) => {
    console.warn(`PostgreSQL watch history write failed: ${error.message}`);
    return null;
  });

  if (item) io.to(room.id).emit("history:updated", { item });
}

async function getRoom(roomId) {
  let room = memoryRooms.get(roomId);
  if (room) return room;

  const storedState = await loadStateFromRedis(roomId) || await loadStateFromDatabase(roomId);
  room = {
    id: roomId,
    members: new Map(),
    state: {
      ...createEmptyState(),
      ...(storedState || {})
    }
  };
  memoryRooms.set(roomId, room);
  return room;
}

function broadcastState(io, room, reason) {
  const state = publicState(room);
  io.to(room.id).emit("room:state", { reason, state });
  return state;
}

function advanceRoomState(room, partialState) {
  room.state = {
    ...room.state,
    ...partialState,
    version: room.state.version + 1,
    updatedAt: Date.now()
  };
}

async function setupRedisAdapter(io) {
  if (!process.env.REDIS_URL) return;

  try {
    const { createClient } = require("redis");
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    redisStateClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect(), redisStateClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisReady = true;
    console.log("Redis adapter connected.");
  } catch (error) {
    redisReady = false;
    redisStateClient = null;
    console.warn(`Redis disabled: ${error.message}`);
  }
}

async function attachRealtime(io) {
  await setupRedisAdapter(io);

  io.on("connection", (socket) => {
    socket.on("room:join", async ({ roomId: rawRoomId, name: rawName } = {}) => {
      const roomId = normalizeRoomId(rawRoomId);
      if (!roomId) {
        socket.emit("room:error", { message: "房间号不能为空。" });
        socket.disconnect(true);
        return;
      }

      const room = await getRoom(roomId);
      if (room.members.size >= MAX_MEMBERS && !room.members.has(socket.id)) {
        socket.emit("room:error", { message: "这个房间已经有两个人了。" });
        socket.disconnect(true);
        return;
      }

      const member = {
        id: createId(),
        name: sanitizeName(rawName),
        joinedAt: Date.now(),
        lastSeen: Date.now()
      };

      socket.data.roomId = roomId;
      socket.data.memberId = member.id;
      room.members.set(socket.id, member);
      await socket.join(roomId);

      loadChatMessages(roomId)
        .then((messages) => {
          socket.emit("chat:history", { messages });
        })
        .catch((error) => {
          console.warn(`PostgreSQL chat history read failed: ${error.message}`);
        });

      socket.emit("room:welcome", {
        memberId: member.id,
        serverNow: Date.now(),
        state: publicState(room)
      });

      socket.to(roomId).emit("room:system", {
        text: `${member.name} 加入了房间。`,
        createdAt: Date.now()
      });

      broadcastState(io, room, "presence");
      await persistState(room);
      await saveWatchEvent(room.id, member.id, "join", { name: member.name }).catch((error) => {
        console.warn(`PostgreSQL watch event write failed: ${error.message}`);
      });
    });

    socket.on("sync:ping", ({ clientSentAt } = {}) => {
      socket.emit("sync:pong", {
        clientSentAt,
        serverNow: Date.now()
      });
    });

    socket.on("video:set", async ({ videoUrl, media, currentTime = 0, duration = 0 } = {}) => {
      const room = memoryRooms.get(socket.data.roomId);
      if (!room) return;

      const safeUrl = sanitizeVideoUrl(videoUrl);
      if (!safeUrl) {
        socket.emit("room:error", { message: "请输入有效的视频 URL。" });
        return;
      }

      advanceRoomState(room, {
        videoUrl: safeUrl,
        currentTime: clampTime(currentTime),
        isPlaying: false,
        duration: clampDuration(duration),
        media: sanitizeMetadata(media, safeUrl)
      });
      broadcastState(io, room, "video");
      await persistState(room);
      await persistHistory(io, room);
      await saveWatchEvent(room.id, socket.data.memberId, "set_video", { videoUrl: safeUrl }).catch((error) => {
        console.warn(`PostgreSQL watch event write failed: ${error.message}`);
      });
    });

    socket.on("video:control", async ({ action, currentTime, isPlaying, duration } = {}) => {
      const room = memoryRooms.get(socket.data.roomId);
      if (!room) return;

      const nextTime = clampTime(currentTime);
      const nextPlaying = Boolean(isPlaying);
      const reason = ["play", "pause", "seek"].includes(action) ? action : "control";
      const nextDuration = clampDuration(duration);

      advanceRoomState(room, {
        currentTime: nextTime,
        isPlaying: nextPlaying,
        duration: nextDuration || room.state.duration
      });
      broadcastState(io, room, reason);
      await persistState(room);
      await persistHistory(io, room);
      await saveWatchEvent(room.id, socket.data.memberId, reason, {
        currentTime: nextTime,
        isPlaying: nextPlaying,
        duration: nextDuration || room.state.duration
      }).catch((error) => {
        console.warn(`PostgreSQL watch event write failed: ${error.message}`);
      });
    });

    socket.on("video:progress", async ({ currentTime, duration, isPlaying } = {}) => {
      const room = memoryRooms.get(socket.data.roomId);
      if (!room?.state.videoUrl) return;

      room.state = {
        ...room.state,
        currentTime: clampTime(currentTime),
        duration: clampDuration(duration) || room.state.duration,
        isPlaying: Boolean(isPlaying),
        updatedAt: Date.now()
      };

      await persistState(room);
      await persistHistory(io, room);
    });

    socket.on("chat:send", async ({ text } = {}) => {
      const room = memoryRooms.get(socket.data.roomId);
      const member = room?.members.get(socket.id);
      const cleanText = String(text || "").trim().slice(0, 500);
      if (!room || !member || !cleanText) return;

      member.lastSeen = Date.now();
      const messageId = randomUUID();
      const message = {
        id: messageId,
        memberId: member.id,
        name: member.name,
        text: cleanText,
        createdAt: Date.now()
      };

      io.to(room.id).emit("chat:message", message);
      await saveChatMessage(room.id, member, cleanText, messageId).catch((error) => {
        console.warn(`PostgreSQL chat write failed: ${error.message}`);
      });
    });

    socket.on("disconnect", async () => {
      const room = memoryRooms.get(socket.data.roomId);
      if (!room) return;

      const member = room.members.get(socket.id);
      room.members.delete(socket.id);

      if (member) {
        await saveWatchEvent(room.id, member.id, "leave", { name: member.name }).catch((error) => {
          console.warn(`PostgreSQL watch event write failed: ${error.message}`);
        });
      }

      if (room.members.size === 0 && !redisReady) {
        memoryRooms.delete(room.id);
        return;
      }

      if (member) {
        socket.to(room.id).emit("room:system", {
          text: `${member.name} 离开了房间。`,
          createdAt: Date.now()
        });
      }

      broadcastState(io, room, "presence");
      await persistState(room);
    });
  });
}

module.exports = {
  attachRealtime,
  getRoom,
  memoryRooms,
  normalizeRoomId,
  publicState
};
