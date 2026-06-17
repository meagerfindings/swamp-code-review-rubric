/**
 * Generic code-review engine: given a grading rubric and a list of PR numbers,
 * produce one graded-review data artifact per PR by delegating the actual LLM
 * call to `@mgreten/cli-agent`'s `invokeAndParse`.
 *
 * PR state is irrelevant — the engine grades whatever PR numbers it is handed
 * (open, merged, or closed). The common consumer pattern is retrospective
 * grading of *merged* PRs to track quality over time (e.g. an OOP-review
 * tracker), but nothing here requires that.
 *
 * This model knows NOTHING about any particular review philosophy, scoring
 * convention, language, or organization. It is the reusable core: the caller
 * injects the rubric (criteria, grading scale, output contract) and the engine
 * fans out the grading. Opinionated rubrics + analytics belong in a consumer
 * model that composes this one.
 *
 * Fan-out by design: `reviewPrs` loops the PR list INTERNALLY in one execution
 * so the per-model lock is acquired once. Each PR's diff is fetched via `gh`,
 * fed through the injected rubric prompt, and the agent's JSON response is
 * validated against the rubric's declared criteria keys.
 *
 * `plannerModel` is REQUIRED (no default) so the consumer must pin the exact
 * model id — the review grade is only comparable across runs if the model is
 * held constant.
 *
 * Prerequisites: the `gh` CLI authenticated for the target repo, and an
 * instance of `@mgreten/cli-agent` reachable as a sibling swamp model.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Schema for shared globalArgs. */
const GlobalArgsSchema = z.object({
  cliAgentModel: z
    .string()
    .default("cli-agent")
    .describe(
      "Name of the @mgreten/cli-agent model instance used to run the review LLM.",
    ),
  repoSlug: z
    .string()
    .describe("GitHub repo (owner/name) to read PR diffs from."),
  plannerProvider: z
    .string()
    .default("claude")
    .describe("cli-agent provider override for the review invocation."),
  plannerModel: z
    .string()
    .describe(
      "cli-agent model id for the review invocation. REQUIRED — pin it so grades stay comparable across runs (e.g. 'claude-opus-4-7').",
    ),
  plannerTimeoutMs: z
    .number()
    .default(300_000)
    .describe("Wall-clock timeout for a single review invocation, in ms."),
  maxDiffBytes: z
    .number()
    .default(40_000)
    .describe("Cap on the PR diff bytes fed to the LLM per PR."),
  swampRepoDir: z
    .string()
    .default(".")
    .describe(
      "Working dir for nested swamp CLI invocations (resolves the @mgreten/cli-agent instance). Defaults to the current directory.",
    ),
});

/** One rubric criterion the LLM must grade. */
const CriterionSchema = z.object({
  key: z.string().describe(
    "Machine key, e.g. 'srp'. Becomes a criteria field.",
  ),
  label: z.string().describe("Human label, e.g. 'Single Responsibility'."),
  guidance: z.string().describe("Grading guidance shown to the LLM."),
});

/** The grading rubric, injected by the consumer model. */
const RubricSchema = z.object({
  name: z.string().describe("Rubric name, e.g. 'Sandi Metz POODR'."),
  promptPreamble: z
    .string()
    .describe("Role + instructions prepended before the PR details and diff."),
  criteria: z
    .array(CriterionSchema)
    .min(1)
    .describe("Ordered list of criteria the LLM grades."),
  gradeScale: z
    .array(z.string())
    .default(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"])
    .describe("Allowed letter grades, high to low."),
  outputContract: z
    .string()
    .describe(
      "Free-text description of the exact JSON shape the LLM must return. Must instruct the LLM to emit `approvals` and `flags` string arrays alongside `grade`, `criteria`, and `key_finding`.",
    ),
});

/**
 * Default letter-grade scale (high to low), plus the `"N/A"` sentinel for a
 * PR that could not be graded or whose LLM grade fell outside the rubric's
 * declared scale. The published `review` resource schema validates `grade` and
 * every criterion value against this closed set — so a hallucinated or
 * off-scale grade normalizes to `"N/A"` in the engine rather than landing as
 * arbitrary text. A rubric MAY declare a custom `gradeScale`; grades outside
 * the default set below still persist as `"N/A"` (honest degradation) so the
 * stored artifact stays CEL-validatable.
 */
const DEFAULT_GRADES = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D",
  "F",
] as const;

