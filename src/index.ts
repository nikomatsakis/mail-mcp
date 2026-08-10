#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";
import { closeAllConnections } from "./mail-client.js";
import { buildServer } from "./server.js";

// stdout is the MCP channel in stdio mode — everything human-readable goes to stderr.
const log = (message: string) => process.stderr.write(`[mail-mcp] ${message}\n`);

function wantsHttp(): boolean {
  const transport = (process.env.MCP_TRANSPORT ?? "").toLowerCase();
  if (transport === "http" || transport === "streamable-http") return true;
  if (transport === "stdio") return false;
  return process.argv.includes("--http");
}

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const { server } = buildServer(config);

  await server.connect(new StdioServerTransport());
  log(
    `ready — ${config.imap.user} on ${config.imap.host}` +
      (config.smtp ? `, sending via ${config.smtp.host}` : ", no SMTP configured") +
      (config.readOnly ? ", read-only" : "") +
      (config.allowedFolders.length ? `, folders limited to ${config.allowedFolders.join(", ")}` : ""),
  );

  // The mailbox connection is opened on the first tool call, not here: a client
  // that starts every configured server at launch should not cost a login each.
  const shutdown = () => {
    void closeAllConnections().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function runHttp(): void {
  const options = httpOptionsFromEnv();

  startHttpServer(options, log);
  log(
    options.allowedHosts.length
      ? `restricted to mail hosts: ${options.allowedHosts.join(", ")}`
      : "any public mail host may be targeted; private addresses are refused",
  );
}

async function main(): Promise<void> {
  if (wantsHttp()) {
    runHttp();
    return;
  }
  await runStdio();
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : (error as Error).message;
  log(`fatal: ${message}`);
  process.exit(1);
});
