import { expect, test } from "bun:test";
import { ConfigError } from "../errors.ts";
import { gitObjectIdOf } from "../contracts/digest.ts";
import {
  commitUrl,
  gitHubOver,
  rawUrl,
  repositoryUrl,
  treeUrl,
} from "./github.ts";
import { fakeGitHub } from "../test-support/remote.ts";
import { rejectedBy } from "../test-support/assertions.ts";
import type { RemoteClient, TreeBlob } from "./remote.ts";

test("every request is built against the two hosts the tool talks to", () => {
  // The host is never taken from anything the tree says. A declaration that
  // could name it would turn a contract mapping into a way of pointing this
  // tool at any server at all.
  expect(repositoryUrl("ba0918/agentic-workflow")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow",
  );
  expect(commitUrl("ba0918/agentic-workflow", "main")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow/commits/main",
  );
  expect(treeUrl("ba0918/agentic-workflow", "a".repeat(40))).toStrictEqual(
    `https://api.github.com/repos/ba0918/agentic-workflow/git/trees/${"a".repeat(
      40,
    )}?recursive=1`,
  );
  expect(
    rawUrl("ba0918/agentic-workflow", "a".repeat(40), "contracts/tdd.md"),
  ).toStrictEqual(
    `https://raw.githubusercontent.com/ba0918/agentic-workflow/${"a".repeat(
      40,
    )}/contracts/tdd.md`,
  );
});

test("a branch name spelled with a separator keeps its separator in the request", () => {
  // `release/2.x` is a legal branch and may be a repository's default one.
  // Percent-encoded whole, it would name a branch nobody has.
  expect(commitUrl("ba0918/agentic-workflow", "release/2.x")).toStrictEqual(
    "https://api.github.com/repos/ba0918/agentic-workflow/commits/release/2.x",
  );
});

const REVISION = "9f1b7c2d4e5a60718293a4b5c6d7e8f90a1b2c3d";
const REPOSITORY = "ba0918/agentic-workflow";

async function revisionOf(
  client: RemoteClient,
  repository: string,
  ref: string,
): Promise<string> {
  const snapshot = await client.open(repository, { kind: "ref", ref });
  try {
    return snapshot.revision;
  } finally {
    await snapshot.close();
  }
}

async function blobsAt(
  client: RemoteClient,
  repository: string,
  revision: string,
): Promise<TreeBlob[]> {
  const snapshot = await client.open(repository, {
    kind: "pin",
    revision,
    objectFormat: "sha1",
  });
  try {
    return snapshot.blobs;
  } finally {
    await snapshot.close();
  }
}

async function fileAt(
  client: RemoteClient,
  repository: string,
  revision: string,
  path: string,
): Promise<Uint8Array> {
  const snapshot = await client.open(repository, {
    kind: "pin",
    revision,
    objectFormat: "sha1",
  });
  try {
    return await snapshot.fileAt(path);
  } finally {
    await snapshot.close();
  }
}

function workflowRepository() {
  return {
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: {
          "README.md": "# Workflow\n",
          "contracts/tdd-contract.md":
            "# TDD Contract\n\nWrite the test first.\n",
          "contracts/tdd-contract/conformance/cases/first.md": "A case.\n",
        },
      },
    },
  };
}

test("opening a ref returns one snapshot that owns its listing and blob reads", async () => {
  const github = fakeGitHub(workflowRepository());
  const snapshot = await gitHubOver(github.fetch).open(REPOSITORY, {
    kind: "ref",
    ref: "main",
  });

  expect(snapshot.revision).toStrictEqual(REVISION);
  expect(snapshot.objectFormat).toStrictEqual("sha1");
  expect(snapshot.blobs.map((entry) => entry.path)).toStrictEqual([
    "README.md",
    "contracts/tdd-contract.md",
    "contracts/tdd-contract/conformance/cases/first.md",
  ]);
  expect(
    new TextDecoder().decode(
      await snapshot.fileAt("contracts/tdd-contract.md"),
    ),
  ).toStrictEqual("# TDD Contract\n\nWrite the test first.\n");
  await snapshot.close();

  expect(github.requested).toStrictEqual([
    `https://api.github.com/repos/${REPOSITORY}/commits/main`,
    `https://api.github.com/repos/${REPOSITORY}/git/trees/${REVISION}?recursive=1`,
    `https://raw.githubusercontent.com/${REPOSITORY}/${REVISION}/contracts/tdd-contract.md`,
  ]);
});

