# @mgreten/code-review-rubric

A generic, philosophy-agnostic code-review engine for swamp. Given a grading
**rubric** (criteria, grade scale, output contract) and a list of pull
requests, it grades each PR and writes one structured `review` artifact per PR.
PR state is irrelevant — the engine grades whatever PR numbers you hand it
(open, merged, or closed); retrospective grading of *merged* PRs is just the
common consumer pattern.
The model knows nothing about any particular review philosophy, scoring
convention, language, or organization — the caller injects the rubric, and the
engine fans the grading out across the PR list in a single execution. The actual
LLM call is delegated to [`@mgreten/cli-agent`](https://github.com/meagerfindings/swamp-cli-agent),
so the same review can run against any provider/model that `cli-agent` supports.

This is the reusable core. Opinionated rubrics (e.g. a Sandi Metz / POODR
ruleset), discovery defaults, and cross-PR analytics belong in a *consumer*
model that composes this one and passes its own `rubric`.

## Installation

```bash
swamp extension pull @mgreten/code-review-rubric
swamp extension pull @mgreten/cli-agent
```

## Setup

Create an instance, pinning the model so grades stay comparable across runs.
You also need a reachable `@mgreten/cli-agent` instance (default name
`cli-agent`).

```bash
swamp model create @mgreten/code-review-rubric code-review-rubric
swamp model edit code-review-rubric   # fill globalArguments below
```

```yaml
# globalArguments
repoSlug: "owner/name"          # GitHub repo to read PR diffs from
plannerModel: "claude-opus-4-7" # REQUIRED — pin it
plannerProvider: "claude"
cliAgentModel: "cli-agent"      # name of your @mgreten/cli-agent instance
```

## Usage

Call `reviewPrs` with a list of PRs and a rubric. The rubric's `outputContract`
must instruct the LLM to return a JSON object carrying `grade`, a `criteria`
object keyed by your criterion keys, `key_finding`, and `approvals` / `flags`
string arrays.

```bash
swamp model method run code-review-rubric reviewPrs --input-file review.json
```

```json
{
  "prs": [
    { "number": 1234, "title": "Add invoicing", "author": "alice", "linesChanged": 180 }
  ],
  "rubric": {
    "name": "Example rubric",
    "promptPreamble": "You are a code reviewer. Grade this merged PR's diff.",
    "criteria": [
      { "key": "srp", "label": "Single Responsibility", "guidance": "One reason to change?" },
      { "key": "naming", "label": "Naming", "guidance": "Intention-revealing names?" }
    ],
    "outputContract": "Return ONLY JSON: {\"grade\":\"B+\",\"criteria\":{\"srp\":\"A-\",\"naming\":\"B\"},\"key_finding\":\"...\",\"approvals\":[\"...\"],\"flags\":[\"...\"],\"files_reviewed\":3}"
  }
}
```

## Global Arguments

| Argument           | Type     | Default     | Purpose |
|--------------------|----------|-------------|---------|
| `repoSlug`         | string   | _(required)_ | GitHub `owner/name` to read PR diffs from. |
| `plannerModel`     | string   | _(required)_ | `cli-agent` model id. Pin it so grades stay comparable. |
| `plannerProvider`  | string   | `claude`    | `cli-agent` provider override. |
| `cliAgentModel`    | string   | `cli-agent` | Name of the `@mgreten/cli-agent` instance to invoke. |
| `plannerTimeoutMs` | number   | `300000`    | Wall-clock timeout for one review invocation, in ms. |
| `maxDiffBytes`     | number   | `40000`     | Cap on the PR diff bytes fed to the LLM per PR. |
| `swampRepoDir`     | string   | `.`         | Working dir for nested swamp CLI calls (resolves the `cli-agent` instance). |

## Method: reviewPrs

Fan-out: grades each PR in `prs` against `rubric` and writes one `review`
artifact per PR in a single execution (the per-model lock is acquired once).

| Argument | Type | Purpose |
|----------|------|---------|
| `prs`    | array | PR metadata: `{ number, title?, author?, mergedAt?, linesChanged? }`. |
| `rubric` | object | `{ name, promptPreamble, criteria[], gradeScale?, outputContract }`. |

Each `review` artifact carries: `grade`, a `criteria` record (your keys →
grade), `keyFinding`, `approvals[]`, `flags[]`, `filesReviewed`,
`filesTouched[]`, `linesChanged`, `diffTruncated`, `invocation` telemetry
(`provider`/`model`/`durationMs`/`costUsd`), and `error` (null on success).

`grade` and every `criteria` value are constrained to the letter-grade scale
(`A+`…`F`) plus an `"N/A"` sentinel: an LLM grade outside that set normalizes to
`"N/A"` rather than landing as free text, so stored reviews stay deterministic
and CEL-queryable. (A rubric may declare a custom `gradeScale` in its prompt,
but grades outside the default letter set persist as `"N/A"`.)

## How It Works

For each PR, the engine fetches a file-by-file diff via `gh api
repos/<slug>/pulls/<n>/files`, builds a prompt from the injected rubric, and
calls `@mgreten/cli-agent`'s `invokeAndParse` (with a short retry loop on
transient datastore-lock contention). The agent's JSON response is validated
against the rubric's declared criteria keys and written as a `review` artifact.

Prerequisites:

- The `gh` CLI authenticated for the target repo.
- A reachable `@mgreten/cli-agent` instance (named by `cliAgentModel`).

## License

MIT — see LICENSE for details.
