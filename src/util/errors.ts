/** Base class for all errors raised intentionally by discordctl. */
export class DiscordctlError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DiscordctlError";
    this.code = code;
    if (options?.hint) this.hint = options.hint;
  }
}

export class ConfigError extends DiscordctlError {
  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super("CONFIG_INVALID", message, options);
    this.name = "ConfigError";
  }
}

export class AuthError extends DiscordctlError {
  constructor(message: string, options?: { hint?: string; cause?: unknown }) {
    super("AUTH", message, options);
    this.name = "AuthError";
  }
}

export class SafetyError extends DiscordctlError {
  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(code, message, options);
    this.name = "SafetyError";
  }
}

/** Error returned by a DiscordApi implementation, normalized across transports. */
export class DiscordApiError extends DiscordctlError {
  readonly status: number;
  readonly discordCode: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  /** True when the request may have been processed by Discord (e.g. timeout, 5xx). */
  readonly ambiguous: boolean;

  constructor(init: {
    status: number;
    message: string;
    discordCode?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    ambiguous?: boolean;
    method?: string;
    route?: string;
    cause?: unknown;
  }) {
    const where = init.method && init.route ? ` (${init.method} ${init.route})` : "";
    super("DISCORD_API", `${init.message}${where}`, { cause: init.cause, hint: hintForStatus(init.status, init.discordCode) });
    this.name = "DiscordApiError";
    this.status = init.status;
    this.discordCode = init.discordCode;
    this.retryable = init.retryable ?? (init.status === 429 || init.status >= 500 || init.status === 0);
    this.retryAfterMs = init.retryAfterMs;
    this.ambiguous = init.ambiguous ?? (init.status >= 500 || init.status === 0);
  }
}

function hintForStatus(status: number, code?: number): string | undefined {
  if (status === 401) return "The bot token is invalid or was reset. Run `discordctl login` again.";
  if (code === 50013) {
    return "The bot is missing a permission or its highest role is below the target role. Run `discordctl doctor`.";
  }
  if (status === 403) return "The bot lacks access. Check that it was invited to the guild with the required permissions.";
  if (status === 404) return "The resource no longer exists or the bot cannot see it.";
  if (code === 50035) return "Discord rejected the request body. Check field limits in docs/configuration.md.";
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