test("a ref is resolved to the commit it names right now", async () => {
  // The lock records a commit and never a branch, so this is where a moving
  // name is turned into a fixed one — the moment a version is adopted.
  const github = fakeGitHub(workflowRepository());
  expect(
    await revisionOf(gitHubOver(github.fetch), REPOSITORY, "main"),
  ).toStrictEqual(REVISION);
  expect(github.requested).toStrictEqual([
    `https://api.github.com/repos/${REPOSITORY}/commits/main`,
    `https://api.github.com/repos/${REPOSITORY}/git/trees/${REVISION}?recursive=1`,
  ]);
});

test("the branch a repository hands out by default is read from the repository", async () => {
  // `add` records an explicit ref, so the default branch has to be asked for
  // once rather than assumed to be one of the two names that are common.
  const github = fakeGitHub(workflowRepository());
  expect(
    await gitHubOver(github.fetch).defaultBranchOf(REPOSITORY),
  ).toStrictEqual("main");
});

test("the files one commit holds are listed and the directories are left out", async () => {
  // The listing answers two questions offline afterwards: whether a source
  // holds a contract at the conventional position, and which conformance files
  // sit beside it. A directory entry answers neither.
  const github = fakeGitHub(workflowRepository());
  const listed = await blobsAt(gitHubOver(github.fetch), REPOSITORY, REVISION);
  expect(listed.map((entry) => entry.path)).toStrictEqual([
    "README.md",
    "contracts/tdd-contract.md",
    "contracts/tdd-contract/conformance/cases/first.md",
  ]);
});

test("a file is fetched as the bytes the commit holds", async () => {
  const github = fakeGitHub(workflowRepository());
  const bytes = await fileAt(
    gitHubOver(github.fetch),
    REPOSITORY,
    REVISION,
    "contracts/tdd-contract.md",
  );
  expect(new TextDecoder().decode(bytes)).toStrictEqual(
    "# TDD Contract\n\nWrite the test first.\n",
  );
});

test("a listing the service had to cut short is refused rather than read as complete", async () => {
  // A cut-short listing looks exactly like a repository that holds fewer
  // files. Read as complete, a contract's conformance tests would be pinned as
  // absent and the tree would verify clean against a pin that lost them.
  const github = fakeGitHub({
    [REPOSITORY]: { ...workflowRepository()[REPOSITORY], truncated: true },
  });
  const error = await rejectedBy(
    () => blobsAt(gitHubOver(github.fetch), REPOSITORY, REVISION),
    ConfigError,
  );
  expect(error.message).toContain("truncated");
});

test("a request the service did not answer is refused, naming the status", async () => {
  // Read as "the repository holds nothing", a 404 would be reported as a
  // closure gap about a repository the run never reached.
  const github = fakeGitHub(workflowRepository());
  const error = await rejectedBy(
    () => revisionOf(gitHubOver(github.fetch), "ba0918/absent", "main"),
    ConfigError,
  );
  expect(error.message).toContain("404");
});

test("an answer far larger than any contract this tool distributes is refused", async () => {
  // Whatever a host is willing to stream, the run stops reading once the
  // answer has stopped looking like a file a contract would distribute.
  const oversized = "x".repeat(2 * 1024 * 1024);
  const github = fakeGitHub({
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: { [REVISION]: { "contracts/huge.md": oversized } },
    },
  });
  const error = await rejectedBy(
    () =>
      fileAt(
        gitHubOver(github.fetch),
        REPOSITORY,
        REVISION,
        "contracts/huge.md",
      ),
    ConfigError,
  );
  expect(error.message).toContain(
    "too large for a file a contract distributes",
  );
});

