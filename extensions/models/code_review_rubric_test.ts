/**
 * Unit tests for @mgreten/code-review-rubric.
 *
 * The model shells out to `gh` (PR diff) and `swamp ... invokeAndParse`
 * (the LLM call). We mock `Deno.Command` and route by argv: `gh api` returns a
 * files JSON array; a `swamp` invocation returns a cli-agent `dataArtifacts`
 * envelope. `model.methods.reviewPrs.execute` is invoked directly with a fake
 * context that captures `writeResource` calls.
 *
 * Covers the success path (a PR is graded and written) and the failure path
 * (diff fetch fails → an error artifact is still written, fan-out continues).
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { model } from "./code_review_rubric.ts";

type WrittenResource = {
  specName: string;
  instanceName: string;
  data: Record<string, unknown>;
};

/** Build a fake MethodContext capturing every writeResource call. */
function makeContext(
  globalArgs: Record<string, unknown>,
): { context: unknown; written: WrittenResource[] } {
  const written: WrittenResource[] = [];
  const noop = (_msg: string, _props?: Record<string, unknown>) => {};
  const context = {
    globalArgs,
    logger: { info: noop, warning: noop, error: noop },
    writeResource: (
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ specName, instanceName, data });
      return Promise.resolve({ name: instanceName });
    },
  };
  return { context, written };
}

/** A canned subprocess result keyed by how the argv is matched. */
type CmdStub = {
  match: (args: string[]) => boolean;
  stdout: string;
  code: number;
};

/**
 * Install a `Deno.Command` mock for the duration of `fn`, routing each spawn to
 * the first matching stub. Restores the real constructor afterward.
 */
async function withMockedCommand(
  stubs: CmdStub[],
  fn: () => Promise<void>,
): Promise<void> {
  const real = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #args: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#args = [cmd, ...(opts?.args ?? [])];
    }
    output() {
      const stub = stubs.find((s) => s.match(this.#args));
      const stdout = stub ? stub.stdout : "";
      const code = stub ? stub.code : 1;
      return Promise.resolve({
        stdout: new TextEncoder().encode(stdout),
        stderr: new TextEncoder().encode(code === 0 ? "" : "stubbed failure"),
        code,
        success: code === 0,
      });
    }
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = real;
  }
}

const RUBRIC = {
  name: "Test rubric",
  promptPreamble: "Grade this PR.",
  criteria: [
    { key: "srp", label: "SRP", guidance: "One reason to change?" },
    { key: "naming", label: "Naming", guidance: "Intention-revealing?" },
  ],
  gradeScale: ["A", "B", "C", "F"],
  outputContract:
    "Return JSON with grade, criteria, key_finding, approvals, flags.",
};

const GLOBAL_ARGS = {
  cliAgentModel: "cli-agent",
  repoSlug: "owner/name",
  plannerProvider: "claude",
  plannerModel: "claude-opus-4-7",
  plannerTimeoutMs: 300_000,
  maxDiffBytes: 40_000,
  swampRepoDir: ".",
};

const ghFilesStub: CmdStub = {
  match: (args) => args[0] === "gh" && args.includes("api"),
  stdout: JSON.stringify([
    {
      filename: "app/foo.rb",
      status: "modified",
      additions: 10,
      deletions: 2,
      patch: "@@ +foo",
    },
  ]),
  code: 0,
};

