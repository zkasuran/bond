import { base64urlnopad } from "@scure/base";
import { generateKeypair, verifyBytes } from "../../identity/keys";
import { BondOwnGatewayAdapter } from "../adapters/own";
import { setFetchImpl } from "../net";
import { invalidateSession, sessionMessage, sessionToken } from "../session";

const BASE = "https://bond.example/v1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A fake Bond server: issues a challenge, verifies the device signature over it, and mints
// numbered tokens so a test can tell a cached token from a fresh one.
function fakeServer() {
  let minted = 0;
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace(BASE, "")}`);
    if (url.endsWith("/session/challenge")) return json({ challenge: "c-1" });
    if (url.endsWith("/session")) {
      const { did, challenge, signature } = JSON.parse(init!.body!);
      const kp = signerKey!;
      const ok =
        did === kp.did &&
        verifyBytes(base64urlnopad.decode(signature), sessionMessage(did, challenge), kp.publicKey);
      if (!ok) return json({ error: "invalid session proof" }, 401);
      minted += 1;
      return json({ token: `bs1.tok-${minted}`, expiresAt: Date.now() + 60 * 60 * 1000 });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchImpl, calls, minted: () => minted };
}

let signerKey: ReturnType<typeof generateKeypair> | null = null;

beforeEach(() => {
  invalidateSession();
  signerKey = generateKeypair();
});
afterEach(() => setFetchImpl(null));

describe("device session", () => {
  it("mints a token by signing the server challenge with the device did:key, then caches it", async () => {
    const srv = fakeServer();
    setFetchImpl(srv.fetchImpl as never);
    const signer = { did: signerKey!.did, secretKey: signerKey!.secretKey };
    expect(await sessionToken(BASE, signer)).toBe("bs1.tok-1");
    expect(await sessionToken(BASE, signer)).toBe("bs1.tok-1");
    expect(srv.minted()).toBe(1);
  });

  it("shares one mint across concurrent callers", async () => {
    const srv = fakeServer();
    setFetchImpl(srv.fetchImpl as never);
    const signer = { did: signerKey!.did, secretKey: signerKey!.secretKey };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => sessionToken(BASE, signer)));
    expect([a, b, c]).toEqual(["bs1.tok-1", "bs1.tok-1", "bs1.tok-1"]);
    expect(srv.minted()).toBe(1);
  });

  it("re-mints once the cached token is inside its refresh margin, or after invalidation", async () => {
    const srv = fakeServer();
    setFetchImpl(srv.fetchImpl as never);
    const signer = { did: signerKey!.did, secretKey: signerKey!.secretKey };
    await sessionToken(BASE, signer);
    expect(await sessionToken(BASE, signer, Date.now() + 56 * 60 * 1000)).toBe("bs1.tok-2");
    invalidateSession();
    expect(await sessionToken(BASE, signer)).toBe("bs1.tok-3");
  });

  it("returns no token, and sends nothing, without an identity", async () => {
    const srv = fakeServer();
    setFetchImpl(srv.fetchImpl as never);
    expect(await sessionToken(BASE, null)).toBeUndefined();
    expect(srv.calls).toEqual([]);
  });

  it("returns no token when the server rejects the proof", async () => {
    const srv = fakeServer();
    setFetchImpl(srv.fetchImpl as never);
    const wrong = generateKeypair();
    expect(await sessionToken(BASE, { did: signerKey!.did, secretKey: wrong.secretKey })).toBeUndefined();
  });
});

describe("BondOwnGatewayAdapter with a session token source", () => {
  it("sends the current token, and on a 401 refreshes it and retries once", async () => {
    const seen: (string | undefined)[] = [];
    let tokenN = 0;
    const getToken = jest.fn(async (opts?: { refresh?: boolean }) => {
      if (opts?.refresh || tokenN === 0) tokenN += 1;
      return `bs1.t${tokenN}`;
    });
    setFetchImpl((async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.authorization);
      if (url.endsWith("/models")) return json({ data: [] });
      if (init?.headers?.authorization === "Bearer bs1.t1") return json({ error: "unauthorized" }, 401);
      return new Response('data: {"kind":"done"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as never);

    const a = new BondOwnGatewayAdapter();
    await a.connect({ baseUrl: BASE, getToken });
    const events = [];
    for await (const e of a.sendTurn({ threadId: "t", messages: [{ role: "user", content: "hi" }] })) events.push(e);

    expect(events.map((e) => e.kind)).toEqual(["done"]);
    expect(seen).toEqual(["Bearer bs1.t1", "Bearer bs1.t1", "Bearer bs1.t2"]);
    expect(getToken).toHaveBeenLastCalledWith({ refresh: true });
  });
});
