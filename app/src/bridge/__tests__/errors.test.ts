import { friendlyConnectError } from "../errors";

it("turns raw network errors into guidance and keeps runtime messages", () => {
  for (const raw of ["Failed to fetch", "TypeError: Network request failed", "getaddrinfo ENOTFOUND x.invalid", "", undefined]) {
    expect(friendlyConnectError(raw)).toMatch(/^Could not reach this runtime/);
  }
  expect(friendlyConnectError("HTTP 401 Unauthorized")).toMatch(/refused the key/);
  expect(friendlyConnectError("model not found: gpt-x")).toBe("model not found: gpt-x");
});
