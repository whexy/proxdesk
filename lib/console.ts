import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { sessionToken } from "./api";
import type { Services } from "./services";
import { allowsOrigin } from "./config";

export function attachConsoleProxy(
  server: Server,
  services: Services,
  nextUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown,
) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const active = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const url = new URL(req.url || "/", services.config.origin);
      if (url.pathname !== "/console-socket") {
        if (nextUpgrade)
          Promise.resolve(nextUpgrade(req, socket, head)).catch(() =>
            socket.destroy(),
          );
        else socket.destroy();
        return;
      }
      if (!allowsOrigin(services.config, req.headers.origin))
        throw new Error("Origin denied");
      const token = sessionToken(req.headers.cookie);
      const entry = services.consumeConsole(
        url.searchParams.get("ticket") || "",
        token,
      );
      sockets.handleUpgrade(req, socket, head, (client) => {
        active.add(client);
        // Pause browser frames until the upstream handshake has completed.
        client.pause();
        const upstream = new WebSocket(entry.connection.url, "binary", {
          headers: entry.connection.headers,
          agent: entry.connection.agent,
          handshakeTimeout: 10_000,
          maxPayload: 4 * 1024 * 1024,
          perMessageDeflate: false,
        });
        const close = () => {
          if (client.readyState < WebSocket.CLOSING) client.close(1000);
          if (upstream.readyState < WebSocket.CLOSING) upstream.close();
        };
        let checking = false;
        const timer = setInterval(() => {
          if (!services.consoleAllowed(entry)) return close();
          if (checking) return;
          checking = true;
          services
            .consoleStillAllowed(entry)
            .then((allowed) => allowed || close(), close)
            .finally(() => (checking = false));
        }, 2000);
        const lifetime = setTimeout(close, 2 * 3600_000);
        upstream.on("open", () => client.resume());
        upstream.on("message", (data, binary) => {
          if (client.readyState === WebSocket.OPEN) {
            if (client.bufferedAmount > 8 * 1024 * 1024) close();
            else client.send(data, { binary });
          }
        });
        client.on("message", (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > 8 * 1024 * 1024) close();
            else upstream.send(data, { binary });
          }
        });
        upstream.on("error", () => {
          if (client.readyState === WebSocket.OPEN)
            client.close(1011, "Proxmox console connection failed");
        });
        client.on("error", close);
        upstream.on("close", close);
        client.on("close", () => {
          clearInterval(timer);
          clearTimeout(lifetime);
          active.delete(client);
          if (upstream.readyState < WebSocket.CLOSING) upstream.close();
        });
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  return { active };
}
