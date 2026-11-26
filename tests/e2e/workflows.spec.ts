import { test, expect, type Page } from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";

async function signIn(page: Page, role: "administrator" | "member") {
  await page.goto("/");
  await page.getByRole("button", { name: `Explore as ${role}` }).click();
  await expect(
    page.getByRole("heading", { name: "Virtual machines", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View alex-dev details", exact: true }),
  ).toBeVisible();
}

test("members see only assigned VMs, search, reboot, and open an honest demo console", async ({
  page,
}) => {
  await signIn(page, "member");
  await expect(
    page.getByRole("button", { name: "View shared-storage details", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Members/ })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search virtual machines" })
    .fill("missing");
  await expect(page.getByText("No matching machines")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Actions for alex-dev" }).click();
  await page.getByRole("button", { name: "Reboot", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Active connections will disconnect",
  );
  await page.getByRole("button", { name: "Reboot VM", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Reboot requested");
  await expect(page.getByRole("status")).toContainText("reboot completed", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Open alex-dev console" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "No live console in demo mode",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
});

test("administrators can create a member and persist VM permissions", async ({
  page,
}) => {
  await signIn(page, "administrator");
  await page.screenshot({
    path: "/tmp/proxdesk-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Members/ }).click();
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Full name").fill("Test Researcher");
  await page.getByLabel("Email address").fill("researcher@example.com");
  await page.getByLabel("Initial password").fill("test-researcher-pass");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add member" })
    .click();
  const member = page
    .getByRole("row")
    .filter({ hasText: "researcher@example.com" });
  await member.getByRole("button", { name: "Manage access" }).click();
  const machine = page
    .locator(".permission-machine")
    .filter({ hasText: "alex-dev" });
  await machine.getByLabel("View status").check();
  await machine.getByLabel("Reboot", { exact: true }).check();
  await machine.getByLabel("Console", { exact: true }).check();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(member).toContainText("1 machines");
  await member.getByRole("button", { name: "Manage access" }).click();
  await expect(
    page
      .locator(".permission-machine")
      .filter({ hasText: "alex-dev" })
      .getByLabel("Console", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close dialog" }).click();
});

test("member layout fits a phone without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "member");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/proxdesk-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "View alex-dev details", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Your permissions");
  await page.getByRole("button", { name: "Close machine details" }).click();
  // The sidebar's account menu is hidden on phones; the top bar opens it.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Chat accounts" }).click();
  await expect(page.getByRole("dialog")).toContainText("Chat accounts");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/proxdesk-account-menu-mobile.png" });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Your workspace" }),
  ).toBeVisible();
});

test("noVNC negotiates an RFB session and renders the console canvas", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "member");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await page.route("**/api/vms/104/console", (route) =>
    route.fulfill({
      json: {
        demo: false,
        path: `ws://127.0.0.1:${port}`,
        password: "test-vnc-password",
      },
    }),
  );
  server.on("connection", (ws) => {
    let stage = 0;
    ws.send(Buffer.from("RFB 003.008\n"));
    ws.on("message", () => {
      if (stage === 0) {
        stage++;
        ws.send(Buffer.from([1, 1]));
      } else if (stage === 1) {
        stage++;
        ws.send(Buffer.alloc(4));
      } else if (stage === 2) {
        stage++;
        const name = Buffer.from("Test VM");
        const init = Buffer.alloc(24 + name.length);
        init.writeUInt16BE(640, 0);
        init.writeUInt16BE(400, 2);
        init[4] = 32;
        init[5] = 24;
        init[7] = 1;
        init.writeUInt16BE(255, 8);
        init.writeUInt16BE(255, 10);
        init.writeUInt16BE(255, 12);
        init[14] = 16;
        init[15] = 8;
        init.writeUInt32BE(name.length, 20);
        name.copy(init, 24);
        ws.send(init);
      }
    });
  });
  try {
    await page.getByRole("button", { name: "Open alex-dev console" }).click();
    await expect(page.locator(".console-toolbar")).toContainText("Connected");
    await expect(page.locator(".console-viewport canvas")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ctrl · Alt · Del" }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
});

test("administrators link chat members and create chat-only members", async ({
  page,
}) => {
  await signIn(page, "administrator");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Demo directory")).toBeVisible();
  await expect(
    page.getByLabel("Account for Alex Chen").locator("option:checked"),
  ).toHaveText("Alex Chen · alex@example.com");
  await page.screenshot({ path: "/tmp/proxdesk-chat.png", fullPage: true });
  await page
    .getByLabel("Account for Maya Patel")
    .selectOption({ label: "Maya Patel · maya@example.com" });
  await expect(page.getByRole("status")).toContainText(
    "Maya Patel linked to Maya Patel",
  );
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByLabel("Account for Maya Patel").locator("option:checked"),
  ).toHaveText("Maya Patel · maya@example.com");
  await page.getByRole("button", { name: "Unlink Maya Patel" }).click();
  await expect(
    page.getByLabel("Account for Maya Patel").locator("option:checked"),
  ).toHaveText("Not linked");
  await page
    .getByRole("row")
    .filter({ hasText: "@maya" })
    .getByRole("button", { name: "Create chat-only member" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "added as a chat-only member",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/proxdesk-chat-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: /^Members/ }).click();
  const chatOnly = page
    .getByRole("row")
    .filter({ hasText: "Maya Patel" })
    .filter({ hasText: "Chat only" });
  await expect(chatOnly).toContainText("0 machines");
  await chatOnly.getByRole("button", { name: "Manage access" }).click();
  await page
    .locator(".permission-machine")
    .filter({ hasText: "maya-research" })
    .getByLabel("Reboot", { exact: true })
    .check();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(chatOnly).toContainText("1 machines");

  await chatOnly.getByRole("button", { name: "Manage access" }).click();
  await page.getByRole("button", { name: "Delete member" }).click();
  await expect(page.getByRole("dialog")).toContainText("This cannot be undone");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete member" })
    .click();
  await expect(page.getByRole("status")).toContainText("Maya Patel deleted");
  await expect(chatOnly).toHaveCount(0);
  const self = page.getByRole("row").filter({ hasText: "admin@example.com" });
  await self.getByRole("button", { name: "Manage access" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete member" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
});

test("a chat user links their account through the link the bot sends", async ({
  page,
  request,
}) => {
  const origin = { origin: "http://localhost:3100" };
  await request.post("/api/auth/demo", { data: { role: "admin" }, headers: origin });
  const response = await request.post("/api/demo/chat", {
    data: { userRef: "U0DEMOSAM", text: "link" },
    headers: origin,
  });
  const { messages } = await response.json();
  const path = new URL(messages[0].text.match(/<(http[^|>]+)\|/)[1]).pathname;

  await page.goto(path);
  await expect(page.getByText("Sign in to link your chat account.")).toBeVisible();
  await page.getByRole("button", { name: "Explore as member" }).click();
  await expect(page.locator(".login-description")).toHaveText(
    "Link Slack user @sam (ID U0DEMOSAM) to your account?",
  );
  await expect(page.getByRole("note")).toContainText(
    "Only confirm if you just asked the bot for this link yourself.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/proxdesk-link-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const confirm = page.getByRole("button", { name: "Link account" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Move it to mine/).check();
  await confirm.click();
  await expect(page.locator(".login-description")).toHaveText(
    "Slack user @sam (ID U0DEMOSAM) is linked to your account. Mention the bot in Slack to manage your VMs.",
  );
  await page.getByRole("link", { name: "Continue to Proxdesk" }).click();
  await expect(
    page.getByRole("heading", { name: "Virtual machines", exact: true }),
  ).toBeVisible();

  await page.locator("button.account").click();
  await page.getByRole("button", { name: "Chat accounts" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Alex Chen");
  await expect(dialog).toContainText("Sam Rivera");
  await dialog.getByRole("button", { name: "Unlink Sam Rivera" }).click();
  await expect(dialog).not.toContainText("Sam Rivera");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.goto(path);
  await expect(page.locator(".form-error")).toHaveText(
    "This link is invalid or has expired",
  );
});

test("members have no Settings page", async ({ page }) => {
  await signIn(page, "member");
  await expect(page.locator(".breadcrumb")).toContainText("Proxdesk");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
});

test("administrators rename the workspace, limit the managed VMs, and back up", async ({
  page,
}) => {
  await signIn(page, "administrator");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("4 simulated VMs in scope")).toBeVisible();

  await page.getByLabel("Workspace name").fill("Research Lab");
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace settings saved",
  );
  await expect(page.locator(".breadcrumb")).toContainText("Research Lab");
  await expect(page.locator(".workspace")).toContainText("Research Lab");
  await expect(page).toHaveTitle(/Research Lab/);

  await page.getByLabel("Managed VMs").selectOption("pool");
  await page.getByLabel("Pool", { exact: true }).fill("research");
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace settings saved",
  );
  await page.getByRole("button", { name: "Run check" }).click();
  await expect(page.getByText("1 simulated VM in scope")).toBeVisible();

  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("status")).toContainText("Backup created");
  await expect(
    page.locator(".backup-table tbody tr").first(),
  ).toContainText(/proxdesk-.*\.sqlite/);
  await page.screenshot({ path: "/tmp/proxdesk-settings.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/proxdesk-settings-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: /^Virtual machines/ }).click();
  await expect(
    page.getByRole("button", { name: "View maya-research details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View alex-dev details" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Managed VMs").selectOption("all");
  await page.getByLabel("Workspace name").fill("Proxdesk");
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace settings saved",
  );
});
