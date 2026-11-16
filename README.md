# Mail MCP

An MCP server for **any IMAP mailbox** — Gmail, Outlook, iCloud, Fastmail, Yandex, your
company's own server. Not tied to a provider, an account or a project: it is configured with
the host, the address and the password, and that is the whole binding.

**20 tools** covering reading, searching, threading, sending, replying, forwarding, drafts,
flags, folders and attachments.

The headline feature: **the server reads attachments**. A screenshot mailed to you is
downloaded and handed to the model as an image — not as a filename it cannot open.

---

## Two ways to run it

| Mode | Transport | Configuration comes from | Use it when |
|---|---|---|---|
| **Hosted** | Streamable HTTP on `/mcp` | request headers, per call | clients should connect to a URL with nothing installed |
| **Local** | stdio | environment variables | the mailbox is private, or credentials must not leave the machine |

The public deployment lives at `https://mail-mcp.webapace.ink` — the landing page on `/`, the
MCP endpoint on `/mcp`. Connecting to it needs no install:

```bash
claude mcp add --transport http mail \
  https://mail-mcp.webapace.ink/mcp \
  --header "X-Mail-User: you@fastmail.com" \
  --header "X-Mail-Password: your-app-password"
```

Or write the configuration yourself. The same object goes into `.mcp.json` in a repository,
`~/.claude.json`, `claude_desktop_config.json` or `.cursor/mcp.json` — fill in the blanks:

```json
{
  "mcpServers": {
    "mail": {
      "type": "http",
      "url": "https://mail-mcp.webapace.ink/mcp",
      "headers": {
        "X-Mail-User": "",
        "X-Mail-Password": "",
        "X-Mail-Imap-Host": "",
        "X-Mail-Smtp-Host": ""
      }
    }
  }
}
```

| Header | Fill in with | If left empty |
|---|---|---|
| `X-Mail-User` | the address you sign in with | the request is refused — this one is required |
| `X-Mail-Password` | the app-specific password from your provider | the request is refused — this one is required too |
| `X-Mail-Imap-Host` | `imap.example.com`, for a mailbox with no preset | derived from your address, when its domain is one of the known providers |
| `X-Mail-Smtp-Host` | `smtp.example.com`, likewise | derived from your address; without either, sending is unavailable |

