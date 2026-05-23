const { randomUUID } = require("crypto");

let poolPromise = null;
let databaseDisabled = false;

function loadPg() {
  try {
    return require("pg");
  } catch {
    return null;
  }
}

async function runMigrations(pool) {
  await pool.query(`
    create table if not exists rooms (
      id text primary key,
      state jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    alter table rooms
    add column if not exists created_at timestamptz not null default now()
  `);

  await pool.query(`
    create table if not exists chat_messages (
      id uuid primary key,
      room_id text not null,
      member_id text not null,
      member_name text not null,
      message text not null,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create index if not exists chat_messages_room_created_at_idx
    on chat_messages (room_id, created_at desc)
  `);

  await pool.query(`
    create table if not exists watch_events (
      id uuid primary key,
      room_id text not null,
      member_id text,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create index if not exists watch_events_room_created_at_idx
    on watch_events (room_id, created_at desc)
  `);

  await pool.query(`
    create table if not exists watch_history (
      id uuid primary key,
      room_id text not null,
      history_key text not null,
      title text not null,
      episode_name text,
      source_name text,
      image_url text,
      episode_url text,
      video_url text not null,
      current_time double precision not null default 0,
      duration double precision,
      is_playing boolean not null default false,
      created_at timestamptz not null default now(),
      last_watched_at timestamptz not null default now(),
      unique (room_id, history_key)
    )
  `);

  await pool.query(`
    create index if not exists watch_history_room_last_watched_at_idx
    on watch_history (room_id, last_watched_at desc)
  `);
}

async function getPool() {
  if (databaseDisabled || !process.env.DATABASE_URL) return null;
  if (poolPromise) return poolPromise;

  const pg = loadPg();
  if (!pg) {
    databaseDisabled = true;
    return null;
  }

  poolPromise = (async () => {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });

    await runMigrations(pool);
    return pool;
  })().catch((error) => {
    console.warn(`PostgreSQL unavailable, will retry later: ${error.message}`);
    poolPromise = null;
    return null;
  });

  return poolPromise;
}

function toPlaybackState(value) {
  if (!value || typeof value !== "object") return null;

  return {
    videoUrl: typeof value.videoUrl === "string" ? value.videoUrl : "",
    currentTime: Number.isFinite(Number(value.currentTime)) ? Number(value.currentTime) : 0,
    isPlaying: Boolean(value.isPlaying),
    duration: Number.isFinite(Number(value.duration)) ? Number(value.duration) : 0,
    media: value.media && typeof value.media === "object" ? value.media : null,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
    version: Number.isFinite(Number(value.version)) ? Number(value.version) : 0
  };
}

function clampSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 24 * 60 * 60);
}

function shortText(value, fallback, limit = 180) {
  const text = String(value || "").trim();
  return (text || fallback || "").slice(0, limit);
}

function normalizeHistoryItem(roomId, state) {
  const videoUrl = shortText(state?.videoUrl, "", 4096);
  if (!roomId || !videoUrl) return null;

  const media = state.media && typeof state.media === "object" ? state.media : {};
  const currentTime = clampSeconds(state.currentTime);
  const duration = clampSeconds(state.duration);
  const title = shortText(media.title || media.itemName, "手动视频", 160);
  const episodeName = shortText(media.episodeName || media.name, "", 160) || null;
  const sourceName = shortText(media.sourceName, "", 120) || null;
  const imageUrl = shortText(media.imageUrl, "", 4096) || null;
  const episodeUrl = shortText(media.episodeUrl, "", 4096) || null;
  const historyKey = shortText(media.historyKey || episodeUrl || videoUrl, videoUrl, 4096);
  const now = Date.now();

  return {
    id: state.historyId || randomUUID(),
    roomId,
    historyKey,
    title,
    episodeName,
    sourceName,
    imageUrl,
    episodeUrl,
    videoUrl,
    currentTime,
    duration,
    isPlaying: Boolean(state.isPlaying),
    lastWatchedAt: now
  };
}

function rowToHistoryItem(row) {
  const lastWatchedAt = row.last_watched_at instanceof Date
    ? row.last_watched_at.getTime()
    : new Date(row.last_watched_at).getTime();
  const duration = Number(row.duration || 0);
  let currentTime = clampSeconds(row.current_time);

  if (row.is_playing) {
    currentTime += Math.max(0, Date.now() - lastWatchedAt) / 1000;
    currentTime = duration ? Math.min(currentTime, duration) : clampSeconds(currentTime);
  }

  return {
    id: row.id,
    roomId: row.room_id,
    historyKey: row.history_key,
    title: row.title,
    episodeName: row.episode_name,
    sourceName: row.source_name,
    imageUrl: row.image_url,
    episodeUrl: row.episode_url,
    videoUrl: row.video_url,
    currentTime,
    duration,
    isPlaying: row.is_playing,
    lastWatchedAt
  };
}

