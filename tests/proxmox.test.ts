import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { Proxmox } from "../lib/proxmox";
import { Services } from "../lib/services";
import { attachConsoleProxy } from "../lib/console";
import type { VM } from "../lib/types";

test("Proxmox adapter scopes requests, encodes task IDs, and keeps API tokens out of console results", async (t) => {
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    assert.equal(
      req.headers.authorization,
      "PVEAPIToken=service@pve!portal=secret-token",
    );
    let data: unknown;
    if (req.url === "/api2/json/cluster/resources?type=vm")
      data = [
        {
          vmid: 104,
          node: "pve-01",
          name: "dev",
          type: "qemu",
          status: "running",
          maxmem: 1024,
          maxcpu: 4,
        },
        { vmid: 105, node: "pve-01", type: "lxc", status: "running" },
        { vmid: 106, node: "pve-01", type: "qemu", template: 1 },
      ];
    else if (req.url?.includes("/vncproxy")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.equal(req.method, "POST");
      assert.equal(new URLSearchParams(body).get("websocket"), "1");
      data = {
        ticket: "PVEVNC:secret:/+=",
        password: "vnc-password",
        port: "5901",
      };
    } else if (req.url?.includes("/tasks/"))
      data = { status: "stopped", exitstatus: "OK" };
    else data = "UPID:pve-01:ABC:/";
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const pve = new Proxmox({
    proxmoxUrl: `http://127.0.0.1:${address.port}`,
    tokenId: "service@pve!portal",
    tokenSecret: "secret-token",
  });
  const vms = await pve.inventory();
  assert.equal(vms.length, 1);
  assert.equal(vms[0].id, 104);
  assert.equal(await pve.action(vms[0], "reboot"), "UPID:pve-01:ABC:/");
  await pve.task("pve-01", "UPID:pve-01:ABC:/");
  assert.ok(
    paths.includes(
      "/api2/json/nodes/pve-01/tasks/UPID%3Apve-01%3AABC%3A%2F/status",
    ),
  );
  const console = await pve.console(vms[0]);
  assert.equal(console.password, "vnc-password");
  assert.equal(
    new URL(console.url).searchParams.get("vncticket"),
    "PVEVNC:secret:/+=",
  );
  assert.ok(!console.url.includes("secret-token"));
});

test(
  "console proxy forwards binary traffic and disconnects when VM access is revoked",
  { timeout: 12000 },
  async (t) => {
    const upstreamServer = createServer();
    const upstream = new WebSocketServer({ server: upstreamServer });
    upstream.on("connection", (socket, request) => {
      assert.equal(request.headers.authorization, "PVEAPIToken=server-only");
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    upstreamServer.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const upstreamPort = (upstreamServer.address() as { port: number }).port;
    const s = new Services({
      demo: true,
      database: ":memory:",
      origin: "http://localhost:3000",
      secureCookies: false,
    });
    s.config.demo = false;
    s.hypervisor.console = async () => ({
      url: `ws://127.0.0.1:${upstreamPort}`,
      headers: { Authorization: "PVEAPIToken=server-only" },
      password: "vnc",
    });
    const server = createServer();
    const { active } = attachConsoleProxy(server, s);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    t.after(() => {
      for (const socket of active) socket.terminate();
      for (const socket of upstream.clients) socket.terminate();
      upstream.close();
      upstreamServer.close();
      server.close();
      s.store.close();
    });
    const alex = s.store.findEmail("alex@example.com")!,
      session = s.store.createSession(alex.id);
    const connection = await s.openConsole(alex, 104, session);
    s.config.additionalOrigins = ["https://portal.example"];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}${connection.path}`,
      "binary",
      {
        origin: s.config.additionalOrigins[0],
        headers: { cookie: `management_session=${session}` },
      },
    );
    t.after(() => client.terminate());
    await once(client, "open");
    const message = once(client, "message");
    client.send(Buffer.from([1, 2, 3, 255]));
    const [data, binary] = await message;
    assert.equal(binary, true);
    assert.deepEqual([...data], [1, 2, 3, 255]);
    const closed = once(client, "close");
    s.store.grant(alex.id, 104, ["view"]);
    await closed;
    assert.notEqual(client.readyState, WebSocket.OPEN);
  },
);

test(
  "console WebSocket rejects cross-origin handshakes",
  { timeout: 5000 },
  async (t) => {
    const s = new Services({
      demo: true,
      database: ":memory:",
      origin: "http://localhost:3000",
      secureCookies: false,
    });
    const server = createServer();
    attachConsoleProxy(server, s);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.close();
      s.store.close();
    });
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/console-socket?ticket=invalid`,
      { origin: "https://evil.example" },
    );
    const [error] = await once(socket, "error");
    assert.match(error.message, /403/);
  },
);
