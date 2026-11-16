import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, resolveConfig, type Config } from "./config.js";
import { buildServer } from "./server.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Hostnames that must never be reachable from a hosted deployment (SSRF guard).
 *
 * Each entry is anchored at both ends, so the prefixes carry an explicit `.*`:
 * an alternation like `127\.` inside `^(…)$` would only ever match the literal
 * string "127." and would let 127.0.0.1 straight through.
 */
const PRIVATE_HOST =
  /^(localhost|localhost\.localdomain|.*\.localhost|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1\]?|\[?::ffff:127\..*|\[?f[cd][0-9a-f]{2}:.*|.*\.internal|.*\.local|.*\.lan|.*\.home\.arpa)$/i;

/**
 * Files served next to the landing page: icons, the web manifest and the social
 * preview image. Everything is small, immutable and referenced by the page head,
 * so each entry carries its own content type and cache lifetime.
 */
const STATIC_ASSETS: Record<string, { file: string; type: string; maxAge: number }> = {
  "/favicon.ico": { file: "favicon.ico", type: "image/x-icon", maxAge: 604800 },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml", maxAge: 604800 },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png", maxAge: 604800 },
  "/icon-192.png": { file: "icon-192.png", type: "image/png", maxAge: 604800 },
  "/icon-512.png": { file: "icon-512.png", type: "image/png", maxAge: 604800 },
  "/og-image.png": { file: "og-image.png", type: "image/png", maxAge: 604800 },
  "/site.webmanifest": { file: "site.webmanifest", type: "application/manifest+json", maxAge: 86400 },
};

