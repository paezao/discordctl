import { describe, it, expect } from "vitest";
import { RestDiscordApi } from "../src/provider/rest.js";
import { DiscordApiError } from "../src/util/errors.js";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB";

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", ...headers });
  return { status, statusText: String(status), ok: status < 300, headers: h, body: null, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer, json: async () => body, text: async () => JSON.stringify(body), bodyUsed: false } as never;
}

describe("REST transport (official Discord API via @discordjs/rest)", () => {
  it("waits out a 429 using Discord's rate-limit headers and retries", async () => {
    const seen: string[] = [];
    let n = 0;
    const api = new RestDiscordApi({
      token: TOKEN,
      makeRequest: async (url, init) => {
        seen.push(`${init.method} ${url}`);
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
        if (n++ === 0) return fakeResponse(429, { message: "You are being rate limited.", retry_after: 0.05, global: false }, { "retry-after": "0.05", "x-ratelimit-scope": "user" });
        return fakeResponse(200, { id: "1", username: "bot", bot: true });
      },
    });
    const me = await api.getCurrentUser();
    expect(me.username).toBe("bot");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/GET https:\/\/discord\.com\/api\/v10\/users\/(@|%40)me/);
  });

  it("fails fast instead of sleeping through very long rate limits", async () => {
    const api = new RestDiscordApi({
      token: TOKEN,
      maxRateLimitWaitMs: 1000,
      makeRequest: async () => fakeResponse(429, { message: "slow down", retry_after: 600, global: false }, { "retry-after": "600" }),
    });
    await expect(api.getCurrentUser()).rejects.toMatchObject({ status: 429, retryable: false });
  });

  it("maps Discord errors with codes and hints, without leaking the token", async () => {
    const api = new RestDiscordApi({ token: TOKEN, makeRequest: async () => fakeResponse(403, { message: "Missing Permissions", code: 50013 }) });
    const err = (await api.createRole("111111111111111111", { name: "x" }).catch((e) => e)) as DiscordApiError;
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.discordCode).toBe(50013);
    expect(err.hint).toMatch(/doctor/);
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(TOKEN);
  });

  it("attaches an audit-log reason to mutations", async () => {
    let reason: string | undefined;
    const api = new RestDiscordApi({
      token: TOKEN,
      makeRequest: async (_url, init) => {
        reason = (init.headers as Record<string, string>)["X-Audit-Log-Reason"];
        return fakeResponse(200, { id: "5", name: "x" });
      },
    });
    await api.createRole("111111111111111111", { name: "x" }, "discordctl apply plan_abc");
    expect(decodeURIComponent(reason!)).toBe("discordctl apply plan_abc");
  });
});
