import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import type { CliContext, GlobalOptions } from "./context.js";
import { createContext, loadEnvFile } from "./context.js";
import { ask, askHidden, eprint, isInteractive, jsonReplacer, print, printJson, readStdin } from "./io.js";
import { renderDiagnostics, renderFindings, renderManualSteps, renderPlan, renderReport } from "../plan/format.js";
import type { Plan } from "../plan/types.js";
import { requiresHighRiskApproval, type ConfigSource } from "../service.js";
import { configJsonSchema } from "../config/schema.js";
import { PERMISSION_ALIASES, PERMISSION_NAMES, namesFromBits } from "../permissions/flags.js";
import { describeRequirement, inviteUrl, requiredBotPermissions } from "../permissions/requirements.js";
import { normalizeToken, removeToken, saveToken } from "../auth/credentials.js";
import { DiscordctlService } from "../service.js";
import { openInBrowser, runSetup } from "./setup.js";
import { listTemplates, readTemplate } from "../templates.js";
import { DiscordctlError } from "../util/errors.js";
import { PRODUCT_NAME, VERSION } from "../core/constants.js";
import type { FindingSeverity } from "../permissions/audit.js";
import { hasErrors } from "../core/diagnostics.js";

type Action<T> = (ctx: CliContext, opts: T, ...args: string[]) => Promise<number | void>;

/** Exit codes: 0 success, 1 error, 2 "changes pending" / "findings above threshold". */
function run<T extends object>(action: Action<T>) {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.optsWithGlobals() as T & GlobalOptions;
    const positional = args.slice(0, -2).filter((a): a is string => typeof a === "string");
    let ctx: CliContext | undefined;
    try {
      loadEnvFile(opts.envFile);
      ctx = createContext(opts);
      const code = await action(ctx, opts, ...positional);
      process.exitCode = typeof code === "number" ? code : 0;
    } catch (err) {
      process.exitCode = 1;
      const e = err as Error;
      if (opts.json) {
        printJson({ error: { message: e.message, ...(err instanceof DiscordctlError ? { code: err.code, hint: err.hint } : {}) } });
      } else {
        eprint(`${ctx?.c.red("Error:") ?? "Error:"} ${e.message}`);
        if (err instanceof DiscordctlError && err.hint) eprint(`  ${ctx?.c.dim("hint:") ?? "hint:"} ${err.hint}`);
        if (opts.verbose && e.stack) eprint(e.stack);
      }
    } finally {
      ctx?.close();
    }
  };
}

function envGuild(): string | undefined {
  return process.env.DISCORD_GUILD_ID?.trim() || undefined;
}

/** Guild for commands acting on a live server: --guild, then the config's guild, then $DISCORD_GUILD_ID. */
function resolveGuild(ctx: CliContext, explicit?: string, config?: string): string {
  if (explicit) return explicit;
  if (config) return ctx.offlineService().loadDesired({ path: config }).desired.guildId;
  const fromEnv = envGuild();
  if (fromEnv) return fromEnv;
  throw new DiscordctlError("MISSING_GUILD", "No guild given", {
    hint: `Pass --guild <id> or --config <file>, or set DISCORD_GUILD_ID in .env (\`${PRODUCT_NAME} setup\` does this).`,
  });
}

