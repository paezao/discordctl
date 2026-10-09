import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DiscordctlService, ConfigSource } from "../service.js";
import { requiresHighRiskApproval } from "../service.js";
import type { GuildSnapshot } from "../core/model.js";
import type { Plan } from "../plan/types.js";
import { renderPlan } from "../plan/format.js";
import { namesFromBits } from "../permissions/flags.js";
import { configJsonSchema } from "../config/schema.js";
import { listTemplates, readTemplate } from "../templates.js";
import { redact, redactDeep } from "../util/redact.js";
import { DiscordctlError, SafetyError } from "../util/errors.js";
import { MCP_SERVER_NAME, PRODUCT_NAME, VERSION } from "../core/constants.js";
import { hasErrors } from "../core/diagnostics.js";

export interface McpOptions {
  service: DiscordctlService;
  /** Register the mutation tool (discord_apply_plan). Default false: read-only server. */
  allowApply?: boolean;
  /** Plan lifetime. Default 15 minutes. */
  planTtlMs?: number;
  /**
   * How a human approves a plan:
   * - "elicitation-or-cli" (default): ask the user through MCP elicitation if the client supports it,
   *   otherwise require `discordctl approve <planId>`. High-risk plans always require the CLI.
   * - "cli": always require `discordctl approve <planId>`.
   */
  approval?: "elicitation-or-cli" | "cli";
  now?: () => Date;
}

