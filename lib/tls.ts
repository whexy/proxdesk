import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { Config } from "./config";

type Trust = Pick<
  Config,
  "proxmoxCa" | "proxmoxCaFile" | "proxmoxFingerprint"
>;

export function trustMode(config: Trust) {
  if (config.proxmoxFingerprint)
    return `pinned certificate fingerprint ${config.proxmoxFingerprint}`;
  if (config.proxmoxCaFile) return `CA file ${config.proxmoxCaFile}`;
  return process.env.NODE_EXTRA_CA_CERTS
    ? `system trust store and NODE_EXTRA_CA_CERTS ${process.env.NODE_EXTRA_CA_CERTS}`
    : "system trust store";
}

export class FingerprintMismatch extends Error {
  code = "ERR_PROXMOX_FINGERPRINT";
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(
      `Proxmox certificate fingerprint ${actual || "(none)"} does not match PROXMOX_FINGERPRINT`,
    );
  }
}

// A pinned certificate is often self-signed and addressed by IP, so the chain
// and hostname are not validated. The socket is handed to the HTTP client only
// after the fingerprint matches, so no request bytes (and no API token) reach
// an impostor.
class PinnedAgent extends https.Agent {
  constructor(private fingerprint: string) {
    super({ keepAlive: true });
  }
  createConnection(
    options: tls.ConnectionOptions,
    callback: (error: Error | null, socket?: Duplex) => void,
  ) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    const fail = (error: Error) => {
      socket.destroy();
      callback(error);
    };
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.off("error", fail);
      const actual = socket.getPeerCertificate().fingerprint256 || "";
      if (actual.toUpperCase() !== this.fingerprint)
        return fail(new FingerprintMismatch(this.fingerprint, actual));
      callback(null, socket);
    });
    return undefined;
  }
}

/** The agent for Proxmox API requests and console WebSockets; undefined uses Node's defaults. */
export function proxmoxAgent(config: Trust): https.Agent | undefined {
  if (config.proxmoxFingerprint)
    return new PinnedAgent(config.proxmoxFingerprint);
  if (config.proxmoxCa)
    return new https.Agent({ keepAlive: true, ca: config.proxmoxCa });
}

/** Reads the certificate a server presents without trusting it; sends no application data. */
export function peerFingerprint(url: string, timeout = 10_000) {
  const { hostname, port } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: Number(port) || 443,
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout,
    });
    socket.once("secureConnect", () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      if (fingerprint) resolve(fingerprint);
      else reject(new Error("The server presented no certificate"));
    });
    socket.once("timeout", () =>
      socket.destroy(new Error("Timed out reading the certificate")),
    );
    socket.once("error", reject);
  });
}
