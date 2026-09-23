import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the exported web build (the same React Native code that
// ships on Android, rendered by react-native-web), driven in a mobile viewport. They
// exercise the real store, on-device identity generation and message signing.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8100",
    headless: true,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npx --yes http-server ./dist -p 8100 -c-1 --silent",
    url: "http://localhost:8100",
    timeout: 90_000,
    reuseExistingServer: true,
  },
  projects: [{ name: "mobile-web", use: { ...devices["Pixel 5"] } }],
});