/** Allowed values for `grade` and criterion grades on a stored review. */
const GradeSchema = z.enum([...DEFAULT_GRADES, "N/A"]);

/**
 * Output artifact of `reviewPrs` — one per PR. The top-level shape is CLOSED
 * (no passthrough) so the resource is CEL-validatable; `criteria` stays an
 * OPEN record keyed by the rubric's criterion keys, but each VALUE is
 * constrained to the grade set, so any rubric works while values stay
 * deterministic.
 */
const ReviewSchema = z.object({
  prNumber: z.number(),
  title: z.string(),
  author: z.string(),
  mergedAt: z.string().nullable(),
  rubricName: z.string(),
  grade: GradeSchema,
  criteria: z.record(z.string(), GradeSchema),
  keyFinding: z.string(),
  approvals: z.array(z.string()),
  flags: z.array(z.string()),
  filesReviewed: z.number(),
  filesTouched: z.array(z.string()),
  linesChanged: z.number(),
  diffTruncated: z.boolean(),
  invocation: z.object({
    provider: z.string(),
    model: z.string(),
    durationMs: z.number(),
    costUsd: z.number().nullable(),
  }),
  error: z.string().nullable(),
  reviewedAt: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Rubric = z.infer<typeof RubricSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

type CmdResult = {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
};

/** Run a subprocess and capture stdout/stderr/exit-code. */
async function runCmd(args: string[]): Promise<CmdResult> {
  const proc = new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
    success: out.success,
  };
}

/** Metadata for one PR passed in by the consumer. */
const PrInputSchema = z.object({
  number: z.number(),
  title: z.string().default(""),
  author: z.string().default(""),
  mergedAt: z.string().nullable().default(null),
  linesChanged: z.number().default(0),
});

type PrInput = z.infer<typeof PrInputSchema>;

/**
 * Fetch a unified-diff-style summary of changed files for the PR via the gh
 * API (file-by-file metadata + patch text — a denser prompt signal than raw
 * diff).
 */
async function fetchPrDiff(
  repoSlug: string,
  prNumber: number,
  maxBytes: number,
): Promise<
  { diff: string; truncated: boolean; bytes: number; filenames: string[] }
> {
  const res = await runCmd([
    "gh",
    "api",
    `repos/${repoSlug}/pulls/${prNumber}/files`,
    "--paginate",
  ]);
  if (!res.success) {
    throw new Error(
      `gh api pulls/${prNumber}/files failed (exit ${res.code}): ${
        res.stderr.slice(0, 300)
      }`,
    );
  }
  // --paginate yields multiple JSON arrays back-to-back; defensively split.
  const rawText = res.stdout.trim();
  const chunks: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(JSON.parse(rawText.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  const files = chunks.flat() as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  const parts: string[] = [];
  for (const f of files) {
    parts.push(
      `=== ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ===`,
    );
    if (f.patch) parts.push(f.patch);
  }
  const full = parts.join("\n");
  const bytes = full.length;
  const filenames = files.map((f) => f.filename);
  if (bytes <= maxBytes) {
    return { diff: full, truncated: false, bytes, filenames };
  }
  return {
    diff: full.slice(0, maxBytes) +
      `\n\n[…truncated, ${bytes - maxBytes} bytes elided…]`,
    truncated: true,
    bytes,
    filenames,
  };
}

/** Build the full review prompt from the injected rubric + PR diff. */
function buildPrompt(rubric: Rubric, pr: PrInput, diff: string): string {
  const criteriaText = rubric.criteria
    .map((c, i) => `${i + 1}. **${c.label}** (\`${c.key}\`): ${c.guidance}`)
    .join("\n\n");
  return [
    rubric.promptPreamble,
    "",
    "## PR Details",
    "",
    `PR #${pr.number}: ${pr.title}`,
    `Author: ${pr.author || "Unknown"}`,
    "",
    "## Full Diff",
    "",
    diff,
    "",
    "## Evaluation Criteria",
    "",
    `Grade each criterion using this scale (high to low): ${
      rubric.gradeScale.join(", ")
    }.`,
    "",
    criteriaText,
    "",
    "## Response Format",
    "",
    rubric.outputContract,
  ].join("\n");
}

/** Parsed result + telemetry from one cli-agent invocation. */
type InvocationResult = {
  parsed: Record<string, unknown> | null;
  durationMs: number;
  costUsd: number | null;
  provider: string;
  model: string;
  error: string | null;
};

/**
 * Invoke `@mgreten/cli-agent`'s invokeAndParse for one prompt, with a
 * lock-retry loop for transient shared-datastore contention. Returns the
 * parsed JSON response plus invocation telemetry.
 */
async function invokeAgent(
  ga: GlobalArgs,
  prompt: string,
): Promise<InvocationResult> {
  const inputFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    inputFile,
    JSON.stringify({
      prompt,
      provider: ga.plannerProvider,
      model: ga.plannerModel,
      wallTimeoutMs: ga.plannerTimeoutMs,
      tags: { source: "code-review-rubric" },
    }),
  );

  let res: CmdResult = { stdout: "", stderr: "", code: -1, success: false };
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await runCmd([
      "swamp",
      "model",
      "method",
      "run",
      ga.cliAgentModel,
      "invokeAndParse",
      "--input-file",
      inputFile,
      "--json",
      "--repo-dir",
      ga.swampRepoDir,
    ]);
    if (res.success) break;
    const combined = res.stdout + res.stderr;
    if (!/Lock\s+"[^"]*"\s+held by/i.test(combined)) break;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  try {
    await Deno.remove(inputFile);
  } catch { /* cleanup */ }

  if (!res.success) {
    return {
      parsed: null,
      durationMs: 0,
      costUsd: null,
      provider: ga.plannerProvider,
      model: ga.plannerModel,
      error: `cli-agent invocation failed (exit ${res.code}): ${
        res.stderr.slice(0, 400) || res.stdout.slice(0, 400)
      }`,
    };
  }

  let envelope: {
    dataArtifacts?: Array<{ attributes?: Record<string, unknown> }>;
  };
  try {
    envelope = JSON.parse(res.stdout);
  } catch (e) {
    return {
      parsed: null,
      durationMs: 0,
      costUsd: null,
      provider: ga.plannerProvider,
      model: ga.plannerModel,
      error: `failed to parse cli-agent --json envelope: ${
        (e as Error).message
      }`,
    };
  }

  const attrs = envelope.dataArtifacts?.[0]?.attributes ?? null;
  if (!attrs) {
    return {
      parsed: null,
      durationMs: 0,
      costUsd: null,
      provider: ga.plannerProvider,
      model: ga.plannerModel,
      error: "cli-agent envelope had no dataArtifacts",
    };
  }

  const parsedResponse = attrs.parsedResponse as
    | Record<string, unknown>
    | null
    | undefined;
  return {
    parsed: parsedResponse ?? null,
    durationMs: typeof attrs.durationMs === "number" ? attrs.durationMs : 0,
    costUsd: typeof attrs.costUsd === "number" ? attrs.costUsd : null,
    provider: typeof attrs.provider === "string"
      ? attrs.provider
      : ga.plannerProvider,
    model: typeof attrs.model === "string" ? attrs.model : ga.plannerModel,
    error: parsedResponse ? null : "no parseable JSON in agent output",
  };
}

/** Allowed stored grade values (the default scale plus the N/A sentinel). */
type Grade = z.infer<typeof GradeSchema>;

const GRADE_SET = new Set<string>([...DEFAULT_GRADES, "N/A"]);

/**
 * Coerce an arbitrary LLM grade to a value the `review` schema accepts. Any
 * grade outside the default scale (a hallucination, or a rubric's custom
 * non-default scale) normalizes to `"N/A"` so the stored artifact stays
 * deterministic and CEL-validatable rather than carrying free text.
 */
function coerceGrade(raw: unknown): Grade {
  return (typeof raw === "string" && GRADE_SET.has(raw.trim()))
    ? raw.trim() as Grade
    : "N/A";
}

/**
 * Coerce the LLM's criteria object to a record over the rubric's criterion
 * keys, with each value normalized to an accepted grade (missing or off-scale
 * → `"N/A"`).
 */
function normalizeCriteria(
  raw: unknown,
  rubric: Rubric,
): Record<string, Grade> {
  const out: Record<string, Grade> = {};
  const obj = (raw && typeof raw === "object")
    ? raw as Record<string, unknown>
    : {};
  for (const c of rubric.criteria) {
    out[c.key] = coerceGrade(obj[c.key]);
  }
  return out;
}

/** Filter an unknown value down to a string array, dropping non-strings. */
function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * The code-review-rubric model: a single fan-out method that grades each PR in
 * a list against a caller-injected rubric, delegating the LLM call to
 * `@mgreten/cli-agent` and writing one `review` artifact per PR.
 */
export const model = {
  type: "@mgreten/code-review-rubric",
  version: "2026.06.17.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    review: {
      description:
        "A single PR graded against the injected rubric. One artifact per PR.",
      schema: ReviewSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    reviewPrs: {
      description:
        "Fan-out: grade each PR in `prs` against `rubric` via cli-agent, writing one review artifact per PR in a single execution.",
      arguments: z.object({
        prs: z
          .array(PrInputSchema)
          .min(1)
          .describe(
            "PR metadata to review (number + title/author/mergedAt/lines).",
          ),
        rubric: RubricSchema,
      }),
      execute: async (
        args: { prs: PrInput[]; rubric: Rubric },
        context: MethodContext,
      ): Promise<{ dataHandles: Array<Record<string, unknown>> }> => {
        const ga = context.globalArgs;
        const { prs, rubric } = args;
        const handles: Array<Record<string, unknown>> = [];

        for (const pr of prs) {
          let diffResult: Awaited<ReturnType<typeof fetchPrDiff>>;
          try {
            diffResult = await fetchPrDiff(
              ga.repoSlug,
              pr.number,
              ga.maxDiffBytes,
            );
          } catch (e) {
            context.logger.error("diff fetch failed for PR {n}: {err}", {
              n: pr.number,
              err: (e as Error).message,
            });
            const handle = await context.writeResource(
              "review",
              `review-${pr.number}`,
              {
                prNumber: pr.number,
                title: pr.title,
                author: pr.author,
                mergedAt: pr.mergedAt,
                rubricName: rubric.name,
                grade: "N/A",
                criteria: normalizeCriteria(null, rubric),
                keyFinding: "",
                approvals: [],
                flags: [],
                filesReviewed: 0,
                filesTouched: [],
                linesChanged: pr.linesChanged,
                diffTruncated: false,
                invocation: {
                  provider: ga.plannerProvider,
                  model: ga.plannerModel,
                  durationMs: 0,
                  costUsd: null,
                },
                error: `diff fetch failed: ${(e as Error).message}`,
                reviewedAt: new Date().toISOString().slice(0, 10),
              },
            );
            handles.push(handle);
            continue;
          }

          const prompt = buildPrompt(rubric, pr, diffResult.diff);
          const inv = await invokeAgent(ga, prompt);
          const parsed = inv.parsed ?? {};
          const grade = coerceGrade(parsed.grade);
          const filesReviewed = typeof parsed.files_reviewed === "number"
            ? parsed.files_reviewed
            : diffResult.filenames.length;

          context.logger.info("reviewed PR {n}: grade {g} ({ms}ms)", {
            n: pr.number,
            g: grade,
            ms: inv.durationMs,
          });

          const handle = await context.writeResource(
            "review",
            `review-${pr.number}`,
            {
              prNumber: pr.number,
              title: pr.title,
              author: pr.author,
              mergedAt: pr.mergedAt,
              rubricName: rubric.name,
              grade,
              criteria: normalizeCriteria(parsed.criteria, rubric),
              keyFinding: typeof parsed.key_finding === "string"
                ? parsed.key_finding
                : "",
              approvals: asStringArray(parsed.approvals),
              flags: asStringArray(parsed.flags),
              filesReviewed,
              filesTouched: diffResult.filenames,
              linesChanged: pr.linesChanged,
              diffTruncated: diffResult.truncated,
              invocation: {
                provider: inv.provider,
                model: inv.model,
                durationMs: inv.durationMs,
                costUsd: inv.costUsd,
              },
              error: inv.error,
              reviewedAt: new Date().toISOString().slice(0, 10),
            },
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },
  },
};
