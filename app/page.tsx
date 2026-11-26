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
  Layers3,
  LayoutGrid,
  Link2,
  Loader2,
  LogOut,
  MemoryStick,
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
  Settings,
  Settings2,
  Shield,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Unlink,
  Users,
  X,
  XCircle,
  Zap,
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
    <span className={`state state-${value}`}>
      <i />
      {value === "running"
        ? "Running"
        : value === "stopped"
          ? "Stopped"
          : value}
    </span>
  );
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
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="modal-heading">
          <h2 id="modal-title">{title}</h2>
          <button
            className="icon-button"
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
    // The sidebar holds the account menu; phones hide the sidebar's foot
    // and open the same menu from the top bar.
    [accountMenu, setAccountMenu] = useState<"sidebar" | "topbar" | null>(
      null,
    );
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
      <div className="initial-loading">
        <Layers3 size={30} />
        <Loader2 className="spin" size={20} />
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

  const accountMenuItems = (
    <>
      <strong>{user.email ?? user.name}</strong>
      <span>{user.role === "admin" ? "Administrator" : "Member"}</span>
      <button
        onClick={() => {
          setChangePassword(true);
          setAccountMenu(null);
        }}
      >
        <Shield size={15} />
        Change password
      </button>
      <button
        onClick={() => {
          setChatAccounts(true);
          setAccountMenu(null);
        }}
      >
        <MessageSquare size={15} />
        Chat accounts
      </button>
      <button onClick={logout}>
        <LogOut size={15} />
        Sign out
      </button>
    </>
  );
  return (
    <div
      className="app-shell"
      onClick={() => {
        if (menu !== null) setMenu(null);
      }}
    >
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <Layers3 size={21} />
          </span>
          Prox<span>desk</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon" aria-hidden="true">
            {(workspaceName || "P").charAt(0).toUpperCase()}
          </span>
          <div>
            <strong>{workspaceName || "Proxdesk"}</strong>
            <small>Infrastructure</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <button
            className={tab === "vms" ? "nav-item active" : "nav-item"}
            onClick={() => {
              setTab("vms");
              setSelected(null);
            }}
          >
            <LayoutGrid size={18} />
            Virtual machines<span className="nav-count">{vms.length}</span>
          </button>
          {user.role === "admin" && (
            <button
              className={tab === "members" ? "nav-item active" : "nav-item"}
              onClick={() => setTab("members")}
            >
              <Users size={18} />
              Members<span className="nav-count">{members.length}</span>
            </button>
          )}
          {user.role === "admin" && (
            <button
              className={tab === "chat" ? "nav-item active" : "nav-item"}
              onClick={() => setTab("chat")}
            >
              <MessageSquare size={18} />
              Chat
            </button>
          )}
          <button
            className={tab === "activity" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("activity")}
          >
            <Activity size={18} />
            Activity
          </button>
          {user.role === "admin" && (
            <button
              className={tab === "settings" ? "nav-item active" : "nav-item"}
              onClick={() => setTab("settings")}
            >
              <Settings size={18} />
              Settings
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={`connection-dot ${loadError ? "offline" : ""}`} />
            <div>
              <strong>
                {demo
                  ? "Demo environment"
                  : loadError
                    ? "Connection needs attention"
                    : "Proxmox connected"}
              </strong>
              <small>
                {demo ? "Simulated infrastructure" : "Secure server connection"}
              </small>
            </div>
          </div>
          <div className="account-wrap">
            {accountMenu === "sidebar" && (
              <div className="account-menu">{accountMenuItems}</div>
            )}
            <button
              className="account"
              onClick={() =>
                setAccountMenu(accountMenu === "sidebar" ? null : "sidebar")
              }
              aria-expanded={accountMenu === "sidebar"}
            >
              <span className="avatar">{initials(user.name)}</span>
              <span>
                <strong>{user.name}</strong>
                <small>
                  {user.role === "admin" ? "Administrator" : "Member"}
                </small>
              </span>
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{workspaceName || "Proxdesk"}</span>
            <ChevronRight size={14} />
            <strong>
              {tab === "vms"
                ? "Virtual machines"
                : tab === "members"
                  ? "Members"
                  : tab === "chat"
                    ? "Chat"
                    : tab === "settings"
                      ? "Settings"
                      : "Activity"}
            </strong>
          </div>
          <div className="topbar-right">
            {demo && <span className="demo-pill">Demo mode</span>}
            <div className="topbar-account">
              <button
                className="topbar-avatar"
                title={user.name}
                aria-label="Account menu"
                aria-expanded={accountMenu === "topbar"}
                onClick={() =>
                  setAccountMenu(accountMenu === "topbar" ? null : "topbar")
                }
              >
                {initials(user.name)}
              </button>
              {accountMenu === "topbar" && (
                <div className="account-menu topbar-menu">
                  {accountMenuItems}
                </div>
              )}
            </div>
          </div>
        </header>
        <main>
          {loadError && (
            <div className="error-banner" role="alert">
              <XCircle size={18} />
              <span>{loadError}</span>
              <button onClick={() => refresh(user)}>Retry</button>
            </div>
          )}
          {tab === "vms" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Virtual machines</h1>
                </div>
                <button
                  className="button"
                  onClick={() => refresh(user)}
                  disabled={loading}
                >
                  <RefreshCw size={15} className={loading ? "spin" : ""} />
                  Refresh
                </button>
              </div>
              <div className="stats-grid">
                <Stat
                  title="Virtual machines"
                  value={String(vms.length)}
                  subtitle={
                    user.role === "admin"
                      ? "In your managed inventory"
                      : "Assigned to you"
                  }
                  icon={<Server size={19} />}
                />
                <Stat
                  title="Running"
                  value={String(running.length)}
                  subtitle={
                    <>
                      <span className="tiny-dot" />
                      {vms.filter((vm) => vm.status === "stopped").length}{" "}
                      stopped
                    </>
                  }
                  icon={<Zap size={19} />}
                />
                <Stat
                  title="Memory in use"
                  value={size(vms.reduce((n, vm) => n + vm.memory, 0))}
                  subtitle={`${size(vms.reduce((n, vm) => n + vm.maxMemory, 0))} allocated`}
                  icon={<MemoryStick size={19} />}
                />
              </div>
              <section className="panel machine-panel">
                <div className="panel-toolbar">
                  <div className="search-box">
                    <Search size={16} />
                    <input
                      aria-label="Search virtual machines"
                      placeholder="Search machines…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="filter-control">
                    <span
                      className={`filter-dot ${filter === "stopped" ? "muted-dot" : ""}`}
                    />
                    <select
                      aria-label="Filter VM status"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">All statuses</option>
                      <option value="running">Running</option>
                      <option value="stopped">Stopped</option>
                    </select>
                    <ChevronDown size={14} />
                  </div>
                </div>
                <div className="table-scroll">
                  <table className="vm-table">
                    <thead>
                      <tr>
                        <th>Machine</th>
                        <th>Status</th>
                        <th>CPU</th>
                        <th>Memory</th>
                        <th>Uptime</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((vm) => (
                        <tr
                          key={vm.id}
                          className={selected === vm.id ? "selected-row" : ""}
                        >
                          <td>
                            <button
                              className="machine-name"
                              aria-label={`View ${vm.name} details`}
                              onClick={() => setSelected(vm.id)}
                            >
                              <span
                                className={`vm-icon ${vm.status !== "running" ? "vm-off" : ""}`}
                              >
                                <Monitor size={20} />
                              </span>
                              <span>
                                <strong>{vm.name}</strong>
                                <small>
                                  VM {vm.id}
                                  <i />
                                  {vm.node}
                                </small>
                              </span>
                            </button>
                          </td>
                          <td>
                            {vm.operation ? (
                              <span className="operation-state">
                                <Loader2 size={13} className="spin" />
                                {actionNames[vm.operation.action]}…
                              </span>
                            ) : (
                              <State value={vm.status} />
                            )}
                          </td>
                          <td>
                            <div className="metric-cell">
                              <span>
                                {(vm.cpu * 100).toFixed(1)}
                                <small>%</small>
                              </span>
                              <div className="meter">
                                <i
                                  style={{
                                    width: `${Math.min(vm.cpu * 100, 100)}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="memory-cell">
                              <span>
                                {gib(vm.memory).toFixed(1)}{" "}
                                <small>
                                  / {gib(vm.maxMemory).toFixed(0)} GiB
                                </small>
                              </span>
                              <div className="meter">
                                <i
                                  style={{
                                    width: `${vm.maxMemory ? Math.min((vm.memory / vm.maxMemory) * 100, 100) : 0}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="uptime-cell">{uptime(vm.uptime)}</td>
                          <td>
                            <div className="row-actions">
                              {vm.permissions.includes("console") && (
                                <button
                                  className="console-button"
                                  aria-label={`Open ${vm.name} console`}
                                  title={`Open ${vm.name} console`}
                                  disabled={
                                    vm.status !== "running" || !!vm.operation
                                  }
                                  onClick={() => setConsoleVM(vm)}
                                >
                                  <SquareTerminal size={15} />
                                  <span>Console</span>
                                </button>
                              )}
                              <div className="menu-anchor">
                                <button
                                  className="icon-button"
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
                                    className="action-menu"
                                    style={{
                                      position: "fixed",
                                      ...menuPosition,
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
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
                                          disabled={!canAct(vm, action)}
                                          className={
                                            action === "reset"
                                              ? "danger-text"
                                              : ""
                                          }
                                          onClick={() =>
                                            selectAction(vm, action)
                                          }
                                        >
                                          {action === "start" ? (
                                            <Play size={15} />
                                          ) : action === "shutdown" ? (
                                            <Power size={15} />
                                          ) : (
                                            <RotateCcw size={15} />
                                          )}
                                          {actionNames[action]}
                                        </button>
                                      ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!visible.length && (
                  <div className="empty-state">
                    <Server size={28} />
                    <h3>
                      {loading
                        ? "Loading machines…"
                        : search || filter !== "all"
                          ? "No matching machines"
                          : "No machines assigned"}
                    </h3>
                    <p>
                      {search || filter !== "all"
                        ? "Try another search or status."
                        : user.role === "admin"
                          ? "Check the service account’s VM access in Proxmox."
                          : "Ask your administrator to assign a VM to your account."}
                    </p>
                    {(search || filter !== "all") && (
                      <button
                        className="button"
                        onClick={() => {
                          setSearch("");
                          setFilter("all");
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    {visible.length} of {vms.length} machines
                  </span>
                  <span>
                    <span className="tiny-dot" />
                    {checkedAt
                      ? `Updated ${new Date(checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                      : "Waiting for inventory"}
                  </span>
                </div>
              </section>
              <section className="panel activity-preview">
                <div className="section-heading">
                  <h2>Recent activity</h2>
                  <button
                    className="text-button"
                    onClick={() => setTab("activity")}
                  >
                    View all
                    <ArrowRight size={14} />
                  </button>
                </div>
                <EventList events={events.slice(0, 4)} compact />
              </section>
              <div className="page-footnote">
                <Shield size={14} />
                {demo
                  ? "Changes affect demo data only. No Proxmox server is connected."
                  : "Actions are checked against your VM permissions and recorded in the audit log."}
              </div>
            </>
          )}
          {tab === "members" && user.role === "admin" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Members</h1>
                  <p>Choose who can access your virtual machines.</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setNewMember(true)}
                >
                  <Plus size={16} />
                  Add member
                </button>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <h2>
                    Workspace members{" "}
                    <span className="count-label">{members.length}</span>
                  </h2>
                  <span className="muted">
                    {members.filter((m) => m.enabled).length} active
                  </span>
                </div>
                <div className="table-scroll">
                  <table className="members-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Role</th>
                        <th>Access</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>
                            <div className="person">
                              <span className="avatar">
                                {initials(member.name)}
                              </span>
                              <div>
                                <strong>
                                  {member.name}
                                  {member.id === user.id && (
                                    <small className="you">You</small>
                                  )}
                                </strong>
                                {member.email ? (
                                  <small>{member.email}</small>
                                ) : (
                                  <small>
                                    <span className="chat-badge">Chat only</span>
                                  </small>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`role ${member.role}`}>
                              {member.role === "admin" && <Shield size={12} />}
                              {member.role === "admin"
                                ? "Administrator"
                                : "Member"}
                            </span>
                          </td>
                          <td className="muted">
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
                          <td>
                            <span
                              className={`state ${member.enabled ? "state-running" : "state-stopped"}`}
                            >
                              <i />
                              {member.enabled ? "Active" : "Disabled / pending"}
                            </span>
                          </td>
                          <td>
                            <button
                              className="button small"
                              onClick={() => setEditMember(member)}
                            >
                              Manage access
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
              <div className="page-heading">
                <div>
                  <h1>Activity</h1>
                  <p>
                    {user.role === "admin"
                      ? "Power actions, console sessions, and access changes across the workspace."
                      : "Your recent requests and their outcomes."}
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() => refresh(user)}
                  disabled={loading}
                >
                  <RefreshCw size={15} className={loading ? "spin" : ""} />
                  Refresh
                </button>
              </div>
              <section className="panel">
                <div className="section-heading">
                  <h2>Audit log</h2>
                  <span className="muted">Latest {events.length} events</span>
                </div>
                <EventList events={events} />
              </section>
            </>
          )}
        </main>
      </div>
      {selectedVM && (
        <div
          className="drawer-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <aside
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedVM.name} details`}
          >
            <div className="drawer-top">
              <span>Machine details</span>
              <button
                className="icon-button"
                aria-label="Close machine details"
                onClick={() => setSelected(null)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="drawer-title">
              <span className="vm-icon large">
                <Monitor size={26} />
              </span>
              <h2>{selectedVM.name}</h2>
              <State value={selectedVM.status} />
            </div>
            <div className="detail-actions">
              {selectedVM.permissions.includes("console") && (
                <button
                  className="button primary"
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
                    className={`button ${action === "reset" ? "danger-text" : ""}`}
                    disabled={!canAct(selectedVM, action)}
                    key={action}
                    onClick={() => {
                      selectAction(selectedVM, action);
                      setSelected(null);
                    }}
                  >
                    {action === "start" ? (
                      <Play size={14} />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    {actionNames[action]}
                  </button>
                ))}
            </div>
            {selectedVM.operation && (
              <div className="inline-note">
                <Loader2 size={16} className="spin" />
                {actionNames[selectedVM.operation.action]} in progress
              </div>
            )}
            <h3 className="detail-section-title">Overview</h3>
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
                <h3 className="detail-section-title">Tags</h3>
                <div className="tag-list">
                  {selectedVM.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </>
            )}
            <h3 className="detail-section-title">Your permissions</h3>
            <div className="tag-list">
              {selectedVM.permissions.map((p) => (
                <span className="permission-tag" key={p}>
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
          <div
            className={`confirm-icon ${confirm.action === "reset" ? "danger" : ""}`}
          >
            {confirm.action === "shutdown" ? (
              <Power size={25} />
            ) : confirm.action === "start" ? (
              <Play size={25} />
            ) : (
              <RotateCcw size={25} />
            )}
          </div>
          <p className="dialog-copy">
            {confirm.action === "start"
              ? "The VM will boot. You can open its console once it is running."
              : confirm.action === "reboot"
                ? "The guest operating system will be asked to restart gracefully. Active connections will disconnect."
                : confirm.action === "shutdown"
                  ? "The guest operating system will be asked to shut down. The VM will stay off until someone starts it."
                  : "This immediately resets the virtual hardware. Unsaved work can be lost and filesystem corruption is possible."}
          </p>
          <div className="confirm-target">
            <Monitor size={17} />
            <strong>{confirm.vm.name}</strong>
            <span>
              VM {confirm.vm.id} · {confirm.vm.node}
            </span>
          </div>
          <div className="modal-footer">
            <button className="button" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
            <button
              className={`button ${confirm.action === "reset" ? "destructive" : "primary"}`}
              onClick={doAction}
              disabled={busy}
            >
              {busy && <Loader2 size={15} className="spin" />}
              {busy ? "Submitting…" : `${actionNames[confirm.action]} VM`}
            </button>
          </div>
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
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <XCircle size={19} /> : <CheckCircle2 size={19} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
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

function Stat({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string;
  subtitle: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{title}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <div className="stat-bottom">{subtitle}</div>
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
  return (
    <div className={compact ? "events compact-events" : "events"}>
      {events.length ? (
        events.map((event) => (
          <div className="event" key={event.id}>
            <span
              className={`event-icon ${event.action.includes("failed") || event.action.includes("unknown") ? "event-error" : ""}`}
            >
              {event.action.includes("console") ? (
                <SquareTerminal size={16} />
              ) : event.action.includes("access") ||
                event.action.includes("account") ||
                event.action.includes("administrator") ? (
                <Shield size={16} />
              ) : event.action.includes("succeeded") ? (
                <Check size={16} />
              ) : (
                <Activity size={16} />
              )}
            </span>
            <div className="event-content">
              <strong>
                {event.action} <span>·</span> {event.target}
              </strong>
              <p>
                {event.userName}
                {!compact && event.detail && <> · {event.detail}</>}
              </p>
            </div>
            <time dateTime={event.createdAt}>{time(event.createdAt)}</time>
          </div>
        ))
      ) : (
        <div className="empty-state">
          <Clock3 size={26} />
          <h3>No activity yet</h3>
          <p>Your requests and access changes will appear here.</p>
        </div>
      )}
    </div>
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
      <div className="page-heading">
        <div>
          <h1>Chat</h1>
        </div>
        <button className="button" onClick={load} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          Refresh
        </button>
      </div>
      {info && !info.adapters.length && (
        <div className="inline-note">
          <MessageSquare size={17} />
          No chat bot is configured. Set the Slack or Discord settings described
          in docs/chat.md, then restart the service.
        </div>
      )}
      {info?.adapters.map((adapter) => (
        <div key={adapter.id}>
          {adapter.state !== "connected" && (
            <div className="error-banner" role="alert">
              <XCircle size={18} />
              <span>
                The bot is not connected to {adapter.label}
                {adapter.lastError ? `: ${adapter.lastError}` : "."}
              </span>
              <button onClick={load}>Retry</button>
            </div>
          )}
          {adapter.membersError && (
            <div className="error-banner" role="alert">
              <XCircle size={18} />
              <span>{adapter.membersError}</span>
              <button onClick={load}>Retry</button>
            </div>
          )}
          {adapter.directory && (
            <section className="panel">
              <div className="section-heading">
                <h2>
                  <span>{`${adapter.label} members`}</span>
                  <span className="count-label">{adapter.members.length}</span>
                </h2>
                <span className="muted">
                  {info.demo
                    ? `Demo directory · no ${adapter.label} workspace connected`
                    : adapter.state === "connected"
                      ? `Bot connected · ${adapter.conversations.join(", ")}`
                      : adapter.conversations.join(", ")}
                </span>
              </div>
              <div className="table-scroll">
                <table className="members-table chat-table">
                  <thead>
                    <tr>
                      <th>{adapter.label} user</th>
                      <th>Proxdesk account</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {adapter.members.map((member) => {
                      const current = identity(adapter.id, member.ref);
                      const busy = saving === `${adapter.id}:${member.ref}`;
                      return (
                        <tr key={member.ref}>
                          <td>
                            <div className="person">
                              <span className="avatar">
                                {initials(member.name)}
                              </span>
                              <div>
                                <strong>{member.name}</strong>
                                <small>@{member.handle}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="filter-control">
                              <select
                                aria-label={`Account for ${member.name}`}
                                value={current?.userId ?? ""}
                                disabled={busy}
                                onChange={(e) =>
                                  e.target.value
                                    ? link(adapter.id, member, e.target.value)
                                    : current &&
                                      unlink(current, member.name)
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
                          <td>
                            {!current && (
                              <button
                                className="button small"
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
            </section>
          )}
          {!adapter.directory && (
            <section className="panel">
              <div className="section-heading">
                <h2>
                  <span>{adapter.label}</span>
                </h2>
                <span className="muted">
                  {adapter.state === "connected"
                    ? `Bot connected · ${adapter.conversations.join(", ")}`
                    : adapter.conversations.join(", ")}
                </span>
              </div>
              <div className="panel-body">
                <p className="muted">
                  {adapter.label} does not let the bot list its members, so
                  people link themselves: they mention the bot with
                  &ldquo;link&rdquo; and open the link it sends. Their links
                  appear under Linked chat accounts.
                </p>
              </div>
            </section>
          )}
        </div>
      ))}
      {info && (
        <section className="panel">
          <div className="section-heading">
            <h2>
              <span>Linked chat accounts</span>
              <span className="count-label">{info.identities.length}</span>
            </h2>
          </div>
          {info.identities.length ? (
            <div className="table-scroll">
              <table className="members-table chat-table">
                <thead>
                  <tr>
                    <th>Chat account</th>
                    <th>Proxdesk account</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {info.identities.map((i) => (
                    <tr key={`${i.platform}:${i.userRef}`}>
                      <td>
                        <div className="person">
                          <span className="avatar">
                            {initials(i.displayName)}
                          </span>
                          <div>
                            <strong>{i.displayName}</strong>
                            <small>
                              {i.platformLabel} · {i.userRef}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="person-text">
                          <strong>{i.userName}</strong>
                          <small>
                            {i.userEmail ?? (
                              <span className="chat-badge">Chat only</span>
                            )}
                          </small>
                        </div>
                      </td>
                      <td>
                        <button
                          className="button small"
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
            <div className="empty-state">
              <MessageSquare size={26} />
              <h3>No linked chat accounts</h3>
              <p>
                Link a member above, or ask people to mention the bot with
                &ldquo;link&rdquo;.
              </p>
            </div>
          )}
        </section>
      )}
      <div className="page-footnote">
        <Shield size={14} />
        The bot acts with the linked member&apos;s VM permissions. Chat-only
        members cannot sign in; grant their VMs under Members.
      </div>
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
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {identities === null && !error ? (
        <Loader2 className="spin" size={18} />
      ) : identities?.length ? (
        <div className="identity-list">
          {identities.map((i) => (
            <div className="confirm-target" key={`${i.platform}:${i.userRef}`}>
              <MessageSquare size={17} />
              <strong>{i.displayName}</strong>
              <span>{i.platformLabel}</span>
              <button
                className="button small"
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
      <p className="form-note">
        The bot acts for a linked chat account with your VM permissions. To link
        one, mention the bot with &ldquo;link&rdquo; and open the link it sends
        you.
      </p>
      <div className="modal-footer">
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
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
      {preview.handle && <strong>@{preview.handle}</strong>}
      {preview.handle ? " (ID " : "ID "}
      <code>{preview.userRef}</code>
      {preview.handle && ")"}
    </>
  );
  return (
    <div className="login-page">
      <div className="login-brand brand">
        <span className="brand-mark">
          <Layers3 size={22} />
        </span>
        Prox<span>desk</span>
      </div>
      <div className="login-card">
        <div className="login-icon">
          <Link2 size={26} />
        </div>
        <h1>Link chat account</h1>
        {done ? (
          <p className="login-description">
            {label} user {who} is linked to your account. Mention the bot in{" "}
            {label} to manage your VMs.
          </p>
        ) : preview ? (
          <p className="login-description">
            Link {label} user {who} to your account?
          </p>
        ) : (
          !error && <Loader2 className="spin" size={18} />
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {preview && !done && (
          <>
            <div className="confirm-target">
              <Users size={17} />
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
            {preview.linked !== "self" && (
              <p className="link-warning" role="note">
                <TriangleAlert size={16} />
                <span>
                  Only confirm if you just asked the bot for this link
                  yourself. If someone sent it to you, cancel: linking gives
                  their {label} account your access.
                </span>
              </p>
            )}
            {preview.linked === "self" ? (
              <p className="form-note link-note">
                This {label} user is already linked to your account.
              </p>
            ) : (
              <p className="form-note link-note">
                The bot will act for this {label} user with your VM
                permissions, including power actions.
              </p>
            )}
            {preview.linked === "other" && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={move}
                  onChange={(e) => setMove(e.target.checked)}
                />
                This {label} user is linked to another Proxdesk account. Move it
                to mine.
              </label>
            )}
            <div className="modal-footer">
              <a className="button" href="/">
                Cancel
              </a>
              <button
                className="button primary"
                disabled={
                  busy ||
                  preview.linked === "self" ||
                  (preview.linked === "other" && !move)
                }
                onClick={confirm}
              >
                {busy && <Loader2 size={15} className="spin" />}
                Link account
              </button>
            </div>
          </>
        )}
        {(done || (error && !preview)) && (
          <a className="button primary login-submit" href="/">
            Continue to Proxdesk
            <ArrowRight size={16} />
          </a>
        )}
      </div>
      <div className="login-footer">Proxdesk · VM self-service</div>
    </div>
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
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <section className="panel settings-panel">
        <div className="section-heading">
          <h2>Workspace</h2>
        </div>
        <form
          className="panel-body"
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
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!info}
            />
          </label>
          <div className="two-fields">
            <label className="field">
              Managed VMs
              <select
                value={scopeType}
                disabled={!info}
                onChange={(e) =>
                  setScopeType(e.target.value as "all" | "pool" | "tag")
                }
              >
                <option value="all">All VMs the token can see</option>
                <option value="pool">VMs in a pool</option>
                <option value="tag">VMs with a tag</option>
              </select>
            </label>
            {scopeType !== "all" && (
              <label className="field">
                {scopeType === "pool" ? "Pool" : "Tag"}
                <input
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
            settings, Slack, and the console. Their existing grants are kept but
            have no effect.
          </p>
          <div className="panel-actions">
            <button className="button primary" disabled={!info || !!saving}>
              {saving === "workspace" && <Loader2 size={15} className="spin" />}
              Save workspace
            </button>
          </div>
        </form>
      </section>
      <section className="panel settings-panel">
        <div className="section-heading">
          <h2>Proxmox connection</h2>
          <button
            className="button small"
            onClick={runCheck}
            disabled={checking}
          >
            <RefreshCw size={13} className={checking ? "spin" : ""} />
            Run check
          </button>
        </div>
        <div className="events">
          {checks?.map((check, index) => (
            <div className="event" key={index}>
              <span
                className={`event-icon ${check.status === "fail" ? "event-error" : check.status === "warn" ? "event-warn" : ""}`}
              >
                {check.status === "fail" ? (
                  <XCircle size={16} />
                ) : check.status === "warn" ? (
                  <TriangleAlert size={16} />
                ) : (
                  <Check size={16} />
                )}
              </span>
              <div className="event-content">
                <strong>{check.message}</strong>
              </div>
            </div>
          ))}
          {!checks && (
            <div className="empty-state">
              {checking ? (
                <Loader2 size={26} className="spin" />
              ) : (
                <Server size={26} />
              )}
              <h3>{checking ? "Checking Proxmox…" : "Not checked yet"}</h3>
            </div>
          )}
        </div>
        {checkedAt && (
          <div className="table-footer">
            <span />
            <span>
              <span className="tiny-dot" />
              Checked {time(checkedAt)}
            </span>
          </div>
        )}
      </section>
      <section className="panel settings-panel">
        <div className="section-heading">
          <h2>
            Backups
            {info && (
              <span className="count-label">{info.backups.files.length}</span>
            )}
          </h2>
          <button
            className="button small"
            onClick={backUpNow}
            disabled={!info || backingUp}
          >
            {backingUp ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <DatabaseBackup size={13} />
            )}
            Back up now
          </button>
        </div>
        <form
          className="panel-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save("backups", { backups });
          }}
        >
          {status?.lastFailure &&
            (!status.lastSuccess ||
              status.lastFailure.at > status.lastSuccess.at) && (
              <div className="form-error" role="alert">
                Last backup failed {time(status.lastFailure.at)}:{" "}
                {status.lastFailure.error}
              </div>
            )}
          <div className="three-fields">
            <label className="field">
              Scheduled backups
              <select
                value={backups.enabled ? "on" : "off"}
                disabled={!info}
                onChange={(e) =>
                  setBackups({ ...backups, enabled: e.target.value === "on" })
                }
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="field">
              Every (hours)
              <input
                type="number"
                required
                min={1}
                max={168}
                value={backups.intervalHours}
                disabled={!info}
                onChange={(e) =>
                  setBackups({ ...backups, intervalHours: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              Keep (newest)
              <input
                type="number"
                required
                min={1}
                max={1000}
                value={backups.retention}
                disabled={!info}
                onChange={(e) =>
                  setBackups({ ...backups, retention: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <dl className="details">
            <div>
              <dt>Directory</dt>
              <dd>{info?.backups.dir ?? "—"}</dd>
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
          <div className="panel-actions">
            <button className="button primary" disabled={!info || !!saving}>
              {saving === "backups" && <Loader2 size={15} className="spin" />}
              Save backup settings
            </button>
          </div>
        </form>
        {!!info?.backups.files.length && (
          <div className="table-scroll">
            <table className="members-table backup-table">
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
                    <td>{file.name}</td>
                    <td className="muted">{bytes(file.size)}</td>
                    <td className="muted">{time(file.modifiedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="page-footnote">
        <Shield size={14} />
        Backups contain password hashes, so they cannot be downloaded here.
        Copy them from the directory above on the server.
      </div>
    </>
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
    <div className="login-page">
      <div className="login-brand brand">
        <span className="brand-mark">
          <Layers3 size={22} />
        </span>
        Prox<span>desk</span>
      </div>
      <div className="login-card">
        <div className="login-icon">
          <Server size={26} />
        </div>
        <h1>Your workspace</h1>
        <p className="login-description">
          {returnTo
            ? "Sign in to link your chat account."
            : "Sign in to access your virtual machines."}
        </p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {demo && (
          <div className="demo-login">
            <div className="demo-label">
              <span className="demo-pill">Demo environment</span>
              <span>No server connected</span>
            </div>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => submit(undefined, "admin")}
            >
              <Shield size={16} />
              Explore as administrator
              <ArrowRight size={16} />
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => submit(undefined, "member")}
            >
              <Users size={16} />
              Explore as member
              <ArrowRight size={16} />
            </button>
            <div className="login-divider">
              <span>or sign in with an account</span>
            </div>
          </div>
        )}
        {oidc && (
          <>
            <a
              className="button sso-button"
              href={`/api/auth/oidc${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ""}`}
            >
              Continue with SSO
              <ArrowUpRight size={16} />
            </a>
            <div className="login-divider">
              <span>or use a local account</span>
            </div>
          </>
        )}
        <form onSubmit={submit}>
          <label className="field">
            Email address
            <input
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
              autoComplete="current-password"
              type="password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={256}
            />
          </label>
          <button className="button primary login-submit" disabled={busy}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            Sign in
          </button>
        </form>
        <div className="login-help">
          <Shield size={14} />
          VM access is assigned by your administrator.
        </div>
      </div>
      <div className="login-footer">Proxdesk · VM self-service</div>
    </div>
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
      <form onSubmit={submit}>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <label className="field">
          Full name
          <input
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
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
          <small>
            {role === "admin"
              ? "Administrators can control every managed VM and change access."
              : "Members can access only the VMs assigned to them."}
          </small>
        </label>
        <label className="field">
          Initial password
          {oidc && <span className="muted">Optional for SSO accounts</span>}
          <input
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
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}Add member
          </button>
        </div>
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
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-icon danger">
          <Trash2 size={25} />
        </div>
        <p className="dialog-copy">
          This removes the account, its VM access, its sessions, and its linked
          chat accounts. The activity log keeps its past events. This cannot be
          undone.
        </p>
        <div className="modal-footer">
          <button
            className="button"
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button destructive" onClick={remove} disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}Delete member
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title={`Access · ${member.name}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="member-summary">
          <span className="avatar">{initials(member.name)}</span>
          <div>
            <strong>{member.name}</strong>
            <small>
              {member.email ?? <span className="chat-badge">Chat only</span>}
            </small>
          </div>
        </div>
        <div className="two-fields">
          <label className="field">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
            >
              <option value="member">Member</option>
              {(canBeAdmin || member.role === "admin") && (
                <option value="admin">Administrator</option>
              )}
            </select>
            {!canBeAdmin && (
              <span className="muted">
                Administrators need an email and a way to sign in
              </span>
            )}
          </label>
          <label className="field">
            Account status
            <select
              value={enabled ? "enabled" : "disabled"}
              onChange={(e) => setEnabled(e.target.value === "enabled")}
            >
              <option value="enabled">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
        </div>
        {currentUser.id === member.id && (
          <p className="form-note">
            Changing your own role or status may end your administrator access.
          </p>
        )}
        {role === "admin" ? (
          <div className="inline-note">
            <Shield size={17} />
            Administrators have all permissions on every managed VM.
          </div>
        ) : (
          <>
            <h3 className="form-section-heading">Machine permissions</h3>
            <div className="permission-list">
              {vms.map((vm) => (
                <div className="permission-machine" key={vm.id}>
                  <div className="row">
                    <strong>
                      <Monitor size={15} />
                      {vm.name}
                    </strong>
                    <span className="muted">VM {vm.id}</span>
                  </div>
                  <div className="permission-checks">
                    {permissions.map((permission) => (
                      <label
                        key={permission}
                        className={
                          permission === "reset" ? "reset-permission" : ""
                        }
                      >
                        <input
                          type="checkbox"
                          checked={(access[vm.id] || []).includes(permission)}
                          onChange={() => toggle(vm.id, permission)}
                        />
                        {permissionNames[permission]}
                      </label>
                    ))}
                  </div>
                </div>
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
            Email address <span className="muted">Optional</span>
            <input
              type="email"
              autoComplete="off"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Leave empty to keep this member chat-only"
            />
            <small>
              Chat-only members use the chat bot and cannot sign in. An email
              with a password, or with SSO, lets them sign in to the web.
            </small>
          </label>
        )}
        <label className="field">
          {member.email === null ? "Initial password" : "Reset password"}{" "}
          <span className="muted">Optional</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave empty to keep the current password"
          />
          <small>A password reset signs this member out of all sessions.</small>
        </label>
        <div className="modal-footer">
          {currentUser.id !== member.id && (
            <button
              className="button danger-text footer-start"
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              <Trash2 size={15} />
              Delete member
            </button>
          )}
          <button
            className="button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}Save access
          </button>
        </div>
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
      <form onSubmit={submit}>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <label className="field">
          Current password
          <input
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
        <div className="modal-footer">
          <button
            className="button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}Change password
          </button>
        </div>
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
        client.background = "#101318";
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
      <div className="console-toolbar">
        <span>
          <i className={connected ? "tiny-dot" : "tiny-dot muted-dot"} />
          {status}
        </span>
        <div>
          <button
            className="button small"
            disabled={!connected}
            onClick={() => rfb.current?.sendCtrlAltDel()}
          >
            Ctrl · Alt · Del
          </button>
          <button
            className="icon-button"
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
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="console-viewport" ref={target}>
        {demo && (
          <div className="console-placeholder">
            <SquareTerminal size={38} />
            <h3>No live console in demo mode</h3>
            <p>
              Connect your Proxmox server to use the VM’s display and keyboard
              here.
            </p>
            <span>
              VM {vm.id} · {vm.node}
            </span>
          </div>
        )}
        {status === "Connecting" && (
          <div className="console-connecting">
            <Loader2 className="spin" size={25} />
            <span>Establishing secure console connection…</span>
          </div>
        )}
      </div>
      <div className="console-footer">
        <Shield size={13} />
        Use your VM’s operating-system credentials to log in. Closing this
        window leaves the VM running.
      </div>
    </Modal>
  );
}
