import { createServer } from "node:http";
import next from "next";
import { attachConsoleProxy } from "./console";
import { acquireServiceLock } from "./lock";
import { getServices } from "./services";
import { createChatBot } from "./chat";
import { databaseFromEnv } from "./config";
import { loadExtensions } from "./extensions";

export async function serve(options: { dev: boolean; dir: string }) {
  const port = Number(process.env.PORT || 3000);
  const hostname = process.env.HOST || "0.0.0.0";
  const lock = acquireServiceLock(databaseFromEnv());
  const app = next({ dev: options.dev, dir: options.dir, hostname, port });
  const services = getServices();
  services.chat = createChatBot(services);
  const extensions = services.config.extensions ?? [];
  try {
    await loadExtensions(extensions, { services, bot: services.chat });
  } catch (error) {
    lock.release();
    throw error;
  }
  if (extensions.length)
    console.log(`Loaded ${extensions.length} extension${extensions.length === 1 ? "" : "s"}: ${extensions.join(", ")}`);
  services.chat.start();
  await app.prepare();
  const handler = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();
  const server = createServer((req, res) => {
    if (
      Number(req.headers["content-length"] || 0) > 16_384 &&
      req.url?.startsWith("/api/")
    ) {
      res.writeHead(413).end();
      return;
    }
    handler(req, res);
  });
  const { active } = attachConsoleProxy(server, services, nextUpgrade);
  const poller = setInterval(() => {
    void services.poll();
  }, 2000);
  void services.poll();
  services.backups.start();
  server.listen(port, hostname, () =>
    console.log(
      `Proxdesk listening on ${hostname}:${port}${services.config.demo ? " (DEMO MODE — simulated VMs)" : ""}`,
    ),
  );
  function shutdown() {
    clearInterval(poller);
    services.backups.stop();
    services.chat?.stop();
    for (const socket of active) socket.close(1001, "Server shutting down");
    server.close(() => {
      lock.release();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
