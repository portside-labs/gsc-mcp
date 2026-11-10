# Google Search Console MCP server

[![npm](https://img.shields.io/npm/v/@portside-labs/gsc-mcp)](https://www.npmjs.com/package/@portside-labs/gsc-mcp)
[![CI](https://github.com/portside-labs/gsc-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/portside-labs/gsc-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect Claude Desktop, Claude Code or any other MCP client to **Google Search Console** and use your real search data to improve the SEO of your websites and landing pages.

Ask things like:

- "Which of my landing pages could get the most extra traffic, and what should I change?"
- "Rewrite the title and meta description for /pricing based on the queries it ranks for."
- "Why did organic traffic drop last month?"
- "Are all the URLs in my sitemap indexed?"
- "Which pages are competing with each other for the same keywords?"

It runs **locally** on your machine over stdio. Your Google credentials are stored on your computer and only sent to Google.

## What it can do

| Tool | What it does |
| --- | --- |
| `performance_summary` | Clicks, impressions, CTR and position versus the previous period or last year, with trend, top queries, top pages, devices and countries. |
| `find_quick_wins` | "Striking distance" queries (position 4-20 by default) ranked by the extra clicks you would get at the top, using your site's own CTR curve. |
| `find_ctr_opportunities` | Pages or queries that rank well but get fewer clicks than they should: title and meta description rewrite candidates, with the queries to target. |
| `compare_periods` | Biggest gains, losses, new and lost pages or queries between two periods. Good for traffic drops and content decay. |
| `find_cannibalization` | Queries where two or more of your pages split impressions. |
| `analyze_page` | Deep dive on one URL: performance, every query it ranks for, striking-distance terms, Google index status and a live on-page audit, including whether the top queries appear in the title, H1 and description. |
| `audit_page` | On-page audit of any public URL: status and redirects, title, meta description, headings, canonical, robots, hreflang, Open Graph, JSON-LD, word count, image alt text, links. No Search Console access needed. |
| `inspect_urls` | URL Inspection for a list of URLs or every URL in a sitemap: indexed or not, coverage state, last crawl, canonical chosen by Google, rich result issues. |
| `search_analytics` | Raw Search Analytics queries with any dimensions (query, page, country, device, date, hour, search appearance), filters and search types (web, image, video, news, Discover, Google News). |
| `list_sites` | Your Search Console properties. |
| `list_sitemaps` / `submit_sitemap` / `delete_sitemap` | Sitemap status and management. Submitting and deleting needs write access. |
| `auth_status` / `login` | Connection status and browser sign-in from inside Claude. |

It also ships three prompts (slash commands in Claude Code, the "+" menu in Claude Desktop): `seo_audit`, `optimize_page` and `investigate_traffic_drop`.

Tools accept a property in any form: `sc-domain:example.com`, `https://www.example.com/`, or just `example.com`. Dates are Pacific Time like Search Console itself, and the default period is the last 28 days of final data.

## Setup

You need a Google account with access to at least one Search Console property, and Node.js 20 or later.

### 1. Create a Google OAuth client (one time, about 5 minutes)

Google requires every app that reads Search Console data to have its own OAuth client. You create one in your own Google Cloud project, so no third party ever sees your data or tokens.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick an existing one), for example "Search Console MCP".
2. Enable the **Google Search Console API**: [APIs & Services > Library > Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) > **Enable**.
3. Configure the consent screen under [Google Auth Platform](https://console.cloud.google.com/auth/overview): pick **External** as the audience (or **Internal** if you use Google Workspace and only need your organization's accounts), give it a name and your email.
4. Under **Audience**, click **Publish app** so it is "In production". In "Testing" mode Google expires your sign-in every 7 days. Since this app is only for you, you do not need Google's verification; you will see a "Google hasn't verified this app" screen when signing in, where you click **Advanced > Go to (your app name)**.
5. Under [**Clients**](https://console.cloud.google.com/auth/clients), click **Create client**, choose **Desktop app**, and **Download JSON**.

### 2. Sign in

```bash
npx @portside-labs/gsc-mcp auth --client-secret-file ~/Downloads/client_secret_XXXX.apps.googleusercontent.com.json
```

Your browser opens for Google sign-in. Afterwards the command prints the properties you can access. Credentials are saved to `~/.config/gsc-mcp/credentials.json` (`%APPDATA%\gsc-mcp` on Windows) with owner-only permissions.

By default the server gets **read-only** access. To let it submit and delete sitemaps, add `--write`.

### 3. Add it to Claude

**Claude Code**

```bash
claude mcp add gsc --scope user -- npx -y @portside-labs/gsc-mcp
```

**Claude Desktop**

Open **Settings > Developer > Edit Config** and add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": ["-y", "@portside-labs/gsc-mcp"]
    }
  }
}
```

Restart Claude Desktop. If it cannot find `npx` (common with nvm), use the full path from `which npx` as the `command`.

Alternatively, download the `.mcpb` bundle from the [latest release](https://github.com/portside-labs/gsc-mcp/releases) and double-click it to install. Enter your OAuth client ID and secret in the settings dialog, then ask Claude to "sign in to Search Console".

**Other MCP clients** (Cursor, VS Code, Windsurf and so on): run `npx -y @portside-labs/gsc-mcp` as a stdio server.

### Signing in from inside Claude

If you would rather not use a terminal, give the server your OAuth client through its environment and ask Claude to sign in. The `login` tool opens your browser and finishes the sign-in on its own:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": ["-y", "@portside-labs/gsc-mcp"],
      "env": {
        "GSC_OAUTH_CLIENT_ID": "1234-abc.apps.googleusercontent.com",
        "GSC_OAUTH_CLIENT_SECRET": "GOCSPX-..."
      }
    }
  }
}
```

### Using a service account instead

Useful for automation, or for properties you do not own personally:

1. In Google Cloud, create a service account and a JSON key, and enable the Search Console API in that project.
2. In [Search Console](https://search.google.com/search-console) > **Settings > Users and permissions**, add the service account's email (`...@....iam.gserviceaccount.com`) as a user with Full or Restricted permission.
3. Set `GSC_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json` in the server's environment.

Application Default Credentials work too when you opt in with `GSC_AUTH=adc` (the server ignores `GOOGLE_APPLICATION_CREDENTIALS` otherwise, since it is often set for unrelated projects). With gcloud, sign in with the Search Console scope and set a quota project:

```bash
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/cloud-platform
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `GSC_DEFAULT_SITE` | Property to use when a request does not name one, e.g. `sc-domain:example.com`. |
| `GSC_MCP_READ_ONLY=1` | Hide `submit_sitemap` and `delete_sitemap` and request only the read-only scope. |
| `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` | OAuth client for the `login` tool (alternative: `GSC_OAUTH_CLIENT_FILE` with the path to the downloaded JSON). |
| `GSC_SERVICE_ACCOUNT_KEY_FILE` | Use a service account key instead of OAuth. |
| `GSC_AUTH=adc` | Use Application Default Credentials (gcloud or `GOOGLE_APPLICATION_CREDENTIALS`). |
| `GSC_MCP_HOME` | Where credentials are stored. Default `~/.config/gsc-mcp`. Use different values to run several Google accounts side by side. |
| `GSC_MCP_CREDENTIALS` | Full path of the credentials file, overriding `GSC_MCP_HOME`. |
| `GSC_MCP_ALLOW_PRIVATE_URLS=1` | Let `audit_page` fetch `localhost` and private network addresses, e.g. to audit a staging site. Off by default. |

## CLI

```
npx @portside-labs/gsc-mcp           # start the MCP server (what Claude runs)
npx @portside-labs/gsc-mcp auth      # sign in (add --write for sitemap changes, --no-browser to print the URL)
npx @portside-labs/gsc-mcp status    # show the connected account and its properties
npx @portside-labs/gsc-mcp logout    # revoke and delete saved credentials
```

## How the opportunity scoring works

- **Expected CTR** for each position comes from your own site: the median CTR of your queries at that rounded position. Positions with fewer than 8 queries of at least 20 impressions fall back to a conservative industry benchmark. Medians keep a few branded queries from distorting the curve. Every response shows the curve it used.
- **Quick wins** estimate `impressions × expected CTR at the target position − current clicks`.
- **CTR opportunities** flag rows whose CTR is below 70% of the expected CTR for their position, ranked by missed clicks.
- Exclude your brand with `excludeQueryRegex` (RE2 syntax, e.g. `(?i)acme|acme corp`) for cleaner results.

Search Console hides rare "anonymized" queries, so query-level numbers add up to less than the property totals. The analysis tools read up to 25,000 rows per breakdown (one API request), sorted by clicks; on bigger properties they say so in a `note` and you can narrow with `pageRegex` or `queryRegex`.

## Privacy and security

- The server runs on your machine and talks only to Google's APIs and to the URLs you ask it to audit.
- OAuth uses PKCE and a one-time listener on `127.0.0.1`. The refresh token is stored in a file only your user can read. `logout` revokes it with Google.
- `audit_page`, `analyze_page` and sitemap reading refuse `localhost`, private and link-local addresses (such as cloud metadata endpoints) unless you set `GSC_MCP_ALLOW_PRIVATE_URLS=1`. The check runs on the address actually connected to, on every redirect, so DNS rebinding cannot get around it.
- Page content fetched for audits is untrusted. The server returns extracted fields (title, headings and so on), not the raw page.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Your Google sign-in has expired or was revoked" every week | Your consent screen is in Testing mode. Publish it (setup step 4) and sign in again. |
| "The Google Search Console API is not enabled" | Enable it for the project your OAuth client belongs to (setup step 2). |
| `access_denied` during sign-in | Publish the app, or add your Google account as a test user under **Audience**. |
| No properties listed | The account has no verified properties, or you signed in with a different Google account. Check `npx @portside-labs/gsc-mcp status`. |
| "does not have sufficient access" for a property | Use the exact property from `list_sites`. Restricted users cannot see some data. |
| Sitemap submit fails with a scope error | Sign in again with `auth --write` (or the `login` tool with `write: true`). |
| Claude Desktop shows the server as failed | Check the logs in `~/Library/Logs/Claude/mcp-server-gsc.log` (macOS) or `%APPDATA%\Claude\logs` (Windows). A missing `npx` on the PATH is the usual cause. |

## Development

```bash
npm install
npm run build        # compile to dist/
npm test             # unit and in-memory MCP integration tests
npm run typecheck
npm run pack:mcpb    # build the Claude Desktop bundle
```

Try a local build with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/cli.js`.

The tests run against an in-memory fake of the Search Console API (`test/fakes.ts`), so they need no Google account.

## License

MIT © Portside Labs
