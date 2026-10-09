import type { Diagnostic } from "../core/diagnostics.js";
import type { ManualStep } from "../core/model.js";
import type { ResourceKind } from "../state/store.js";

/**
 * Plans are plain JSON (bigints encoded as decimal strings) so they can be saved to disk,
 * stored for MCP approval, and applied later after a state-fingerprint check.
 */

/** A reference resolved at execution time: an existing Discord ID or a logical key created earlier in the plan. */
export type Ref = { id: string } | { ref: string };

export type OpAction = "create" | "update" | "move" | "delete" | "import";
export type OpResource = "guild" | "everyone" | "role" | "role-order" | "category" | "channel" | "channel-order";
export type Risk = "low" | "medium" | "high" | "critical";

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface WireOverwrite {
  target: Ref;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface WireTag {
  id?: string;
  name: string;
  moderated: boolean;
  emoji_id: string | null;
  emoji_name: string | null;
}

export interface ChannelBody {
  name?: string;
  type?: number;
  parent?: Ref | null;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  bitrate?: number;
  user_limit?: number;
  rtc_region?: string | null;
  video_quality_mode?: number;
  overwrites?: WireOverwrite[];
  available_tags?: WireTag[];
  default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null;
  default_sort_order?: number | null;
  default_forum_layout?: number;
  default_thread_rate_limit_per_user?: number;
  default_auto_archive_duration?: number;
  flags?: number;
}

export interface RoleBody {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
}

export interface GuildBody {
  name?: string;
  description?: string | null;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  afk_timeout?: number;
  afk_channel?: Ref | null;
  system_channel?: Ref | null;
  rules_channel?: Ref | null;
  public_updates_channel?: Ref | null;
}

export type OpPayload =
  | { type: "role.create"; body: RoleBody }
  | { type: "role.update"; roleId: string; body: RoleBody }
  | { type: "role.import"; roleId: string }
  | { type: "role.delete"; roleId: string }
  | { type: "everyone.update"; body: RoleBody }
  | { type: "roles.reorder"; order: Ref[] }
  | { type: "channel.create"; body: ChannelBody; followUp?: ChannelBody }
  | { type: "channel.update"; channelId: string; body: ChannelBody; followUp?: ChannelBody }
  | { type: "channel.import"; channelId: string }
  | { type: "channel.delete"; channelId: string }
  | { type: "channels.reorder"; parent: Ref | null; sortClass: "category" | "text" | "voice"; order: Ref[] }
  | { type: "guild.update"; body: GuildBody };

export interface PlanOp {
  id: string;
  action: OpAction;
  resource: OpResource;
  key: string;
  name: string;
  discordId?: string;
  changes: FieldChange[];
  payload: OpPayload;
  dependsOn: string[];
  risk: Risk;
  riskReasons: string[];
  destructive: boolean;
  /** State binding recorded once the op succeeds. */
  bind?: { kind: ResourceKind; key: string; name: string };
  note?: string;
}

export interface PlanSummary {
  create: number;
  update: number;
  move: number;
  delete: number;
  import: number;
}

export interface Binding {
  kind: ResourceKind;
  key: string;
  id: string;
  name: string;
}

export interface Plan {
  formatVersion: 1;
  id: string;
  guildId: string;
  guildName: string;
  createdAt: string;
  configHash: string;
  /** Hash of the live guild state the plan was computed against. */
  fingerprint: string;
  ops: PlanOp[];
  /** Existing resources matched to config keys (used to resolve refs and refresh state). */
  bindings: Binding[];
  summary: PlanSummary;
  diagnostics: Diagnostic[];
  manualSteps: ManualStep[];
  allowDelete: boolean;
  maxRisk: Risk;
}

export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((m, r) => (RISK_ORDER[r] > RISK_ORDER[m] ? r : m), "low");
}

export function isEmptyPlan(plan: Plan): boolean {
  return plan.ops.length === 0;
}
