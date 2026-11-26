import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { attachConsoleProxy } from "../lib/console";
import type { Config } from "../lib/config";
import { doctor } from "../lib/doctor";
import { Proxmox } from "../lib/proxmox";
import { Services } from "../lib/services";
import { peerFingerprint, proxmoxAgent } from "../lib/tls";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const cert = readFileSync(join(fixtures, "proxmox-cert.pem"), "utf8");
const key = readFileSync(join(fixtures, "proxmox-key.pem"), "utf8");
const otherCa = readFileSync(join(fixtures, "other-ca.pem"), "utf8");
const fingerprint = new X509Certificate(cert).fingerprint256;
const wrongFingerprint = fingerprint.replace(/^../, (b) =>
  b === "00" ? "01" : "00",
);

/** A Proxmox stand-in with the fixture's self-signed certificate (CN=localhost). */
async function fakeProxmox(t: { after(fn: () => void): void }) {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const server = createServer({ key, cert }, async (req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    for await (const _ of req);
    let data: unknown = null;
    if (req.url === "/api2/json/version") data = { version: "8.4.1" };
    else if (req.url === "/api2/json/access/permissions")
      data = { "/vms": { "VM.Audit": 1, "VM.PowerMgmt": 1, "VM.Console": 1 } };
    else if (req.url === "/api2/json/cluster/resources?type=vm")
      data = [
        { vmid: 104, node: "pve", name: "dev", type: "qemu", status: "running" },
      ];
    else if (req.url?.endsWith("/vncproxy"))
      data = { ticket: "PVEVNC:ticket", password: "vnc", port: 5900 };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, req) => {
    upgrades.push(String(req.headers.authorization));
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  server.listen(0);
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  return { port, requests, upgrades };
}

const proxmox = (url: string, trust: Partial<Config> = {}) =>
  new Proxmox({
    proxmoxUrl: url,
    tokenId: "proxdesk@pve!portal",
    tokenSecret: "server-only-secret",
    ...trust,
  });
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as Error & { cause?: Error & { code?: string } }).cause!;
  }
  assert.fail("expected the request to fail");
}

test("the system trust store rejects a self-signed Proxmox certificate", async (t) => {
  const { port, requests } = await fakeProxmox(t);
  const cause = await failure(
    proxmox(`https://localhost:${port}`).request("/version"),
  );
  assert.equal(cause.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.deepEqual(requests, []);
});

test("PROXMOX_CA_FILE trusts its CA and still checks the hostname", async (t) => {
  const { port } = await fakeProxmox(t);
  const trusted = { proxmoxCa: cert, proxmoxCaFile: "ca.pem" };
  assert.deepEqual(
    await proxmox(`https://localhost:${port}`, trusted).request("/version"),
    { version: "8.4.1" },
  );
  const mismatch = await failure(
    proxmox(`https://127.0.0.1:${port}`, trusted).request("/version"),
  );
  assert.equal(mismatch.code, "ERR_TLS_CERT_ALTNAME_INVALID");
  const other = await failure(
    proxmox(`https://localhost:${port}`, { proxmoxCa: otherCa }).request(
      "/version",
    ),
  );
  assert.equal(other.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
});

test("a pinned fingerprint accepts only that certificate and sends nothing to another", async (t) => {
  const { port, requests } = await fakeProxmox(t);
  // Addressed by IP, which the certificate does not name: the pin alone decides.
  const pinned = proxmox(`https://127.0.0.1:${port}`, {
    proxmoxFingerprint: fingerprint,
  });
  assert.deepEqual(await pinned.request("/version"), { version: "8.4.1" });
  assert.equal(requests.length, 1);
  const cause = await failure(
    proxmox(`https://127.0.0.1:${port}`, {
      proxmoxFingerprint: wrongFingerprint,
    }).request("/version"),
  );
  assert.equal((cause as { code?: string }).code, "ERR_PROXMOX_FINGERPRINT");
  assert.ok(cause.message.includes(fingerprint));
  assert.equal(requests.length, 1);
});

test("the console proxy reaches a pinned Proxmox over WSS; a wrong pin gets no upgrade", async (t) => {
  const { port, upgrades } = await fakeProxmox(t);
  const s = new Services(
    {
      demo: true,
      origin: "http://localhost:3000",
      database: ":memory:",
      secureCookies: false,
    },
    proxmox(`https://127.0.0.1:${port}`, { proxmoxFingerprint: fingerprint }),
  );
  s.config.demo = false;
  const server = createHttpServer();
  const { active } = attachConsoleProxy(server, s);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of active) socket.terminate();
    server.close();
    s.store.close();
  });
  const alex = s.store.findEmail("alex@example.com")!;
  const session = s.store.createSession(alex.id);
  const opened = await s.openConsole(alex, 104, session);
  const proxyPort = (server.address() as { port: number }).port;
  const client = new WebSocket(
    `ws://127.0.0.1:${proxyPort}${opened.path}`,
    "binary",
    {
      origin: "http://localhost:3000",
      headers: { cookie: `management_session=${session}` },
    },
  );
  t.after(() => client.terminate());
  await once(client, "open");
  const reply = once(client, "message");
  client.send(Buffer.from([7, 8, 9]));
  assert.deepEqual([...(await reply)[0]], [7, 8, 9]);
  assert.deepEqual(upgrades, [
    "PVEAPIToken=proxdesk@pve!portal=server-only-secret",
  ]);

  const impostor = new WebSocket(
    `wss://127.0.0.1:${port}/api2/json/nodes/pve/qemu/104/vncwebsocket`,
    "binary",
    {
      headers: { Authorization: "PVEAPIToken=must-not-leak" },
      agent: proxmoxAgent({ proxmoxFingerprint: wrongFingerprint }),
    },
  );
  const [error] = await once(impostor, "error");
  assert.equal((error as { code?: string }).code, "ERR_PROXMOX_FINGERPRINT");
  assert.equal(upgrades.length, 1);
});

test("doctor shows the presented fingerprint when Proxmox is untrusted", async (t) => {
  const { port } = await fakeProxmox(t);
  assert.equal(await peerFingerprint(`https://127.0.0.1:${port}`), fingerprint);
  const config: Config = {
    demo: false,
    origin: "http://localhost:3000",
    database: ":memory:",
    secureCookies: false,
    proxmoxUrl: `https://localhost:${port}`,
    tokenId: "proxdesk@pve!portal",
    tokenSecret: "secret",
    bootstrapEmail: "admin@example.com",
    bootstrapPassword: "admin-password-1",
  };
  const untrusted = await doctor({ config: () => config });
  const failed = untrusted.find((c) => c.status === "fail")!;
  assert.ok(failed.message.includes(`PROXMOX_FINGERPRINT=${fingerprint}`));
  const pinned = await doctor({
    config: () => ({ ...config, proxmoxFingerprint: fingerprint }),
  });
  assert.deepEqual(
    pinned.filter((c) => c.status === "fail"),
    [],
  );
  assert.match(
    pinned.map((c) => c.message).join("\n"),
    /TLS trust: pinned certificate fingerprint/,
  );
});
