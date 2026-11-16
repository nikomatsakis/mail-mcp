import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigError, TOOL_GROUPS, parseAllowedTools, resolveConfig } from "../dist/config.js";
import { assertKnownTools, buildServer, toolNames } from "../dist/server.js";

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** Tools a client sees, plus the server instructions. No mailbox is contacted. */
async function connect(allowedTools) {
  const config = resolveConfig({
    user: "someone@example.com",
    password: "unused",
    imapHost: "imap.example.com",
    smtpHost: "smtp.example.com",
    allowedTools,
  });
  const { server } = buildServer(config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const tools = client.getServerCapabilities()?.tools
    ? (await client.listTools()).tools.map((tool) => tool.name).sort()
    : [];
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { tools, instructions };
}

function startupError(env) {
  const result = spawnSync(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH,
      MAIL_USER: "someone@example.com",
      MAIL_PASSWORD: "unused",
      IMAP_HOST: "imap.example.com",
      ...env,
    },
    input: "",
    encoding: "utf8",
    timeout: 5000,
  });
  return { status: result.status, stderr: result.stderr };
}

test("parseAllowedTools: unset means no restriction", () => {
  assert.equal(parseAllowedTools(undefined), undefined);
});

test("parseAllowedTools: set but blank means no tools", () => {
  assert.deepEqual(parseAllowedTools(""), []);
  assert.deepEqual(parseAllowedTools(" , "), []);
});

test("parseAllowedTools: expands groups, case-insensitively, without duplicates", () => {
  assert.deepEqual(parseAllowedTools("@TRIAGE"), TOOL_GROUPS["@triage"]);
  const mixed = parseAllowedTools("@flag, mail_set_flags, mail_send");
  assert.deepEqual(mixed, ["mail_set_flags", "mail_mark_search_read", "mail_send"]);
});

test("parseAllowedTools: rejects an unknown group", () => {
  assert.throws(() => parseAllowedTools("@nope"), ConfigError);
});

test("assertKnownTools: rejects an unknown tool", () => {
  assert.throws(() => assertKnownTools(["mail_sendd"]), /unknown tools: mail_sendd/);
  assert.doesNotThrow(() => assertKnownTools(["mail_send"]));
  assert.doesNotThrow(() => assertKnownTools(undefined));
});

test("every group names only real tools", () => {
  const known = new Set(toolNames());
  for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
    for (const tool of tools) assert.ok(known.has(tool), `${group} names unknown tool ${tool}`);
  }
});

test("every tool belongs to a group", () => {
  const grouped = new Set(Object.values(TOOL_GROUPS).flat());
  const ungrouped = toolNames().filter((tool) => !grouped.has(tool));
  assert.deepEqual(ungrouped, [], "add new tools to TOOL_GROUPS in src/config.ts");
});

test("@triage exposes reading and flagging, nothing that sends", () => {
  assert.ok(!TOOL_GROUPS["@triage"].some((tool) => TOOL_GROUPS["@compose"].includes(tool)));
  assert.ok(!TOOL_GROUPS["@triage"].some((tool) => TOOL_GROUPS["@organize"].includes(tool)));
});

test("server: no allowlist registers every tool", async () => {
  const { tools, instructions } = await connect(undefined);
  assert.deepEqual(tools, toolNames().sort());
  assert.match(instructions, /mail_reply/);
});

test("server: allowlist registers only the listed tools", async () => {
  const { tools, instructions } = await connect("@triage");
  assert.deepEqual(tools, [...TOOL_GROUPS["@triage"]].sort());
  assert.doesNotMatch(instructions, /mail_reply/);
  assert.match(instructions, /Only these tools exist/);
});

test("server: empty allowlist registers no tools", async () => {
  const { tools, instructions } = await connect("");
  assert.deepEqual(tools, []);
  assert.match(instructions, /Only these tools exist on this server: none/);
});

test("startup: an unknown tool stops stdio mode", () => {
  const { status, stderr } = startupError({ MAIL_ALLOWED_TOOLS: "mail_sendd" });
  assert.equal(status, 1);
  assert.match(stderr, /unknown tools: mail_sendd/);
});

test("startup: an unknown tool stops HTTP mode before listening", () => {
  const { status, stderr } = startupError({
    MAIL_ALLOWED_TOOLS: "mail_sendd",
    MCP_TRANSPORT: "http",
    HOST: "127.0.0.1",
    PORT: "0",
  });
  assert.equal(status, 1);
  assert.match(stderr, /unknown tools: mail_sendd/);
  assert.doesNotMatch(stderr, /listening/);
});
