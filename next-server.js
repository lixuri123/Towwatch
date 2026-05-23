const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");
const { attachRealtime } = require("./src/server/realtime");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

async function createTowwatchServer(options = {}) {
  const app = next({
    dev: options.dev ?? dev,
    hostname: options.hostname || hostname,
    port: options.port ?? port
  });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true
    }
  });

  await attachRealtime(io);

  return {
    app,
    httpServer,
    io,
    listen(listenPort = port, listenHost = hostname) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(listenPort, listenHost, () => {
          httpServer.off("error", reject);
          resolve(httpServer);
        });
      });
    },
    async close() {
      await new Promise((resolve) => io.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

if (require.main === module) {
  createTowwatchServer()
    .then(async (appServer) => {
      await appServer.listen();
      console.log(`Towwatch is running at http://${hostname}:${port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  createTowwatchServer
};
