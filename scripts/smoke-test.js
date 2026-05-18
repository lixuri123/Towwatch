const crypto = require("crypto");
const net = require("net");
const { server } = require("../server");

function maskFrame(payload) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  }

  header[0] = 0x81;
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(client) {
  while (client.frameBuffer.length >= 2) {
    const opcode = client.frameBuffer[0] & 0x0f;
    let length = client.frameBuffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.frameBuffer.length < 4) return;
      length = client.frameBuffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.frameBuffer.length < 10) return;
      length = Number(client.frameBuffer.readBigUInt64BE(2));
      offset = 10;
    }

    const frameEnd = offset + length;
    if (client.frameBuffer.length < frameEnd) return;

    const payload = client.frameBuffer.subarray(offset, frameEnd).toString("utf8");
    client.frameBuffer = client.frameBuffer.subarray(frameEnd);

    if (opcode === 0x1) {
      client.queue.push(JSON.parse(payload));
      const waiter = client.waiters.shift();
      if (waiter) waiter();
    }
  }
}

function createWsClient(port, room, name) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    const client = {
      socket,
      frameBuffer: Buffer.alloc(0),
      queue: [],
      waiters: []
    };

    let handshakeBuffer = Buffer.alloc(0);
    let didHandshake = false;

    socket.once("error", reject);
    socket.on("data", (chunk) => {
      if (!didHandshake) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
        if (!headers.includes("101 Switching Protocols")) {
          reject(new Error(`WebSocket handshake failed: ${headers}`));
          socket.end();
          return;
        }

        didHandshake = true;
        client.frameBuffer = handshakeBuffer.subarray(headerEnd + 4);
        parseServerFrames(client);
        resolve(client);
        return;
      }

      client.frameBuffer = Buffer.concat([client.frameBuffer, chunk]);
      parseServerFrames(client);
    });

    socket.write(
      `GET /ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)} HTTP/1.1\r\n` +
        "Host: 127.0.0.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n"
    );
  });
}

function sendJson(client, message) {
  client.socket.write(maskFrame(JSON.stringify(message)));
}

function waitFor(client, predicate, label, timeoutMs = 2500) {
  const existingIndex = client.queue.findIndex(predicate);
  if (existingIndex >= 0) {
    const [message] = client.queue.splice(existingIndex, 1);
    return Promise.resolve(message);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    const check = () => {
      const index = client.queue.findIndex(predicate);
      if (index >= 0) {
        clearTimeout(timer);
        const [message] = client.queue.splice(index, 1);
        resolve(message);
        return;
      }

      if (Date.now() - startedAt < timeoutMs) {
        client.waiters.push(check);
      }
    };

    client.waiters.push(check);
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  let one;
  let two;

  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    if (response.status !== 200) throw new Error(`HTTP check failed: ${response.status}`);

    const sourceUrl = `http://127.0.0.1:${port}/fixtures/sample-source.json`;
    const sourcesResponse = await fetch(`http://127.0.0.1:${port}/api/sources?url=${encodeURIComponent(sourceUrl)}`);
    const sourcesData = await sourcesResponse.json();
    if (sourcesData.count !== 1) throw new Error("Source list did not load");
    const sourceId = sourcesData.sources[0].id;

    const searchResponse = await fetch(
      `http://127.0.0.1:${port}/api/search?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&q=${encodeURIComponent("测试")}`
    );
    const searchData = await searchResponse.json();
    if (searchData.items[0]?.name !== "测试番") throw new Error("Source search did not parse results");
    if (!searchData.items[0]?.imageUrl?.endsWith("/fixtures/sample-cover.svg")) {
      throw new Error("Source search did not parse result images");
    }

    const episodesResponse = await fetch(
      `http://127.0.0.1:${port}/api/episodes?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(searchData.items[0].url)}`
    );
    const episodesData = await episodesResponse.json();
    if (episodesData.episodes[0]?.name !== "第1集") throw new Error("Episode list did not parse");

    const resolveResponse = await fetch(
      `http://127.0.0.1:${port}/api/resolve?sourceUrl=${encodeURIComponent(sourceUrl)}&sourceId=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(episodesData.episodes[0].url)}`
    );
    const resolveData = await resolveResponse.json();
    if (resolveData.videoUrl !== "https://cdn.example.test/video.mp4") throw new Error("Episode video did not resolve");

    const room = "SMOKE01";
    one = await createWsClient(port, room, "Alice");
    two = await createWsClient(port, room, "Bob");

    await waitFor(one, (message) => message.type === "welcome", "first welcome");
    await waitFor(two, (message) => message.type === "welcome", "second welcome");
    await waitFor(
      one,
      (message) => message.type === "state" && message.reason === "presence" && message.state.members.length === 2,
      "two-member presence"
    );

    sendJson(one, { type: "chat", text: "ready?" });
    const chat = await waitFor(two, (message) => message.type === "chat" && message.text === "ready?", "chat");
    if (chat.name !== "Alice") throw new Error("Chat sender mismatch");

    const videoUrl = "https://example.com/movie.mp4";
    sendJson(one, { type: "set_video", videoUrl });
    const videoState = await waitFor(two, (message) => message.type === "state" && message.reason === "video", "video state");
    if (videoState.state.videoUrl !== videoUrl) throw new Error("Video URL did not sync");

    sendJson(one, { type: "control", action: "play", currentTime: 12, isPlaying: true });
    const playState = await waitFor(two, (message) => message.type === "state" && message.reason === "play", "play state");
    if (!playState.state.isPlaying || playState.state.currentTime !== 12) throw new Error("Play state did not sync");

    sendJson(two, { type: "control", action: "seek", currentTime: 48, isPlaying: true });
    const seekState = await waitFor(one, (message) => message.type === "state" && message.reason === "seek", "seek state");
    if (seekState.state.currentTime !== 48) throw new Error("Seek state did not sync");

    sendJson(one, { type: "control", action: "pause", currentTime: 49, isPlaying: false });
    const pauseState = await waitFor(two, (message) => message.type === "state" && message.reason === "pause", "pause state");
    if (pauseState.state.isPlaying || pauseState.state.currentTime !== 49) throw new Error("Pause state did not sync");

    console.log("Smoke test passed.");
  } finally {
    if (one) one.socket.destroy();
    if (two) two.socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