Deno.test("reviewPrs success path grades a PR and writes a review artifact", async () => {
  const agentEnvelope = JSON.stringify({
    dataArtifacts: [{
      attributes: {
        parsedResponse: {
          grade: "B",
          criteria: { srp: "B", naming: "A" },
          key_finding: "Solid, minor naming nits.",
          approvals: ["clear method names"],
          flags: ["foo.rb doing two things"],
          files_reviewed: 1,
        },
        durationMs: 4200,
        costUsd: 0.012,
        provider: "claude",
        model: "claude-opus-4-7",
      },
    }],
  });
  const swampStub: CmdStub = {
    match: (args) => args[0] === "swamp" && args.includes("invokeAndParse"),
    stdout: agentEnvelope,
    code: 0,
  };

  const { context, written } = makeContext(GLOBAL_ARGS);
  await withMockedCommand([ghFilesStub, swampStub], async () => {
    const res = await model.methods.reviewPrs.execute(
      {
        prs: [{
          number: 1234,
          title: "Add foo",
          author: "alice",
          mergedAt: "2026-06-17",
          linesChanged: 12,
        }],
        rubric: RUBRIC,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(res.dataHandles.length, 1);
  });

  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "review");
  assertEquals(written[0].instanceName, "review-1234");
  assertEquals(written[0].data.grade, "B");
  assertEquals(written[0].data.criteria, { srp: "B", naming: "A" });
  assertEquals(written[0].data.approvals, ["clear method names"]);
  assertEquals(written[0].data.flags, ["foo.rb doing two things"]);
  assertEquals(written[0].data.error, null);
  assertEquals(written[0].data.diffTruncated, false);
  assertEquals(
    (written[0].data.invocation as Record<string, unknown>).costUsd,
    0.012,
  );
});

Deno.test("reviewPrs coerces an off-scale LLM grade to N/A", async () => {
  // The model hallucinates a grade ("Excellent!") and a bogus criterion grade.
  const swampStub: CmdStub = {
    match: (args) => args[0] === "swamp" && args.includes("invokeAndParse"),
    stdout: JSON.stringify({
      dataArtifacts: [{
        attributes: {
          parsedResponse: {
            grade: "Excellent!",
            criteria: { srp: "B", naming: "totally fine" },
            key_finding: "ok",
            approvals: [],
            flags: [],
            files_reviewed: 1,
          },
          durationMs: 50,
          costUsd: null,
          provider: "claude",
          model: "claude-opus-4-7",
        },
      }],
    }),
    code: 0,
  };

  const { context, written } = makeContext(GLOBAL_ARGS);
  await withMockedCommand([ghFilesStub, swampStub], async () => {
    await model.methods.reviewPrs.execute(
      {
        prs: [{
          number: 7,
          title: "x",
          author: "a",
          mergedAt: null,
          linesChanged: 1,
        }],
        rubric: RUBRIC,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  });

  assertEquals(written.length, 1);
  // off-scale top-level grade and off-scale criterion value both normalize
  assertEquals(written[0].data.grade, "N/A");
  assertEquals(written[0].data.criteria, { srp: "B", naming: "N/A" });
});

Deno.test("reviewPrs failure path writes an error artifact when diff fetch fails", async () => {
  const ghFailStub: CmdStub = {
    match: (args) => args[0] === "gh" && args.includes("api"),
    stdout: "",
    code: 1,
  };

  const { context, written } = makeContext(GLOBAL_ARGS);
  await withMockedCommand([ghFailStub], async () => {
    const res = await model.methods.reviewPrs.execute(
      {
        prs: [{
          number: 99,
          title: "Broken",
          author: "bob",
          mergedAt: null,
          linesChanged: 5,
        }],
        rubric: RUBRIC,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(res.dataHandles.length, 1);
  });

  assertEquals(written.length, 1);
  assertEquals(written[0].instanceName, "review-99");
  assertEquals(written[0].data.grade, "N/A");
  // error artifact still carries normalized (N/A) criteria over the rubric keys
  assertEquals(written[0].data.criteria, { srp: "N/A", naming: "N/A" });
  const err = written[0].data.error as string;
  assertEquals(typeof err, "string");
  assertEquals(err.startsWith("diff fetch failed:"), true);
});

Deno.test("reviewPrs fans out: writes one artifact per PR in a single execution", async () => {
  const ghStub: CmdStub = {
    match: (args) => args[0] === "gh" && args.includes("api"),
    stdout: JSON.stringify([
      {
        filename: "a.rb",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ +a",
      },
    ]),
    code: 0,
  };
  const swampStub: CmdStub = {
    match: (args) => args[0] === "swamp" && args.includes("invokeAndParse"),
    stdout: JSON.stringify({
      dataArtifacts: [{
        attributes: {
          parsedResponse: {
            grade: "A",
            criteria: { srp: "A", naming: "A" },
            key_finding: "ok",
            approvals: [],
            flags: [],
            files_reviewed: 1,
          },
          durationMs: 100,
          costUsd: null,
          provider: "claude",
          model: "claude-opus-4-7",
        },
      }],
    }),
    code: 0,
  };

  const { context, written } = makeContext(GLOBAL_ARGS);
  await withMockedCommand([ghStub, swampStub], async () => {
    const res = await model.methods.reviewPrs.execute(
      {
        prs: [
          {
            number: 1,
            title: "one",
            author: "a",
            mergedAt: null,
            linesChanged: 3,
          },
          {
            number: 2,
            title: "two",
            author: "b",
            mergedAt: null,
            linesChanged: 4,
          },
        ],
        rubric: RUBRIC,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(res.dataHandles.length, 2);
  });
  assertEquals(written.length, 2);
  assertEquals(written.map((w) => w.instanceName).sort(), [
    "review-1",
    "review-2",
  ]);
});