`X-Mail-Read-Only`, `X-Mail-Allowed-Recipients` and `X-Mail-Allowed-Folders` can be added the
same way; see [Hosted mode](#hosted-mode) for the full header list.

Keep the file out of version control, or write `"X-Mail-Password": "${MAIL_PASSWORD}"` — Claude
Code and Cursor substitute environment variables, so the secret stays in your shell.

**One thing to weigh.** Unlike a project-scoped API token, a mailbox password opens the whole
mailbox, and on the hosted endpoint it passes through the host on every request. Nothing is
stored there, and the guard rails below narrow what can be done with it — but if that trade is
not acceptable, [run it locally](#running-it-locally); it is a few commands and everything
behaves identically.

Several mailboxes at once — several entries with different names:

```json
{
  "mcpServers": {
    "mail-work":     { "type": "http", "url": "https://mail-mcp.webapace.ink/mcp", "headers": { "X-Mail-User": "me@company.com",  "X-Mail-Password": "…" } },
    "mail-personal": { "type": "http", "url": "https://mail-mcp.webapace.ink/mcp", "headers": { "X-Mail-User": "me@fastmail.com", "X-Mail-Password": "…" } }
  }
}
```

Two things worth knowing when a change appears to do nothing:

- In Claude Code an entry added to the **local** scope (kept in `~/.claude.json`) takes
  precedence over the project's `.mcp.json`. `claude mcp list` shows what is actually in use,
  and `claude mcp remove <name> -s local` drops a stale one.
- Client configuration is read at startup, so restart the app after editing the file.

The rest of this document is for running your own copy in either mode.

---

## Running it locally

```bash
git clone git@github.com:amalychev/mail-mcp.git
cd mail-mcp
npm install
npm run build
```

Requires Node.js 20 or newer. Then point your assistant at the built file, with the
configuration as environment variables instead of headers:

```bash
claude mcp add mail \
  --env MAIL_USER=you@fastmail.com \
  --env MAIL_PASSWORD=your-app-password \
  -- node /absolute/path/mail-mcp/dist/index.js
```

That is the whole setup for a known provider: the IMAP and SMTP hosts are derived from the
address. Nothing listens on the network in this mode, and the credentials never leave the
machine. Ask for `mail_whoami` to confirm — it logs in to both servers and reports what it found.

Or in a file, which travels with the project:

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/mail-mcp/dist/index.js"],
      "env": {
        "MAIL_USER": "you@example.com",
        "MAIL_PASSWORD": "${MAIL_PASSWORD}",
        "IMAP_HOST": "imap.example.com",
        "SMTP_HOST": "smtp.example.com"
      }
    }
  }
}
```

The same block works in Claude Desktop (`claude_desktop_config.json`) and Cursor
(`.cursor/mcp.json`).

---

## The password

Nearly every provider refuses your account password over IMAP and wants an app-specific
password — a separate value you generate once, use here, and can revoke without touching the
account itself.

| Provider | Where to get it |
|---|---|
| **Gmail / Workspace** | Turn on 2-Step Verification, then [App passwords](https://myaccount.google.com/apppasswords). Workspace accounts also need IMAP enabled by an administrator |
| **iCloud** | appleid.apple.com → Sign-In and Security → App-Specific Passwords. The login is often the part of the address before `@` |
| **Yahoo / AOL** | Account security → Generate app password |
| **Fastmail** | Settings → Privacy & Security → App passwords |
| **Yandex / Mail.ru** | Security → app passwords, and IMAP switched on under mail-client settings |
| **Zoho** | Security → App passwords, plus IMAP access in Mail Settings |
| **Outlook.com / Microsoft 365** | Usually OAuth only — see below |
| **Proton** | Install Proton Bridge and use the credentials it shows, not your Proton password |

**Microsoft** has switched personal accounts and most tenants to OAuth, so a password often
fails outright. Supply an access token as `MAIL_PASSWORD` together with `MAIL_AUTH_TYPE=oauth2`;
the same setting works for Gmail's OAuth if you prefer it to an app password.

When authentication fails, the error names your provider and says what it wants — the message
is not a generic "login failed".

---

## Configuration

In stdio mode everything is configured through environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAIL_USER` | yes | — | The address (or login name) you sign in with |
| `MAIL_PASSWORD` | yes | — | App-specific password, or an OAuth token with `MAIL_AUTH_TYPE=oauth2` |
| `MAIL_PROVIDER` | no | detected | Preset that fills in all four host settings |
| `IMAP_HOST` / `IMAP_PORT` | no | from preset | Incoming server. A host pasted with `:993` or a scheme is cleaned up |
| `IMAP_SECURE` | no | from port | `true` for implicit TLS, `false` for STARTTLS |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | no | from preset | Outgoing server. Omit entirely for a read-only mailbox |
| `SMTP_USER` / `SMTP_PASSWORD` | no | the IMAP ones | When the outgoing server wants separate credentials |
| `MAIL_FROM` / `MAIL_FROM_NAME` | no | `MAIL_USER` | The From header. Required when the login is not an address |
| `MAIL_AUTH_TYPE` | no | password | `oauth2` — treat the password as an access token |
| `MAIL_DEFAULT_FOLDER` | no | `INBOX` | Folder used when a tool does not name one |
| `MAIL_READ_ONLY` | no | `false` | `true` — every tool that would change anything is refused |
| `MAIL_ALLOWED_RECIPIENTS` | no | — | Comma-separated addresses or `@domains`; mail elsewhere is refused |
| `MAIL_ALLOWED_FOLDERS` | no | — | Comma-separated folders; everything else is out of scope |
| `MAIL_ALLOWED_TOOLS` | no | — | Comma-separated tool names or `@groups`; only these tools exist |
| `MAIL_APPEND_TO_SENT` | no | `true` | `false` — do not file a copy of sent mail |
| `MAIL_TLS_REJECT_UNAUTHORIZED` | no | `true` | `false` — accept a self-signed certificate |
| `MAIL_TIMEOUT_MS` | no | `60000` | Per-connection timeout |
| `MAIL_MAX_ATTACHMENT_BYTES` | no | `8388608` | Largest attachment read or sent |
| `MAIL_MAX_BODY_CHARS` | no | `40000` | Bodies longer than this are truncated |
| `MAIL_ALLOW_LOCAL_FILES` | no | `true` | `false` — refuse to attach files from disk |

