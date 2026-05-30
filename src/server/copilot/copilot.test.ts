import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { emptyRagSettings, type UserRecord } from "../store";
import { readDocument, writeDocument } from "../vault/vaultService";
import { runCopilotAgent } from "./agent";
import { saveConversation, listConversations, loadConversation } from "./conversations";
import { applyFileEditProposal, clearFileEditProposalsForTest } from "./proposals";
import { createCopilotToolRegistry } from "./tools";
import type { CopilotStreamEvent } from "./types";

function testVaultPath(name: string): string {
  return path.resolve("sample-vault", "test-vaults", `${name}-${process.pid}-${Date.now()}`);
}

function makeUser(vaultPath: string): UserRecord {
  const rag = emptyRagSettings();
  rag.qa = {
    provider: "openai-compatible",
    apiMode: "chat-completions",
    endpointPath: "/chat/completions",
    baseUrl: "http://provider.test/v1",
    model: "mock-model",
    timeoutMs: 30_000
  };
  return {
    username: `test-${path.basename(vaultPath)}`,
    role: "admin",
    passwordHash: "",
    passwordUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    vault: {
      path: vaultPath,
      allowPlainMarkdownFolder: true
    },
    rag,
    createdAtByPath: {},
    metadataByPath: {}
  };
}

async function withVault(name: string, fn: (user: UserRecord, vaultPath: string) => Promise<void>) {
  const vaultPath = testVaultPath(name);
  await fs.rm(vaultPath, { recursive: true, force: true });
  await fs.mkdir(vaultPath, { recursive: true });
  const user = makeUser(vaultPath);
  try {
    await fn(user, vaultPath);
  } finally {
    clearFileEditProposalsForTest();
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
}

function tool(name: string) {
  const found = createCopilotToolRegistry().find((candidate) => candidate.name === name);
  assert.ok(found, `Expected ${name} tool`);
  return found;
}

test("copilot tools search, read notes, list tree, and resolve time ranges", async () => {
  await withVault("tools", async (user) => {
    await writeDocument(user, "Project.md", "# Project\n\nAlpha launch plan links to [[Reference]].");
    await writeDocument(user, "Reference.md", "# Reference\n\nReference details.");
    await writeDocument(user, "copilot/copilot-conversations/Hidden.md", "Alpha hidden chat history.");

    const search = await tool("localSearch").execute({ query: "Alpha launch", salientTerms: ["Alpha", "launch"] }, { user });
    assert.equal(search.status, "ok");
    assert.ok(search.citations?.some((citation) => citation.path === "Project.md"));
    assert.ok(!search.citations?.some((citation) => citation.path.startsWith("copilot/")));

    const hiddenSearch = await tool("localSearch").execute({ query: "hidden chat history", salientTerms: ["hidden"] }, { user });
    assert.equal(hiddenSearch.citations?.length ?? 0, 0);

    const read = await tool("readNote").execute({ notePath: "Project.md" }, { user });
    assert.equal(read.status, "ok");
    assert.equal(read.notePath, "Project.md");
    assert.match(String(read.content), /Alpha launch/);
    assert.deepEqual(read.linkedNotes, [{ path: "Reference.md", title: "Reference" }]);

    const readCurrent = await tool("readNote").execute(
      { notePath: "current" },
      {
        user,
        activeNote: {
          path: "Draft.md",
          title: "Draft",
          content: "# Draft\n\nUnsaved Alpha context.",
          isCurrent: true,
          isDraft: true,
          dirty: true
        }
      }
    );
    assert.equal(readCurrent.status, "ok");
    assert.equal(readCurrent.notePath, "Draft.md");
    assert.equal(readCurrent.isDraft, true);
    assert.match(String(readCurrent.content), /Unsaved Alpha context/);

    const tree = await tool("getFileTree").execute({}, { user });
    assert.equal(tree.status, "ok");
    assert.match(JSON.stringify(tree.tree), /Project\.md/);
    assert.doesNotMatch(JSON.stringify(tree.tree), /Hidden\.md/);

    const timeRange = await tool("getTimeRangeMs").execute({ timeExpression: "yesterday" }, { user });
    assert.equal(timeRange.status, "ok");
    assert.equal(typeof timeRange.startTime, "number");
    assert.equal(typeof timeRange.endTime, "number");
  });
});

test("file edit proposals do not mutate until apply and block hash conflicts", async () => {
  await withVault("proposals", async (user) => {
    await writeDocument(user, "Note.md", "# Note\n\nHello world.");

    const editResult = await tool("editFile").execute(
      { path: "Note.md", oldText: "Hello world.", newText: "Hello Copilot." },
      { user }
    );
    assert.equal(editResult.status, "pending_confirmation");
    assert.ok(editResult.proposal);
    assert.match((await readDocument(user, "Note.md")).content, /Hello world/);

    await applyFileEditProposal(user, editResult.proposal.id);
    assert.match((await readDocument(user, "Note.md")).content, /Hello Copilot/);

    const conflictResult = await tool("editFile").execute(
      { path: "Note.md", oldText: "Hello Copilot.", newText: "Goodbye." },
      { user }
    );
    assert.ok(conflictResult.proposal);
    await writeDocument(user, "Note.md", "# Note\n\nExternal change.");
    await assert.rejects(() => applyFileEditProposal(user, conflictResult.proposal!.id), /Document changed on disk/);
  });
});

test("conversation markdown save/load roundtrips through the vault", async () => {
  await withVault("conversations", async (user) => {
    const saved = await saveConversation(user, {
      messages: [
        { role: "user", content: "What is Alpha?", id: "u1", createdAt: "2026-05-29T00:00:00.000Z" },
        { role: "assistant", content: "Alpha is in Project.md.", id: "a1", createdAt: "2026-05-29T00:00:01.000Z" }
      ]
    });
    assert.ok(saved.path?.startsWith("copilot/copilot-conversations/"));

    const listed = await listConversations(user);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);

    const loaded = await loadConversation(user, saved.id);
    assert.equal(loaded.title, "What is Alpha?");
    assert.deepEqual(loaded.messages.map((message) => message.content), ["What is Alpha?", "Alpha is in Project.md."]);
  });
});

