import { test, expect } from "@playwright/test";

// Skip onboarding so each test targets the core signed-messaging flow directly. The
// onboarded flag is stored by WebStorage under the bond:kv: prefix.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("bond:kv:bond.onboarded", "true");
    } catch {
      // no-op
    }
  });
});

test("create a room and post a cryptographically signed message", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Humans and agents, together")).toBeVisible();

  await page.getByTestId("new-room-toggle").click();
  await page.getByPlaceholder("Room name").fill("Launch war room");
  await page.getByText("Create room", { exact: true }).click();

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();
  await input.fill("Bond ships today");
  await page.getByTestId("composer-send").click();

  // the message appears in the thread, signed by the device identity, so it earns a
  // Verified badge. getByText also matches the now-updated room preview on the Rooms
  // screen kept mounted underneath, so target the last (on-top Room screen) match.
  await expect(page.getByText("Bond ships today").last()).toBeVisible();
  await expect(page.getByText("Verified").last()).toBeVisible();
});

test("the built-in Bond agent bridge is listed on the Agents tab", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Agents", { exact: true }).first().click();
  await expect(page.getByText("Bond gateway").first()).toBeVisible();
});
