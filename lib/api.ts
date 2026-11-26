import { z } from "zod";
import { allowsOrigin } from "./config";
import { AppError, getServices, type Services } from "./services";
import { settingsPatch } from "./settings";
import { accountLabel } from "./store";
import type { DemoSlackAdapter } from "./chat/demo";
import type { ChatMember } from "./chat/adapter";
import { permissions, type ChatIdentity, type User } from "./types";

export function sessionToken(cookie: string | null | undefined) {
  return (
    cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("management_session="))
      ?.slice("management_session=".length) || ""
  );
}
function cookie(name: string, value: string, secure: boolean, age = 43200) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
}
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
const platform = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const userRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const linkCode = /^[A-Za-z0-9_-]{43}$/;
// Only the link page may be the destination after signing in with SSO.
const returnPath = /^\/link\/[A-Za-z0-9_-]{43}$/;
const userInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "member"]).default("member"),
  enabled: z.boolean().default(true),
  password: z.string().min(12).max(256).optional(),
});
const assignmentInput = z.object({
  vmId: z.number().int().positive(),
  permissions: z.array(z.enum(permissions)).max(permissions.length),
});
const userPatch = z.object({
  email: z.email().max(254).optional(),
  role: z.enum(["admin", "member"]).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(12).max(256).optional(),
  assignments: z.array(assignmentInput).max(1000).optional(),
});
async function body(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError(415, "Use application/json");
  const reader = req.body?.getReader();
  if (!reader) throw new AppError(400, "Request body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16_384) {
      await reader.cancel();
      throw new AppError(413, "Request is too large");
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!length) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(400, "Invalid JSON");
  }
}
function admin(who: User) {
  if (who.role !== "admin")
    throw new AppError(403, "Administrator access required");
}
const platformLabel = (s: Services, id: string) =>
  s.chat?.adapter(id)?.label ?? id;
async function directoryMember(s: Services, id: string, ref: string) {
  const adapter = s.chat?.adapter(id);
  if (!adapter?.directory)
    throw new AppError(404, "This chat platform is not connected");
  const member = (await adapter.directory()).find((m) => m.ref === ref);
  if (!member)
    throw new AppError(400, `This ${adapter.label} user is not in the bot's directory`);
  return member;
}
function identityView(s: Services, identity: ChatIdentity) {
  const user = s.store.getUser(identity.userId);
  return {
    ...identity,
    platformLabel: platformLabel(s, identity.platform),
    userName: user?.name ?? "",
    userEmail: user?.email ?? null,
  };
}

let oidcConfiguration: { issuer: string; promise: Promise<any> } | undefined;
async function oidc(s: Services) {
  if (!s.config.oidcIssuer)
    throw new AppError(404, "Single sign-on is not configured");
  const client = await import("openid-client");
  if (!oidcConfiguration || oidcConfiguration.issuer !== s.config.oidcIssuer) {
    const promise = client.discovery(
      new URL(s.config.oidcIssuer),
      s.config.oidcClientId!,
      s.config.oidcClientSecret!,
    );
    oidcConfiguration = { issuer: s.config.oidcIssuer, promise };
    promise.catch(() => {
      oidcConfiguration = undefined;
    });
  }
  return { client, config: await oidcConfiguration.promise };
}

