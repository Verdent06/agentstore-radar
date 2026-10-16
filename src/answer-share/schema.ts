import { z } from "zod";

export const ProviderNameSchema = z.enum(["openai", "anthropic", "gemini", "xai"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;
export const PROVIDER_NAMES = ProviderNameSchema.options;

export const PromptCategorySchema = z.enum([
  "coding",
  "travel",
  "finance",
  "productivity",
  "design",
  "data",
  "marketing",
  "education",
  "shopping",
  "health",
  "devops",
]);
export type PromptCategory = z.infer<typeof PromptCategorySchema>;
export const PROMPT_CATEGORIES = PromptCategorySchema.options;

export const PromptSchema = z.object({
  id: z.string(),
  category: PromptCategorySchema,
  text: z.string().min(1),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptSetSchema = z.object({
  version: z.string(),
  prompts: z.array(PromptSchema),
});
export type PromptSet = z.infer<typeof PromptSetSchema>;

export const MatchMethodSchema = z.enum(["exact", "alias", "fuzzy"]);
export type MatchMethod = z.infer<typeof MatchMethodSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  web_search_calls: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof UsageSchema>;

export const RawResponseRecordSchema = z.object({
  prompt_id: z.string(),
  category: PromptCategorySchema,
  provider: ProviderNameSchema,
  run: z.number().int().positive(),
  model: z.string(),
  settings: z.record(z.unknown()),
  timestamp: z.string(),
  text: z.string(),
  raw: z.unknown(),
  usage: UsageSchema.optional(),
  error: z.string().optional(),
});
export type RawResponseRecord = z.infer<typeof RawResponseRecordSchema>;

export const ExtractedMentionSchema = z.object({
  prompt_id: z.string(),
  category: PromptCategorySchema,
  provider: ProviderNameSchema,
  run: z.number().int().positive(),
  name: z.string(),
  rank: z.number().int().positive(),
  reason: z.string().optional(),
});
export type ExtractedMention = z.infer<typeof ExtractedMentionSchema>;

export const NormalizedMentionSchema = ExtractedMentionSchema.extend({
  matched_app_id: z.string().nullable(),
  match_method: MatchMethodSchema.nullable(),
  match_score: z.number().min(0).max(1).nullable(),
});
export type NormalizedMention = z.infer<typeof NormalizedMentionSchema>;

export const ProviderRunSchema = z.object({
  provider: ProviderNameSchema,
  ran: z.boolean(),
  skipped: z.boolean(),
  skipReason: z.string().optional(),
  model: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
  calls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  costEstimateUsd: z.number().nonnegative(),
  costActualUsd: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  webSearchCalls: z.number().nonnegative(),
});
export type ProviderRun = z.infer<typeof ProviderRunSchema>;

export const AnswerShareManifestSchema = z.object({
  probeDate: z.string(),
  collectedAt: z.string(),
  promptVersion: z.string(),
  n: z.number().int().positive(),
  maxCalls: z.number().int().nonnegative().nullable(),
  callsMade: z.number().int().nonnegative(),
  truncated: z.boolean(),
  providers: z.array(ProviderRunSchema),
  ran: z.array(ProviderNameSchema),
  skipped: z.array(ProviderNameSchema),
  promptCount: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative(),
  matchedMentionCount: z.number().int().nonnegative(),
  costEstimateUsd: z.number().nonnegative(),
  costActualUsd: z.number().nonnegative(),
});
export type AnswerShareManifest = z.infer<typeof AnswerShareManifestSchema>;

export const AnswerShareRowSchema = z.object({
  name: z.string(),
  matched_app_id: z.string().nullable(),
  provider: ProviderNameSchema.nullable(),
  category: PromptCategorySchema.nullable(),
  mention_count: z.number().int().nonnegative(),
  run_count: z.number().int().nonnegative(),
  eligible_runs: z.number().int().nonnegative(),
  answer_share: z.number().min(0).max(1),
  run_share: z.number().min(0).max(1),
});
export type AnswerShareRow = z.infer<typeof AnswerShareRowSchema>;

export const PromptVarianceSchema = z.object({
  prompt_id: z.string(),
  provider: ProviderNameSchema,
  runs: z.number().int().nonnegative(),
  mean_jaccard: z.number().min(0).max(1).nullable(),
});
export type PromptVariance = z.infer<typeof PromptVarianceSchema>;

export const AnswerShareSnapshotSchema = z.object({
  probeDate: z.string(),
  promptVersion: z.string(),
  shares: z.array(AnswerShareRowSchema),
  variance: z.array(PromptVarianceSchema),
  meanJaccard: z.number().min(0).max(1).nullable(),
});
export type AnswerShareSnapshot = z.infer<typeof AnswerShareSnapshotSchema>;
