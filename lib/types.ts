export const permissions = [
  "view",
  "start",
  "reboot",
  "shutdown",
  "reset",
  "console",
] as const;
export type Permission = (typeof permissions)[number];
export type Action = Exclude<Permission, "view" | "console">;
export type User = {
  id: string;
  /** Null for a chat-only member, who acts through a chat bot and cannot sign in to the web. */
  email: string | null;
  name: string;
  role: "admin" | "member";
  enabled: boolean;
};
export type VM = {
  id: number;
  node: string;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  maxMemory: number;
  disk: number;
  maxDisk: number;
  uptime: number;
  cpus: number;
  tags: string[];
  pool?: string;
  permissions: Permission[];
  operation?: Operation;
};
export type Operation = {
  id: string;
  vmId: number;
  vmName: string;
  userId: string;
  userName: string;
  action: Action;
  status: "pending" | "running" | "succeeded" | "failed" | "unknown";
  task: string | null;
  node: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Audit = {
  id: string;
  userName: string;
  action: string;
  target: string;
  detail: string;
  createdAt: string;
};
export type Grant = { userId: string; vmId: number; permissions: Permission[] };
export type ChatIdentity = {
  platform: string;
  userRef: string;
  displayName: string;
  userId: string;
  createdAt: string;
};
