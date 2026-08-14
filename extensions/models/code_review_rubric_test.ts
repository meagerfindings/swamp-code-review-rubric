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
import {
  extractDispatch,
  model,
  resolveDispatch,
} from "./code_review_rubric.ts";

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

Deno.test("reviewPrs isolates a per-PR write failure: the rest of the batch still gets graded", async () => {
  const agentEnvelope = JSON.stringify({
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
  });
  const swampStub: CmdStub = {
    match: (args) => args[0] === "swamp" && args.includes("invokeAndParse"),
    stdout: agentEnvelope,
    code: 0,
  };

  const written: WrittenResource[] = [];
  const noop = (_msg: string, _props?: Record<string, unknown>) => {};
  let calls = 0;
  const context = {
    globalArgs: GLOBAL_ARGS,
    logger: { info: noop, warning: noop, error: noop },
    writeResource: (
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ) => {
      calls++;
      // Simulate a write failure for the first PR only (e.g. a transient
      // datastore error) — the second PR's grading must not be skipped.
      if (calls === 1) {
        throw new Error("simulated datastore write failure");
      }
      written.push({ specName, instanceName, data });
      return Promise.resolve({ name: instanceName });
    },
  };

  await withMockedCommand([ghFilesStub, swampStub], async () => {
    const res = await model.methods.reviewPrs.execute(
      {
        prs: [
          { number: 1, title: "one", author: "a", mergedAt: null, linesChanged: 3 },
          { number: 2, title: "two", author: "b", mergedAt: null, linesChanged: 4 },
        ],
        rubric: RUBRIC,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    // PR 1's success-path write throws once, caught, then the error-path
    // write for PR 1 succeeds; PR 2's success-path write also succeeds.
    assertEquals(res.dataHandles.length, 2);
  });
  assertEquals(written.length, 2);
  const byPr = new Map(written.map((w) => [w.instanceName, w.data]));
  assertEquals(byPr.get("review-1")?.grade, "N/A");
  assertEquals(
    (byPr.get("review-1")?.error as string).includes(
      "simulated datastore write failure",
    ),
    true,
  );
  assertEquals(byPr.get("review-2")?.grade, "A");
});

// --- Provider catalog read --------------------------------------------------
//
// This model defaults the catalog OFF (`useProviderCatalog: false`) because
// `plannerModel` is pinned so grades stay comparable across runs. These cover
// the opt-in read, the default-off behavior, and every fail-open path — a broken
// catalog must never take a grading run down.

/** Global args with the catalog opted IN, as an instance would parse them. */
function catalogGlobalArgs(overrides: Record<string, unknown> = {}) {
  return model.globalArguments.parse({
    ...GLOBAL_ARGS,
    useProviderCatalog: true,
    ...overrides,
  });
}

/**
 * A fake MethodContext exposing only `runModel`, recording each call so a test
 * can assert the catalog was (or was NOT) consulted.
 */
function makeRunModelContext(
  impl: (options: { definition: string; method: string }) => unknown,
): {
  context: unknown;
  calls: Array<{ definition: string; method: string; arguments?: unknown }>;
} {
  const calls: Array<
    { definition: string; method: string; arguments?: unknown }
  > = [];
  const context = {
    runModel: (
      options: { definition: string; method: string; arguments?: unknown },
    ) => {
      calls.push(options);
      return Promise.resolve(impl(options));
    },
  };
  return { context, calls };
}

Deno.test("extractDispatch reads provider/model out of a dispatch payload", () => {
  // The parsing contract, tested directly on the function that owns it. Going
  // through resolveDispatch for this would require faking a runModel shape the
  // real runtime never produces (see the next test).
  assertEquals(
    extractDispatch([{
      name: "agent-dispatch-pr-1234-rubric-1",
      attributes: { provider: "codex", model: "gpt-5-codex", tier: 0 },
    }]),
    { provider: "codex", model: "gpt-5-codex" },
  );
});

Deno.test("resolveDispatch does not trust runModel's payload for the values", async () => {
  // REGRESSION GUARD. runModel resolves to {ok, resources:[{specName, name}]} —
  // resource NAMES ONLY, never `attributes`. An earlier version read
  // extractDispatch(run.resources) and RETURNED it, so the in-process path
  // always yielded null and the catalog silently never applied. The fix is to
  // treat an empty in-process read as "fall through to the shellout", not as a
  // final answer.
  //
  // This asserts the realistic shape produces no premature null-return: with
  // runModel returning name-only resources, resolveDispatch must NOT resolve to
  // a value derived from them. (It proceeds to the shellout, which in a unit
  // test has no catalog to reach and so fails open to null.)
  const { context, calls } = makeRunModelContext(() => ({
    ok: true,
    resources: [
      { specName: "agentDispatch", name: "agent-dispatch-pr-1234-rubric-1" },
    ],
  }));
  const dispatch = await resolveDispatch(
    catalogGlobalArgs(),
    // deno-lint-ignore no-explicit-any
    context as any,
    "pr-1234",
    "rubric",
  );
  // Not a value invented from the name-only payload.
  assertEquals(dispatch, null);
  // And it did ask the catalog, with the right role.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].definition, "provider-catalog");
  assertEquals(calls[0].method, "resolveAgentDispatch");
  assertEquals((calls[0].arguments as Record<string, unknown>).role, "rubric");
});

Deno.test("extractDispatch scans past non-dispatch entries instead of indexing [0]", () => {
  assertEquals(
    extractDispatch([
      { name: "catalog-audit", attributes: { note: "audited" } },
      { name: "no-attributes" },
      {
        name: "agent-dispatch-pr-1234-rubric-1",
        attributes: { provider: "codex", model: "gpt-5-codex" },
      },
    ]),
    { provider: "codex", model: "gpt-5-codex" },
  );
});

Deno.test("resolveDispatch fails open (null) when runModel throws", async () => {
  const { context } = makeRunModelContext(() => {
    throw new Error("provider-catalog not found");
  });
  assertEquals(
    await resolveDispatch(
      catalogGlobalArgs(),
      // deno-lint-ignore no-explicit-any
      context as any,
      "pr-1234",
      "rubric",
    ),
    null,
  );
});

Deno.test("resolveDispatch fails open (null) on an ok:false catalog result", async () => {
  const { context } = makeRunModelContext(() => ({
    ok: false,
    error: { message: 'unknown role "rubric"' },
  }));
  assertEquals(
    await resolveDispatch(
      catalogGlobalArgs(),
      // deno-lint-ignore no-explicit-any
      context as any,
      "pr-1234",
      "rubric",
    ),
    null,
  );
});

Deno.test("extractDispatch rejects a payload missing model", () => {
  assertEquals(
    extractDispatch([{
      name: "agent-dispatch",
      attributes: { provider: "codex" },
    }]),
    null,
  );
});

Deno.test("resolveDispatch does not consult the catalog when useProviderCatalog is false", async () => {
  const ga = catalogGlobalArgs({ useProviderCatalog: false });
  const { context, calls } = makeRunModelContext(() => ({
    ok: true,
    resources: [{ attributes: { provider: "codex", model: "gpt-5-codex" } }],
  }));
  assertEquals(
    // deno-lint-ignore no-explicit-any
    await resolveDispatch(ga, context as any, "pr-1234", "rubric"),
    null,
  );
  assertEquals(calls.length, 0);
});

Deno.test("extractDispatch ignores non-array and empty payloads", () => {
  assertEquals(extractDispatch(undefined), null);
  assertEquals(extractDispatch(null), null);
  assertEquals(extractDispatch({}), null);
  assertEquals(extractDispatch([]), null);
});

Deno.test("global args default the catalog OFF so pinned grades stay comparable", () => {
  const parsed = model.globalArguments.parse({
    repoSlug: "owner/name",
    plannerModel: "claude-opus-4-7",
  });
  assertEquals(parsed.useProviderCatalog, false);
  assertEquals(parsed.providerCatalogModel, "provider-catalog");
  assertEquals(parsed.catalogRole, "rubric");
  // The pinned values stay intact as the fail-open fallback.
  assertEquals(parsed.plannerProvider, "claude");
  assertEquals(parsed.plannerModel, "claude-opus-4-7");
});

Deno.test("reviewPrs records the catalog's provider/model on the review when opted in", async () => {
  // The cli-agent envelope omits provider/model, so the stored invocation
  // reflects exactly what the engine decided to invoke with.
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
          durationMs: 10,
          costUsd: null,
        },
      }],
    }),
    code: 0,
  };

  // The catalog is reached over the SHELLOUT, because that is the only
  // transport that returns attributes — runModel yields resource names only.
  // Stubbing it here (rather than faking a runModel payload with `attributes`)
  // is what makes this test exercise the path production actually takes.
  const catalogStub: CmdStub = {
    match: (args) =>
      args[0] === "swamp" && args.includes("resolveAgentDispatch"),
    stdout: JSON.stringify({
      dataArtifacts: [{
        attributes: {
          workItem: "pr-5",
          role: "rubric",
          catalogRole: "reviewer",
          tier: 0,
          provider: "codex",
          model: "gpt-5-codex",
          disposition: "initial",
        },
      }],
    }),
    code: 0,
  };

  // No runModel on the context: forces the shellout transport.
  const { context, written } = makeContext(catalogGlobalArgs());

  await withMockedCommand([ghFilesStub, catalogStub, swampStub], async () => {
    await model.methods.reviewPrs.execute(
      {
        prs: [{
          number: 5,
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
  assertEquals(written[0].data.invocation, {
    provider: "codex",
    model: "gpt-5-codex",
    durationMs: 10,
    costUsd: null,
  });
});

Deno.test("reviewPrs keeps the pinned provider/model when the catalog fails", async () => {
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
          durationMs: 10,
          costUsd: null,
        },
      }],
    }),
    code: 0,
  };

  const { context: base, written } = makeContext(catalogGlobalArgs());
  const context = {
    ...(base as Record<string, unknown>),
    runModel: () => {
      throw new Error("provider-catalog unreachable");
    },
  };

  await withMockedCommand([ghFilesStub, swampStub], async () => {
    await model.methods.reviewPrs.execute(
      {
        prs: [{
          number: 6,
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
  assertEquals(
    (written[0].data.invocation as Record<string, unknown>).provider,
    "claude",
  );
  assertEquals(
    (written[0].data.invocation as Record<string, unknown>).model,
    "claude-opus-4-7",
  );
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