`MAIL_ADDRESS`, `MAIL_PASS`, `IMAP_USER`, `IMAP_PASSWORD`, `MAIL_IMAP_HOST` and
`MAIL_SMTP_HOST` are accepted as aliases.

### Providers with a preset

`gmail`, `outlook`, `yahoo`, `icloud`, `fastmail`, `zoho`, `yandex`, `mailru`, `gmx`, `aol`,
`migadu`, `mailbox`, `proton` — each fills in the IMAP and SMTP host, port and transport.
Aliases such as `google`, `hotmail`, `office365` and `protonmail` resolve to the right one, and
an address ending in a domain the preset owns selects it with no configuration at all.

Anything else is a normal IMAP server: give the two hosts and it works.

---

## What the tools do

Messages are addressed by **UID within a folder**. A UID is only meaningful together with the
folder it came from, and a message that moves gets a new one — every tool that returns messages
returns the folder alongside them.

Folders accept **aliases**: `inbox`, `sent`, `drafts`, `trash`, `junk`, `archive` resolve
through the server's own special-use flags, so they work whether the account calls it `Sent`,
`[Gmail]/Sent Mail` or `Отправленные`.

### Reading

| Tool | Description |
|---|---|
| `mail_list_messages` | Newest messages in a folder, with an optional preview of each |
| `mail_search` | Sender, recipient, subject, body, date range, read state, size, arbitrary headers |
| `mail_read_message` | One message: headers, readable body, attachment list |
| `mail_read_thread` | The whole conversation, oldest first, including your own replies from Sent |
| `mail_get_raw_message` | The raw source — Received chains, SPF/DKIM, list headers |

`mail_read_message` fetches only the body part, so a message carrying a 20 MB attachment still
costs a few kilobytes to read. HTML-only mail is flattened to prose with the links kept.
Reading never marks anything as read unless you pass `mark_read: true`.

### Attachments

| Tool | Description |
|---|---|
| `mail_list_attachments` | What is attached, with the part ids needed to fetch it |
| `mail_read_attachment` | Downloads one: images come back as images, text as text, the rest as a base64 resource |

### Writing

| Tool | Description |
|---|---|
| `mail_send` | A new message, with attachments from disk or from base64 |
| `mail_reply` | Threads properly: In-Reply-To and References are carried over, `reply_all` optional |
| `mail_forward` | With the usual header block and, unless disabled, the original attachments |
| `mail_save_draft` | Writes into Drafts without sending — for text a person should review first |

Every sent message is filed in the Sent folder, and the copy is the exact bytes that were sent
rather than a re-composed lookalike. The From address comes from the deployment and cannot be
overridden by a tool argument.

### Organising

| Tool | Description |
|---|---|
| `mail_set_flags` | Read/unread, flagged, answered, custom keywords, several messages at once |
| `mail_mark_search_read` | Marks everything a search matches, with a ceiling so a broad query cannot run away |
| `mail_move_messages` / `mail_copy_messages` | File mail into folders |
| `mail_delete_messages` | Moves to Trash; `permanent: true` needs `confirm: true` as well |
| `mail_list_folders` / `mail_folder_status` | The folder tree, with counts on request |
| `mail_folder_action` | Create, rename, delete, subscribe, unsubscribe |
| `mail_whoami` | Logs in to both servers and reports account, quota and restrictions |

---

## Keeping it inside bounds

An assistant with a mailbox password can, in principle, read everything and write to anyone.
Four independent limits narrow that, and they stack:

**Read-only.** `MAIL_READ_ONLY=true` refuses every tool that sends, moves, flags or deletes.
Reading still works completely.

**A recipient allowlist.** `MAIL_ALLOWED_RECIPIENTS=@yourcompany.com,partner@client.com` checks
every recipient — To, Cc and Bcc together — before anything reaches the SMTP server. This is
the one worth setting even when everything else is open: it turns "the assistant could email
anyone" into "the assistant could email these people".

**A folder allowlist.** `MAIL_ALLOWED_FOLDERS=INBOX,INBOX/Clients` puts every other folder out
of reach, for reading as well as writing. A listed folder covers its subfolders. The
"no such folder" error is filtered to the allowed set, so it cannot be used to map the account.

