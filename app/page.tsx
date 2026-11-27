"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  DatabaseBackup,
  ChevronDown,
  ChevronRight,
  Clock3,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  Shield,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Unlink,
  Users,
  X,
  XCircle,
} from "lucide-react";
import {
  permissions,
  type Action,
  type Audit,
  type ChatIdentity,
  type Grant,
  type Operation,
  type Permission,
  type User,
  type VM,
} from "@/lib/types";
import type { BackupFile, BackupStatus } from "@/lib/backups";
import type { Check as HealthCheck } from "@/lib/doctor";
import type { Settings as WorkspaceSettings } from "@/lib/settings";

class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new APIError(data.error || "Request failed", response.status);
  return data;
}
const actionNames: Record<Action, string> = {
  start: "Start",
  reboot: "Reboot",
  shutdown: "Shut down",
  reset: "Force reset",
};
const permissionNames: Record<Permission, string> = {
  view: "View status",
  start: "Start",
  reboot: "Reboot",
  shutdown: "Shut down",
  reset: "Force reset",
  console: "Console",
};
const gib = (n: number) => n / 1024 ** 3;
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? size(n)
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.max(1, Math.round(n / 1024))} KiB`;
const size = (n: number) =>
  `${gib(n).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`;
const initials = (name: string) =>
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const time = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function uptime(seconds: number) {
  if (!seconds) return "—";
  if (seconds >= 86400)
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}
function State({ value }: { value: string }) {
  return (
    <span className="text-ink-soft inline-flex items-center gap-2 text-sm whitespace-nowrap">
      <i
        className={`state-dot ${value === "running" ? "state-on" : "state-off"}`}
      />
      {value === "running"
        ? "Running"
        : value === "stopped"
          ? "Stopped"
          : value}
    </span>
  );
}
function Spinner({ size = 15 }: { size?: number }) {
  return <Loader2 size={size} className="motion-safe:animate-spin" />;
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`paper dialog ${wide ? "sm:max-w-content" : "sm:max-w-md"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 id="modal-title" className="card-title">
            {title}
          </h2>
          <button
            className="btn-icon -mr-2"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false),
    [demo, setDemo] = useState(false),
    [oidc, setOidc] = useState(false);
  const [tab, setTab] = useState<
    "vms" | "members" | "chat" | "activity" | "settings"
  >("vms");
  const [workspaceName, setWorkspaceName] = useState("");
  const [vms, setVms] = useState<VM[]>([]),
    [events, setEvents] = useState<Audit[]>([]),
    [members, setMembers] = useState<User[]>([]),
    [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(""),
    [checkedAt, setCheckedAt] = useState("");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<number | null>(null),
    [menu, setMenu] = useState<number | null>(null),
    // Where the account menu opens; null while closed.
    [accountMenu, setAccountMenu] = useState<{
      top: number;
      right: number;
    } | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const [confirm, setConfirm] = useState<{ vm: VM; action: Action } | null>(
      null,
    ),
    [busy, setBusy] = useState(false);
  const [consoleVM, setConsoleVM] = useState<VM | null>(null),
    [newMember, setNewMember] = useState(false),
    [editMember, setEditMember] = useState<User | null>(null),
    [changePassword, setChangePassword] = useState(false),
    [chatAccounts, setChatAccounts] = useState(false);
  // Set on /link/<code>, the page a chat bot sends for linking an account.
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const tracked = useRef(new Map<string, Operation>());
  const refresh = useCallback(async (who: User, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [inventory, audit, session] = await Promise.all([
        api<{ vms: VM[]; checkedAt: string }>("/vms"),
        api<{ events: Audit[] }>("/audit"),
        api<{ workspaceName?: string }>("/auth/session"),
      ]);
      if (session.workspaceName) setWorkspaceName(session.workspaceName);
      setVms(inventory.vms);
      setCheckedAt(inventory.checkedAt);
      setEvents(audit.events);
      setLoadError("");
      for (const vm of inventory.vms)
        if (vm.operation) tracked.current.set(vm.operation.id, vm.operation);
      if (who.role === "admin") {
        const [people, access] = await Promise.all([
          api<{ users: User[] }>("/users"),
          api<{ grants: Grant[] }>("/grants"),
        ]);
        setMembers(people.users);
        setGrants(access.grants);
      }
    } catch (error) {
      if (error instanceof APIError && error.status === 401) setUser(null);
      else
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not refresh infrastructure",
        );
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLinkCode(
      location.pathname.match(/^\/link\/([A-Za-z0-9_-]+)$/)?.[1] ?? null,
    );
    api<{
      user: User | null;
      demo: boolean;
      oidc: boolean;
      workspaceName?: string;
    }>("/auth/session")
      .then((data) => {
        setUser(data.user);
        setDemo(data.demo);
        setOidc(data.oidc);
        if (data.workspaceName) setWorkspaceName(data.workspaceName);
      })
      .catch((error) => setLoadError(error.message))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!user) return;
    let cancelled = false,
      inFlight = false;
    void refresh(user);
    const timer = setInterval(async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        for (const [id] of tracked.current) {
          const { operation } = await api<{ operation: Operation }>(
            `/operations/${id}`,
          );
          if (cancelled) return;
          if (!["pending", "running"].includes(operation.status)) {
            tracked.current.delete(id);
            setToast({
              message:
                operation.status === "succeeded"
                  ? `${operation.vmName}: ${actionNames[operation.action].toLowerCase()} completed`
                  : `${operation.vmName}: ${operation.error || operation.status}`,
              error: operation.status !== "succeeded",
            });
          }
        }
        if (!cancelled) await refresh(user, true);
      } catch (error) {
        if (error instanceof APIError && error.status === 401) setUser(null);
        else if (error instanceof APIError && [403, 404].includes(error.status))
          tracked.current.clear();
      } finally {
        inFlight = false;
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, refresh]);
  useEffect(() => {
    document.title =
      workspaceName && workspaceName !== "Proxdesk"
        ? `${workspaceName} · Proxdesk`
        : "Proxdesk · VM self-service";
  }, [workspaceName]);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const closeModal = useCallback(() => {
    setConfirm(null);
    setConsoleVM(null);
    setNewMember(false);
    setEditMember(null);
    setChangePassword(false);
    setChatAccounts(false);
  }, []);
  const notifyError = useCallback(
    (error: unknown) =>
      setToast({
        message:
          error instanceof Error ? error.message : "Something went wrong",
        error: true,
      }),
    [],
  );
  async function login(
    email: string,
    password: string,
    role?: "admin" | "member",
  ) {
    const result = await api<{ user: User }>(
      role ? "/auth/demo" : "/auth/login",
      {
        method: "POST",
        body: JSON.stringify(role ? { role } : { email, password }),
      },
    );
    setUser(result.user);
    setTab("vms");
    setLoadError("");
  }
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      tracked.current.clear();
      setUser(null);
      setVms([]);
      setEvents([]);
      setMembers([]);
      setGrants([]);
      setSelected(null);
      setAccountMenu(null);
      closeModal();
    } catch (error) {
      notifyError(error);
    }
  }
  async function doAction() {
    if (!confirm || !user) return;
    setBusy(true);
    try {
      const { operation } = await api<{ operation: Operation }>(
        `/vms/${confirm.vm.id}/actions`,
        { method: "POST", body: JSON.stringify({ action: confirm.action }) },
      );
      tracked.current.set(operation.id, operation);
      setToast({
        message:
          operation.status === "unknown"
            ? operation.error || "Outcome unknown. Check VM state."
            : `${actionNames[confirm.action]} requested for ${confirm.vm.name}`,
        error: operation.status === "unknown",
      });
      setConfirm(null);
      await refresh(user, true);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  const selectAction = (vm: VM, action: Action) => {
    setMenu(null);
    setConfirm({ vm, action });
  };
  const canAct = (vm: VM, action: Action) =>
    vm.permissions.includes(action) &&
    !vm.operation &&
    (action === "start" ? vm.status === "stopped" : vm.status === "running");
  const selectedVM = vms.find((vm) => vm.id === selected);
  const visible = vms.filter(
    (vm) =>
      `${vm.name} ${vm.id} ${vm.node} ${vm.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || vm.status === filter),
  );
  const running = vms.filter((vm) => vm.status === "running");
  if (!ready)
    return (
      <div
        className="text-ink-muted flex min-h-dvh items-center justify-center"
        aria-label="Loading"
      >
        <Spinner size={22} />
      </div>
    );
  if (!user)
    return (
      <SignIn
        demo={demo}
        oidc={oidc}
        onLogin={login}
        initialError={loadError}
        returnTo={linkCode ? `/link/${linkCode}` : undefined}
      />
    );
  if (linkCode) return <LinkAccount code={linkCode} user={user} />;

  const tabs: [typeof tab, string][] = [
    ["vms", "Virtual machines"],
    ...(user.role === "admin"
      ? ([
          ["members", "Members"],
          ["chat", "Chat"],
        ] as [typeof tab, string][])
      : []),
    ["activity", "Activity"],
    ...(user.role === "admin"
      ? ([["settings", "Settings"]] as [typeof tab, string][])
      : []),
  ];
  const stopped = vms.filter((vm) => vm.status === "stopped");
  return (
    <div
      className="min-h-dvh"
      onClick={() => {
        if (menu !== null) setMenu(null);
        if (accountMenu) setAccountMenu(null);
      }}
    >
      <header className="header-bar print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-1 px-4 py-2 lg:px-8">
          <a
            href="/"
            className="font-title focus-visible:outline-accent rounded-md text-2xl font-semibold text-black focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {workspaceName || "Proxdesk"}
          </a>
          <nav
            aria-label="Main navigation"
            className="order-last flex w-full flex-wrap gap-x-6 gap-y-1 pb-1 sm:order-none sm:mr-auto sm:w-auto sm:pb-0"
          >
            {tabs.map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                className={`nav-link rounded-md ${tab === id ? "nav-link-active" : ""}`}
                onClick={() => {
                  setTab(id);
                  setSelected(null);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {demo && <span className="chip">Demo</span>}
            <button
              className="initials focus-visible:outline-accent transition-all duration-200 hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2"
              title={user.name}
              aria-label="Account menu"
              aria-expanded={!!accountMenu}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setAccountMenu(
                  accountMenu
                    ? null
                    : { top: rect.bottom + 8, right: innerWidth - rect.right },
                );
              }}
            >
              {initials(user.name)}
            </button>
          </div>
        </div>
      </header>
      {accountMenu && (
        <div
          // Outside the header: its backdrop blur would otherwise limit
          // this menu's blur to the header itself.
          className="glass-float menu fixed min-w-64"
          style={accountMenu}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pt-2 pb-2">
            <p className="text-ink text-sm font-medium">{user.name}</p>
            <p className="text-ink-muted text-xs">
              {user.email ? `${user.email} · ` : ""}
              {user.role === "admin" ? "Administrator" : "Member"}
            </p>
            <p className="text-ink-muted mt-2 flex items-center gap-2 text-xs">
              <i
                className={`state-dot ${loadError ? "state-off" : "state-on"}`}
              />
              {demo
                ? "Demo environment, simulated VMs"
                : loadError
                  ? "Connection needs attention"
                  : "Proxmox connected"}
            </p>
          </div>
          <div className="my-1 h-px bg-black/5" />
          <button
            className="menu-item"
            onClick={() => {
              setChangePassword(true);
              setAccountMenu(null);
            }}
          >
            <Shield size={15} />
            Change password
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setChatAccounts(true);
              setAccountMenu(null);
            }}
          >
            <MessageSquare size={15} />
            Chat accounts
          </button>
          <button className="menu-item" onClick={logout}>
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      )}
      <main className="text-ink">
        <div className="box-border flex w-full flex-col gap-8 px-0 py-4 sm:px-4 sm:py-10 lg:px-8">
          {loadError && (
            <div className="notice mx-4 items-center sm:mx-0" role="alert">
              <XCircle size={18} />
              <span className="flex-1">{loadError}</span>
              <button
                className="btn-soft px-3 py-1.5"
                onClick={() => refresh(user)}
              >
                Retry
              </button>
            </div>
          )}
          {tab === "vms" && (
            <>
              <PageHeading title="Virtual machines">
                <button
                  className="btn-soft"
                  onClick={() => refresh(user)}
                  disabled={loading}
                >
                  <RefreshCw
                    size={15}
                    className={loading ? "motion-safe:animate-spin" : ""}
                  />
                  Refresh
                </button>
              </PageHeading>
              <section
                className="glass-card w-full p-6 max-sm:rounded-none lg:p-8"
                aria-label="Summary"
              >
                <div className="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30" />
                <div className="glow-blob top-4 left-4 h-24 w-24 from-blue-200/20 to-cyan-200/20 blur-xl" />
                <div className="glow-blob right-6 bottom-4 h-20 w-20 from-purple-200/15 to-pink-200/15 blur-lg" />
                <div className="glow-blob top-8 right-4 h-16 w-16 from-yellow-200/15 to-orange-200/15 blur-lg" />
                <div className="glass-shine" />
                <div className="relative z-10">
                  <p className="text-ink-muted text-sm">Running now</p>
                  <p className="figure-hero mt-2">
                    {running.length}
                    <span className="figure-unit">of {vms.length}</span>
                  </p>
                  <div className="stat-row mt-6">
                    <Stat
                      label="Machines"
                      value={String(vms.length)}
                      note={
                        user.role === "admin"
                          ? "In your managed inventory"
                          : "Assigned to you"
                      }
                    />
                    <Stat label="Stopped" value={String(stopped.length)} />
                    <Stat
                      label="Memory in use"
                      value={size(vms.reduce((n, vm) => n + vm.memory, 0))}
                      note={`${size(vms.reduce((n, vm) => n + vm.maxMemory, 0))} allocated`}
                    />
                    <Stat
                      label="vCPUs"
                      value={String(vms.reduce((n, vm) => n + vm.cpus, 0))}
                      note="Allocated"
                    />
                  </div>
                </div>
              </section>
              <div className="grid items-start gap-8 lg:grid-cols-3">
                <section
                  className="paper min-w-0 lg:col-span-2"
                  aria-label="Machines"
                >
                  <div className="card-head">
                    <div className="relative min-w-48 flex-1 sm:max-w-sm">
                      <Search
                        size={16}
                        className="text-ink-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                      />
                      <input
                        className="input pl-9"
                        aria-label="Search virtual machines"
                        placeholder="Search machines…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <div
                      className="segmented"
                      role="group"
                      aria-label="Filter VM status"
                    >
                      {(
                        [
                          ["all", "All"],
                          ["running", "Running"],
                          ["stopped", "Stopped"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          aria-pressed={filter === value}
                          className={`segmented-item py-1 ${filter === value ? "segmented-active" : "segmented-idle"}`}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="relative overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Machine</th>
                          <th>Status</th>
                          <th className="max-md:hidden">CPU</th>
                          <th className="max-md:hidden">Memory</th>
                          <th className="max-md:hidden">Uptime</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((vm) => (
                          <tr
                            key={vm.id}
                            className={selected === vm.id ? "bg-wash" : ""}
                          >
                            <td>
                              <button
                                className="group focus-visible:outline-accent flex items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2"
                                aria-label={`View ${vm.name} details`}
                                onClick={() => setSelected(vm.id)}
                              >
                                <MachineIcon on={vm.status === "running"} />
                                <span>
                                  <span className="font-title text-ink group-hover:text-ink-glass block font-bold transition-colors duration-200">
                                    {vm.name}
                                  </span>
                                  <span className="text-ink-muted block text-xs whitespace-nowrap">
                                    VM {vm.id} · {vm.node}
                                  </span>
                                </span>
                              </button>
                            </td>
                            <td>
                              {vm.operation ? (
                                <span className="text-ink-soft inline-flex items-center gap-2 text-sm whitespace-nowrap">
                                  <Spinner size={13} />
                                  {actionNames[vm.operation.action]}…
                                </span>
                              ) : (
                                <State value={vm.status} />
                              )}
                            </td>
                            <td className="max-md:hidden">
                              <Meter
                                value={`${(vm.cpu * 100).toFixed(1)}`}
                                unit="%"
                                share={vm.cpu}
                              />
                            </td>
                            <td className="max-md:hidden">
                              <Meter
                                value={gib(vm.memory).toFixed(1)}
                                unit={` / ${gib(vm.maxMemory).toFixed(0)} GiB`}
                                share={
                                  vm.maxMemory ? vm.memory / vm.maxMemory : 0
                                }
                              />
                            </td>
                            <td className="text-ink-subtle whitespace-nowrap tabular-nums max-md:hidden">
                              {uptime(vm.uptime)}
                            </td>
                            <td>
                              <div className="flex items-center justify-end gap-1">
                                {vm.permissions.includes("console") && (
                                  <button
                                    className="btn-soft px-3 py-1.5"
                                    aria-label={`Open ${vm.name} console`}
                                    title={`Open ${vm.name} console`}
                                    disabled={
                                      vm.status !== "running" || !!vm.operation
                                    }
                                    onClick={() => setConsoleVM(vm)}
                                  >
                                    <SquareTerminal size={15} />
                                    <span className="max-sm:hidden">
                                      Console
                                    </span>
                                  </button>
                                )}
                                <button
                                  className="btn-icon"
                                  aria-label={`Actions for ${vm.name}`}
                                  aria-expanded={menu === vm.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const rect =
                                      e.currentTarget.getBoundingClientRect();
                                    setMenuPosition({
                                      top: Math.min(
                                        rect.bottom + 5,
                                        innerHeight - 235,
                                      ),
                                      right: innerWidth - rect.right,
                                    });
                                    setMenu(menu === vm.id ? null : vm.id);
                                  }}
                                >
                                  <MoreHorizontal size={19} />
                                </button>
                                {menu === vm.id && (
                                  <div
                                    className="glass-float menu fixed"
                                    style={menuPosition}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      className="menu-item"
                                      onClick={() => {
                                        setSelected(vm.id);
                                        setMenu(null);
                                      }}
                                    >
                                      <Settings2 size={15} />
                                      Machine details
                                    </button>
                                    {(
                                      [
                                        "start",
                                        "reboot",
                                        "shutdown",
                                        "reset",
                                      ] as Action[]
                                    )
                                      .filter((action) =>
                                        vm.permissions.includes(action),
                                      )
                                      .map((action) => (
                                        <button
                                          key={action}
                                          className="menu-item"
                                          disabled={!canAct(vm, action)}
                                          onClick={() =>
                                            selectAction(vm, action)
                                          }
                                        >
                                          <ActionIcon action={action} />
                                          {actionNames[action]}
                                        </button>
                                      ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!visible.length && (
                    <EmptyState
                      icon={<Server size={26} />}
                      title={
                        loading
                          ? "Loading machines…"
                          : search || filter !== "all"
                            ? "No matching machines"
                            : "No machines assigned"
                      }
                      text={
                        search || filter !== "all"
                          ? "Try another search or status."
                          : user.role === "admin"
                            ? "Check the service account’s VM access in Proxmox."
                            : "Ask your administrator to assign a VM to your account."
                      }
                    >
                      {(search || filter !== "all") && (
                        <button
                          className="btn-soft"
                          onClick={() => {
                            setSearch("");
                            setFilter("all");
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </EmptyState>
                  )}
                  <div className="border-rule text-ink-muted flex justify-between gap-3 border-t px-4 py-4 text-xs sm:px-6">
                    <span>
                      {visible.length} of {vms.length} machines
                    </span>
                    <span>
                      {checkedAt
                        ? `Updated ${new Date(checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                        : "Waiting for inventory"}
                    </span>
                  </div>
                </section>
                <section className="paper min-w-0 pb-2">
                  <div className="card-head">
                    <h2 className="card-title">Recent activity</h2>
                    <button
                      className="btn-soft px-3 py-1.5"
                      onClick={() => setTab("activity")}
                    >
                      View all
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <EventList events={events.slice(0, 5)} compact />
                </section>
              </div>
              <p className="footnote">
                <Shield size={14} className="mt-0.5 shrink-0" />
                {demo
                  ? "Changes affect demo data only. No Proxmox server is connected."
                  : "Actions are checked against your VM permissions and recorded in the audit log."}
              </p>
            </>
          )}
          {tab === "members" && user.role === "admin" && (
            <>
              <PageHeading
                title="Members"
                subtitle="Choose who can access your virtual machines."
              >
                <button
                  className="btn-solid"
                  onClick={() => setNewMember(true)}
                >
                  <Plus size={16} />
                  Add member
                </button>
              </PageHeading>
              <section className="paper min-w-0 pb-2">
                <div className="card-head">
                  <h2 className="card-title">
                    Workspace members
                    <span className="chip">{members.length}</span>
                  </h2>
                  <span className="text-ink-muted text-sm">
                    {members.filter((m) => m.enabled).length} active
                  </span>
                </div>
                <div className="relative overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th className="max-md:hidden">Role</th>
                        <th>Access</th>
                        <th className="max-md:hidden">Status</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>
                            <Person
                              name={member.name}
                              detail={member.email}
                              you={member.id === user.id}
                            />
                          </td>
                          <td className="max-md:hidden">
                            <span className="chip">
                              {member.role === "admin" && <Shield size={12} />}
                              {member.role === "admin"
                                ? "Administrator"
                                : "Member"}
                            </span>
                          </td>
                          <td className="text-ink-subtle whitespace-nowrap">
                            {member.role === "admin"
                              ? "All managed VMs"
                              : `${
                                  // Grants for VMs outside the managed scope stay stored but give no access.
                                  grants.filter(
                                    (g) =>
                                      g.userId === member.id &&
                                      vms.some((vm) => vm.id === g.vmId),
                                  ).length
                                } machines`}
                          </td>
                          <td className="max-md:hidden">
                            <span className="text-ink-soft inline-flex items-center gap-2 text-sm whitespace-nowrap">
                              <i
                                className={`state-dot ${member.enabled ? "state-on" : "state-off"}`}
                              />
                              {member.enabled ? "Active" : "Disabled / pending"}
                            </span>
                          </td>
                          <td className="text-right">
                            <button
                              className="btn-soft px-3 py-1.5"
                              onClick={() => setEditMember(member)}
                            >
                              <span className="max-sm:sr-only">
                                Manage access
                              </span>
                              <ChevronRight size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {tab === "chat" && user.role === "admin" && (
            <ChatPanel
              members={members}
              onSaved={(message) => {
                setToast({ message });
                void refresh(user, true);
              }}
              onError={notifyError}
            />
          )}
          {tab === "settings" && user.role === "admin" && (
            <SettingsPanel
              onSaved={(message, settings) => {
                setToast({ message });
                if (settings) setWorkspaceName(settings.workspaceName);
                void refresh(user, true);
              }}
              onError={notifyError}
            />
          )}
          {tab === "activity" && (
            <>
              <PageHeading
                title="Activity"
                subtitle={
                  user.role === "admin"
                    ? "Power actions, console sessions, and access changes across the workspace."
                    : "Your recent requests and their outcomes."
                }
              >
                <button
                  className="btn-soft"
                  onClick={() => refresh(user)}
                  disabled={loading}
                >
                  <RefreshCw
                    size={15}
                    className={loading ? "motion-safe:animate-spin" : ""}
                  />
                  Refresh
                </button>
              </PageHeading>
              <section className="paper min-w-0 pb-2">
                <div className="card-head">
                  <h2 className="card-title">Audit log</h2>
                  <span className="text-ink-muted text-sm">
                    Latest {events.length} events
                  </span>
                </div>
                <EventList events={events} />
              </section>
            </>
          )}
        </div>
      </main>
      {selectedVM && (
        <div
          className="scrim sm:items-stretch sm:justify-end"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <aside
            className="paper dialog sm:max-w-md"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedVM.name} details`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-muted text-sm">Machine details</span>
              <button
                className="btn-icon -mr-2"
                aria-label="Close machine details"
                onClick={() => setSelected(null)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <MachineIcon on={selectedVM.status === "running"} />
              <h2 className="card-title min-w-0 flex-1 break-words">
                {selectedVM.name}
              </h2>
              <State value={selectedVM.status} />
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {selectedVM.permissions.includes("console") && (
                <button
                  className="btn-solid"
                  disabled={
                    selectedVM.status !== "running" || !!selectedVM.operation
                  }
                  onClick={() => {
                    setConsoleVM(selectedVM);
                    setSelected(null);
                  }}
                >
                  <SquareTerminal size={16} />
                  Open console
                </button>
              )}
              {(["start", "reboot", "shutdown", "reset"] as Action[])
                .filter(
                  (action) =>
                    selectedVM.permissions.includes(action) &&
                    (action === "start"
                      ? selectedVM.status === "stopped"
                      : selectedVM.status === "running"),
                )
                .map((action) => (
                  <button
                    className="btn-soft"
                    disabled={!canAct(selectedVM, action)}
                    key={action}
                    onClick={() => {
                      selectAction(selectedVM, action);
                      setSelected(null);
                    }}
                  >
                    <ActionIcon action={action} />
                    {actionNames[action]}
                  </button>
                ))}
            </div>
            {selectedVM.operation && (
              <div className="notice mt-4 items-center">
                <Spinner size={16} />
                {actionNames[selectedVM.operation.action]} in progress
              </div>
            )}
            <SectionLabel>Overview</SectionLabel>
            <dl className="details">
              <div>
                <dt>VM ID</dt>
                <dd>{selectedVM.id}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{selectedVM.node}</dd>
              </div>
              <div>
                <dt>vCPUs</dt>
                <dd>{selectedVM.cpus}</dd>
              </div>
              <div>
                <dt>CPU usage</dt>
                <dd>{(selectedVM.cpu * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>
                  {size(selectedVM.memory)} / {size(selectedVM.maxMemory)}
                </dd>
              </div>
              <div>
                <dt>Disk allocation</dt>
                <dd>{size(selectedVM.maxDisk)}</dd>
              </div>
              <div>
                <dt>Uptime</dt>
                <dd>{uptime(selectedVM.uptime)}</dd>
              </div>
            </dl>
            {!!selectedVM.tags.length && (
              <>
                <SectionLabel>Tags</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {selectedVM.tags.map((tag) => (
                    <span className="chip" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </>
            )}
            <SectionLabel>Your permissions</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {selectedVM.permissions.map((p) => (
                <span className="chip" key={p}>
                  <Check size={12} />
                  {permissionNames[p]}
                </span>
              ))}
            </div>
          </aside>
        </div>
      )}
      {confirm && (
        <Modal
          title={`${actionNames[confirm.action]} ${confirm.vm.name}?`}
          onClose={closeModal}
        >
          <DialogIcon>
            <ActionIcon action={confirm.action} size={24} />
          </DialogIcon>
          <p className="dialog-copy">
            {confirm.action === "start"
              ? "The VM will boot. You can open its console once it is running."
              : confirm.action === "reboot"
                ? "The guest operating system will be asked to restart gracefully. Active connections will disconnect."
                : confirm.action === "shutdown"
                  ? "The guest operating system will be asked to shut down. The VM will stay off until someone starts it."
                  : "This immediately resets the virtual hardware. Unsaved work can be lost and filesystem corruption is possible."}
          </p>
          <Target icon={<Monitor size={17} />} name={confirm.vm.name}>
            VM {confirm.vm.id} · {confirm.vm.node}
          </Target>
          <DialogFooter>
            <button className="btn-soft" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
            <button className="btn-solid" onClick={doAction} disabled={busy}>
              {busy && <Spinner />}
              {busy ? "Submitting…" : `${actionNames[confirm.action]} VM`}
            </button>
          </DialogFooter>
        </Modal>
      )}
      {consoleVM && <ConsoleModal vm={consoleVM} onClose={closeModal} />}
      {newMember && (
        <AddMember
          oidc={oidc}
          onClose={closeModal}
          onSave={async (values) => {
            await api("/users", {
              method: "POST",
              body: JSON.stringify(values),
            });
            setNewMember(false);
            setToast({ message: "Member added. Assign their VM access next." });
            await refresh(user, true);
          }}
        />
      )}
      {editMember && (
        <MemberAccess
          member={editMember}
          currentUser={user}
          vms={vms}
          grants={grants}
          onClose={closeModal}
          onSave={async (patch, assignments) => {
            const result = await api<{ user: User }>(
              `/users/${editMember.id}`,
              {
                method: "PATCH",
                body: JSON.stringify({ ...patch, assignments }),
              },
            );
            if (editMember.id === user.id)
              setUser(result.user.enabled ? result.user : null);
            setEditMember(null);
            setToast({ message: `Access updated for ${editMember.name}` });
            await refresh(
              result.user.id === user.id ? result.user : user,
              true,
            );
          }}
          onDelete={async () => {
            await api(`/users/${editMember.id}`, { method: "DELETE" });
            setEditMember(null);
            setToast({ message: `${editMember.name} deleted` });
            await refresh(user, true);
          }}
        />
      )}
      {chatAccounts && <ChatAccounts onClose={closeModal} />}
      {changePassword && (
        <ChangePassword
          onClose={closeModal}
          onSave={async (currentPassword, newPassword) => {
            await api("/auth/password", {
              method: "POST",
              body: JSON.stringify({ currentPassword, newPassword }),
            });
            setChangePassword(false);
            setToast({
              message: "Password changed. Other sessions have been signed out.",
            });
          }}
        />
      )}
      {toast && (
        <div
          className="glass-float text-ink-glass fixed right-4 bottom-4 left-4 z-50 flex items-center gap-3 py-2 pr-2 pl-4 text-sm sm:left-auto sm:max-w-sm"
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? (
            <XCircle size={18} className="shrink-0" />
          ) : (
            <CheckCircle2 size={18} className="shrink-0" />
          )}
          <span className="flex-1">{toast.message}</span>
          <button
            className="btn-icon"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 px-4 sm:px-0">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-title text-ink-muted mt-7 mb-3 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  );
}
function MachineIcon({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-black/5 ${on ? "text-ink-glass" : "text-ink-faint"}`}
    >
      <Monitor size={18} />
    </span>
  );
}
function ActionIcon({ action, size = 15 }: { action: Action; size?: number }) {
  return action === "start" ? (
    <Play size={size} />
  ) : action === "shutdown" ? (
    <Power size={size} />
  ) : (
    <RotateCcw size={size} />
  );
}
function Meter({
  value,
  unit,
  share,
}: {
  value: string;
  unit: string;
  share: number;
}) {
  return (
    <div className="w-28">
      <span className="text-ink tabular-nums">
        {value}
        <span className="text-ink-muted text-xs">{unit}</span>
      </span>
      <div className="rank-track">
        <div
          className="rank-fill bg-series-total"
          style={{ width: `${Math.min(share * 100, 100)}%` }}
        />
      </div>
    </div>
  );
}
function Person({
  name,
  detail,
  you = false,
}: {
  name: string;
  /** An email or handle; null marks a chat-only member. */
  detail: ReactNode | null;
  you?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="initials">{initials(name)}</span>
      <div className="min-w-0">
        <p className="text-ink flex items-center gap-2 font-medium whitespace-nowrap">
          {name}
          {you && <span className="chip">You</span>}
        </p>
        <p className="text-ink-muted text-xs">
          {detail ?? <span className="chip">Chat only</span>}
        </p>
      </div>
    </div>
  );
}
function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text?: string;
  children?: ReactNode;
}) {
  return (
    <div className="text-ink-faint flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon}
      <h3 className="font-title text-ink-glass mt-1 text-base font-bold">
        {title}
      </h3>
      {text && <p className="text-ink-muted text-sm">{text}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
function DialogIcon({ children }: { children: ReactNode }) {
  return (
    <div className="text-ink-glass mb-4 inline-flex size-12 items-center justify-center rounded-2xl bg-black/5">
      {children}
    </div>
  );
}
/** The object a dialog acts on, set apart from the explanation. */
function Target({
  icon,
  name,
  children,
}: {
  icon: ReactNode;
  name: string;
  children?: ReactNode;
}) {
  return (
    <div className="text-ink-subtle mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-black/5 px-4 py-3 text-sm">
      {icon}
      <strong className="text-ink font-medium">{name}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}
function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}
function EventList({
  events,
  compact = false,
}: {
  events: Audit[];
  compact?: boolean;
}) {
  if (!events.length)
    return (
      <EmptyState
        icon={<Clock3 size={26} />}
        title="No activity yet"
        text="Your requests and access changes will appear here."
      />
    );
  return (
    <ul>
      {events.map((event) => (
        <li
          className="border-rule flex items-start gap-3 border-t px-4 py-3 first:border-t-0 sm:px-6"
          key={event.id}
        >
          <EventIcon>
            {event.action.includes("failed") ||
            event.action.includes("unknown") ? (
              <TriangleAlert size={15} />
            ) : event.action.includes("console") ? (
              <SquareTerminal size={15} />
            ) : event.action.includes("access") ||
              event.action.includes("account") ||
              event.action.includes("administrator") ? (
              <Shield size={15} />
            ) : event.action.includes("succeeded") ? (
              <Check size={15} />
            ) : (
              <Activity size={15} />
            )}
          </EventIcon>
          <div className="min-w-0 flex-1">
            <p className="text-ink text-sm break-words">
              <span className="font-medium">{event.action}</span>
              <span className="text-ink-faint"> · </span>
              {event.target}
            </p>
            <p className="text-ink-muted text-xs break-words">
              {event.userName}
              {!compact && event.detail && <> · {event.detail}</>}
            </p>
          </div>
          <time
            className="text-ink-muted shrink-0 pt-0.5 text-xs whitespace-nowrap"
            dateTime={event.createdAt}
          >
            {time(event.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}
function EventIcon({ children }: { children: ReactNode }) {
  return (
    <span className="text-ink-subtle inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-black/5">
      {children}
    </span>
  );
}

type ChatMemberInfo = { ref: string; name: string; handle: string };
type LinkedIdentity = ChatIdentity & {
  platformLabel: string;
  userName: string;
  userEmail: string | null;
};
type ChatInfo = {
  demo: boolean;
  adapters: {
    id: string;
    label: string;
    state: "connected" | "connecting" | "disconnected";
    lastError: string;
    conversations: string[];
    directory: boolean;
    members: ChatMemberInfo[];
    membersError: string;
  }[];
  identities: LinkedIdentity[];
};
const identityPath = (i: { platform: string; userRef: string }) =>
  `${encodeURIComponent(i.platform)}/${encodeURIComponent(i.userRef)}`;
function ChatPanel({
  members,
  onSaved,
  onError,
}: {
  members: User[];
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<ChatInfo | null>(null),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api<ChatInfo>("/chat"));
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  async function change(
    key: string,
    request: () => Promise<{ identities: LinkedIdentity[] }>,
    message: string,
  ) {
    setSaving(key);
    try {
      const { identities } = await request();
      setInfo((previous) => previous && { ...previous, identities });
      onSaved(message);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(null);
    }
  }
  const link = (platform: string, member: ChatMemberInfo, userId: string) =>
    change(
      `${platform}:${member.ref}`,
      () =>
        api("/chat/identities", {
          method: "PUT",
          body: JSON.stringify({ platform, userRef: member.ref, userId }),
        }),
      `${member.name} linked to ${members.find((m) => m.id === userId)?.name || "the account"}`,
    );
  const unlink = (identity: { platform: string; userRef: string }, name: string) =>
    change(
      `${identity.platform}:${identity.userRef}`,
      () =>
        api(`/chat/identities/${identityPath(identity)}`, { method: "DELETE" }),
      `${name} unlinked`,
    );
  const create = (platform: string, member: ChatMemberInfo) =>
    change(
      `${platform}:${member.ref}`,
      () =>
        api("/chat/members", {
          method: "POST",
          body: JSON.stringify({ platform, userRef: member.ref }),
        }),
      `${member.name} added as a chat-only member. Grant VMs under Members.`,
    );
  const identity = (platform: string, ref: string) =>
    info?.identities.find((i) => i.platform === platform && i.userRef === ref);
  return (
    <>
      <PageHeading title="Chat">
        <button className="btn-soft" onClick={load} disabled={loading}>
          <RefreshCw
            size={15}
            className={loading ? "motion-safe:animate-spin" : ""}
          />
          Refresh
        </button>
      </PageHeading>
      {info && !info.adapters.length && (
        <div className="notice mx-4 sm:mx-0">
          <MessageSquare size={17} />
          No chat bot is configured. Set the Slack or Discord settings described
          in docs/chat.md, then restart the service.
        </div>
      )}
      {info?.adapters.map((adapter) => (
        <div key={adapter.id} className="flex flex-col gap-4">
          {adapter.state !== "connected" && (
            <div className="notice mx-4 items-center sm:mx-0" role="alert">
              <XCircle size={18} />
              <span className="flex-1">
                The bot is not connected to {adapter.label}
                {adapter.lastError ? `: ${adapter.lastError}` : "."}
              </span>
              <button className="btn-soft px-3 py-1.5" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {adapter.membersError && (
            <div className="notice mx-4 items-center sm:mx-0" role="alert">
              <XCircle size={18} />
              <span className="flex-1">{adapter.membersError}</span>
              <button className="btn-soft px-3 py-1.5" onClick={load}>
                Retry
              </button>
            </div>
          )}
          <section className="paper min-w-0 pb-2">
            <div className="card-head">
              <h2 className="card-title">
                {adapter.directory ? `${adapter.label} members` : adapter.label}
                {adapter.directory && (
                  <span className="chip">{adapter.members.length}</span>
                )}
              </h2>
              <span className="text-ink-muted text-sm">
                {adapter.directory && info.demo
                  ? `Demo directory · no ${adapter.label} workspace connected`
                  : adapter.state === "connected"
                    ? `Bot connected · ${adapter.conversations.join(", ")}`
                    : adapter.conversations.join(", ")}
              </span>
            </div>
            {adapter.directory ? (
              <div className="relative overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{adapter.label} user</th>
                      <th>Proxdesk account</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {adapter.members.map((member) => {
                      const current = identity(adapter.id, member.ref);
                      const busy = saving === `${adapter.id}:${member.ref}`;
                      return (
                        <tr key={member.ref}>
                          <td>
                            <Person
                              name={member.name}
                              detail={`@${member.handle}`}
                            />
                          </td>
                          <td>
                            <div className="select min-w-56 sm:max-w-sm">
                              <select
                                className="input"
                                aria-label={`Account for ${member.name}`}
                                value={current?.userId ?? ""}
                                disabled={busy}
                                onChange={(e) =>
                                  e.target.value
                                    ? link(adapter.id, member, e.target.value)
                                    : current && unlink(current, member.name)
                                }
                              >
                                <option value="">Not linked</option>
                                {members.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name} · {m.email ?? "chat only"}
                                  </option>
                                ))}
                              </select>
                              <ChevronDown size={14} />
                            </div>
                          </td>
                          <td className="text-right">
                            {!current && (
                              <button
                                className="btn-soft px-3 py-1.5"
                                disabled={busy}
                                onClick={() => create(adapter.id, member)}
                              >
                                <Plus size={13} />
                                Create chat-only member
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="font-article text-ink-subtle px-4 pb-4 text-sm leading-relaxed sm:px-6">
                {adapter.label} does not let the bot list its members, so people
                link themselves: they mention the bot with &ldquo;link&rdquo;
                and open the link it sends. Their links appear under Linked chat
                accounts.
              </p>
            )}
          </section>
        </div>
      ))}
      {info && (
        <section className="paper min-w-0 pb-2">
          <div className="card-head">
            <h2 className="card-title">
              Linked chat accounts
              <span className="chip">{info.identities.length}</span>
            </h2>
          </div>
          {info.identities.length ? (
            <div className="relative overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Chat account</th>
                    <th>Proxdesk account</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {info.identities.map((i) => (
                    <tr key={`${i.platform}:${i.userRef}`}>
                      <td>
                        <Person
                          name={i.displayName}
                          detail={`${i.platformLabel} · ${i.userRef}`}
                        />
                      </td>
                      <td>
                        <p className="text-ink font-medium whitespace-nowrap">
                          {i.userName}
                        </p>
                        <p className="text-ink-muted text-xs">
                          {i.userEmail ?? (
                            <span className="chip">Chat only</span>
                          )}
                        </p>
                      </td>
                      <td className="text-right">
                        <button
                          className="btn-soft px-3 py-1.5"
                          aria-label={`Unlink ${i.displayName}`}
                          disabled={saving === `${i.platform}:${i.userRef}`}
                          onClick={() => unlink(i, i.displayName)}
                        >
                          <Unlink size={13} />
                          Unlink
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<MessageSquare size={26} />}
              title="No linked chat accounts"
              text="Link a member above, or ask people to mention the bot with “link”."
            />
          )}
        </section>
      )}
      <p className="footnote">
        <Shield size={14} className="mt-0.5 shrink-0" />
        The bot acts with the linked member&apos;s VM permissions. Chat-only
        members cannot sign in; grant their VMs under Members.
      </p>
    </>
  );
}

function ChatAccounts({ onClose }: { onClose: () => void }) {
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api<{ identities: LinkedIdentity[] }>("/account/identities")
      .then((data) => setIdentities(data.identities))
      .catch((err) => setError(err.message));
  }, []);
  async function unlink(identity: LinkedIdentity) {
    const key = `${identity.platform}:${identity.userRef}`;
    setBusy(key);
    setError("");
    try {
      const data = await api<{ identities: LinkedIdentity[] }>(
        `/account/identities/${identityPath(identity)}`,
        { method: "DELETE" },
      );
      setIdentities(data.identities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlink");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal title="Chat accounts" onClose={onClose}>
      {error && (
        <div className="notice mb-4" role="alert">
          <XCircle size={17} />
          {error}
        </div>
      )}
      {identities === null && !error ? (
        <div className="text-ink-muted py-4">
          <Spinner size={18} />
        </div>
      ) : identities?.length ? (
        <div className="flex flex-col gap-2">
          {identities.map((i) => (
            <div
              className="flex items-center gap-3 rounded-2xl bg-black/5 py-2 pr-2 pl-4 text-sm"
              key={`${i.platform}:${i.userRef}`}
            >
              <MessageSquare size={17} className="text-ink-subtle shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-ink font-medium">{i.displayName}</p>
                <p className="text-ink-muted text-xs">{i.platformLabel}</p>
              </div>
              <button
                className="btn-soft bg-white px-3 py-1.5"
                aria-label={`Unlink ${i.displayName}`}
                disabled={busy === `${i.platform}:${i.userRef}`}
                onClick={() => unlink(i)}
              >
                <Unlink size={13} />
                Unlink
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="dialog-copy">No chat accounts are linked to you.</p>
      )}
      <p className="form-note mt-4">
        The bot acts for a linked chat account with your VM permissions. To link
        one, mention the bot with &ldquo;link&rdquo; and open the link it sends
        you.
      </p>
      <DialogFooter>
        <button className="btn-soft" onClick={onClose}>
          Close
        </button>
      </DialogFooter>
    </Modal>
  );
}

type LinkPreview = {
  platform: string;
  platformLabel: string;
  userRef: string;
  handle: string;
  displayName: string;
  linked: "self" | "other" | null;
};
function LinkAccount({ code, user }: { code: string; user: User }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null),
    [error, setError] = useState(""),
    [move, setMove] = useState(false),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    api<LinkPreview>(`/link/${code}`)
      .then(setPreview)
      .catch((err) => setError(err.message));
  }, [code]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api(`/link/${code}`, {
        method: "POST",
        body: JSON.stringify({ move }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link");
    } finally {
      setBusy(false);
    }
  }
  const label = preview?.platformLabel ?? "chat";
  // Display names can be set to anyone's name, so the page names the chat
  // user only by username and ID, which the person cannot choose freely.
  const who = preview && (
    <>
      {preview.handle && (
        <strong className="text-ink">@{preview.handle}</strong>
      )}
      {preview.handle ? " (ID " : "ID "}
      <code className="text-ink rounded-md bg-black/5 px-1 font-mono text-sm">
        {preview.userRef}
      </code>
      {preview.handle && ")"}
    </>
  );
  return (
    <AuthPage icon={<Link2 size={20} />} title="Link chat account">
      {done ? (
        <p className="page-subtitle">
          {label} user {who} is linked to your account. Mention the bot in{" "}
          {label} to manage your VMs.
        </p>
      ) : preview ? (
        <p className="page-subtitle">
          Link {label} user {who} to your account?
        </p>
      ) : (
        !error && (
          <div className="text-ink-muted mt-4">
            <Spinner size={18} />
          </div>
        )
      )}
      {error && (
        <div className="notice mt-5" role="alert">
          <XCircle size={17} />
          {error}
        </div>
      )}
      {preview && !done && (
        <>
          <Target icon={<Users size={17} />} name={user.name}>
            {user.email}
          </Target>
          {preview.linked !== "self" && (
            <p className="notice mt-4" role="note">
              <TriangleAlert size={16} />
              <span>
                Only confirm if you just asked the bot for this link yourself.
                If someone sent it to you, cancel: linking gives their {label}{" "}
                account your access.
              </span>
            </p>
          )}
          <p className="form-note mt-4">
            {preview.linked === "self"
              ? `This ${label} user is already linked to your account.`
              : `The bot will act for this ${label} user with your VM permissions, including power actions.`}
          </p>
          {preview.linked === "other" && (
            <label className="check mt-4">
              <input
                type="checkbox"
                checked={move}
                onChange={(e) => setMove(e.target.checked)}
              />
              This {label} user is linked to another Proxdesk account. Move it
              to mine.
            </label>
          )}
          <DialogFooter>
            <a className="btn-glass" href="/">
              Cancel
            </a>
            <button
              className="btn-solid"
              disabled={
                busy ||
                preview.linked === "self" ||
                (preview.linked === "other" && !move)
              }
              onClick={confirm}
            >
              {busy && <Spinner />}
              Link account
            </button>
          </DialogFooter>
        </>
      )}
      {(done || (error && !preview)) && (
        <a className="btn-solid mt-6 w-full" href="/">
          Continue to Proxdesk
          <ArrowRight size={16} />
        </a>
      )}
    </AuthPage>
  );
}

/** Centered identity card for the pages shown before the portal. */
function AuthPage({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="text-ink flex min-h-dvh flex-col items-center justify-center gap-6 py-10 sm:px-4">
      <p className="font-title text-2xl font-semibold text-black">Proxdesk</p>
      <div className="glass-card w-full p-6 max-sm:rounded-none sm:max-w-md lg:p-8">
        <div className="glass-tint from-blue-100/30 via-purple-50/20 to-pink-100/30" />
        <div className="glow-blob top-4 left-4 h-24 w-24 from-blue-200/20 to-cyan-200/20 blur-xl" />
        <div className="glow-blob right-6 bottom-4 h-20 w-20 from-purple-200/15 to-pink-200/15 blur-lg" />
        <div className="glow-blob top-8 right-4 h-16 w-16 from-yellow-200/15 to-orange-200/15 blur-lg" />
        <div className="glass-shine" />
        <div className="relative z-10">
          <span className="icon-tile bg-gradient-to-br from-blue-500/20 to-purple-500/20 text-blue-600">
            {icon}
          </span>
          <h1 className="page-title mt-4">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

type BackupInfo = {
  dir: string;
  files: BackupFile[];
  status: BackupStatus;
  nextRunAt: string | null;
};
type SettingsInfo = { settings: WorkspaceSettings; backups: BackupInfo };
function SettingsPanel({
  onSaved,
  onError,
}: {
  onSaved: (message: string, settings?: WorkspaceSettings) => void;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<SettingsInfo | null>(null),
    [name, setName] = useState(""),
    [scopeType, setScopeType] =
      useState<WorkspaceSettings["scope"]["type"]>("all"),
    [scopeValue, setScopeValue] = useState(""),
    [backups, setBackups] = useState<WorkspaceSettings["backups"]>({
      enabled: true,
      intervalHours: 24,
      retention: 14,
    }),
    [saving, setSaving] = useState<"workspace" | "backups" | null>(null),
    [backingUp, setBackingUp] = useState(false),
    [checks, setChecks] = useState<HealthCheck[] | null>(null),
    [checkedAt, setCheckedAt] = useState(""),
    [checking, setChecking] = useState(false);
  const apply = useCallback((data: SettingsInfo) => {
    setInfo(data);
    setName(data.settings.workspaceName);
    setScopeType(data.settings.scope.type);
    setScopeValue(
      data.settings.scope.type === "pool"
        ? data.settings.scope.pool
        : data.settings.scope.type === "tag"
          ? data.settings.scope.tag
          : "",
    );
    setBackups(data.settings.backups);
  }, []);
  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const result = await api<{ checks: HealthCheck[]; checkedAt: string }>(
        "/settings/check",
        { method: "POST" },
      );
      setChecks(result.checks);
      setCheckedAt(result.checkedAt);
    } catch (error) {
      onError(error);
    } finally {
      setChecking(false);
    }
  }, [onError]);
  useEffect(() => {
    api<SettingsInfo>("/settings").then(apply, onError);
    void runCheck();
  }, [apply, onError, runCheck]);
  async function save(
    kind: "workspace" | "backups",
    patch: Partial<WorkspaceSettings>,
  ) {
    setSaving(kind);
    try {
      const data = await api<SettingsInfo>("/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      apply(data);
      onSaved(
        kind === "workspace" ? "Workspace settings saved" : "Backup settings saved",
        data.settings,
      );
    } catch (error) {
      onError(error);
    } finally {
      setSaving(null);
    }
  }
  async function backUpNow() {
    setBackingUp(true);
    try {
      const data = await api<{ file: string; backups: BackupInfo }>(
        "/backups",
        { method: "POST" },
      );
      setInfo((previous) => previous && { ...previous, backups: data.backups });
      onSaved(`Backup created: ${data.file.split("/").pop()}`);
    } catch (error) {
      onError(error);
      api<SettingsInfo>("/settings").then(
        (data) =>
          setInfo((previous) => previous && { ...previous, backups: data.backups }),
        () => {},
      );
    } finally {
      setBackingUp(false);
    }
  }
  const status = info?.backups.status;
  const latest = info?.backups.files[0];
  return (
    <>
      <PageHeading title="Settings" />
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <section className="paper min-w-0">
          <div className="card-head">
            <h2 className="card-title">Workspace</h2>
          </div>
          <form
            className="flex flex-col gap-4 px-4 pb-6 sm:px-6"
            onSubmit={(e) => {
              e.preventDefault();
              void save("workspace", {
                workspaceName: name,
                scope:
                  scopeType === "pool"
                    ? { type: "pool", pool: scopeValue }
                    : scopeType === "tag"
                      ? { type: "tag", tag: scopeValue }
                      : { type: "all" },
              });
            }}
          >
            <label className="field">
              Workspace name
              <input
                className="input"
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!info}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field">
                Managed VMs
                <Select
                  value={scopeType}
                  disabled={!info}
                  onChange={(e) =>
                    setScopeType(e.target.value as "all" | "pool" | "tag")
                  }
                >
                  <option value="all">All VMs the token can see</option>
                  <option value="pool">VMs in a pool</option>
                  <option value="tag">VMs with a tag</option>
                </Select>
              </label>
              {scopeType !== "all" && (
                <label className="field">
                  {scopeType === "pool" ? "Pool" : "Tag"}
                  <input
                    className="input"
                    required
                    maxLength={64}
                    pattern="[A-Za-z0-9_][A-Za-z0-9_.+\-]*"
                    value={scopeValue}
                    onChange={(e) => setScopeValue(e.target.value)}
                    placeholder={scopeType === "pool" ? "students" : "proxdesk"}
                  />
                </label>
              )}
            </div>
            <p className="form-note">
              VMs outside this scope are hidden from the machine list, access
              settings, Slack, and the console. Their existing grants are kept
              but have no effect.
            </p>
            <div className="flex justify-end">
              <button className="btn-solid" disabled={!info || !!saving}>
                {saving === "workspace" && <Spinner />}
                Save workspace
              </button>
            </div>
          </form>
        </section>
        <section className="paper min-w-0 pb-2">
          <div className="card-head">
            <h2 className="card-title">Proxmox connection</h2>
            <button
              className="btn-soft px-3 py-1.5"
              onClick={runCheck}
              disabled={checking}
            >
              <RefreshCw
                size={13}
                className={checking ? "motion-safe:animate-spin" : ""}
              />
              Run check
            </button>
          </div>
          {checks ? (
            <ul>
              {checks.map((check, index) => (
                <li
                  className="border-rule flex items-start gap-3 border-t px-4 py-3 first:border-t-0 sm:px-6"
                  key={index}
                >
                  <EventIcon>
                    {check.status === "fail" ? (
                      <XCircle size={15} />
                    ) : check.status === "warn" ? (
                      <TriangleAlert size={15} />
                    ) : (
                      <Check size={15} />
                    )}
                  </EventIcon>
                  <p className="text-ink min-w-0 flex-1 pt-1.5 text-sm break-words">
                    {check.message}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={checking ? <Spinner size={26} /> : <Server size={26} />}
              title={checking ? "Checking Proxmox…" : "Not checked yet"}
            />
          )}
          {checkedAt && (
            <p className="border-rule text-ink-muted mt-2 border-t px-4 pt-4 pb-2 text-right text-xs sm:px-6">
              Checked {time(checkedAt)}
            </p>
          )}
        </section>
        <section className="paper min-w-0 pb-2 lg:col-span-2">
          <div className="card-head">
            <h2 className="card-title">
              Backups
              {info && (
                <span className="chip">{info.backups.files.length}</span>
              )}
            </h2>
            <button
              className="btn-soft px-3 py-1.5"
              onClick={backUpNow}
              disabled={!info || backingUp}
            >
              {backingUp ? <Spinner size={13} /> : <DatabaseBackup size={13} />}
              Back up now
            </button>
          </div>
          <form
            className="flex flex-col gap-5 px-4 pb-6 sm:px-6"
            onSubmit={(e) => {
              e.preventDefault();
              void save("backups", { backups });
            }}
          >
            {status?.lastFailure &&
              (!status.lastSuccess ||
                status.lastFailure.at > status.lastSuccess.at) && (
                <div className="notice" role="alert">
                  <TriangleAlert size={17} />
                  <span>
                    Last backup failed {time(status.lastFailure.at)}:{" "}
                    {status.lastFailure.error}
                  </span>
                </div>
              )}
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="field">
                Scheduled backups
                <Select
                  value={backups.enabled ? "on" : "off"}
                  disabled={!info}
                  onChange={(e) =>
                    setBackups({ ...backups, enabled: e.target.value === "on" })
                  }
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </label>
              <label className="field">
                Every (hours)
                <input
                  className="input"
                  type="number"
                  required
                  min={1}
                  max={168}
                  value={backups.intervalHours}
                  disabled={!info}
                  onChange={(e) =>
                    setBackups({
                      ...backups,
                      intervalHours: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                Keep (newest)
                <input
                  className="input"
                  type="number"
                  required
                  min={1}
                  max={1000}
                  value={backups.retention}
                  disabled={!info}
                  onChange={(e) =>
                    setBackups({
                      ...backups,
                      retention: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <dl className="details sm:grid-cols-3">
              <div>
                <dt>Directory</dt>
                <dd className="font-mono">{info?.backups.dir ?? "—"}</dd>
              </div>
              <div>
                <dt>Last backup</dt>
                <dd>{latest ? time(latest.modifiedAt) : "None yet"}</dd>
              </div>
              <div>
                <dt>Next scheduled backup</dt>
                <dd>
                  {!info
                    ? "—"
                    : !info.backups.nextRunAt
                      ? "Scheduled backups are off"
                      : Date.parse(info.backups.nextRunAt) <= Date.now()
                        ? "Within a minute"
                        : time(info.backups.nextRunAt)}
                </dd>
              </div>
            </dl>
            <div className="flex justify-end">
              <button className="btn-solid" disabled={!info || !!saving}>
                {saving === "backups" && <Spinner />}
                Save backup settings
              </button>
            </div>
          </form>
          {!!info?.backups.files.length && (
            <div className="relative overflow-x-auto">
              <table className="data-table" aria-label="Backup files">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {info.backups.files.map((file) => (
                    <tr key={file.name}>
                      <td className="font-mono text-xs">{file.name}</td>
                      <td className="text-ink-subtle whitespace-nowrap">
                        {bytes(file.size)}
                      </td>
                      <td className="text-ink-subtle whitespace-nowrap">
                        {time(file.modifiedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <p className="footnote">
        <Shield size={14} className="mt-0.5 shrink-0" />
        Backups contain password hashes, so they cannot be downloaded here. Copy
        them from the directory above on the server.
      </p>
    </>
  );
}
function Select({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select">
      <select className="input" {...props}>
        {children}
      </select>
      <ChevronDown size={14} />
    </span>
  );
}

function SignIn({
  demo,
  oidc,
  onLogin,
  initialError,
  returnTo,
}: {
  demo: boolean;
  oidc: boolean;
  /** Where single sign-on returns to; local sign-in stays on the current page. */
  returnTo?: string;
  onLogin: (
    email: string,
    password: string,
    role?: "admin" | "member",
  ) => Promise<void>;
  initialError: string;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("approval") === "pending")
      setError("Your account is awaiting administrator approval.");
  }, []);
  async function submit(event?: FormEvent, role?: "admin" | "member") {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onLogin(email, password, role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthPage icon={<Server size={20} />} title="Your workspace">
      <p className="page-subtitle">
        {returnTo
          ? "Sign in to link your chat account."
          : "Sign in to access your virtual machines."}
      </p>
      {error && (
        <div className="notice mt-5" role="alert">
          <XCircle size={17} />
          {error}
        </div>
      )}
      {demo && (
        <div className="mt-6 flex flex-col gap-2">
          <p className="text-ink-muted mb-1 flex items-center gap-2 text-sm">
            <span className="chip">Demo environment</span>
            No server connected
          </p>
          <button
            className="btn-solid w-full"
            disabled={busy}
            onClick={() => submit(undefined, "admin")}
          >
            <Shield size={16} />
            Explore as administrator
            <ArrowRight size={16} />
          </button>
          <button
            className="btn-glass w-full justify-center"
            disabled={busy}
            onClick={() => submit(undefined, "member")}
          >
            <Users size={16} />
            Explore as member
            <ArrowRight size={16} />
          </button>
          <p className="divider mt-4">or sign in with an account</p>
        </div>
      )}
      {oidc && (
        <div className={`flex flex-col gap-4 ${demo ? "mt-4" : "mt-6"}`}>
          <a
            className="btn-glass w-full justify-center"
            href={`/api/auth/oidc${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ""}`}
          >
            Continue with SSO
            <ArrowUpRight size={16} />
          </a>
          <p className="divider">or use a local account</p>
        </div>
      )}
      <form
        onSubmit={submit}
        className={`flex flex-col gap-4 ${demo || oidc ? "mt-4" : "mt-6"}`}
      >
        <label className="field">
          Email address
          <input
            className="input"
            autoComplete="username"
            type="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          Password
          <input
            className="input"
            autoComplete="current-password"
            type="password"
            placeholder="Enter your password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={256}
          />
        </label>
        <button className="btn-solid mt-1 w-full" disabled={busy}>
          {busy ? <Spinner size={16} /> : <ArrowRight size={16} />}
          Sign in
        </button>
      </form>
      <p className="text-ink-muted mt-5 flex items-center gap-2 text-xs">
        <Shield size={14} />
        VM access is assigned by your administrator.
      </p>
    </AuthPage>
  );
}

type NewUser = {
  name: string;
  email: string;
  password?: string;
  role: "admin" | "member";
};
function AddMember({
  oidc,
  onClose,
  onSave,
}: {
  oidc: boolean;
  onClose: () => void;
  onSave: (values: NewUser) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState<"admin" | "member">("member"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({ name, email, role, ...(password ? { password } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create member");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add member" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <div className="notice" role="alert">
            <XCircle size={17} />
            {error}
          </div>
        )}
        <label className="field">
          Full name
          <input
            className="input"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="Alex Chen"
          />
        </label>
        <label className="field">
          Email address
          <input
            className="input"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder="alex@example.com"
          />
        </label>
        <label className="field">
          Role
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </Select>
          <span className="field-hint">
            {role === "admin"
              ? "Administrators can control every managed VM and change access."
              : "Members can access only the VMs assigned to them."}
          </span>
        </label>
        <label className="field">
          <span>
            Initial password{" "}
            {oidc && (
              <span className="field-hint">Optional for SSO accounts</span>
            )}
          </span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required={!oidc}
            minLength={12}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
          />
        </label>
        <p className="form-note">
          Share the initial password privately. This does not send an invitation
          email.
        </p>
        <DialogFooter>
          <button
            type="button"
            className="btn-soft"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn-solid" disabled={busy}>
            {busy && <Spinner />}Add member
          </button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

function MemberAccess({
  member,
  currentUser,
  vms,
  grants,
  onClose,
  onSave,
  onDelete,
}: {
  member: User;
  currentUser: User;
  vms: VM[];
  grants: Grant[];
  onClose: () => void;
  onDelete: () => Promise<void>;
  onSave: (
    patch: {
      role: "admin" | "member";
      enabled: boolean;
      password?: string;
      email?: string;
    },
    assignments: { vmId: number; permissions: Permission[] }[],
  ) => Promise<void>;
}) {
  const [role, setRole] = useState(member.role),
    [enabled, setEnabled] = useState(member.enabled),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  // A chat-only member cannot sign in, so it can manage nothing as an administrator.
  const canBeAdmin = member.email !== null || (!!email && !!password);
  const [access, setAccess] = useState<Record<number, Permission[]>>(() =>
    Object.fromEntries(
      vms.map((vm) => [
        vm.id,
        grants.find((g) => g.userId === member.id && g.vmId === vm.id)
          ?.permissions || [],
      ]),
    ),
  );
  function toggle(vmId: number, permission: Permission) {
    setAccess((previous) => {
      const list = previous[vmId] || [];
      if (permission === "view" && list.includes("view"))
        return { ...previous, [vmId]: [] };
      const next = list.includes(permission)
        ? list.filter((p) => p !== permission)
        : [...new Set<Permission>(["view", ...list, permission])];
      return { ...previous, [vmId]: next };
    });
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const changed = vms
      .filter(
        (vm) =>
          JSON.stringify([...(access[vm.id] || [])].sort()) !==
          JSON.stringify(
            [
              ...(grants.find((g) => g.userId === member.id && g.vmId === vm.id)
                ?.permissions || []),
            ].sort(),
          ),
      )
      .map((vm) => ({ vmId: vm.id, permissions: access[vm.id] || [] }));
    try {
      await onSave(
        {
          role,
          enabled,
          ...(password ? { password } : {}),
          ...(email ? { email } : {}),
        },
        changed,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save access");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete member");
      setBusy(false);
    }
  }
  if (confirmDelete)
    return (
      <Modal title={`Delete ${member.name}?`} onClose={onClose}>
        {error && (
          <div className="notice" role="alert">
            <XCircle size={17} />
            {error}
          </div>
        )}
        <DialogIcon>
          <Trash2 size={24} />
        </DialogIcon>
        <p className="dialog-copy">
          This removes the account, its VM access, its sessions, and its linked
          chat accounts. The activity log keeps its past events. This cannot be
          undone.
        </p>
        <DialogFooter>
          <button
            className="btn-soft"
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn-solid" onClick={remove} disabled={busy}>
            {busy && <Spinner />}Delete member
          </button>
        </DialogFooter>
      </Modal>
    );
  return (
    <Modal title={`Access · ${member.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <div className="notice" role="alert">
            <XCircle size={17} />
            {error}
          </div>
        )}
        <Person name={member.name} detail={member.email} />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field">
            Role
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
            >
              <option value="member">Member</option>
              {(canBeAdmin || member.role === "admin") && (
                <option value="admin">Administrator</option>
              )}
            </Select>
            {!canBeAdmin && (
              <span className="field-hint">
                Administrators need an email and a way to sign in
              </span>
            )}
          </label>
          <label className="field">
            Account status
            <Select
              value={enabled ? "enabled" : "disabled"}
              onChange={(e) => setEnabled(e.target.value === "enabled")}
            >
              <option value="enabled">Active</option>
              <option value="disabled">Disabled</option>
            </Select>
          </label>
        </div>
        {currentUser.id === member.id && (
          <p className="form-note">
            Changing your own role or status may end your administrator access.
          </p>
        )}
        {role === "admin" ? (
          <div className="notice">
            <Shield size={17} />
            Administrators have all permissions on every managed VM.
          </div>
        ) : (
          <>
            <h3 className="font-title text-ink-muted mt-2 text-xs font-semibold tracking-wide uppercase">
              Machine permissions
            </h3>
            <div className="flex flex-col gap-2">
              {vms.map((vm) => (
                <fieldset
                  className="rounded-2xl border border-black/5 px-4 pt-3 pb-4"
                  key={vm.id}
                >
                  <legend className="sr-only">{vm.name}</legend>
                  <div
                    className="flex items-center justify-between gap-3"
                    aria-hidden="true"
                  >
                    <span className="font-title text-ink flex items-center gap-2 text-sm font-bold">
                      <Monitor size={15} className="text-ink-subtle" />
                      {vm.name}
                    </span>
                    <span className="text-ink-muted text-xs">VM {vm.id}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                    {permissions.map((permission) => (
                      <label key={permission} className="check">
                        <input
                          type="checkbox"
                          checked={(access[vm.id] || []).includes(permission)}
                          onChange={() => toggle(vm.id, permission)}
                        />
                        {permissionNames[permission]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
            <p className="form-note">
              Force reset can lose unsaved work. Console access includes boot
              and recovery screens.
            </p>
          </>
        )}
        {member.email === null && (
          <label className="field">
            <span>
              Email address <span className="field-hint">Optional</span>
            </span>
            <input
              className="input"
              type="email"
              autoComplete="off"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Leave empty to keep this member chat-only"
            />
            <span className="field-hint">
              Chat-only members use the chat bot and cannot sign in. An email
              with a password, or with SSO, lets them sign in to the web.
            </span>
          </label>
        )}
        <label className="field">
          <span>
            {member.email === null ? "Initial password" : "Reset password"}{" "}
            <span className="field-hint">Optional</span>
          </span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave empty to keep the current password"
          />
          <span className="field-hint">
            A password reset signs this member out of all sessions.
          </span>
        </label>
        <DialogFooter>
          {currentUser.id !== member.id && (
            <button
              className="btn-soft sm:mr-auto"
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              <Trash2 size={15} />
              Delete member
            </button>
          )}
          <button
            className="btn-soft"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn-solid" disabled={busy}>
            {busy && <Spinner />}Save access
          </button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

function ChangePassword({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== repeat) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await onSave(current, password);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not change password",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Change password" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <div className="notice" role="alert">
            <XCircle size={17} />
            {error}
          </div>
        )}
        <label className="field">
          Current password
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          New password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
          />
        </label>
        <label className="field">
          Confirm new password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <p className="form-note">
          This changes your local account password and signs out other sessions.
          SSO-only accounts use their identity provider to manage passwords.
        </p>
        <DialogFooter>
          <button
            className="btn-soft"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn-solid" disabled={busy}>
            {busy && <Spinner />}Change password
          </button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

function ConsoleModal({ vm, onClose }: { vm: VM; onClose: () => void }) {
  const target = useRef<HTMLDivElement>(null),
    rfb = useRef<any>(null);
  const connectionRequest = useRef<{
    attempt: number;
    promise: Promise<{ demo: boolean; path?: string; password?: string }>;
  } | null>(null);
  const [status, setStatus] = useState("Connecting"),
    [error, setError] = useState(""),
    [demo, setDemo] = useState(false),
    [retry, setRetry] = useState(0),
    [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setStatus("Connecting");
    setError("");
    setDemo(false);
    setConnected(false);
    async function connect() {
      try {
        if (
          !connectionRequest.current ||
          connectionRequest.current.attempt !== retry
        )
          connectionRequest.current = {
            attempt: retry,
            promise: api(`/vms/${vm.id}/console`, { method: "POST" }),
          };
        const data = await connectionRequest.current.promise;
        if (cancelled) return;
        if (data.demo) {
          setDemo(true);
          setStatus("Demo");
          return;
        }
        const { default: RFB } = await import("@novnc/novnc");
        if (cancelled || !target.current) return;
        const url = new URL(data.path!, location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const client = new RFB(target.current, url.toString(), {
          credentials: { password: data.password },
          wsProtocols: ["binary"],
        });
        rfb.current = client;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = getComputedStyle(target.current).backgroundColor;
        client.addEventListener("connect", () => {
          if (!cancelled) {
            setStatus("Connected");
            setConnected(true);
          }
        });
        client.addEventListener("disconnect", (event: CustomEvent) => {
          if (!cancelled) {
            setStatus("Disconnected");
            setConnected(false);
            if (!event.detail.clean)
              setError(
                "The console connection ended. Your session or VM access may have expired.",
              );
          }
        });
        client.addEventListener("securityfailure", () => {
          if (!cancelled)
            setError(
              "Proxmox rejected console authentication. Check the service account’s console permission.",
            );
        });
        client.addEventListener("credentialsrequired", () => {
          if (!cancelled)
            setError(
              "Console authentication needs additional credentials. Check the Proxmox console configuration.",
            );
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Console connection failed",
          );
          setStatus("Disconnected");
        }
      }
    }
    void connect();
    return () => {
      cancelled = true;
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [vm.id, retry]);
  return (
    <Modal title={`${vm.name} · Console`} onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-ink-soft inline-flex items-center gap-2 text-sm">
          <i className={`state-dot ${connected ? "state-on" : "state-off"}`} />
          {status}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="btn-soft px-3 py-1.5"
            disabled={!connected}
            onClick={() => rfb.current?.sendCtrlAltDel()}
          >
            Ctrl · Alt · Del
          </button>
          <button
            className="btn-icon"
            title="Reconnect console"
            aria-label="Reconnect console"
            disabled={status === "Connecting"}
            onClick={() => setRetry((n) => n + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {error && (
        <div className="notice mb-3" role="alert">
          <XCircle size={17} />
          {error}
        </div>
      )}
      <div
        className="console-screen bg-ink text-on-ink relative aspect-video overflow-hidden rounded-lg"
        ref={target}
      >
        {demo && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <SquareTerminal size={34} className="opacity-60" />
            <h3 className="font-title text-lg font-bold">
              No live console in demo mode
            </h3>
            <p className="font-article text-sm opacity-80">
              Connect your Proxmox server to use the VM’s display and keyboard
              here.
            </p>
            <span className="font-mono text-xs opacity-60">
              VM {vm.id} · {vm.node}
            </span>
          </div>
        )}
        {status === "Connecting" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm opacity-80">
            <Spinner size={24} />
            <span>Establishing secure console connection…</span>
          </div>
        )}
      </div>
      <p className="text-ink-muted mt-3 flex items-start gap-2 text-xs leading-relaxed">
        <Shield size={13} className="mt-0.5 shrink-0" />
        Use your VM’s operating-system credentials to log in. Closing this
        window leaves the VM running.
      </p>
    </Modal>
  );
}