export interface HttpOptions {
  port: number;
  host: string;
  /** Absolute path of the landing page served at `/`. */
  landingPath: string;
  /** Directory holding the static assets referenced by the landing page. */
  assetsPath: string;
  /** When set, only these mail hosts may be targeted. */
  allowedHosts: string[];
  /** Fallbacks used when a request omits the corresponding header. */
  defaults: Record<string, string | undefined>;
}

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    landingPath: env.LANDING_PATH ?? resolve(here, "..", "landing.html"),
    assetsPath: env.ASSETS_PATH ?? resolve(here, "..", "assets"),
    allowedHosts: (env.MAIL_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    defaults: {
      provider: env.MAIL_PROVIDER,
      imapHost: env.IMAP_HOST,
      imapPort: env.IMAP_PORT,
      imapSecure: env.IMAP_SECURE,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      user: env.MAIL_USER,
      password: env.MAIL_PASSWORD,
      from: env.MAIL_FROM,
      defaultFolder: env.MAIL_DEFAULT_FOLDER,
      allowedFolders: env.MAIL_ALLOWED_FOLDERS,
      allowedRecipients: env.MAIL_ALLOWED_RECIPIENTS,
      readOnly: env.MAIL_READ_ONLY,
      appendToSent: env.MAIL_APPEND_TO_SENT,
      rejectUnauthorized: env.MAIL_TLS_REJECT_UNAUTHORIZED,
      timeoutMs: env.MAIL_TIMEOUT_MS,
      maxAttachmentBytes: env.MAIL_MAX_ATTACHMENT_BYTES,
      maxBodyChars: env.MAIL_MAX_BODY_CHARS,
      allowedTools: env.MAIL_ALLOWED_TOOLS,
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A blank header counts as absent, so a configuration template shipped with
 * empty strings falls back to the deployment defaults instead of overriding
 * them with nothing.
 */
function configHeader(req: IncomingMessage, name: string): string | undefined {
  return header(req, name)?.trim() || undefined;
}

/**
 * `Authorization: Basic base64(user:password)` as an alternative to the two
 * separate headers — the form every mail client already uses for a mailbox.
 */
function basicAuth(req: IncomingMessage): { user?: string; password?: string } {
  const auth = header(req, "authorization");
  const match = auth && /^Basic\s+(.+)$/i.exec(auth);
  if (!match) return {};
  const decoded = Buffer.from(match[1].trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return {};
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Builds a per-request config from headers, falling back to deployment defaults.
 * TLS verification and local file access are deliberately not header-controlled:
 * they belong to whoever runs the deployment.
 */
export function configFromRequest(req: IncomingMessage, options: HttpOptions): Config {
  const { defaults } = options;
  const basic = basicAuth(req);

  const config = resolveConfig({
    provider: configHeader(req, "x-mail-provider") ?? defaults.provider,
    user: configHeader(req, "x-mail-user") ?? basic.user ?? defaults.user,
    password: configHeader(req, "x-mail-password") ?? basic.password ?? defaults.password,
    authType: configHeader(req, "x-mail-auth-type"),
    imapHost: configHeader(req, "x-mail-imap-host") ?? defaults.imapHost,
    imapPort: configHeader(req, "x-mail-imap-port") ?? defaults.imapPort,
    imapSecure: configHeader(req, "x-mail-imap-secure") ?? defaults.imapSecure,
    smtpHost: configHeader(req, "x-mail-smtp-host") ?? defaults.smtpHost,
    smtpPort: configHeader(req, "x-mail-smtp-port") ?? defaults.smtpPort,
    smtpSecure: configHeader(req, "x-mail-smtp-secure") ?? defaults.smtpSecure,
    from: configHeader(req, "x-mail-from") ?? defaults.from,
    fromName: configHeader(req, "x-mail-from-name"),
    defaultFolder: configHeader(req, "x-mail-default-folder") ?? defaults.defaultFolder,
    allowedFolders: configHeader(req, "x-mail-allowed-folders") ?? defaults.allowedFolders,
    allowedRecipients: configHeader(req, "x-mail-allowed-recipients") ?? defaults.allowedRecipients,
    readOnly: configHeader(req, "x-mail-read-only") ?? defaults.readOnly,
    appendToSent: configHeader(req, "x-mail-append-to-sent") ?? defaults.appendToSent,
    rejectUnauthorized: defaults.rejectUnauthorized,
    timeoutMs: defaults.timeoutMs,
    maxAttachmentBytes: defaults.maxAttachmentBytes,
    maxBodyChars: defaults.maxBodyChars,
    allowedTools: defaults.allowedTools,
    // `path` attachments would read the server's disk, not the caller's.
    allowLocalFiles: "false",
  });

  assertHostAllowed(config.imap.host, options);
  if (config.smtp) assertHostAllowed(config.smtp.host, options);
  return config;
}

function assertHostAllowed(host: string, options: HttpOptions): void {
  const name = host.toLowerCase();

  if (options.allowedHosts.length > 0) {
    if (!options.allowedHosts.includes(name)) {
      throw new ConfigError(
        `This deployment only serves ${options.allowedHosts.join(", ")}; ${name} is not allowed.`,
      );
    }
    return;
  }

  // Without an explicit allowlist, keep the public endpoint away from internal
  // networks — including a Proton Bridge on the caller's own machine, which a
  // hosted server has no way of reaching anyway.
  if (PRIVATE_HOST.test(name)) {
    throw new ConfigError(
      `Refusing to connect to the private address ${name}. Run the server locally over stdio to ` +
        "reach a mail server on a private network or a local bridge.",
    );
  }
}

/** Date of the last landing page change, for <lastmod> in the sitemap. */
async function landingModified(landingPath: string): Promise<string> {
  try {
    const { mtime } = await stat(landingPath);
    return mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Public origin of this deployment, as seen by the visitor. Taken from the
 * request rather than configuration so that a self-hosted copy advertises its
 * own address in robots.txt and sitemap.xml instead of the reference one.
 */
function publicOrigin(req: IncomingMessage): string {
  const forwarded = header(req, "x-forwarded-proto")?.split(",")[0].trim();
  const host = header(req, "x-forwarded-host") ?? header(req, "host") ?? "localhost";
  const protocol = forwarded ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  type: string,
  body: string | Buffer,
  maxAge: number,
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": payload.byteLength,
    "Cache-Control": `public, max-age=${maxAge}`,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** JSON-RPC shaped error so MCP clients surface the reason instead of "connection failed". */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", header(req, "origin") ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, " +
      "X-Mail-Provider, X-Mail-User, X-Mail-Password, X-Mail-Imap-Host, X-Mail-Imap-Port, " +
      "X-Mail-Imap-Secure, X-Mail-Smtp-Host, X-Mail-Smtp-Port, X-Mail-Smtp-Secure, X-Mail-From, " +
      "X-Mail-From-Name, X-Mail-Default-Folder, X-Mail-Allowed-Folders, X-Mail-Allowed-Recipients, " +
      "X-Mail-Read-Only, X-Mail-Append-To-Sent, X-Mail-Auth-Type",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Starts the hosted endpoint: the landing page on `/` and a stateless MCP
 * endpoint on `/mcp`, where every request carries its own mailbox credentials.
 */
export function startHttpServer(
  options: HttpOptions,
  log: (message: string) => void,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handle(req, res, options, log).catch((error: unknown) => {
      log(`unhandled: ${(error as Error).message}`);
      if (!res.headersSent) sendRpcError(res, 500, "Internal server error");
    });
  });

  server.listen(options.port, options.host, () => {
    log(`listening on http://${options.host}:${options.port} (landing on /, MCP on /mcp)`);
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpOptions,
  log: (message: string) => void,
): Promise<void> {
  applyCors(req, res);
  const url = new URL(req.url ?? "/", `http://${header(req, "host") ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const asset = STATIC_ASSETS[url.pathname];
    if (asset) {
      try {
        const body = await readFile(resolve(options.assetsPath, asset.file));
        sendText(req, res, asset.type, body, asset.maxAge);
      } catch {
        sendJson(res, 404, { error: `Asset ${asset.file} not found` });
      }
      return;
    }

    if (url.pathname === "/robots.txt") {
      const origin = publicOrigin(req);
      // The MCP endpoint holds nothing for a crawler, and /health would only
      // add a duplicate JSON page to the index.
      sendText(
        req,
        res,
        "text/plain; charset=utf-8",
        ["User-agent: *", "Disallow: /mcp", "Disallow: /health", "", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n"),
        86400,
      );
      return;
    }

    if (url.pathname === "/sitemap.xml") {
      const origin = publicOrigin(req);
      sendText(
        req,
        res,
        "application/xml; charset=utf-8",
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `  <url>\n    <loc>${origin}/</loc>\n` +
          `    <lastmod>${await landingModified(options.landingPath)}</lastmod>\n` +
          "    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n" +
          "</urlset>\n",
        3600,
      );
      return;
    }
  }

  // One canonical address for the page, so crawlers never see it twice.
  if (url.pathname === "/index.html") {
    res.writeHead(301, { Location: "/" }).end();
    return;
  }

  if (url.pathname === "/") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendRpcError(res, 405, "Method not allowed");
      return;
    }
    try {
      const page = await readFile(options.landingPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": page.byteLength,
        // Short and revalidated: the page is small, and a stale copy behind a CDN
        // hides a redeploy for as long as it lives.
        "Cache-Control": "public, max-age=60, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      res.end(req.method === "HEAD" ? undefined : page);
    } catch {
      sendJson(res, 404, { error: "Landing page not found" });
    }
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
    return;
  }

  // Stateless transport: no session to resume, so only POST carries meaning.
  if (req.method !== "POST") {
    sendRpcError(res, 405, "Method not allowed. This endpoint is stateless; use POST.");
    return;
  }

  let config: Config;
  try {
    config = configFromRequest(req, options);
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : `Invalid configuration: ${(error as Error).message}`;
    sendRpcError(res, error instanceof ConfigError ? 401 : 400, message);
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    sendRpcError(res, 400, `Invalid request body: ${(error as Error).message}`);
    return;
  }

  const { server: mcpServer } = buildServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON replies rather than SSE: every tool here is a single
    // request/response, and buffering proxies cannot break them.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
    // The IMAP connection itself is pooled and outlives the request on purpose.
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    log(`request failed: ${(error as Error).message}`);
    if (!res.headersSent) sendRpcError(res, 502, (error as Error).message);
  }
}
