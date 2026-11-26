import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeAdapter, cleanup, setup } from "./helpers";
import { ChatBot } from "../../lib/chat/bot";

afterEach(cleanup);

/** Asks the bot for a link as this chat user and returns the code from the private reply. */
async function requestLink(adapter: FakeAdapter, userRef: string, name: string) {
  await adapter.send(userRef, "link", undefined, name);
  const reply = adapter.sent.at(-1)!;
  assert.equal(reply.kind, "private");
  const match = reply.text.match(/http:\/\/localhost:3000\/link\/([A-Za-z0-9_-]{43})/);
  assert.ok(match, reply.text);
  return match[1];
}

test("a chat user links themselves through a single-use web link", async () => {
  const { s, adapter, maya, session, call } = setup();
  const code = await requestLink(adapter, "U0NEW", "New Person");
  assert.match(adapter.sent.at(-1)!.text, /within 10 minutes/);
  const token = session(maya.id);
  const preview = await call(token, `/link/${code}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(
    { ...(await preview.json()), expiresAt: undefined },
    {
      platform: "slack",
      platformLabel: "Slack",
      userRef: "U0NEW",
      handle: "u0new",
      displayName: "New Person",
      linked: null,
      expiresAt: undefined,
    },
  );
  // Previewing does not use the code; a cross-origin POST is refused.
  assert.equal(
    (await call(token, `/link/${code}`, "POST", {}, "https://evil.example")).status,
    403,
  );
  // Without a session, nothing happens and the code stays valid.
  assert.equal((await call("", `/link/${code}`, "POST", {})).status, 401);
  assert.equal((await call(token, `/link/${code}`, "POST", {})).status, 200);
  assert.equal(s.store.chatIdentity("slack", "U0NEW")?.userId, maya.id);
  assert.equal((await call(token, `/link/${code}`, "POST", {})).status, 404);
  assert.equal((await call(token, `/link/${code}`)).status, 404);
  const audit = s.store.audits(maya).find((e) => e.action === "Linked chat identity")!;
  assert.equal(audit.target, "New Person");
  assert.equal(audit.detail, "Slack · maya@example.com");
  // The link now gives the bot Maya's access.
  assert.match(await adapter.send("U0NEW", "status"), /maya-research \(VM 132\) is running/);
});

test("link codes expire after ten minutes and only the newest works", async () => {
  const { s, adapter, maya, session, call } = setup();
  const first = await requestLink(adapter, "U0NEW", "New Person");
  const second = await requestLink(adapter, "U0NEW", "New Person");
  const token = session(maya.id);
  assert.equal((await call(token, `/link/${first}`, "POST", {})).status, 404);
  s.store.db.prepare("UPDATE chat_link_codes SET expires=?").run(Date.now() - 1);
  assert.equal((await call(token, `/link/${second}`)).status, 404);
  assert.equal((await call(token, `/link/${second}`, "POST", {})).status, 404);
  assert.equal((await call(token, "/link/not-a-code")).status, 404);
  assert.equal(s.store.chatIdentity("slack", "U0NEW"), undefined);
});

test("moving an identity from another account needs explicit confirmation", async () => {
  const { s, adapter, alex, maya, session, call } = setup();
  const code = await requestLink(adapter, "U0DEMOALEX", "Alex Chen");
  assert.match(adapter.sent.at(-1)!.text, /already linked/);
  const token = session(maya.id);
  assert.equal((await (await call(token, `/link/${code}`)).json()).linked, "other");
  const refused = await call(token, `/link/${code}`, "POST", {});
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Confirm moving it/);
  assert.equal(s.store.chatIdentity("slack", "U0DEMOALEX")?.userId, alex.id);
  assert.equal((await call(token, `/link/${code}`, "POST", { move: true })).status, 200);
  assert.equal(s.store.chatIdentity("slack", "U0DEMOALEX")?.userId, maya.id);
  const audit = s.store.audits(maya).find((e) => e.action === "Linked chat identity")!;
  assert.match(audit.detail, /moved from alex@example\.com/);
  // The original owner previews their own link as already linked.
  const again = await requestLink(adapter, "U0DEMOALEX", "Alex Chen");
  assert.equal((await (await call(token, `/link/${again}`)).json()).linked, "self");
});

test("without private replies, private answers are refused in public", async () => {
  const { s } = setup();
  const adapter = new FakeAdapter("plain", "Plain", false);
  const bot = new ChatBot(s);
  bot.add(adapter);
  for (const command of ["link", "whoami"]) {
    await adapter.send("U1", command);
    const sent = adapter.sent.at(-1)!;
    assert.equal(sent.kind, "reply");
    assert.match(sent.text, /can't send private messages on Plain.*Ask an administrator to link your account/);
    assert.doesNotMatch(sent.text, /\/link\/|not linked/);
  }
  assert.equal(adapter.sent.length, 2);
});

test("members see and unlink only their own chat accounts", async () => {
  const { s, alex, maya, session, call } = setup();
  const alexToken = session(alex.id),
    mayaToken = session(maya.id);
  const own = await (await call(alexToken, "/account/identities")).json();
  assert.deepEqual(
    own.identities.map((i: { userRef: string; platformLabel: string }) => [i.userRef, i.platformLabel]),
    [["U0DEMOALEX", "Slack"]],
  );
  assert.deepEqual((await (await call(mayaToken, "/account/identities")).json()).identities, []);
  assert.equal(
    (await call(mayaToken, "/account/identities/slack/U0DEMOALEX", "DELETE")).status,
    404,
  );
  assert.equal(
    (await call(alexToken, "/account/identities/slack/U0DEMOALEX", "DELETE", undefined, "https://evil.example")).status,
    403,
  );
  const removed = await call(alexToken, "/account/identities/slack/U0DEMOALEX", "DELETE");
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).identities, []);
  assert.equal(s.store.chatIdentity("slack", "U0DEMOALEX"), undefined);
});

test("administrators link directory members, create chat-only members, and unlink", async () => {
  const { s, admin, alex, maya, session, call } = setup();
  const adminToken = session(admin.id),
    memberToken = session(alex.id);
  assert.equal((await call(memberToken, "/chat")).status, 403);
  const info = await (await call(adminToken, "/chat")).json();
  assert.equal(info.adapters[0].label, "Slack");
  assert.deepEqual(info.adapters[0].conversations, ["C0CHAN"]);
  assert.equal(info.adapters[0].members.length, 2);
  assert.deepEqual(
    info.identities.map((i: { userRef: string; userName: string }) => [i.userRef, i.userName]),
    [
      ["U0DEMOALEX", "Alex Chen"],
      ["U0DEMOSAM", "Sam Rivera"],
    ],
  );
  const link = (userRef: string, userId: string) =>
    call(adminToken, "/chat/identities", "PUT", { platform: "slack", userRef, userId });
  assert.equal((await link("U0OUTSIDER", maya.id)).status, 400);
  assert.equal((await link("U0DEMOMAYA", "11111111-1111-4111-8111-111111111111")).status, 404);
  assert.equal((await call(memberToken, "/chat/identities", "PUT", { platform: "slack", userRef: "U0DEMOMAYA", userId: alex.id })).status, 403);
  assert.equal((await link("U0DEMOMAYA", maya.id)).status, 200);
  assert.equal(s.store.chatIdentity("slack", "U0DEMOMAYA")?.userId, maya.id);

  const created = await call(adminToken, "/chat/members", "POST", { platform: "slack", userRef: "U0NEW" });
  assert.equal(created.status, 201);
  const { user } = await created.json();
  assert.deepEqual([user.email, user.name, user.role, user.enabled], [null, "New Person", "member", true]);
  assert.equal(s.store.chatIdentity("slack", "U0NEW")?.userId, user.id);
  assert.equal(s.store.grants(user.id).length, 0);
  assert.equal((await call(adminToken, "/chat/members", "POST", { platform: "slack", userRef: "U0NEW" })).status, 409);
  // Chat-only members are listed with other members and granted VMs the same way.
  const users = (await (await call(adminToken, "/users")).json()).users;
  assert.ok(users.some((u: { id: string; email: null }) => u.id === user.id && u.email === null));
  assert.equal(
    (await call(adminToken, `/users/${user.id}`, "PATCH", { assignments: [{ vmId: 132, permissions: ["view", "reboot"] }] })).status,
    200,
  );
  const audit = s.store.audits(admin).find((e) => e.action === "Updated VM access")!;
  assert.equal(audit.detail, "New Person · view, reboot");

  const unlinked = await call(adminToken, "/chat/identities/slack/U0NEW", "DELETE");
  assert.equal(unlinked.status, 200);
  assert.equal(s.store.chatIdentity("slack", "U0NEW"), undefined);
  assert.ok(s.store.audits(admin).some((e) => e.action === "Unlinked chat identity" && e.target === "New Person"));
});

test("a chat-only member becomes a web account by getting an email and a password", async () => {
  const { s, admin, sam, session, call } = setup();
  const adminToken = session(admin.id);
  const missingPassword = await call(adminToken, `/users/${sam.id}`, "PATCH", { email: "sam@example.com" });
  assert.equal(missingPassword.status, 400);
  const taken = await call(adminToken, `/users/${sam.id}`, "PATCH", {
    email: "alex@example.com",
    password: "a-long-password-1",
  });
  assert.equal(taken.status, 409);
  const converted = await call(adminToken, `/users/${sam.id}`, "PATCH", {
    email: "Sam@Example.com",
    password: "a-long-password-1",
  });
  assert.equal(converted.status, 200);
  assert.equal((await converted.json()).user.email, "sam@example.com");
  assert.equal(s.store.authenticate("sam@example.com", "a-long-password-1")?.id, sam.id);
  // The chat identity and grants carry over.
  assert.equal(s.store.chatIdentity("slack", "U0DEMOSAM")?.userId, sam.id);
  assert.equal(s.store.grants(sam.id)[0].vmId, 120);
  // An email cannot be changed through this path.
  assert.equal(
    (await call(adminToken, `/users/${sam.id}`, "PATCH", { email: "other@example.com" })).status,
    409,
  );
});

test("administrators delete members with their grants, identities, and sessions", async () => {
  const { s, adapter, admin, alex, sam, session, call } = setup();
  const adminToken = session(admin.id);
  const samToken = session(sam.id);
  // Members cannot delete anyone.
  assert.equal((await call(session(alex.id), `/users/${sam.id}`, "DELETE")).status, 403);
  const response = await call(adminToken, `/users/${sam.id}`, "DELETE");
  assert.equal(response.status, 200);
  assert.equal(s.store.getUser(sam.id), undefined);
  assert.deepEqual(s.store.grants(sam.id), []);
  assert.equal(s.store.chatIdentity("slack", "U0DEMOSAM"), undefined);
  assert.equal(s.store.session(samToken), undefined);
  const audit = s.store.audits(admin).find((e) => e.action === "Deleted account")!;
  assert.equal(audit.target, "Sam Rivera");
  assert.equal(audit.detail, "member, Slack · Sam Rivera");
  // The chat identity is free again and no longer acts.
  assert.match(await adapter.send("U0DEMOSAM", "status"), /not linked/);
  assert.equal((await call(adminToken, `/users/${sam.id}`, "DELETE")).status, 404);
  // Never yourself, and never the last enabled administrator.
  assert.equal((await call(adminToken, `/users/${admin.id}`, "DELETE")).status, 409);
  const other = s.store.createUser({ email: "second@example.com", name: "Second", role: "admin", enabled: true, password: "second-password" });
  const otherToken = session(other.id);
  s.store.updateUser(admin.id, { enabled: false });
  const last = await call(otherToken, `/users/${admin.id}`, "DELETE");
  assert.equal(last.status, 200, "a disabled administrator can go");
  const lone = s.store.createUser({ email: "third@example.com", name: "Third", role: "admin", enabled: true, password: "third-password-1" });
  s.store.updateUser(lone.id, { enabled: false });
  assert.throws(() => s.store.deleteUser(other.id), /Keep at least one enabled administrator/);
});

test("only accounts that can sign in are administrators or count as the last one", async () => {
  const { s, admin, sam, session, call } = setup();
  const adminToken = session(admin.id);
  const promote = await call(adminToken, `/users/${sam.id}`, "PATCH", { role: "admin" });
  assert.equal(promote.status, 409);
  assert.match((await promote.json()).error, /Only an account that can sign in/);
  assert.equal(s.store.getUser(sam.id)?.role, "member");
  assert.throws(
    () => s.store.createUser({ email: null, name: "Chat", role: "admin", enabled: true }),
    /Only an account that can sign in/,
  );
  assert.throws(
    () => s.store.createUser({ email: "x@example.com", name: "X", role: "admin", enabled: true }),
    /Only an account that can sign in/,
  );
  // With SSO configured, an email is enough: the first SSO sign-in links it.
  s.store.sso = true;
  assert.equal(
    s.store.createUser({ email: "sso@example.com", name: "SSO", role: "admin", enabled: false }).role,
    "admin",
  );
  s.store.sso = false;
  // An email and a password in the same change make the account able to sign in.
  const converted = await call(adminToken, `/users/${sam.id}`, "PATCH", {
    email: "sam@example.com",
    password: "a-long-password-1",
    role: "admin",
  });
  assert.equal(converted.status, 200);
  assert.equal((await converted.json()).user.role, "admin");
  s.store.updateUser(sam.id, { role: "member" });
  // A chat-only administrator left by an older release does not count.
  const legacy = s.store.createUser({ email: null, name: "Legacy", role: "member", enabled: true });
  s.store.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(legacy.id);
  assert.throws(() => s.store.updateUser(admin.id, { role: "member" }), /who can sign in/);
  assert.throws(() => s.store.deleteUser(admin.id), /who can sign in/);
  assert.equal(s.store.updateUser(legacy.id, { role: "member" }).role, "member");
});
