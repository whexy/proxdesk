import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    launchOptions: { chromiumSandbox: false },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3100/api/auth/session",
    timeout: 120000,
    reuseExistingServer: false,
    env: {
      PORT: "3100",
      APP_ORIGIN: "http://localhost:3100",
      DATABASE_PATH: join(
        mkdtempSync(join(tmpdir(), "proxdesk-e2e-")),
        "test.sqlite",
      ),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