test("an answer that is not shaped like the API's own is refused, never guessed at", async () => {
  // A body that parses but says nothing the caller asked for is not an
  // absence: read as one, the run would record an empty revision or a
  // repository with no branches as though the service had said so.
  const shapes = [
    `{"message":"Moved Permanently"}`,
    `{"sha":"not-a-commit-sha"}`,
    `[]`,
  ];
  for (const body of shapes) {
    const transport = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await rejectedBy(
      () => revisionOf(gitHubOver(transport), REPOSITORY, "main"),
      ConfigError,
    );
  }
});

test("a refusal names the rate limit as a cause, never as the cause", async () => {
  // 403 is what the hourly allowance answers with, and it is also what a
  // proxy or an egress filter between the run and the host answers with. A
  // message that named the allowance outright sent a reader to wait out one
  // that was never spent, so the status stands on its own and the allowance
  // is offered beside it.
  for (const status of [403, 429]) {
    const transport = (async () =>
      new Response("", { status })) as unknown as typeof fetch;
    const error = await rejectedBy(
      () => revisionOf(gitHubOver(transport), REPOSITORY, "main"),
      ConfigError,
    );
    expect(error.message).toContain(`answered ${status}`);
    expect(error.message).toContain("rate limited by the hour");
    expect(error.message).toContain("filtering outbound traffic");
  }
});

test("a refusal that is not a refused request carries no rate limit note", async () => {
  const transport = (async () =>
    new Response("", { status: 404 })) as unknown as typeof fetch;
  const error = await rejectedBy(
    () => revisionOf(gitHubOver(transport), REPOSITORY, "main"),
    ConfigError,
  );
  expect(error.message).toContain("answered 404");
  expect(error.message).not.toContain("rate limited");
});