test("agent injects active and referenced note context into provider messages", async () => {
  await withVault("agent-context", async (user) => {
    const requestBodies: any[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Context-aware answer." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const final = await runCopilotAgent({
      user,
      messages: [{ id: "u1", role: "user", content: "Use the current note and @Reference", createdAt: new Date().toISOString() }],
      activeNote: {
        path: "Current.md",
        title: "Current",
        content: "# Current\n\nActive note body.",
        isCurrent: true,
        dirty: true
      },
      referencedNotes: [
        {
          path: "Reference.md",
          title: "Reference",
          content: "# Reference\n\nReferenced note body."
        }
      ],
      emit: () => {},
      fetchImpl: fetchImpl as typeof fetch
    });

    assert.equal(final, "Context-aware answer.");
    const systemContext = requestBodies[0].messages
      .filter((message: any) => message.role === "system")
      .map((message: any) => message.content)
      .join("\n");
    assert.match(systemContext, /<active_note path="Current\.md" title="Current"/);
    assert.match(systemContext, /Active note body/);
    assert.match(systemContext, /<note_context path="Reference\.md" title="Reference"/);
    assert.match(systemContext, /Referenced note body/);
  });
});

test("agent loop handles localSearch then readNote before final answer", async () => {
  await withVault("agent", async (user) => {
    await writeDocument(user, "Project.md", "# Project\n\nAlpha launch plan.");
    const events: CopilotStreamEvent[] = [];
    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-search",
                  type: "function",
                  function: { name: "localSearch", arguments: JSON.stringify({ query: "Alpha", salientTerms: ["Alpha"] }) }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: { name: "readNote", arguments: JSON.stringify({ notePath: "Project.md" }) }
                }
              ]
            }
          }
        ]
      },
      {
        choices: [{ message: { content: "Alpha is described in Project.md." } }]
      }
    ];
    let callIndex = 0;
    const fetchImpl = async () =>
      new Response(JSON.stringify(responses[callIndex++]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const final = await runCopilotAgent({
      user,
      messages: [{ id: "u1", role: "user", content: "Tell me about Alpha", createdAt: new Date().toISOString() }],
      emit: (event) => {
        events.push(event);
      },
      fetchImpl: fetchImpl as typeof fetch
    });

    assert.equal(final, "Alpha is described in Project.md.");
    assert.deepEqual(
      events.filter((event) => event.type === "tool_call").map((event) => event.name),
      ["localSearch", "readNote"]
    );
    assert.ok(events.some((event) => event.type === "citation" && event.citation.path === "Project.md"));
    assert.ok(events.some((event) => event.type === "message_delta" && event.text.includes("Alpha")));
  });
});

test("agent loop finalizes without tools after iteration limit", async () => {
  await withVault("agent-finalize", async (user) => {
    const events: CopilotStreamEvent[] = [];
    const requestBodies: any[] = [];
    let callIndex = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      callIndex += 1;
      const payload =
        callIndex <= 8
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `call-time-${callIndex}`,
                        type: "function",
                        function: { name: "getCurrentTime", arguments: "{}" }
                      }
                    ]
                  }
                }
              ]
            }
          : {
              choices: [{ message: { content: "Final answer from existing tool results." } }]
            };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const final = await runCopilotAgent({
      user,
      messages: [{ id: "u1", role: "user", content: "What time is it?", createdAt: new Date().toISOString() }],
      emit: (event) => {
        events.push(event);
      },
      fetchImpl: fetchImpl as typeof fetch
    });

    assert.equal(final, "Final answer from existing tool results.");
    assert.equal(callIndex, 9);
    assert.ok(requestBodies.slice(0, 8).every((body) => Array.isArray(body.tools)));
    assert.equal(requestBodies[8].tools, undefined);
    assert.ok(events.some((event) => event.type === "status" && event.message === "Finalizing with available tool results"));
    assert.ok(!events.some((event) => event.type === "error"));
  });
});