function configSource(path: string | undefined): ConfigSource {
  if (!path) throw new DiscordctlError("MISSING_CONFIG", "--config is required", { hint: `Create one with \`${PRODUCT_NAME} init\` or \`${PRODUCT_NAME} export\`.` });
  return { path };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(PRODUCT_NAME)
    .description("Infrastructure as Code for Discord servers")
    .version(VERSION)
    .option("--state <path>", "state database (default: ./.discordctl/state.db or $DISCORDCTL_STATE)")
    .option("--profile <name>", "credentials profile", "default")
    .option("--env-file <path>", "load environment variables from a file (default: ./.env if present)")
    .option("--json", "machine-readable JSON output")
    .option("--no-color", "disable colors")
    .option("-v, --verbose", "verbose logging");

  // ------------------------------------------------------------------ init
  program
    .command("init")
    .description("create a configuration file from a template")
    .option("-t, --template <name>", "template to start from", "small-private-team")
    .option("-o, --output <file>", "output file", "discord.yaml")
    .option("--guild <id>", "write this guild ID instead of ${DISCORD_GUILD_ID}")
    .option("--list", "list available templates")
    .option("--force", "overwrite the output file")
    .action(
      run(async (ctx, o: { template: string; output: string; guild?: string; list?: boolean; force?: boolean }) => {
        if (o.list) {
          const t = listTemplates();
          if (ctx.json) return printJson(t.map(({ path: _p, ...rest }) => rest));
          for (const x of t) print(`${ctx.c.bold(x.name.padEnd(22))} ${x.description}`);
          return;
        }
        if (existsSync(o.output) && !o.force) throw new DiscordctlError("EXISTS", `${o.output} already exists`, { hint: "Use --force to overwrite." });
        let text = readTemplate(o.template);
        if (o.guild) {
          if (!/^\d{17,20}$/.test(o.guild)) throw new DiscordctlError("INVALID_GUILD", `"${o.guild}" is not a guild ID`);
          text = text.replace('"${DISCORD_GUILD_ID}"', `"${o.guild}"`);
        }
        writeFileSync(o.output, text);
        if (ctx.json) return printJson({ written: o.output, template: o.template });
        print(`${ctx.c.green("✓")} Wrote ${o.output} from template "${o.template}"`);
        print("");
        print("Next steps:");
        if (!o.guild) print(`  1. Set DISCORD_GUILD_ID in .env (Developer Mode → right-click server → Copy Server ID)`);
        print(`  ${o.guild ? 1 : 2}. ${PRODUCT_NAME} validate --config ${o.output}`);
        print(`  ${o.guild ? 2 : 3}. ${PRODUCT_NAME} plan --config ${o.output}`);
      }),
    );

  program
    .command("templates")
    .description("list built-in templates")
    .action(
      run(async (ctx) => {
        const t = listTemplates();
        if (ctx.json) return printJson(t.map(({ path: _p, ...rest }) => rest));
        for (const x of t) print(`${ctx.c.bold(x.name.padEnd(22))} ${x.description}`);
      }),
    );

  // ------------------------------------------------------------------ setup
  program
    .command("setup")
    .description("guided first-time setup: create a bot, store its token, invite it, check permissions")
    .option("-c, --config <file>", "request exactly the permissions this config needs")
    .option("-g, --guild <id>", "server to set up (preselected in the invite)")
    .option("--no-browser", "print links instead of opening them")
    .option("--no-wait", "do not wait for the bot to join the server")
    .option("--timeout <seconds>", "how long to wait for the bot to join", "300")
    .option("--env-out <file>", "where to record DISCORD_GUILD_ID (never the token)", ".env")
    .action(
      run(async (ctx, o: { config?: string; guild?: string; browser: boolean; wait: boolean; timeout: string; envOut: string; profile: string }) => {
        if (!isInteractive()) {
          throw new DiscordctlError("NEEDS_TTY", "setup is interactive", { hint: `In scripts use \`${PRODUCT_NAME} login --token-stdin\` and \`${PRODUCT_NAME} invite\`.` });
        }
        const r = await runSetup(
          {
            profile: o.profile, browser: o.browser, wait: o.wait, timeoutMs: Number(o.timeout) * 1000, envFile: o.envOut,
            ...(o.config ? { config: o.config } : {}), ...(o.guild ? { guild: o.guild } : {}),
          },
          {
            io: { print, ask, askSecret: askHidden, openUrl: openInBrowser, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() },
            c: ctx.c,
            createApi: (token) => ctx.createApi(token),
            createService: (api) => new DiscordctlService({ api, store: ctx.store(), logger: ctx.logger }),
          },
        );
        return r.ready ? 0 : 1;
      }),
    );

  // ------------------------------------------------------------------ login / logout
  program
    .command("login")
    .description("store a Discord bot token (never a user token) and verify it")
    .option("--token-stdin", "read the token from stdin instead of prompting")
    .action(
      run(async (ctx, o: { tokenStdin?: boolean; profile: string }) => {
        const raw = o.tokenStdin ? await readStdin() : await askHidden("Bot token (input hidden): ");
        const token = normalizeToken(raw);
        const me = await ctx.createApi(token).getCurrentUser();
        if (!me.bot) throw new DiscordctlError("NOT_A_BOT", "This token belongs to a user account. discordctl only supports bot tokens.");
        const path = saveToken(token, o.profile, { botUserId: me.id, botName: me.username });
        const url = inviteUrl(me.id, requiredBotPermissions());
        if (ctx.json) return printJson({ bot: { id: me.id, username: me.username }, savedTo: path, inviteUrl: url });
        print(`${ctx.c.green("✓")} Authenticated as bot ${ctx.c.bold(me.username)} (${me.id})`);
        print(`  Token saved to ${path} (mode 600, profile "${o.profile}")`);
        print(`  Environment variables (DISCORD_TOKEN) take precedence over the saved token.`);
        print("");
        print(`Invite the bot (base permissions; run \`${PRODUCT_NAME} invite --config <file>\` for exact needs):`);
        print(`  ${url}`);
      }),
    );

  program
    .command("logout")
    .description("remove a stored bot token")
    .action(
      run(async (ctx, o: { profile: string }) => {
        const removed = removeToken(o.profile);
        if (ctx.json) return printJson({ removed });
        print(removed ? `Removed profile "${o.profile}"` : `No stored token for profile "${o.profile}"`);
      }),
    );

  program
    .command("invite")
    .description("print an OAuth2 invite URL requesting the minimal permissions a config needs")
    .option("-c, --config <file>", "compute permissions from this config")
    .option("--guild <id>", "preselect this guild")
    .option("--client-id <id>", "application ID (default: the authenticated bot's ID)")
    .action(
      run(async (ctx, o: { config?: string; guild?: string; clientId?: string }) => {
        let perms = requiredBotPermissions();
        let guildId = o.guild;
        if (o.config) {
          const { desired, diagnostics } = ctx.service().loadDesired({ path: o.config }, o.guild);
          if (hasErrors(diagnostics)) throw new DiscordctlError("CONFIG_INVALID", "Configuration has errors; run validate");
          perms = requiredBotPermissions(desired);
          guildId ??= desired.guildId;
        }
        guildId ??= envGuild();
        const clientId = o.clientId ?? (await ctx.service().api.getCurrentUser()).id;
        const url = inviteUrl(clientId, perms, guildId);
        if (ctx.json) return printJson({ url, permissions: perms.toString(), permissionNames: namesFromBits(perms) });
        print(url);
        print("");
        print(ctx.c.dim("Requested permissions: " + describeRequirement(perms).join(", ")));
        print(ctx.c.dim("After inviting, drag the bot's role above every role it should manage (Server Settings → Roles)."));
      }),
    );

  // ------------------------------------------------------------------ guilds / inspect
  program
    .command("guilds")
    .description("list guilds the bot can access")
    .action(
      run(async (ctx) => {
        const guilds = await ctx.service().listGuilds();
        if (ctx.json) return printJson(guilds);
        if (!guilds.length) print("The bot is not in any guilds. Use `discordctl invite` to add it.");
        for (const g of guilds) print(`${g.id}  ${g.name}${(g.features as string[]).includes("COMMUNITY") ? ctx.c.dim("  [community]") : ""}`);
      }),
    );

  program
    .command("inspect")
    .description("show a guild's roles, channels and permissions")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const s = await ctx.service().snapshot(resolveGuild(ctx, o.guild));
        if (ctx.json) return printJson(s);
        const c = ctx.c;
        print(c.bold(`${s.guild.name} (${s.guild.id})`));
        print(c.dim(`features: ${s.guild.features.join(", ") || "(none)"}; boost tier ${s.guild.premiumTier}`));
        print(c.dim(`bot: ${s.bot.username}, highest role position ${s.bot.highestRolePosition}`));
        print("");
        print(c.bold("Roles (highest first)"));
        for (const r of s.roles) {
          const flags = [r.managed ? "managed" : "", r.hoist ? "hoisted" : "", r.mentionable ? "mentionable" : ""].filter(Boolean).join(", ");
          const perms = namesFromBits(r.permissions);
          print(`  ${String(r.position).padStart(3)}  ${r.isEveryone ? "@everyone" : r.name}${flags ? c.dim(` (${flags})`) : ""}  ${c.dim(perms.includes("Administrator") ? "Administrator" : `${perms.length} permissions`)}`);
        }
        print("");
        print(c.bold("Channels"));
        const byParent = (pid: string | null) =>
          s.channels.filter((x) => x.parentId === pid && x.kind !== "category").sort((a, b) => Number(a.kind === "voice" || a.kind === "stage") - Number(b.kind === "voice" || b.kind === "stage") || a.position - b.position);
        const line = (x: (typeof s.channels)[number], indent: string) =>
          print(`${indent}${x.kind === "category" ? c.bold(x.name) : `${x.name}`} ${c.dim(`[${x.kind}${x.overwrites.length ? `, ${x.overwrites.length} overwrites` : ""}] ${x.id}`)}`);
        for (const x of byParent(null)) line(x, "  ");
        for (const cat of s.channels.filter((x) => x.kind === "category").sort((a, b) => a.position - b.position)) {
          line(cat, "  ");
          for (const x of byParent(cat.id)) line(x, "    ");
        }
      }),
    );

  // ------------------------------------------------------------------ export
  program
    .command("export")
    .description("export a guild's current structure as a configuration file")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .option("-o, --output <file>", "write to a file instead of stdout")
    .option("--with-ids", "pin every resource by Discord ID")
    .option("--guild-var", "write ${DISCORD_GUILD_ID} instead of the literal guild ID")
    .option("--write-state", "record exported resources in state (equivalent to import)")
    .option("--force", "overwrite the output file")
    .action(
      run(async (ctx, o: { guild?: string; output?: string; withIds?: boolean; guildVar?: boolean; writeState?: boolean; force?: boolean }) => {
        if (o.output && existsSync(o.output) && !o.force) throw new DiscordctlError("EXISTS", `${o.output} already exists`, { hint: "Use --force to overwrite." });
        const r = await ctx.service().exportGuild(resolveGuild(ctx, o.guild), { withIds: Boolean(o.withIds), guildIdVariable: Boolean(o.guildVar), writeState: Boolean(o.writeState) });
        if (o.output) writeFileSync(o.output, r.yaml);
        if (ctx.json) return printJson({ ...(o.output ? { written: o.output } : { yaml: r.yaml }), notes: r.notes, resources: r.bindings.length });
        if (!o.output) process.stdout.write(r.yaml);
        else print(`${ctx.c.green("✓")} Exported ${r.bindings.length} resources to ${o.output}`);
        for (const n of r.notes) eprint(ctx.c.yellow(n));
      }),
    );

  // ------------------------------------------------------------------ validate
  program
    .command("validate")
    .description("validate a configuration file offline (schema, references, permission audit)")
    .requiredOption("-c, --config <file>", "configuration file")
    .option("-g, --guild <id>", "override guild ID")
    .option("--strict", "treat warnings and high/critical findings as errors")
    .action(
      run(async (ctx, o: { config: string; guild?: string; strict?: boolean }) => {
        const r = ctx.offlineService().validate(configSource(o.config), o.guild);
        const serious = r.findings.filter((f) => f.severity === "critical" || f.severity === "high");
        const warnings = r.diagnostics.filter((d) => d.severity === "warning");
        const failed = !r.valid || (o.strict && (serious.length > 0 || warnings.length > 0));
        if (ctx.json) {
          printJson({ valid: r.valid, diagnostics: r.diagnostics, findings: r.findings, summary: summarizeDesired(r.desired) });
          return failed ? 1 : 0;
        }
        const diag = renderDiagnostics(r.diagnostics.filter((d) => d.severity !== "info" || ctx.opts.verbose), ctx.c);
        if (diag) print(diag);
        if (r.valid) {
          const s = summarizeDesired(r.desired);
          print(`${ctx.c.green("✓")} ${o.config} is valid: ${s.roles} roles, ${s.categories} categories, ${s.channels} channels`);
          if (r.findings.length) {
            print("");
            print(ctx.c.bold("Permission audit:"));
            print(renderFindings(r.findings, ctx.c));
          }
          if (r.desired.manualSteps.length) print("\n" + renderManualSteps(r.desired.manualSteps, ctx.c));
        } else print(ctx.c.red(`✗ ${o.config} has errors`));
        return failed ? 1 : 0;
      }),
    );

  // ------------------------------------------------------------------ plan
  program
    .command("plan")
    .description("show what apply would change (read-only)")
    .requiredOption("-c, --config <file>", "configuration file")
    .option("-g, --guild <id>", "override guild ID")
    .option("--allow-delete", "plan deletion of resources removed from the config (previously managed only)")
    .option("-o, --out <file>", "save the plan as JSON for `apply --plan`")
    .option("--compact", "hide per-field details")
    .option("--detailed-exitcode", "exit 2 when there are changes")
    .action(
      run(async (ctx, o: { config: string; guild?: string; allowDelete?: boolean; out?: string; compact?: boolean; detailedExitcode?: boolean }) => {
        const { plan, findings } = await ctx.service().plan(configSource(o.config), { ...(o.guild ? { guildId: o.guild } : {}), allowDelete: Boolean(o.allowDelete) });
        if (o.out) writeFileSync(o.out, JSON.stringify(plan, jsonReplacer, 2) + "\n");
        if (ctx.json) printJson({ plan, findings });
        else {
          print(renderPlan(plan, ctx.c, { detailed: !o.compact, manualSteps: "full" }));
          const serious = findings.filter((f) => f.severity === "critical" || f.severity === "high");
          if (serious.length) print("\n" + ctx.c.bold("Permission audit of the resulting configuration:") + "\n" + renderFindings(serious, ctx.c));
          if (o.out) print(ctx.c.dim(`\nSaved plan ${plan.id} to ${o.out}. Apply it with: ${PRODUCT_NAME} apply --plan ${o.out}`));
        }
        if (hasErrors(plan.diagnostics)) return 1;
        return o.detailedExitcode && plan.ops.length > 0 ? 2 : 0;
      }),
    );

  // ------------------------------------------------------------------ apply
  program
    .command("apply")
    .description("apply changes (dry run unless confirmed)")
    .option("-c, --config <file>", "configuration file")
    .option("-p, --plan <file>", "apply a saved plan (from `plan --out`)")
    .option("--plan-id <id>", "apply a plan proposed by an AI agent via MCP (see `plans list`)")
    .option("-g, --guild <id>", "override guild ID")
    .option("-y, --yes", "apply without the interactive confirmation")
    .option("--dry-run", "only show the plan")
    .option("--allow-delete", "allow deleting resources removed from the config")
    .option("--allow-high-risk", "allow high/critical-risk changes (e.g. granting Administrator) with --yes")
    .option("--continue-on-error", "keep applying independent operations after a failure")
    .action(
      run(async (ctx, o: { config?: string; plan?: string; planId?: string; guild?: string; yes?: boolean; dryRun?: boolean; allowDelete?: boolean; allowHighRisk?: boolean; continueOnError?: boolean }) => {
        const service = ctx.service();
        let plan: Plan;
        let desired;
        if (o.planId) {
          const stored = ctx.store().getPlan(o.planId);
          if (!stored) throw new DiscordctlError("NOT_FOUND", `No stored plan ${o.planId}`);
          if (stored.status !== "pending" && stored.status !== "approved") throw new DiscordctlError("PLAN_NOT_PENDING", `Plan ${o.planId} is ${stored.status}`);
          if (new Date(stored.expiresAt) < new Date()) throw new DiscordctlError("PLAN_EXPIRED", `Plan ${o.planId} expired at ${stored.expiresAt}`, { hint: "Create a new plan." });
          plan = JSON.parse(stored.planJson) as Plan;
          if (plan.ops.some((op) => op.destructive) && !o.allowDelete) {
            throw new DiscordctlError("DELETE_NOT_AUTHORIZED", "This plan deletes resources; pass --allow-delete to confirm");
          }
        } else if (o.plan) {
          plan = JSON.parse(readFileSync(o.plan, "utf8")) as Plan;
          if (plan.formatVersion !== 1) throw new DiscordctlError("PLAN_FORMAT", "Unsupported plan file format");
          if (o.config) desired = service.loadDesired({ path: o.config }, o.guild).desired;
          if (plan.ops.some((op) => op.destructive) && !o.allowDelete) {
            throw new DiscordctlError("DELETE_NOT_AUTHORIZED", "This plan deletes resources; pass --allow-delete to confirm");
          }
        } else {
          const r = await service.plan(configSource(o.config), { ...(o.guild ? { guildId: o.guild } : {}), allowDelete: Boolean(o.allowDelete) });
          plan = r.plan;
          desired = r.desired;
        }
        if (!ctx.json) print(renderPlan(plan, ctx.c));
        if (hasErrors(plan.diagnostics)) {
          if (ctx.json) printJson({ applied: false, reason: "plan has errors", plan });
          else eprint(ctx.c.red("\nThe plan has errors; nothing was applied."));
          return 1;
        }
        if (plan.ops.length === 0) {
          if (ctx.json) printJson({ applied: false, reason: "no changes", plan });
          else if (plan.manualSteps.length) print("\n" + renderManualSteps(plan.manualSteps, ctx.c));
          return 0;
        }
        const highRisk = requiresHighRiskApproval(plan);
        let confirmed = false;
        if (o.dryRun) confirmed = false;
        else if (o.yes) {
          if (highRisk && !o.allowHighRisk) {
            throw new DiscordctlError("HIGH_RISK", `This plan contains ${plan.maxRisk}-risk or destructive changes`, { hint: "Review them, then re-run with --yes --allow-high-risk (or confirm interactively)." });
          }
          confirmed = true;
        } else if (isInteractive() && !ctx.json) {
          print("");
          if (highRisk) {
            print(ctx.c.red(ctx.c.bold(`This plan contains ${plan.maxRisk}-risk or destructive changes.`)));
            const answer = await ask(`Type the server name "${plan.guildName}" to apply: `);
            confirmed = answer === plan.guildName;
          } else {
            const answer = await ask(`Apply ${plan.ops.length} change(s) to "${plan.guildName}"? Only "yes" is accepted: `);
            confirmed = answer === "yes";
          }
          if (!confirmed) print("Cancelled; nothing was applied.");
        } else if (!ctx.json) {
          print(ctx.c.dim("\nDry run (non-interactive). Re-run with --yes to apply."));
        }
        if (!confirmed) {
          if (ctx.json) printJson({ applied: false, reason: o.dryRun ? "dry run" : "not confirmed (use --yes)", plan });
          return 0;
        }
        if (o.planId && !ctx.store().claimPlanForApply(o.planId, ["pending", "approved"])) {
          throw new DiscordctlError("PLAN_NOT_PENDING", `Plan ${o.planId} is already being applied`);
        }
        let result;
        try {
          result = await service.apply(plan, {
          actor: "cli",
          ...(desired ? { desired } : {}),
          continueOnError: Boolean(o.continueOnError),
          onProgress: ctx.json ? undefined : ({ op, status, error }) => {
            if (status === "applied") print(`${ctx.c.green("✓")} ${op.id}`);
            else if (status === "failed") print(`${ctx.c.red("✗")} ${op.id}: ${error}`);
          },
          });
        } catch (err) {
          if (o.planId) ctx.store().setPlanStatus(o.planId, "failed");
          throw err;
        }
        if (o.planId) ctx.store().setPlanStatus(o.planId, result.report.status === "success" ? "applied" : "failed");
        if (ctx.json) printJson({ applied: true, report: result.report, remaining: result.remaining?.ops ?? null, manualSteps: plan.manualSteps });
        else {
          print("");
          print(renderReport(result.report, ctx.c));
          if (result.remaining && result.remaining.ops.length > 0) {
            print(ctx.c.yellow(`\nVerification: ${result.remaining.ops.length} change(s) still pending after apply (Discord may have normalized a value):`));
            print(renderPlan(result.remaining, ctx.c, { detailed: true }));
          } else if (result.remaining) print(ctx.c.green("Verified: Discord now matches the configuration."));
          if (result.report.status === "success" && plan.manualSteps.length) print("\n" + renderManualSteps(plan.manualSteps, ctx.c));
        }
        return result.report.status === "success" ? 0 : 1;
      }),
    );

  // ------------------------------------------------------------------ audit
  program
    .command("audit")
    .description("audit live permissions and detect drift from a configuration")
    .option("-c, --config <file>", "configuration file (enables drift detection)")
    .option("-g, --guild <id>", "guild ID (default: from --config, else $DISCORD_GUILD_ID)")
    .addOption(new Option("--fail-on <severity>", "exit 2 if findings at or above this severity exist (or drift)").choices(["critical", "high", "medium", "low", "info"]))
    .action(
      run(async (ctx, o: { config?: string; guild?: string; failOn?: FindingSeverity }) => {
        const service = ctx.service();
        const r = await service.audit(resolveGuild(ctx, o.guild, o.config), o.config ? { path: o.config } : undefined);
        const sevRank: Record<FindingSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
        const threshold = o.failOn ? sevRank[o.failOn] : Infinity;
        const failing = r.live.some((f) => sevRank[f.severity] >= threshold) || (o.failOn !== undefined && (r.drift?.ops.length ?? 0) > 0);
        if (ctx.json) {
          printJson(r);
          return failing ? 2 : 0;
        }
        print(ctx.c.bold(`Permission audit of live guild "${r.guildName}":`));
        print(renderFindings(r.live, ctx.c));
        if (r.drift) {
          print("");
          if (r.drift.ops.length === 0) print(ctx.c.green("No drift: Discord matches the configuration."));
          else {
            print(ctx.c.yellow(ctx.c.bold(`Drift detected: ${r.drift.ops.length} difference(s) between Discord and ${o.config}`)));
            print(renderPlan(r.drift, ctx.c));
          }
        }
        return failing ? 2 : 0;
      }),
    );

  // ------------------------------------------------------------------ permissions
  program
    .command("permissions")
    .description("show effective permissions per channel and role (simulated)")
    .option("-c, --config <file>", "simulate the configuration instead of the live guild")
    .option("-g, --guild <id>", "guild ID for the live guild (default: $DISCORD_GUILD_ID)")
    .option("-r, --role <key...>", "only these roles")
    .option("--channel <key...>", "only these channels")
    .option("--list", "list valid permission names and aliases")
    .action(
      run(async (ctx, o: { config?: string; guild?: string; role?: string[]; channel?: string[]; list?: boolean }) => {
        if (o.list) {
          const aliases = Object.entries(PERMISSION_ALIASES);
          if (ctx.json) return printJson({ permissions: PERMISSION_NAMES, aliases: Object.fromEntries(aliases) });
          print(ctx.c.bold("Permissions:"));
          for (const n of PERMISSION_NAMES) print(`  ${n}`);
          print(ctx.c.bold("\nAliases:"));
          for (const [a, n] of aliases) print(`  ${a.padEnd(18)} → ${n}`);
          return;
        }
        const service = o.config ? ctx.offlineService() : ctx.service();
        const r = await service.permissions(o.config ? o.guild : resolveGuild(ctx, o.guild), o.config ? { path: o.config } : undefined, { ...(o.role ? { roles: o.role } : {}), ...(o.channel ? { channels: o.channel } : {}) });
        if (ctx.json) return printJson(r);
        const personas = Object.keys(r.matrix[0]?.personas ?? {});
        print(ctx.c.dim(`Effective permissions (${r.source}). V=view S=send/speak C=connect M=manage; '-' = none\n`));
        const width = Math.min(36, Math.max(...r.matrix.map((m) => m.channel.length + (m.category ? 2 : 0)), 8));
        print("".padEnd(width + 2) + personas.map((p) => p.slice(0, 12).padEnd(13)).join(""));
        for (const row of r.matrix) {
          const name = (row.kind === "category" ? row.channel : `  ${row.channel}`).slice(0, width).padEnd(width + 2);
          const cells = personas.map((p) => {
            const x = row.personas[p]!;
            const cell = `${x.view ? "V" : "-"}${x.send ? "S" : "-"}${x.connect ? "C" : "-"}${x.manage ? "M" : "-"}`.padEnd(13);
            return x.view ? cell : ctx.c.dim(cell);
          });
          print((row.kind === "category" ? ctx.c.bold(name) : name) + cells.join(""));
        }
      }),
    );

  // ------------------------------------------------------------------ import
  program
    .command("import")
    .description("adopt existing roles and channels matching the config into state (no Discord changes)")
    .requiredOption("-c, --config <file>", "configuration file")
    .option("-g, --guild <id>", "override guild ID")
    .option("--dry-run", "show what would be imported")
    .action(
      run(async (ctx, o: { config: string; guild?: string; dryRun?: boolean }) => {
        const r = await ctx.service().importState(configSource(o.config), { ...(o.guild ? { guildId: o.guild } : {}), dryRun: Boolean(o.dryRun) });
        if (ctx.json) return printJson(r);
        for (const b of r.bindings) print(`${ctx.c.cyan("=")} ${b.kind} ${b.key} → ${b.name} (${b.id})`);
        for (const u of r.unmatched) print(`${ctx.c.dim("·")} ${u} ${ctx.c.dim("(not found; will be created by apply)")}`);
        print(`\n${o.dryRun ? "Would import" : "Imported"} ${r.bindings.length} resource(s); ${r.unmatched.length} not found.`);
      }),
    );

  // ------------------------------------------------------------------ doctor
  program
    .command("doctor")
    .description("check connectivity, guild access, bot permissions, hierarchy and config")
    .option("-c, --config <file>", "configuration file")
    .option("-g, --guild <id>", "guild ID")
    .action(
      run(async (ctx, o: { config?: string; guild?: string }) => {
        const r = await ctx.service().doctor(o.guild ?? (o.config ? undefined : envGuild()), o.config ? { path: o.config } : undefined);
        if (ctx.json) {
          printJson(r);
          return r.ok ? 0 : 1;
        }
        for (const ch of r.checks) {
          const icon = ch.status === "ok" ? ctx.c.green("✓") : ch.status === "warn" ? ctx.c.yellow("!") : ch.status === "fail" ? ctx.c.red("✗") : ctx.c.dim("-");
          print(`${icon} ${ch.name.padEnd(18)} ${ch.detail}`);
          if (ch.hint) print(`  ${"".padEnd(18)} ${ctx.c.dim(ch.hint)}`);
        }
        return r.ok ? 0 : 1;
      }),
    );

  // ------------------------------------------------------------------ plans / approve (MCP approvals)
  const plans = program.command("plans").description("plans created by AI agents through the MCP server");
  plans
    .command("list")
    .option("-g, --guild <id>", "only this guild")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const list = ctx.store().listPlans(o.guild).map((p) => ({ id: p.id, guildId: p.guildId, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, origin: p.origin }));
        if (ctx.json) return printJson(list);
        if (!list.length) print("No stored plans.");
        for (const p of list) print(`${p.id}  ${p.status.padEnd(9)} guild ${p.guildId}  created ${p.createdAt}  expires ${p.expiresAt}`);
      }),
    );
  plans
    .command("show <planId>")
    .action(
      run(async (ctx, _o, planId) => {
        const stored = ctx.store().getPlan(planId!);
        if (!stored) throw new DiscordctlError("NOT_FOUND", `No plan ${planId}`);
        if (ctx.json) return printJson({ ...stored, plan: JSON.parse(stored.planJson) });
        print(renderPlan(JSON.parse(stored.planJson) as Plan, ctx.c));
        print(ctx.c.dim(`\nstatus ${stored.status}; expires ${stored.expiresAt}`));
      }),
    );
  program
    .command("approve <planId>")
    .description("approve a plan proposed by an AI agent (out-of-band human confirmation)")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(
      run(async (ctx, o: { yes?: boolean }, planId) => {
        const store = ctx.store();
        const stored = store.getPlan(planId!);
        if (!stored) throw new DiscordctlError("NOT_FOUND", `No plan ${planId}`);
        if (stored.status !== "pending") throw new DiscordctlError("PLAN_NOT_PENDING", `Plan ${planId} is ${stored.status}`);
        if (new Date(stored.expiresAt) < new Date()) throw new DiscordctlError("PLAN_EXPIRED", `Plan ${planId} expired at ${stored.expiresAt}`, { hint: "Ask the agent to create a new plan." });
        const plan = JSON.parse(stored.planJson) as Plan;
        if (!ctx.json) print(renderPlan(plan, ctx.c));
        if (!o.yes) {
          if (!isInteractive()) throw new DiscordctlError("NEEDS_CONFIRMATION", "Run interactively or pass --yes");
          const answer = await ask(`\nApprove plan ${planId} for "${plan.guildName}"? Only "yes" is accepted: `);
          if (answer !== "yes") return void print("Not approved.");
        }
        store.setPlanStatus(planId!, "approved", `cli:${process.env.USER ?? "user"}`);
        store.audit({ guildId: stored.guildId, actor: "cli", action: "approve", planId: planId!, opId: null, status: "approved", details: "{}" });
        if (ctx.json) return printJson({ approved: planId });
        print(ctx.c.green(`✓ Approved ${planId}. The agent can now call discord_apply_plan before ${stored.expiresAt}.`));
      }),
    );
  program
    .command("reject <planId>")
    .description("reject a plan proposed by an AI agent")
    .action(
      run(async (ctx, _o, planId) => {
        const store = ctx.store();
        if (!store.getPlan(planId!)) throw new DiscordctlError("NOT_FOUND", `No plan ${planId}`);
        store.setPlanStatus(planId!, "rejected");
        if (ctx.json) return printJson({ rejected: planId });
        print(`Rejected ${planId}.`);
      }),
    );

  // ------------------------------------------------------------------ state
  const state = program.command("state").description("inspect and repair local state (logical key ↔ Discord ID mappings)");
  state
    .command("list")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const guild = resolveGuild(ctx, o.guild);
        const m = ctx.store().getMappings(guild);
        if (ctx.json) return printJson(m);
        if (!m.length) print("No state for this guild.");
        for (const x of m) print(`${x.kind.padEnd(8)} ${x.key.padEnd(28)} ${x.discordId}  ${ctx.c.dim(x.name)}`);
      }),
    );
  state
    .command("rm <key>")
    .description("stop tracking a resource (does not touch Discord)")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .addOption(new Option("--kind <kind>", "resource kind").choices(["role", "channel"]).default("channel"))
    .action(
      run(async (ctx, o: { guild?: string; kind: "role" | "channel" }, key) => {
        const guild = resolveGuild(ctx, o.guild);
        const removed = ctx.store().unbind(guild, o.kind, key!);
        if (ctx.json) return printJson({ removed });
        print(removed ? `Removed ${o.kind} ${key} from state.` : `No ${o.kind} ${key} in state.`);
      }),
    );
  state
    .command("refresh")
    .description("drop mappings whose Discord resource no longer exists")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const guild = resolveGuild(ctx, o.guild);
        const s = await ctx.service().snapshot(guild);
        const ids = new Set([...s.roles.map((r) => r.id), ...s.channels.map((c) => c.id)]);
        const stale = ctx.store().getMappings(guild).filter((m) => !ids.has(m.discordId));
        for (const m of stale) ctx.store().unbind(guild, m.kind, m.key);
        if (ctx.json) return printJson({ removed: stale });
        print(stale.length ? `Removed ${stale.length} stale mapping(s): ${stale.map((m) => m.key).join(", ")}` : "State is consistent with Discord.");
      }),
    );
  state
    .command("export")
    .description("back up state for a guild as JSON")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const guild = resolveGuild(ctx, o.guild);
        printJson(ctx.store().exportGuild(guild));
      }),
    );
  state
    .command("restore <file>")
    .description("restore state from a JSON backup")
    .option("--replace", "replace existing state for the guild")
    .action(
      run(async (ctx, o: { replace?: boolean }, file) => {
        const data = JSON.parse(readFileSync(file!, "utf8"));
        const n = ctx.store().importGuild(data, Boolean(o.replace));
        if (ctx.json) return printJson({ restored: n });
        print(`Restored ${n} mapping(s) for guild ${data.guildId}.`);
      }),
    );
  state
    .command("reset")
    .description("forget all state for a guild (does not touch Discord; re-run import afterwards)")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .option("-y, --yes", "skip confirmation")
    .action(
      run(async (ctx, o: { guild?: string; yes?: boolean }) => {
        const guild = resolveGuild(ctx, o.guild);
        if (!o.yes) {
          if (!isInteractive()) throw new DiscordctlError("NEEDS_CONFIRMATION", "Pass --yes");
          if ((await ask(`Forget all state for guild ${guild}? Type "yes": `)) !== "yes") return;
        }
        const n = ctx.store().clearGuild(guild);
        if (ctx.json) return printJson({ removed: n });
        print(`Removed ${n} mapping(s). Run \`${PRODUCT_NAME} import --config <file>\` to rebuild state.`);
      }),
    );
  state
    .command("unlock")
    .description("release a stale apply lock")
    .option("-g, --guild <id>", "guild ID (default: $DISCORD_GUILD_ID)")
    .action(
      run(async (ctx, o: { guild?: string }) => {
        const guild = resolveGuild(ctx, o.guild);
        ctx.store().releaseLock(guild);
        if (ctx.json) return printJson({ unlocked: guild });
        print(`Released lock for ${guild}.`);
      }),
    );

  // ------------------------------------------------------------------ history / schema
  program
    .command("history")
    .description("show the local audit log of applied changes")
    .option("-g, --guild <id>", "only this guild")
    .option("-n, --limit <n>", "entries", "30")
    .action(
      run(async (ctx, o: { guild?: string; limit: string }) => {
        const entries = ctx.store().auditLog(o.guild, Number(o.limit));
        if (ctx.json) return printJson(entries);
        if (!entries.length) print("No history.");
        for (const e of entries) print(`${e.ts}  ${e.actor.padEnd(4)} ${e.status.padEnd(8)} ${e.action}${e.planId ? ctx.c.dim(` (${e.planId})`) : ""}`);
      }),
    );
  program
    .command("schema")
    .description("print the configuration JSON Schema (for editors and AI agents)")
    .action(
      run(async () => {
        printJson(configJsonSchema());
      }),
    );

  return program;
}

function summarizeDesired(d: { roles: unknown[]; categories: unknown[]; channels: unknown[] }) {
  return { roles: d.roles.length, categories: d.categories.length, channels: d.channels.length };
}

