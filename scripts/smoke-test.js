const { io } = require("socket.io-client");
const { createTowwatchServer } = require("../next-server");

function waitFor(socket, eventName, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(eventName, handler);
      resolve(payload);
    }

    socket.on(eventName, handler);
  });
}

async function connectClient(baseUrl, roomId, name) {
  const socket = io(baseUrl, {
    transports: ["websocket"],
    reconnection: false
  });

  await waitFor(socket, "connect", () => true, `${name} connect`);
  socket.emit("room:join", { roomId, name });
  const welcome = await waitFor(socket, "room:welcome", () => true, `${name} welcome`);
  return { socket, welcome };
}

async function main() {
  const appServer = await createTowwatchServer({ dev: true, port: 0, hostname: "127.0.0.1" });
  await appServer.listen(0, "127.0.0.1");
  const { port } = appServer.httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let one;
  let two;

  try {
    const response = await fetch(baseUrl);
    if (response.status !== 200) throw new Error(`HTTP check failed: ${response.status}`);

    const sourceUrl = `${baseUrl}/fixtures/sample-source.json`;
    const sourcesResponse = await fetch(`${baseUrl}/api/sources?url=${encodeURIComponent(sourceUrl)}`);
    const sourcesData = await sourcesResponse.json();
    if (sourcesData.count !== 2) throw new Error("Source list did not load every source");
    const sourceId = sourcesData.sources.find((source) => source.name === "测试源")?.id;
    if (!sourceId) throw new Error("Primary fixture source did not load");

    const searchResponse = await fetch(
      `${baseUrl}/api/search?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&q=${encodeURIComponent("测试")}`
    );
    const searchData = await searchResponse.json();
    if (searchData.items[0]?.name !== "测试番") throw new Error("Source search did not parse results");

    const episodesResponse = await fetch(
      `${baseUrl}/api/episodes?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(searchData.items[0].url)}`
    );
    const episodesData = await episodesResponse.json();
    if (episodesData.episodes[0]?.name !== "第1集") throw new Error("Episode list did not parse");

    const resolveResponse = await fetch(
      `${baseUrl}/api/resolve?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(episodesData.episodes[0].url)}`
    );
    const resolveData = await resolveResponse.json();
    if (resolveData.videoUrl !== "https://cdn.example.test/video.mp4") throw new Error("Episode video did not resolve");

    const roomId = "SMOKE01";
    one = await connectClient(baseUrl, roomId, "Alice");
    two = await connectClient(baseUrl, roomId, "Bob");

    const presence = await waitFor(
      one.socket,
      "room:state",
      (message) => message.reason === "presence" && message.state.members.length === 2,
      "two-member presence"
    );
    if (presence.state.members.map((member) => member.name).sort().join(",") !== "Alice,Bob") {
      throw new Error("Room members did not sync");
    }

    one.socket.emit("chat:send", { text: "ready?" });
    const chat = await waitFor(two.socket, "chat:message", (message) => message.text === "ready?", "chat");
    if (chat.name !== "Alice") throw new Error("Chat sender mismatch");

    const videoUrl = "https://example.com/movie.mp4";
    const historyUpdatePromise = waitFor(
      two.socket,
      "history:updated",
      (message) => message.item?.videoUrl === videoUrl,
      "watch history update"
    );
    one.socket.emit("video:set", {
      videoUrl,
      currentTime: 7,
      duration: 120,
      media: {
        title: "Smoke Movie",
        episodeName: "Episode 1",
        sourceName: "Smoke Source",
        historyKey: "smoke-episode-1"
      }
    });
    const videoState = await waitFor(
      two.socket,
      "room:state",
      (message) => message.reason === "video",
      "video state"
    );
    if (videoState.state.videoUrl !== videoUrl) throw new Error("Video URL did not sync");
    if (videoState.state.media?.title !== "Smoke Movie") throw new Error("Video metadata did not sync");
    const historyUpdate = await historyUpdatePromise;
    if (historyUpdate.item.title !== "Smoke Movie" || historyUpdate.item.currentTime !== 7) {
      throw new Error("Watch history did not update");
    }

    one.socket.emit("video:control", { action: "play", currentTime: 12, isPlaying: true });
    const playState = await waitFor(
      two.socket,
      "room:state",
      (message) => message.reason === "play",
      "play state"
    );
    if (!playState.state.isPlaying || playState.state.currentTime !== 12) {
      throw new Error("Play state did not sync");
    }

    two.socket.emit("video:control", { action: "seek", currentTime: 48, isPlaying: true });
    const seekState = await waitFor(
      one.socket,
      "room:state",
      (message) => message.reason === "seek",
      "seek state"
    );
    if (seekState.state.currentTime !== 48) throw new Error("Seek state did not sync");

    console.log("Smoke test passed.");
  } finally {
    if (one) one.socket.disconnect();
    if (two) two.socket.disconnect();
    await appServer.close();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