**A tool allowlist.** `MAIL_ALLOWED_TOOLS=@triage` registers only the listed tools; the rest do
not exist on the server, so the assistant never sees them. Entries are tool names or groups, and
mix freely — `@read,mail_set_flags`:

| Group | Tools |
|---|---|
| `@read` | `mail_whoami`, `mail_list_folders`, `mail_folder_status`, `mail_list_messages`, `mail_search`, `mail_read_message`, `mail_read_thread`, `mail_get_raw_message`, `mail_list_attachments`, `mail_read_attachment` |
| `@flag` | `mail_set_flags`, `mail_mark_search_read` |
| `@organize` | `mail_move_messages`, `mail_copy_messages`, `mail_delete_messages`, `mail_folder_action` |
| `@compose` | `mail_send`, `mail_reply`, `mail_forward`, `mail_save_draft` |
| `@triage` | `@read` and `@flag`: read everything, mark read or unread, flag — never send |

This is finer-grained than read-only: `@triage` with `MAIL_READ_ONLY=false` allows flagging but
not replying. Read-only still applies on top, so combining it with `@flag` leaves the flag tools
listed but refused. `mail_read_message` is in `@read` yet can set the read flag via `mark_read`
unless the server is read-only.

An unknown tool or group name stops the server at startup. Set but empty, the variable
registers no tools at all, so a template variable that expands to nothing cannot widen access.
A tool not listed in any group is exposed only when named explicitly.

Beyond that: deleting is a move to Trash unless `permanent: true` and `confirm: true` are both
given, deleting a folder needs `confirm: true`, and an app-specific password can be revoked in
the provider's interface without touching the account.

---

## Hosted mode

Start the HTTP transport with `MCP_TRANSPORT=http` (or `--http`). It serves:

| Route | Purpose |
|---|---|
| `GET /` | the landing page (`landing.html`, or `LANDING_PATH`) |
| `POST /mcp` | the MCP endpoint, stateless — one server instance per request |
| `GET /health` | liveness probe |
| `GET /robots.txt`, `/sitemap.xml` | generated per request from the `Host` header |
| `GET /favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/og-image.png`, `/site.webmanifest` | static files from `assets/` (or `ASSETS_PATH`), cached for a week |

Every request carries its own credentials, so one deployment serves many mailboxes without
holding state:

| Header | Maps to |
|---|---|
| `X-Mail-User` / `X-Mail-Password` | `MAIL_USER` / `MAIL_PASSWORD` — `Authorization: Basic` is accepted instead |
| `X-Mail-Provider` | `MAIL_PROVIDER` |
| `X-Mail-Imap-Host`, `X-Mail-Imap-Port`, `X-Mail-Imap-Secure` | the incoming server |
| `X-Mail-Smtp-Host`, `X-Mail-Smtp-Port`, `X-Mail-Smtp-Secure` | the outgoing server |
| `X-Mail-From`, `X-Mail-From-Name` | the From header |
| `X-Mail-Default-Folder` | `MAIL_DEFAULT_FOLDER` |
| `X-Mail-Read-Only`, `X-Mail-Allowed-Recipients`, `X-Mail-Allowed-Folders` | the guard rails above |
| `X-Mail-Auth-Type` | `oauth2` to send a token instead of a password |

TLS verification, timeouts, the size caps and `MAIL_ALLOWED_TOOLS` are deliberately **not** header-controlled: they
are process-wide and belong to whoever runs the deployment. Attaching files from disk is forced
off, because in hosted mode "the local disk" is the server's, not the caller's.

Without an allowlist the server refuses private addresses (`localhost`, RFC 1918 ranges,
`169.254.*`, `*.internal`, `*.local`) so a public deployment cannot be used to probe the network
it runs in. `MAIL_ALLOWED_HOSTS=imap.example.com,smtp.example.com` narrows it to named hosts.

```bash
docker build -t mail-mcp .
docker run -p 8080:8080 -e MAIL_ALLOWED_HOSTS=imap.example.com,smtp.example.com mail-mcp
```