async function migrateDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const pool = await getPool();
  if (!pool) {
    throw new Error("PostgreSQL is not available.");
  }
}

async function loadRoomState(roomId) {
  const pool = await getPool();
  if (!pool) return null;

  const result = await pool.query("select state from rooms where id = $1", [roomId]);
  return toPlaybackState(result.rows[0]?.state);
}

async function loadChatMessages(roomId, limit = 50) {
  const pool = await getPool();
  if (!pool) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const result = await pool.query(
    `
      select id, member_id, member_name, message, created_at
      from chat_messages
      where room_id = $1
      order by created_at desc
      limit $2
    `,
    [roomId, safeLimit]
  );

  return result.rows.reverse().map((row) => ({
    id: row.id,
    memberId: row.member_id,
    name: row.member_name,
    text: row.message,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime()
  }));
}

async function loadWatchHistory(roomId, limit = 20) {
  const pool = await getPool();
  if (!pool) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const result = await pool.query(
    `
      select id, room_id, history_key, title, episode_name, source_name, image_url,
        episode_url, video_url, current_time, duration, is_playing, last_watched_at
      from watch_history
      where room_id = $1
      order by last_watched_at desc
      limit $2
    `,
    [roomId, safeLimit]
  );

  return result.rows.map(rowToHistoryItem);
}

async function saveRoomState(roomId, state) {
  const pool = await getPool();
  if (!pool) return;

  await pool.query(
    `
      insert into rooms (id, state, updated_at)
      values ($1, $2, now())
      on conflict (id)
      do update set state = excluded.state, updated_at = now()
    `,
    [roomId, JSON.stringify(state)]
  );
}

async function saveChatMessage(roomId, member, text, messageId = randomUUID()) {
  const pool = await getPool();
  if (!pool) return messageId;

  await pool.query(
    `
      insert into chat_messages (id, room_id, member_id, member_name, message)
      values ($1, $2, $3, $4, $5)
    `,
    [messageId, roomId, member.id, member.name, text]
  );

  return messageId;
}

async function saveWatchEvent(roomId, memberId, eventType, payload = {}) {
  const pool = await getPool();
  if (!pool) return;

  await pool.query(
    `
      insert into watch_events (id, room_id, member_id, event_type, payload)
      values ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), roomId, memberId || null, eventType, JSON.stringify(payload)]
  );
}

async function saveWatchHistory(roomId, state) {
  const item = normalizeHistoryItem(roomId, state);
  if (!item) return null;

  const pool = await getPool();
  if (!pool) return item;

  const result = await pool.query(
    `
      insert into watch_history (
        id, room_id, history_key, title, episode_name, source_name, image_url,
        episode_url, video_url, current_time, duration, is_playing, last_watched_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, nullif($11, 0), $12, now())
      on conflict (room_id, history_key)
      do update set
        title = excluded.title,
        episode_name = excluded.episode_name,
        source_name = excluded.source_name,
        image_url = excluded.image_url,
        episode_url = excluded.episode_url,
        video_url = excluded.video_url,
        current_time = excluded.current_time,
        duration = coalesce(excluded.duration, watch_history.duration),
        is_playing = excluded.is_playing,
        last_watched_at = now()
      returning id, room_id, history_key, title, episode_name, source_name, image_url,
        episode_url, video_url, current_time, duration, is_playing, last_watched_at
    `,
    [
      item.id,
      roomId,
      item.historyKey,
      item.title,
      item.episodeName,
      item.sourceName,
      item.imageUrl,
      item.episodeUrl,
      item.videoUrl,
      item.currentTime,
      item.duration,
      item.isPlaying
    ]
  );

  return rowToHistoryItem(result.rows[0]);
}

async function closeDatabase() {
  const pool = poolPromise ? await poolPromise : null;
  if (pool) await pool.end();
  poolPromise = null;
}

module.exports = {
  closeDatabase,
  getPool,
  loadChatMessages,
  loadRoomState,
  loadWatchHistory,
  migrateDatabase,
  saveChatMessage,
  saveRoomState,
  saveWatchEvent,
  saveWatchHistory
};
