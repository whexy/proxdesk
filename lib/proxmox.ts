import https from "node:https";
import http from "node:http";
import type { Action, VM } from "./types";
import type { Config } from "./config";
import { proxmoxAgent } from "./tls";

export type ConsoleConnection = {
  url: string;
  headers: Record<string, string>;
  password: string;
  agent?: http.Agent;
};
export interface Hypervisor {
  inventory(): Promise<VM[]>;
  action(vm: VM, action: Action): Promise<string>;
  task(
    node: string,
    task: string,
  ): Promise<{ status: string; exitstatus?: string }>;
  console(vm: VM): Promise<ConsoleConnection>;
}

export function parseResources(resources: Record<string, any>[]): VM[] {
  return resources
    .filter((r) => r.type === "qemu" && !r.template)
    .map((r) => ({
      id: Number(r.vmid),
      node: r.node,
      name: r.name || `VM ${r.vmid}`,
      status: r.status,
      cpu: r.cpu || 0,
      memory: r.mem || 0,
      maxMemory: r.maxmem || 0,
      disk: r.disk || 0,
      maxDisk: r.maxdisk || 0,
      uptime: r.uptime || 0,
      cpus: r.maxcpu || 0,
      tags: r.tags ? String(r.tags).split(/[;, ]/).filter(Boolean) : [],
      ...(r.pool ? { pool: String(r.pool) } : {}),
      permissions: [],
    }));
}

export class Proxmox implements Hypervisor {
  private agent?: https.Agent;
  constructor(
    private config: Pick<
      Config,
      | "proxmoxUrl"
      | "tokenId"
      | "tokenSecret"
      | "proxmoxCa"
      | "proxmoxCaFile"
      | "proxmoxFingerprint"
    >,
  ) {
    this.agent = proxmoxAgent(config);
  }
  headers() {
    return {
      Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`,
    };
  }
  async request<T>(
    path: string,
    method = "GET",
    values?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.config.proxmoxUrl}/api2/json${path}`);
    const body = values ? new URLSearchParams(values).toString() : undefined;
    return new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method,
          headers: {
            ...this.headers(),
            ...(body
              ? {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength(body).toString(),
                }
              : {}),
          },
          timeout: 15_000,
          ...(url.protocol === "https:" && this.agent
            ? { agent: this.agent }
            : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2_000_000)
              req.destroy(new Error("Proxmox response is too large"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            if (
              !res.statusCode ||
              res.statusCode < 200 ||
              res.statusCode >= 300
            )
              return reject(
                new Error(
                  `Proxmox returned HTTP ${res.statusCode}. Check service-account privileges and VM state.`,
                ),
              );
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()).data as T);
            } catch {
              reject(new Error("Invalid response from Proxmox"));
            }
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("Proxmox request timed out")),
      );
      req.on("error", (cause) =>
        reject(
          new Error(
            "Cannot reach Proxmox. Check the connection and trusted TLS certificate.",
            { cause },
          ),
        ),
      );
      req.end(body);
    });
  }
  async inventory(): Promise<VM[]> {
    return parseResources(
      await this.request<Record<string, any>[]>("/cluster/resources?type=vm"),
    );
  }
  action(vm: VM, action: Action) {
    return this.request<string>(
      `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.id}/status/${action}`,
      "POST",
    );
  }
  task(node: string, task: string) {
    return this.request<{ status: string; exitstatus?: string }>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(task)}/status`,
    );
  }
  async console(vm: VM): Promise<ConsoleConnection> {
    const base = `/nodes/${encodeURIComponent(vm.node)}/qemu/${vm.id}`;
    const data = await this.request<{
      ticket: string;
      password?: string;
      port: number | string;
    }>(`${base}/vncproxy`, "POST", {
      websocket: "1",
      "generate-password": "1",
    });
    const port = Number(data.port);
    if (
      typeof data.ticket !== "string" ||
      !data.ticket ||
      !Number.isInteger(port) ||
      port < 5900 ||
      port > 5999
    )
      throw new Error("Proxmox returned invalid console connection details");
    const url = new URL(
      `${this.config.proxmoxUrl}/api2/json${base}/vncwebsocket`,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("port", String(port));
    url.searchParams.set("vncticket", data.ticket);
    return {
      url: url.toString(),
      headers: this.headers(),
      password: data.password || data.ticket,
      ...(url.protocol === "wss:" && this.agent ? { agent: this.agent } : {}),
    };
  }
}

export class DemoHypervisor implements Hypervisor {
  private tasks = new Map<string, { vm: VM; action: Action; ready: number }>();
  private vms: VM[] = [
    {
      id: 104,
      node: "pve-01",
      name: "alex-dev",
      status: "running",
      cpu: 0.083,
      memory: 12.4 * 1024 ** 3,
      maxMemory: 32 * 1024 ** 3,
      disk: 78 * 1024 ** 3,
      maxDisk: 256 * 1024 ** 3,
      uptime: 544320,
      cpus: 8,
      tags: ["development", "ubuntu-24.04"],
      pool: "students",
      permissions: [],
    },
    {
      id: 117,
      node: "pve-01",
      name: "alex-sandbox",
      status: "stopped",
      cpu: 0,
      memory: 0,
      maxMemory: 8 * 1024 ** 3,
      disk: 14 * 1024 ** 3,
      maxDisk: 64 * 1024 ** 3,
      uptime: 0,
      cpus: 4,
      tags: ["sandbox"],
      pool: "students",
      permissions: [],
    },
    {
      id: 120,
      node: "pve-01",
      name: "shared-storage",
      status: "running",
      cpu: 0.024,
      memory: 7.2 * 1024 ** 3,
      maxMemory: 16 * 1024 ** 3,
      disk: 310 * 1024 ** 3,
      maxDisk: 1024 * 1024 ** 3,
      uptime: 1836000,
      cpus: 4,
      tags: ["shared", "debian-12"],
      permissions: [],
    },
    {
      id: 132,
      node: "pve-02",
      name: "maya-research",
      status: "running",
      cpu: 0.342,
      memory: 43.2 * 1024 ** 3,
      maxMemory: 64 * 1024 ** 3,
      disk: 128 * 1024 ** 3,
      maxDisk: 512 * 1024 ** 3,
      uptime: 172800,
      cpus: 16,
      tags: ["research", "ubuntu-24.04", "gpu"],
      pool: "research",
      permissions: [],
    },
  ];
  async inventory() {
    return structuredClone(this.vms);
  }
  async action(vm: VM, action: Action) {
    const task = `demo:${crypto.randomUUID()}`;
    this.tasks.set(task, { vm, action, ready: Date.now() + 2500 });
    return task;
  }
  async task(_node: string, task: string) {
    const item = this.tasks.get(task);
    if (!item)
      return {
        status: "stopped",
        exitstatus: "Demo server restarted before this action finished",
      };
    if (Date.now() < item.ready) return { status: "running" };
    const vm = this.vms.find((v) => v.id === item.vm.id)!;
    if (item.action === "shutdown")
      Object.assign(vm, { status: "stopped", cpu: 0, memory: 0, uptime: 0 });
    else
      Object.assign(vm, {
        status: "running",
        uptime: 3,
        cpu: 0.01,
        memory: vm.maxMemory * 0.1,
      });
    return { status: "stopped", exitstatus: "OK" };
  }
  async console(_vm: VM): Promise<ConsoleConnection> {
    throw new Error(
      "Demo VMs have no hypervisor console. Connect Proxmox to use the live console.",
    );
  }
}
