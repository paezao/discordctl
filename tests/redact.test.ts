import { describe, it, expect } from "vitest";
import { redact, redactDeep, registerSecret } from "../src/util/redact.js";
import { createLogger } from "../src/util/logger.js";

const TOKEN = "OTk5OTk5OTk5OTk5OTk5OTk5.Gzzzzz.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

describe("secret redaction", () => {
  it("redacts token-shaped strings and auth headers", () => {
    expect(redact(`token=${TOKEN}`)).toBe("token=[REDACTED_TOKEN]");
    expect(redact("Authorization: Bot abcdefghijklmnopqrstuvwxyz.123")).toContain("Bot [REDACTED]");
  });

  it("redacts registered secrets of any shape", () => {
    registerSecret("hunter2-but-longer");
    expect(redact("pw is hunter2-but-longer")).toBe("pw is [REDACTED]");
  });

  it("drops secret-named keys in objects", () => {
    expect(redactDeep({ token: "x", nested: { password: "y", ok: 1 } })).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]", ok: 1 } });
  });

  it("redacts log output", () => {
    const lines: string[] = [];
    createLogger("debug", (l) => lines.push(l)).info("using", { t: TOKEN });
    expect(lines[0]).not.toContain(TOKEN);
  });
});