**What hosting costs you.** The mailbox password passes through the host on every request. The
server keeps nothing — no accounts, no database, nothing written to disk, one throwaway server
instance per request — but a mailbox password is not a scoped token, and no amount of "we store
nothing" changes that. Run it yourself, or run it locally over stdio, whenever that matters.

### Connection reuse

Logging in to IMAP costs a TLS handshake and a round trip, and providers rate-limit repeated
logins hard. Authenticated connections are therefore pooled per mailbox and kept warm for five
idle minutes, shared across requests in hosted mode. Work on one connection is serialised,
because a single IMAP connection has one selected folder at a time.

### Deploying

`deploy.sh` does the whole cycle on the server — pull, build, swap the container, verify, purge
the CDN cache:

```bash
./deploy.sh                # the usual deploy
./deploy.sh --page-only    # only replace landing.html in the running container, no rebuild
./deploy.sh --no-pull      # deploy the working tree as it is
./deploy.sh --logs         # follow the container log afterwards
```

Copy `deploy.env.example` to `deploy.env` on the server and set the port, container name,
`PUBLIC_URL` and, if the site sits behind Cloudflare, a zone id and an API token with the Cache
Purge permission. `deploy.env` is git-ignored, so server-specific values stay there.

The previous image is tagged `:previous` before every build, and a failed health check restores
it automatically and exits non-zero, so a broken build never stays deployed.

### Landing page assets

`assets/` holds everything the page references: `favicon.svg` (the source of every raster icon),
`favicon.ico`, the touch and PWA icons, `site.webmanifest`, and `og-image.png` — the 1200×630
preview, rendered from `assets/og-card.html`.

The PNG and ICO files are committed, so a normal build needs nothing extra. Regenerate them only
after editing `favicon.svg` or `og-card.html`:

```bash
npm run assets      # headless Chrome does the rasterising; set CHROME=… if it is not found
```

---

## Development

```bash
npm run build       # compile
npm run dev         # tsc --watch
npm run typecheck   # types only
npm test            # compile, then run test/ with node --test; no mailbox needed
npm run start       # stdio mode
npm run start:http  # hosted mode on PORT (default 8080)
```

Layout:

```
src/
  index.ts          entry point, picks stdio or HTTP
  server.ts         builds a configured MCP server with every tool registered
  http.ts           hosted mode: landing page, stateless /mcp, per-request credentials
  config.ts         configuration from environment or headers
  providers.ts      host presets for the common mail services
  mail-client.ts    IMAP connection pool, folder resolution, bodies, attachments, SMTP
  mime.ts           charsets, HTML to text, addresses, quoting, subjects
  dates.ts          date arguments: ISO, `7d`, `yesterday`
  tools/
    helpers.ts      shared argument schemas, result formatting, the read-only guard
    core.ts         mail_whoami
    folders.ts      folder tree and management
    messages.ts     listing, search, reading, threads, raw source
    attachments.ts  attachment listing and download
    compose.ts      send, reply, forward, drafts
    actions.ts      flags, moving, copying, deleting
```

To add a tool, call `defineTool` in the appropriate module: error handling and the read-only
guard are wired in automatically.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `IMAP rejected the credentials` | Nearly always the account password where an app-specific one is needed, or IMAP not enabled in the provider's web interface. The message names your provider's requirement |
| `Cannot reach the SMTP server` | Submission is port 587 with STARTTLS or 465 with TLS; port 25 is blocked by most networks |
| `The server refused the message` (550/553) | The account is not allowed to send as the configured From address |
| Connect hangs, then times out | A TLS port configured as STARTTLS or the reverse. Set `IMAP_SECURE` / `SMTP_SECURE` explicitly for a non-standard port |
| `No folder X in this account` | The error lists the real folder names — providers localise them, and Gmail nests them under `[Gmail]` |
| `No message with UID N` | UIDs belong to one folder. A message that was moved has a different UID there |
| `certificate` errors | For an internal server with its own CA, set `MAIL_TLS_REJECT_UNAUTHORIZED=false` |
| `Refused: … MAIL_READ_ONLY` / `MAIL_ALLOWED_*` | Working as intended: a guard rail stopped it |
| Server will not start | Logs go to stderr with the `[mail-mcp]` prefix; usually `MAIL_USER` or `MAIL_PASSWORD` is missing |

A visual walkthrough with examples lives in `landing.html` at the repository root.