test("a body that is not JSON at all is refused as an unreadable answer", async () => {
  const transport = (async () =>
    new Response("<html>rate limited</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  const error = await rejectedBy(
    () => blobsAt(gitHubOver(transport), REPOSITORY, REVISION),
    ConfigError,
  );
  expect(error.message).toContain("unreadable JSON");
});

test("the listing carries the path a commit gives each entry rather than judging it", async () => {
  // The shape of a path is judged where the run consumes it — as a request
  // URL, as a cache site, or as a position it asks about. Judged here instead,
  // one name a git repository on POSIX legitimately tracks put every contract
  // that source holds out of reach, over a file no run opens.
  const github = fakeGitHub({
    [REPOSITORY]: {
      defaultBranch: "main",
      refs: { main: REVISION },
      files: {
        [REVISION]: {
          "contracts/tdd-contract.md": "# TDD Contract\n",
          "tests/fixtures/windows\\path.txt": "a name a repository may hold\n",
        },
      },
    },
  });

  const listed = await blobsAt(gitHubOver(github.fetch), REPOSITORY, REVISION);

  expect(listed.map((entry) => entry.path)).toStrictEqual([
    "contracts/tdd-contract.md",
    "tests/fixtures/windows\\path.txt",
  ]);
});

test("the listing carries the object id the commit gives each file", async () => {
  // The id is what a download is judged against, so it has to come from the
  // same answer that says the file exists. Asked for separately, the two could
  // describe different commits.
  const github = fakeGitHub(workflowRepository());
  const listed = await blobsAt(gitHubOver(github.fetch), REPOSITORY, REVISION);
  const readme = listed.find((entry) => entry.path === "README.md");
  expect(readme?.objectId).toStrictEqual(
    await gitObjectIdOf(new TextEncoder().encode("# Workflow\n")),
  );
});

test("the listing carries the mode a commit gives each entry rather than judging it", async () => {
  // A listing covers a whole repository, so a mode judged here decides for
  // files the run will never open: one link or one vendored subproject
  // standing anywhere in a source put every contract that source holds out of
  // reach. The mode travels to whoever is about to take the file, and the
  // directories a repository is shaped by are dropped — a directory is not a
  // file this tool takes.
  const github = fakeGitHub({
    [REPOSITORY]: {
      ...workflowRepository()[REPOSITORY],
      modes: {
        "README.md": "160000",
        "contracts/tdd-contract/conformance/cases/first.md": "120000",
      },
    },
  });

  const listed = await blobsAt(gitHubOver(github.fetch), REPOSITORY, REVISION);

  expect(
    new Map(listed.map((entry) => [entry.path, entry.mode])),
  ).toStrictEqual(
    new Map([
      ["README.md", "160000"],
      ["contracts/tdd-contract.md", "100644"],
      ["contracts/tdd-contract/conformance/cases/first.md", "120000"],
    ]),
  );
});

test("a listing giving an entry no mode at all is refused", async () => {
  // The answer failing to be a tree listing, the way a missing path is. Read
  // as some mode this tool declines to take, the entry would describe itself
  // as something no caller can judge.
  const transport = (async () =>
    new Response(
      JSON.stringify({
        sha: REVISION,
        tree: [{ path: "contracts/tdd-contract.md", sha: "a".repeat(40) }],
        truncated: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const error = await rejectedBy(
    () => blobsAt(gitHubOver(transport), REPOSITORY, REVISION),
    ConfigError,
  );

  expect(error.message).toContain("contracts/tdd-contract.md");
  expect(error.message).toContain("no mode");
});

test("an answer that redirects is refused rather than followed", async () => {
  // The hosts this tool talks to are fixed, and following a redirect would
  // make that true of the first request of a chain only: a Location naming any
  // third-party host would be asked next and its answer taken. These endpoints
  // do not normally redirect, so one that does is an anomaly.
  const transport = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.invalid/repos" },
    })) as unknown as typeof fetch;
  const error = await rejectedBy(
    () => revisionOf(gitHubOver(transport), REPOSITORY, "main"),
    ConfigError,
  );
  expect(error.message).toContain("redirect");
});

test("every request tells the transport not to follow a redirect itself", async () => {
  // Refusing a 3xx answer only closes the hole if a 3xx answer is what arrives.
  // Left to its default, fetch follows the chain and hands back the last
  // answer, so the refusal above would never see the redirect at all.
  const asked: (RequestInit | undefined)[] = [];
  const transport = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    asked.push(init);
    return new Response(
      JSON.stringify({ sha: REVISION, tree: [], truncated: false }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  await revisionOf(gitHubOver(transport), REPOSITORY, "main");

  expect(asked.map((init) => init?.redirect)).toStrictEqual([
    "manual",
    "manual",
  ]);
});

const TOKEN = "test-only-credential-value-000000000000";

/** Every Authorization header a run of `fn` put on the wire, in order. */
async function authorizationsDuring(
  fn: (transport: typeof fetch) => Promise<unknown>,
): Promise<(string | null)[]> {
  const seen: (string | null)[] = [];
  const transport = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return await new Response(
      JSON.stringify({ sha: REVISION, default_branch: "main", tree: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  await fn(transport);
  return seen;
}

test("a run given no token sends no Authorization header at all", async () => {
  // The unauthenticated request is what it always was. An empty or absent
  // credential spelled as a header is a request that reaches the host as
  // neither one thing nor the other, and a 401 answered to it would be read
  // here as the source not holding the contract.
  const seen = await authorizationsDuring(async (transport) => {
    const client = gitHubOver(transport);
    await revisionOf(client, REPOSITORY, "main");
    await fileAt(client, REPOSITORY, REVISION, "contracts/tdd.md");
  });
  expect(seen).toStrictEqual([null, null, null, null]);
});

test("the token reaches both hosts, because both of them serve a private source", async () => {
  // The listing comes from the API host and the bytes from the raw host, and
  // a private repository answers neither without a credential. Sent to the
  // API alone, a private source would resolve its commit and then fail to
  // fetch one single file of it.
  const seen = await authorizationsDuring(async (transport) => {
    const client = gitHubOver(transport, TOKEN);
    await revisionOf(client, REPOSITORY, "main");
    await blobsAt(client, REPOSITORY, REVISION);
    await fileAt(client, REPOSITORY, REVISION, "contracts/tdd.md");
  });
  expect(seen).toStrictEqual([
    `Bearer ${TOKEN}`,
    `Bearer ${TOKEN}`,
    `Bearer ${TOKEN}`,
    `Bearer ${TOKEN}`,
    `Bearer ${TOKEN}`,
  ]);
});

test("an authenticated refusal names the causes that fit its status", async () => {
  // A credential raises the primary allowance but does not make it infinite:
  // 403 and 429 retain rate limiting as a possible cause, while 401 and 404
  // point the reader at the credential without the unauthenticated hint.
  //
  // 404 is in the list for a behaviour of the raw content host that a person
  // will otherwise spend an afternoon on: handed an Authorization header it
  // cannot validate, it answers 404 for a file it serves anonymously with
  // 200, so a merely wrong token makes a public source look empty rather than
  // making itself known.
  for (const status of [401, 403, 404, 429]) {
    const transport = (async () =>
      new Response("", { status })) as unknown as typeof fetch;
    const error = await rejectedBy(
      () => revisionOf(gitHubOver(transport, TOKEN), REPOSITORY, "main"),
      ConfigError,
    );
    expect(error.message).toContain(`answered ${status}`);
    expect(error.message).toContain("token");
    expect(error.message).not.toContain("unauthenticated requests");
    if (status === 403 || status === 429) {
      expect(error.message).toContain("rate limit");
    }
  }
});

test("an unauthenticated run keeps the note it always had, and gains none", async () => {
  // The run that reaches for no credential is the run this tool has always
  // made, and its refusals say what they always said. A 404 in particular
  // carries no note at all: without a credential the raw host answers it for
  // a file that genuinely is not there.
  for (const [status, expected] of [
    [403, true],
    [429, true],
    [401, false],
    [404, false],
  ] as [number, boolean][]) {
    const transport = (async () =>
      new Response("", { status })) as unknown as typeof fetch;
    const error = await rejectedBy(
      () => revisionOf(gitHubOver(transport), REPOSITORY, "main"),
      ConfigError,
    );
    expect(error.message).toContain(`answered ${status}`);
    expect(error.message.includes("rate limited by the hour")).toStrictEqual(
      expected,
    );
    expect(error.message).not.toContain("the token this run was given");
  }
});

test("no refusal puts the token into its message", async () => {
  // A refusal is written to a terminal, kept in a CI log and pasted into
  // issues. The URL it names is built from the tree; the credential is not
  // part of the URL and must not be part of anything reported beside it.
  for (const status of [401, 403, 404, 500]) {
    const transport = (async () =>
      new Response("", { status })) as unknown as typeof fetch;
    const error = await rejectedBy(
      () => fileAt(gitHubOver(transport, TOKEN), REPOSITORY, REVISION, "a.md"),
      ConfigError,
    );
    expect(error.message).not.toContain(TOKEN);
  }
});

test("an authenticated redirect cannot repeat the token from Location", async () => {
  // Response headers come from the remote peer. Treating Location as safe
  // merely because the request URL contains no credential lets that peer put
  // the Authorization value straight into a terminal or CI log.
  const transport = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: `https://elsewhere.invalid/${TOKEN}` },
    })) as unknown as typeof fetch;

  const error = await rejectedBy(
    () => revisionOf(gitHubOver(transport, TOKEN), REPOSITORY, "main"),
    ConfigError,
  );

  expect(error.message).toContain("redirect");
  expect(error.message).not.toContain(TOKEN);
});

test("a transport exception cannot put the token into its message", async () => {
  const transport = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    throw new Error(
      `transport failed for ${new Headers(init?.headers).get("authorization")}`,
    );
  }) as unknown as typeof fetch;

  const error = await rejectedBy(
    () => revisionOf(gitHubOver(transport, TOKEN), REPOSITORY, "main"),
    ConfigError,
  );
  expect(error.message).toContain("cannot reach");
  expect(error.message).not.toContain(TOKEN);
});