const guildId = z.string().regex(/^\d{17,20}$/).describe("Discord guild (server) ID");
const configInput = {
  configYaml: z.string().max(500_000).optional().describe("Configuration YAML text (discordctl schema v1). Use this to propose a configuration."),
  configPath: z.string().optional().describe("Path to a configuration file, relative to the server's working directory"),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * MCP adapter. Exposes inspection, validation, planning and auditing as read-only tools.
 * The only mutation path is discord_apply_plan, which requires a stored, unexpired plan,
 * explicit human approval, and an unchanged guild fingerprint. There is no tool that calls
 * arbitrary Discord endpoints, and bot tokens never appear in any output.
 */
export function createMcpServer(options: McpOptions): McpServer {
  const { service } = options;
  const store = service.store;
  const ttl = options.planTtlMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());
  const approvalMode = options.approval ?? "elicitation-or-cli";

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    {
      instructions:
        `${PRODUCT_NAME} manages Discord server structure (roles, categories, channels, permissions) declaratively.\n` +
        "Workflow: inspect or export the guild → write/modify a YAML config (see discord_get_config_schema and discord_list_templates) → " +
        "discord_validate_config → discord_plan_changes → show the plan to the user → the user approves → discord_apply_plan.\n" +
        "Never claim changes were applied unless discord_apply_plan returned status success. Deletions are never automatic.",
    },
  );

  const ok = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: redact(JSON.stringify(redactDeep(value), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)) }],
  });
  const fail = (err: unknown): CallToolResult => {
    const e = err as Error;
    const payload = { error: redact(e.message), ...(err instanceof DiscordctlError ? { code: err.code, ...(err.hint ? { hint: err.hint } : {}) } : {}) };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  };
  const wrap = <A>(fn: (args: A) => Promise<unknown> | unknown) => async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
  const source = (a: { configYaml?: string | undefined; configPath?: string | undefined }): ConfigSource => {
    if (a.configYaml && a.configPath) throw new DiscordctlError("BAD_INPUT", "Pass either configYaml or configPath, not both");
    if (a.configYaml) return { text: a.configYaml, label: "configYaml" };
    if (a.configPath) return { path: a.configPath };
    throw new DiscordctlError("BAD_INPUT", "configYaml or configPath is required");
  };

  // ------------------------------------------------------------------ read-only tools
  server.registerTool(
    "discord_list_guilds",
    { title: "List guilds", description: "List Discord servers the bot can access (filtered by the allowed-guild list, if configured).", inputSchema: {}, annotations: READ_ONLY },
    wrap(async () => ({ guilds: await service.listGuilds() })),
  );

  server.registerTool(
    "discord_inspect_guild",
    {
      title: "Inspect guild",
      description: "Summarize a guild: settings, features, bot capabilities, roles and channel tree with permission overwrites (names, not bitfields).",
      inputSchema: { guildId },
      annotations: READ_ONLY,
    },
    wrap(async (a: { guildId: string }) => summarizeSnapshot(await service.snapshot(a.guildId))),
  );

  server.registerTool(
    "discord_list_roles",
    { title: "List roles", description: "List roles in hierarchy order (highest first) with permission names.", inputSchema: { guildId }, annotations: READ_ONLY },
    wrap(async (a: { guildId: string }) => ({ roles: summarizeSnapshot(await service.snapshot(a.guildId)).roles })),
  );

  server.registerTool(
    "discord_list_channels",
    { title: "List channels", description: "List categories and channels with types, topics and permission overwrites.", inputSchema: { guildId }, annotations: READ_ONLY },
    wrap(async (a: { guildId: string }) => ({ channels: summarizeSnapshot(await service.snapshot(a.guildId)).channels })),
  );

  server.registerTool(
    "discord_get_permissions",
    {
      title: "Effective permissions",
      description: "Simulate effective permissions (view/send/connect/manage) per channel for @everyone and each role, either for the live guild or for a proposed configuration.",
      inputSchema: {
        guildId: guildId.optional(),
        ...configInput,
        roles: z.array(z.string()).optional().describe("Only these roles (keys or names)"),
        channels: z.array(z.string()).optional().describe("Only these channels (keys or names)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: { guildId?: string; configYaml?: string; configPath?: string; roles?: string[]; channels?: string[] }) => {
      const src = a.configYaml || a.configPath ? source(a) : undefined;
      if (!src && !a.guildId) throw new DiscordctlError("BAD_INPUT", "guildId or a config is required");
      return service.permissions(a.guildId, src, { ...(a.roles ? { roles: a.roles } : {}), ...(a.channels ? { channels: a.channels } : {}) });
    }),
  );

  server.registerTool(
    "discord_export_config",
    {
      title: "Export configuration",
      description: "Export the guild's current structure as discordctl YAML. Use it as the starting point for proposed changes. Does not modify state.",
      inputSchema: { guildId },
      annotations: READ_ONLY,
    },
    wrap(async (a: { guildId: string }) => {
      const r = await service.exportGuild(a.guildId, { guildIdVariable: false });
      return { yaml: r.yaml, notes: r.notes };
    }),
  );

  server.registerTool(
    "discord_validate_config",
    {
      title: "Validate configuration",
      description: "Validate a configuration offline: schema, references, Discord limits, and a permission-safety audit. Does not contact Discord.",
      inputSchema: { ...configInput, guildId: guildId.optional() },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    wrap(async (a: { configYaml?: string; configPath?: string; guildId?: string }) => {
      const r = service.validate(source(a), a.guildId);
      return { valid: r.valid, diagnostics: r.diagnostics, findings: r.findings, manualSteps: r.desired.manualSteps };
    }),
  );

  server.registerTool(
    "discord_plan_changes",
    {
      title: "Plan changes",
      description:
        "Compute the changes needed to make the guild match a configuration. Read-only. Returns a planId that expires after a short time; " +
        "applying it requires explicit approval from the user. Show the returned `text` to the user.",
      inputSchema: { ...configInput, guildId: guildId.optional(), allowDelete: z.boolean().optional().describe("Include deletion of previously-managed resources that were removed from the config") },
      annotations: READ_ONLY,
    },
    wrap(async (a: { configYaml?: string; configPath?: string; guildId?: string; allowDelete?: boolean }) => {
      const { plan, findings } = await service.plan(source(a), { ...(a.guildId ? { guildId: a.guildId } : {}), allowDelete: Boolean(a.allowDelete) });
      const created = now();
      const expiresAt = new Date(created.getTime() + ttl);
      const blocked = hasErrors(plan.diagnostics);
      if (plan.ops.length > 0 && !blocked) {
        store.savePlan({
          id: plan.id, guildId: plan.guildId, createdAt: created.toISOString(), expiresAt: expiresAt.toISOString(), configHash: plan.configHash,
          fingerprint: plan.fingerprint, planJson: JSON.stringify(plan), status: "pending", approvedAt: null, approvedBy: null, origin: "mcp",
        });
      }
      const highRisk = requiresHighRiskApproval(plan);
      return {
        planId: plan.ops.length > 0 && !blocked ? plan.id : null,
        expiresAt: plan.ops.length > 0 && !blocked ? expiresAt.toISOString() : null,
        summary: plan.summary,
        maxRisk: plan.maxRisk,
        text: renderPlan(plan),
        operations: plan.ops.map((o) => ({ id: o.id, action: o.action, resource: o.resource, name: o.name, risk: o.risk, riskReasons: o.riskReasons, changes: o.changes })),
        diagnostics: plan.diagnostics,
        findings,
        manualSteps: plan.manualSteps,
        nextStep: blocked
          ? "The plan has errors and cannot be applied. Fix the configuration and plan again."
          : plan.ops.length === 0
            ? "No changes needed."
            : approvalInstructions(plan.id, highRisk, Boolean(options.allowApply), approvalMode),
      };
    }),
  );

  server.registerTool(
    "discord_get_plan_status",
    { title: "Plan status", description: "Check whether a plan is pending, approved, applied, rejected or expired.", inputSchema: { planId: z.string() }, annotations: { ...READ_ONLY, openWorldHint: false } },
    wrap(async (a: { planId: string }) => {
      const p = store.getPlan(a.planId);
      if (!p) throw new DiscordctlError("NOT_FOUND", `No plan ${a.planId}`);
      const expired = new Date(p.expiresAt) < now() && p.status !== "applied";
      return { planId: p.id, guildId: p.guildId, status: expired ? "expired" : p.status, expiresAt: p.expiresAt, approvedBy: p.approvedBy };
    }),
  );

  server.registerTool(
    "discord_audit_permissions",
    {
      title: "Audit permissions",
      description: "Audit the live guild for dangerous permission setups (admin granted broadly, private channels exposed, writable announcements, ...). With a config, also reports drift.",
      inputSchema: { guildId, ...configInput },
      annotations: READ_ONLY,
    },
    wrap(async (a: { guildId: string; configYaml?: string; configPath?: string }) => {
      const r = await service.audit(a.guildId, a.configYaml || a.configPath ? source(a) : undefined);
      return { guildId: r.guildId, guildName: r.guildName, live: r.live, desired: r.desired, drift: r.drift ? { changes: r.drift.ops.length, text: renderPlan(r.drift) } : undefined };
    }),
  );

  server.registerTool(
    "discord_check_bot_capabilities",
    {
      title: "Check bot capabilities",
      description: "Run health checks: connectivity, guild access, required permissions, role hierarchy, Community features and (with a config) whether a plan can be applied.",
      inputSchema: { guildId: guildId.optional(), ...configInput },
      annotations: READ_ONLY,
    },
    wrap(async (a: { guildId?: string; configYaml?: string; configPath?: string }) => service.doctor(a.guildId, a.configYaml || a.configPath ? source(a) : undefined)),
  );

  server.registerTool(
    "discord_list_templates",
    { title: "List templates", description: "List built-in server templates (editable YAML layouts).", inputSchema: {}, annotations: { ...READ_ONLY, openWorldHint: false } },
    wrap(async () => ({ templates: listTemplates().map(({ path: _p, ...t }) => t) })),
  );

  server.registerTool(
    "discord_get_template",
    { title: "Get template", description: "Return a built-in template's YAML to adapt into a configuration.", inputSchema: { name: z.string() }, annotations: { ...READ_ONLY, openWorldHint: false } },
    wrap(async (a: { name: string }) => ({ name: a.name, yaml: readTemplate(a.name) })),
  );

  server.registerTool(
    "discord_get_config_schema",
    { title: "Configuration schema", description: "JSON Schema of the discordctl configuration format.", inputSchema: {}, annotations: { ...READ_ONLY, openWorldHint: false } },
    wrap(async () => ({ schema: configJsonSchema(), docs: "docs/configuration.md" })),
  );

  // ------------------------------------------------------------------ mutation tool
  if (options.allowApply) {
    server.registerTool(
      "discord_apply_plan",
      {
        title: "Apply plan",
        description:
          "Apply a plan created by discord_plan_changes. Requires explicit human approval (MCP confirmation prompt or `discordctl approve <planId>`), " +
          "an unexpired plan, and an unchanged guild. Never call this without the user having reviewed the plan.",
        inputSchema: { planId: z.string().regex(/^plan_[0-9a-f]{12}$/) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      wrap(async (a: { planId: string }) => {
        const stored = store.getPlan(a.planId);
        if (!stored) throw new SafetyError("NOT_FOUND", `No plan ${a.planId}. Create one with discord_plan_changes.`);
        if (stored.status !== "pending" && stored.status !== "approved") {
          throw new SafetyError("PLAN_NOT_PENDING", `Plan ${a.planId} is ${stored.status}; create a new plan`);
        }
        if (new Date(stored.expiresAt) < now()) throw new SafetyError("PLAN_EXPIRED", `Plan ${a.planId} expired at ${stored.expiresAt}; create a new plan`);
        const plan = JSON.parse(stored.planJson) as Plan;
        service.assertGuildAllowed(plan.guildId);
        const highRisk = requiresHighRiskApproval(plan);

        if (stored.status !== "approved") {
          const canElicit = approvalMode === "elicitation-or-cli" && !highRisk && Boolean(server.server.getClientCapabilities()?.elicitation);
          if (!canElicit) {
            throw new SafetyError("APPROVAL_REQUIRED", `Plan ${a.planId} has not been approved by the user`, {
              hint: `Ask the user to review and run: ${PRODUCT_NAME} approve ${a.planId}` + (highRisk ? " (high-risk plans can only be approved from the CLI)" : ""),
            });
          }
          const answer = await server.server.elicitInput({
            mode: "form",
            message: `Apply these changes to Discord server "${plan.guildName}"?\n\n${renderPlan(plan)}`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Apply these changes", description: "Check to apply the plan to Discord" } },
              required: ["confirm"],
            },
          });
          if (answer.action !== "accept" || answer.content?.confirm !== true) {
            store.setPlanStatus(a.planId, "rejected");
            throw new SafetyError("NOT_APPROVED", "The user did not approve the plan; nothing was applied");
          }
          store.setPlanStatus(a.planId, "approved", "mcp-elicitation");
        }

        if (!store.claimPlanForApply(a.planId, ["approved"])) {
          throw new SafetyError("PLAN_NOT_PENDING", `Plan ${a.planId} is already being applied or was not approved`);
        }
        try {
          const { report } = await service.apply(plan, { actor: "mcp" });
          store.setPlanStatus(a.planId, report.status === "success" ? "applied" : "failed");
          return { status: report.status, report };
        } catch (err) {
          // Any failure consumes the plan; the agent must plan again.
          store.setPlanStatus(a.planId, "failed");
          throw err;
        }
      }),
    );
  }

  return server;
}

function approvalInstructions(planId: string, highRisk: boolean, allowApply: boolean, mode: string): string {
  const review = "Show the plan text to the user and ask them to review it.";
  if (!allowApply) {
    return `${review} This MCP server is read-only. The user can apply the plan with: ${PRODUCT_NAME} apply --plan-id ${planId}`;
  }
  if (highRisk || mode === "cli") {
    return `${review} It must be approved by the user from a terminal: ${PRODUCT_NAME} approve ${planId}. Then call discord_apply_plan.`;
  }
  return `${review} Then call discord_apply_plan; the user will be asked to confirm (or can pre-approve with: ${PRODUCT_NAME} approve ${planId}).`;
}

/** Agent-friendly view of a guild: names instead of IDs and bitfields wherever possible. */
export function summarizeSnapshot(s: GuildSnapshot) {
  const roleName = (id: string) => (id === s.guild.id ? "@everyone" : s.roles.find((r) => r.id === id)?.name ?? id);
  const channelName = (id: string | null) => (id ? s.channels.find((c) => c.id === id)?.name ?? id : null);
  return {
    guild: {
      id: s.guild.id, name: s.guild.name, features: s.guild.features, community: s.guild.features.includes("COMMUNITY"), boostTier: s.guild.premiumTier,
      systemChannel: channelName(s.guild.systemChannelId), rulesChannel: channelName(s.guild.rulesChannelId),
    },
    bot: { username: s.bot.username, permissions: namesFromBits(s.bot.permissions), highestRolePosition: s.bot.highestRolePosition },
    roles: s.roles.map((r) => ({
      id: r.id, name: r.isEveryone ? "@everyone" : r.name, position: r.position, managed: r.managed,
      color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null, hoist: r.hoist, mentionable: r.mentionable,
      permissions: namesFromBits(r.permissions), manageableByBot: !r.managed && !r.isEveryone && r.position < s.bot.highestRolePosition,
    })),
    channels: [...s.channels]
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        id: c.id, name: c.name, type: c.kind, category: channelName(c.parentId), position: c.position,
        ...(c.topic ? { topic: c.topic } : {}),
        ...(c.slowmode ? { slowmode: c.slowmode } : {}),
        ...(c.tags?.length ? { tags: c.tags.map((t) => t.name) } : {}),
        overwrites: c.overwrites.map((o) => ({
          target: o.type === "member" ? `member:${o.id}` : roleName(o.id),
          allow: namesFromBits(o.allow),
          deny: namesFromBits(o.deny),
        })),
      })),
  };
}
