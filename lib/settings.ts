import { z } from "zod";
import type { VM } from "./types";

// Proxmox pool IDs and tags share this character set; tags compare case-insensitively.
const proxmoxName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/, "Use letters, digits, _ . + or -");

export const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("pool"), pool: proxmoxName }),
  z.object({ type: z.literal("tag"), tag: proxmoxName }),
]);
export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  retention: z.number().int().min(1).max(1000),
});
export const settingsSchema = z.object({
  workspaceName: z.string().trim().min(1).max(60),
  scope: scopeSchema,
  backups: backupSettingsSchema,
});
export type Scope = z.infer<typeof scopeSchema>;
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  workspaceName: "Proxdesk",
  scope: { type: "all" },
  backups: { enabled: true, intervalHours: 24, retention: 14 },
};
export const settingsPatch = z.strictObject({
  workspaceName: settingsSchema.shape.workspaceName.optional(),
  scope: scopeSchema.optional(),
  backups: backupSettingsSchema.partial().strict().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatch>;

export function inScope(vm: Pick<VM, "pool" | "tags">, scope: Scope) {
  if (scope.type === "pool") return vm.pool === scope.pool;
  if (scope.type === "tag")
    return vm.tags.some((tag) => tag.toLowerCase() === scope.tag.toLowerCase());
  return true;
}
export function describeScope(scope: Scope) {
  if (scope.type === "pool") return `VMs in pool ${scope.pool}`;
  if (scope.type === "tag") return `VMs tagged ${scope.tag}`;
  return "all VMs visible to the token";
}