export async function handleApi(
  req: Request,
  services?: Services,
): Promise<Response> {
  try {
    const s = services || getServices();
    const url = new URL(req.url),
      path = url.pathname.replace(/^\/api/, ""),
      method = req.method;
    if (
      !["GET", "HEAD"].includes(method) &&
      !allowsOrigin(s.config, req.headers.get("origin"))
    )
      throw new AppError(403, "Request origin is not allowed");
    const inputBody =
      !["GET", "HEAD"].includes(method) && req.body
        ? await body(req)
        : undefined;
    const token = sessionToken(req.headers.get("cookie"));
    const who = s.store.session(token);
    const secureCookies = !["GET", "HEAD"].includes(method)
      ? new URL(req.headers.get("origin")!).protocol === "https:"
      : s.config.secureCookies;
    const sessionHeaders = (value: string) => ({
      "Set-Cookie": cookie("management_session", value, secureCookies),
    });

    if (method === "GET" && path === "/auth/session")
      return json({
        user: who || null,
        demo: s.config.demo,
        oidc: !!s.config.oidcIssuer,
        ...(who ? { workspaceName: s.store.settings().workspaceName } : {}),
      });
    if (method === "POST" && path === "/auth/login") {
      const input = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(256),
        })
        .parse(inputBody);
      s.rateLimit("login:global", 200, 60_000);
      s.rateLimit(`login:${input.email.toLowerCase()}`);
      const result = s.store.authenticate(input.email, input.password);
      if (!result)
        throw new AppError(
          401,
          "Invalid credentials or account awaiting approval",
        );
      s.store.audit(result, "Signed in", accountLabel(result));
      return json(
        { user: result },
        200,
        sessionHeaders(s.store.createSession(result.id)),
      );
    }
    if (method === "POST" && path === "/auth/demo" && s.config.demo) {
      const input = z
        .object({ role: z.enum(["admin", "member"]) })
        .parse(inputBody);
      const result = s.store.findEmail(
        input.role === "admin" ? "admin@example.com" : "alex@example.com",
      );
      if (!result?.enabled) throw new AppError(403, "Demo account is disabled");
      return json(
        { user: result },
        200,
        sessionHeaders(s.store.createSession(result.id)),
      );
    }
    if (method === "GET" && path === "/auth/oidc") {
      const next = url.searchParams.get("next");
      const returnTo = next && returnPath.test(next) ? next : undefined;
      if (url.host !== new URL(s.config.origin).host)
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${s.config.origin}/api/auth/oidc${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ""}`,
            "Cache-Control": "no-store",
          },
        });
      s.rateLimit("oidc:global", 100, 60_000);
      const { client, config } = await oidc(s);
      const state = client.randomState(),
        nonce = client.randomNonce(),
        verifier = client.randomPKCECodeVerifier();
      s.store.putFlow(state, { nonce, verifier, returnTo });
      const destination = client.buildAuthorizationUrl(config, {
        redirect_uri: `${s.config.origin}/api/auth/callback`,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: destination.toString(),
          "Cache-Control": "no-store",
          "Set-Cookie": cookie(
            "management_oidc",
            state,
            s.config.secureCookies,
            600,
          ),
        },
      });
    }
    if (method === "GET" && path === "/auth/callback") {
      const state = url.searchParams.get("state");
      const browserState = req.headers
        .get("cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("management_oidc="))
        ?.slice("management_oidc=".length);
      if (!state || state !== browserState)
        throw new AppError(400, "Login state is invalid or expired");
      const flow = s.store.consumeFlow(state);
      if (!flow) throw new AppError(400, "Login state is invalid or expired");
      const { client, config } = await oidc(s);
      const tokens = await client.authorizationCodeGrant(
        config,
        new URL(`${s.config.origin}${url.pathname}${url.search}`),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (
        !claims ||
        claims.email_verified !== true ||
        typeof claims.email !== "string" ||
        !claims.sub
      )
        throw new AppError(
          403,
          "Your identity provider must supply a verified email address",
        );
      const email = z.email().max(254).parse(claims.email);
      const result = s.store.oidcUser(
        s.config.oidcIssuer!,
        claims.sub,
        email,
        typeof claims.name === "string" ? claims.name.slice(0, 100) : email,
      );
      if (!result.enabled)
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/?approval=pending",
            "Cache-Control": "no-store",
          },
        });
      s.store.audit(result, "Signed in with SSO", accountLabel(result));
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            typeof flow.returnTo === "string" && returnPath.test(flow.returnTo)
              ? flow.returnTo
              : "/",
          "Cache-Control": "no-store",
          ...sessionHeaders(s.store.createSession(result.id)),
        },
      });
    }
    if (!who) throw new AppError(401, "Sign in to continue");
    if (method === "POST" && path === "/auth/logout") {
      s.store.deleteSession(token);
      return json({ ok: true }, 200, {
        "Set-Cookie": cookie("management_session", "", secureCookies, 0),
      });
    }
    if (method === "POST" && path === "/auth/password") {
      s.rateLimit(`password:${who.id}`);
      const input = z
        .object({
          currentPassword: z.string().min(1).max(256),
          newPassword: z.string().min(12).max(256),
        })
        .parse(inputBody);
      if (!who.email || !s.store.authenticate(who.email, input.currentPassword))
        throw new AppError(403, "Current password is incorrect");
      s.store.updateUser(who.id, { password: input.newPassword });
      s.store.audit(who, "Changed password", who.email);
      return json(
        { ok: true },
        200,
        sessionHeaders(s.store.createSession(who.id)),
      );
    }
    const linkMatch = path.match(/^\/link\/([^/]+)$/);
    if (linkMatch) {
      if (!linkCode.test(linkMatch[1]))
        throw new AppError(404, "This link is invalid or has expired");
      s.rateLimit("link:global", 300, 60_000);
      s.rateLimit(`link:${who.id}`, 20);
      const code = linkMatch[1];
      if (method === "GET") {
        const pending = s.store.linkCode(code);
        if (!pending) throw new AppError(404, "This link is invalid or has expired");
        const current = s.store.chatIdentity(pending.platform, pending.userRef);
        return json({
          platform: pending.platform,
          platformLabel: platformLabel(s, pending.platform),
          userRef: pending.userRef,
          handle: pending.handle,
          displayName: pending.displayName,
          linked: !current ? null : current.userId === who.id ? "self" : "other",
          expiresAt: new Date(pending.expires).toISOString(),
        });
      }
      if (method === "POST") {
        const input = z
          .object({ move: z.boolean().default(false) })
          .parse(inputBody ?? {});
        const identity = s.store.transaction(() => {
          const pending = s.store.linkCode(code);
          if (!pending)
            throw new AppError(404, "This link is invalid or has expired");
          const current = s.store.chatIdentity(pending.platform, pending.userRef);
          const previous =
            current && current.userId !== who.id
              ? s.store.getUser(current.userId)
              : undefined;
          if (previous && !input.move)
            throw new AppError(
              409,
              "This chat account is linked to another Proxdesk account. Confirm moving it to yours.",
            );
          s.store.deleteLinkCode(code);
          const linked = s.store.linkChatIdentity(
            pending.platform,
            pending.userRef,
            pending.displayName,
            who.id,
          );
          s.store.audit(
            who,
            "Linked chat identity",
            pending.displayName,
            `${platformLabel(s, pending.platform)} · ${accountLabel(who)}${previous ? ` · moved from ${accountLabel(previous)}` : ""}`,
          );
          return linked;
        });
        return json({ identity: identityView(s, identity) });
      }
    }
    if (method === "GET" && path === "/account/identities")
      return json({
        identities: s.store.chatIdentities(who.id).map((i) => identityView(s, i)),
      });
    const ownIdentity = path.match(/^\/account\/identities\/([^/]+)\/([^/]+)$/);
    if (method === "DELETE" && ownIdentity) {
      const [id, ref] = [
        platform.parse(ownIdentity[1]),
        userRef.parse(ownIdentity[2]),
      ];
      const identity = s.store.chatIdentity(id, ref);
      if (!identity || identity.userId !== who.id)
        throw new AppError(404, "Chat account not found");
      s.store.unlinkChatIdentity(id, ref);
      s.store.audit(
        who,
        "Unlinked chat identity",
        identity.displayName,
        `${platformLabel(s, id)} · ${accountLabel(who)}`,
      );
      return json({
        identities: s.store.chatIdentities(who.id).map((i) => identityView(s, i)),
      });
    }
    if (method === "POST" && path === "/demo/chat" && s.config.demo) {
      const input = z
        .object({ userRef, text: z.string().max(200) })
        .parse(inputBody);
      // The server and the Next.js routes load separate copies of the chat
      // modules, so the demo adapter is recognised by shape, not by class.
      const adapter = s.chat?.adapter("slack") as
        | Partial<Pick<DemoSlackAdapter, "mention">>
        | undefined;
      if (typeof adapter?.mention !== "function")
        throw new AppError(404, "The demo chat is not running");
      s.rateLimit(`demo-chat:${who.id}`, 30, 60_000);
      return json({ messages: await adapter.mention(input.userRef, input.text) });
    }
    if (method === "GET" && path === "/vms")
      return json({
        vms: await s.inventory(who),
        checkedAt: new Date().toISOString(),
      });
    const actionMatch = path.match(/^\/vms\/(\d+)\/actions$/);
    if (method === "POST" && actionMatch) {
      const input = z
        .object({ action: z.enum(["start", "reboot", "shutdown", "reset"]) })
        .parse(inputBody);
      s.rateLimit(`action:${who.id}`, 30, 60_000);
      return json(
        { operation: await s.act(who, Number(actionMatch[1]), input.action) },
        202,
      );
    }
    const consoleMatch = path.match(/^\/vms\/(\d+)\/console$/);
    if (method === "POST" && consoleMatch)
      return json(await s.openConsole(who, Number(consoleMatch[1]), token));
    const opMatch = path.match(/^\/operations\/([a-f0-9-]+)$/);
    if (method === "GET" && opMatch) {
      const op = s.store.getOperation(opMatch[1]);
      if (!op || (who.role !== "admin" && op.userId !== who.id))
        throw new AppError(404, "Operation not found");
      s.requirePermission(who, op.vmId, "view");
      return json({ operation: op });
    }
    if (method === "GET" && path === "/audit")
      return json({ events: s.store.audits(who) });
    if (
      path === "/users" ||
      path.startsWith("/users/") ||
      path === "/grants" ||
      path === "/chat" ||
      path.startsWith("/chat/") ||
      path.startsWith("/settings") ||
      path.startsWith("/backups")
    )
      admin(who);
    if (method === "GET" && path === "/settings")
      return json({ settings: s.store.settings(), backups: s.backupInfo() });
    if (method === "PUT" && path === "/settings") {
      const patch = settingsPatch.parse(inputBody);
      const { settings, changed } = s.store.transaction(() => {
        const result = s.store.updateSettings(patch);
        if (result.changed.length)
          s.store.audit(
            who,
            "Updated settings",
            result.changed.join(", "),
            result.changed
              .map((key) => `${key}: ${JSON.stringify(result.settings[key])}`)
              .join("; "),
          );
        return result;
      });
      if (changed.includes("backups")) s.backups.tick();
      return json({ settings, backups: s.backupInfo() });
    }
    if (method === "POST" && path === "/settings/check") {
      s.rateLimit(`check:${who.id}`, 10, 60_000);
      return json({
        checks: await s.proxmoxCheck(),
        checkedAt: new Date().toISOString(),
      });
    }
    if (method === "POST" && path === "/backups") {
      s.rateLimit(`backup:${who.id}`, 5, 60_000);
      const file = s.manualBackup(who);
      return json({ file, backups: s.backupInfo() }, 201);
    }
    if (method === "GET" && path === "/chat") {
      const adapters = await Promise.all(
        (s.chat?.list() ?? []).map(async ({ adapter, options }) => {
          let members: ChatMember[] = [],
            membersError = "";
          try {
            members = (await adapter.directory?.()) ?? [];
          } catch (error) {
            membersError =
              error instanceof Error ? error.message : "Could not list members";
          }
          return {
            id: adapter.id,
            label: adapter.label,
            ...adapter.status(),
            conversations: options.conversations,
            directory: !!adapter.directory,
            members,
            membersError,
          };
        }),
      );
      return json({
        demo: s.config.demo,
        adapters,
        identities: s.store.chatIdentities().map((i) => identityView(s, i)),
      });
    }
    if (method === "PUT" && path === "/chat/identities") {
      const input = z
        .object({ platform, userRef, userId: z.uuid() })
        .parse(inputBody);
      const member = await directoryMember(s, input.platform, input.userRef);
      const target = s.store.getUser(input.userId);
      if (!target) throw new AppError(404, "User not found");
      const current = s.store.session(token);
      if (!current) throw new AppError(401, "Session expired");
      admin(current);
      const previous = s.store.chatIdentity(input.platform, input.userRef);
      if (previous?.userId !== target.id) {
        s.store.linkChatIdentity(input.platform, member.ref, member.name, target.id);
        s.store.audit(
          who,
          "Linked chat identity",
          member.name,
          `${platformLabel(s, input.platform)} · ${accountLabel(target)}`,
        );
      }
      return json({
        identities: s.store.chatIdentities().map((i) => identityView(s, i)),
      });
    }
    if (method === "POST" && path === "/chat/members") {
      const input = z.object({ platform, userRef }).parse(inputBody);
      const member = await directoryMember(s, input.platform, input.userRef);
      const current = s.store.session(token);
      if (!current) throw new AppError(401, "Session expired");
      admin(current);
      const created = s.store.transaction(() => {
        if (s.store.chatIdentity(input.platform, member.ref))
          throw new AppError(409, "Unlink this chat account before creating a member for it");
        const user = s.store.createUser({
          email: null,
          name: member.name.slice(0, 100) || member.ref,
          role: "member",
          enabled: true,
        });
        s.store.linkChatIdentity(input.platform, member.ref, member.name, user.id);
        s.store.audit(
          who,
          "Created chat-only account",
          user.name,
          `${platformLabel(s, input.platform)} · ${member.ref}`,
        );
        return user;
      });
      return json(
        {
          user: created,
          identities: s.store.chatIdentities().map((i) => identityView(s, i)),
        },
        201,
      );
    }
    const adminIdentity = path.match(/^\/chat\/identities\/([^/]+)\/([^/]+)$/);
    if (method === "DELETE" && adminIdentity) {
      const [id, ref] = [
        platform.parse(adminIdentity[1]),
        userRef.parse(adminIdentity[2]),
      ];
      const identity = s.store.unlinkChatIdentity(id, ref);
      if (identity) {
        const owner = s.store.getUser(identity.userId);
        s.store.audit(
          who,
          "Unlinked chat identity",
          identity.displayName,
          `${platformLabel(s, id)} · ${owner ? accountLabel(owner) : identity.userId}`,
        );
      }
      return json({
        identities: s.store.chatIdentities().map((i) => identityView(s, i)),
      });
    }
    if (method === "GET" && path === "/users")
      return json({ users: s.store.users() });
    if (method === "POST" && path === "/users") {
      const input = userInput.parse(inputBody);
      if (!input.password && !s.config.oidcIssuer)
        throw new AppError(
          400,
          "Set an initial password when SSO is not configured",
        );
      if (s.store.findEmail(input.email))
        throw new AppError(409, "This email already has an account");
      const created = s.store.createUser(input);
      s.store.audit(who, "Created account", accountLabel(created), created.role);
      return json({ user: created }, 201);
    }
    const userMatch = path.match(/^\/users\/([a-f0-9-]+)$/);
    if (method === "PATCH" && userMatch) {
      const patch = userPatch.parse(inputBody);
      const target = s.store.getUser(userMatch[1]);
      if (!target) throw new AppError(404, "User not found");
      // A chat-only member given an email must have a way to sign in.
      if (
        patch.email &&
        target.email === null &&
        !patch.password &&
        !s.config.oidcIssuer
      )
        throw new AppError(
          400,
          "Set an initial password when SSO is not configured",
        );
      if (patch.assignments?.some((a) => a.permissions.length)) {
        const inventory = await s.managedInventory();
        if (
          patch.assignments.some(
            (a) =>
              a.permissions.length && !inventory.some((vm) => vm.id === a.vmId),
          )
        )
          throw new AppError(
            400,
            "An assigned VM is not in the managed inventory",
          );
      }
      const current = s.store.session(token);
      if (!current) throw new AppError(401, "Session expired");
      admin(current);
      try {
        const updated = s.store.transaction(() => {
          const result = s.store.updateUser(userMatch[1], patch);
          for (const assignment of patch.assignments || []) {
            s.store.grant(result.id, assignment.vmId, assignment.permissions);
            s.store.audit(
              who,
              assignment.permissions.length
                ? "Updated VM access"
                : "Revoked VM access",
              `VM ${assignment.vmId}`,
              `${accountLabel(result)} · ${assignment.permissions.join(", ") || "no access"}`,
            );
          }
          s.store.audit(
            who,
            "Updated account",
            accountLabel(result),
            Object.entries(patch)
              .filter(([key]) => key !== "assignments")
              .map(([key, value]) =>
                key === "password" ? "password reset" : `${key}: ${value}`,
              )
              .join(", "),
          );
          return result;
        });
        return json({ user: updated });
      } catch (error) {
        throw new AppError(
          409,
          error instanceof Error ? error.message : "Unable to update account",
        );
      }
    }
    if (method === "DELETE" && userMatch) {
      if (userMatch[1] === who.id)
        throw new AppError(409, "You cannot delete your own account");
      const current = s.store.session(token);
      if (!current) throw new AppError(401, "Session expired");
      admin(current);
      try {
        s.store.transaction(() => {
          const identities = s.store.chatIdentities(userMatch[1]);
          const removed = s.store.deleteUser(userMatch[1]);
          s.store.audit(
            who,
            "Deleted account",
            accountLabel(removed),
            [
              removed.role,
              ...identities.map((i) => `${platformLabel(s, i.platform)} · ${i.displayName}`),
            ].join(", "),
          );
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new AppError(
          message === "User not found" ? 404 : 409,
          message || "Unable to delete account",
        );
      }
      return json({ users: s.store.users() });
    }
    if (method === "GET" && path === "/grants")
      return json({ grants: s.store.grants() });
    if (method === "PUT" && path === "/grants") {
      const input = z
        .object({
          userId: z.uuid(),
          vmId: z.number().int().positive(),
          permissions: z.array(z.enum(permissions)).max(permissions.length),
        })
        .parse(inputBody);
      const target = s.store.getUser(input.userId);
      if (!target) throw new AppError(404, "User not found");
      const vm = await s.vm(who, input.vmId, "view");
      const current = s.store.session(token);
      if (!current) throw new AppError(401, "Session expired");
      admin(current);
      s.store.grant(input.userId, input.vmId, input.permissions);
      s.store.audit(
        who,
        input.permissions.length ? "Updated VM access" : "Revoked VM access",
        vm.name,
        `${accountLabel(target)} · ${input.permissions.join(", ") || "no access"}`,
      );
      return json({ grants: s.store.grants() });
    }
    throw new AppError(404, "Endpoint not found");
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    const status =
      error instanceof Error && "status" in error ? Number(error.status) : 502;
    const message = error instanceof Error ? error.message : "Request failed";
    if (status >= 500)
      console.error("Proxdesk backend request failed:", message);
    return json(
      {
        error:
          status >= 400 && status < 500
            ? message
            : "The server could not complete this request. Check the Proxmox connection or server logs.",
      },
      status >= 400 && status <= 599 ? status : 500,
    );
  }
}
