# kufar-mcp

MCP server for Claude Code: prepare and publish ads on [Kufar](https://www.kufar.by), the Belarusian marketplace.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer (check with `node -v`)
- [Claude Code](https://claude.com/claude-code) (check with `claude --version`)
- A Belarusian IP address: some Kufar endpoints are closed to other countries. Turn off your VPN while using it.

## Installation

```bash
claude mcp add --scope user kufar -- npx -y kufar-mcp
```

Start a new Claude Code session and run `/mcp` — you should see `kufar ✓ connected`.

For other MCP clients (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "kufar": { "command": "npx", "args": ["-y", "kufar-mcp"] }
  }
}
```

## Where data is stored

The session and drafts live in `~/.kufar-mcp/` (`session.json` and `drafts/`). Set the `KUFAR_MCP_HOME` environment variable to use a different folder.

## Usage

Just tell Claude what you want to sell and give it the path to your photos:

```
I want to sell a bike, photos are in ~/Desktop/bike. Stels Navigator 500, used, good condition,
Minsk, 300 BYN, negotiable. Create an ad and publish it on Kufar.
```

Claude will process the photos, write the ad text, open the SMS login page if needed,
pick the category and fields, show you the result and publish only after you agree.

## Tools

| Tool | What it does |
|---|---|
| `enhance_photos` | Photo color correction |
| `create_draft` | Ad draft in `~/.kufar-mcp/drafts/` (photos + text) |
| `list_drafts` | List drafts |
| `kufar_login` | Opens the SMS login page in the browser |
| `kufar_status` / `kufar_logout` | Check / reset login |
| `kufar_categories` | Find a category ID by name |
| `kufar_category_fields` | Form fields for a category: required ones and value codes |
| `publish_ad` | Publish a draft (dry run by default) |
| `kufar_api_request` | Diagnostics: arbitrary request to the Kufar API |

## First run — test prompt

```
Check the Kufar integration step by step and report the result after each step:
1. kufar_login — I'll log in via SMS on the page that opens, then check the login.
2. kufar_status.
3. kufar_categories for "laptop".
4. list_drafts and publish_ad for the latest draft with the category found, in dry_run mode.
5. Ask me before publishing for real (dry_run=false).
If any step returns an error, show the server response and suggest what to fix in kufar-api.js.
```

## Login

`kufar_login` opens a local page `http://127.0.0.1:…` in the browser: enter your phone number, then the SMS code.
The number and code go straight to the Kufar API; Claude never sees them. The session is stored in `~/.kufar-mcp/session.json`
on this computer only and lasts about a year. The page link is valid for 10 minutes and closes right after login.

## API status (checked 2026-10-10)

| What | Endpoint | Status |
|---|---|---|
| SMS login | `cre-auth.kufar.by/v2/auth/phone/code` | ✅ works |
| Category tree | `api.kufar.by/category-tree/v1/category_tree` | ✅ works |
| Search | `cre-api.kufar.by/ads-search/v1/...` | ✅ works |
| Form fields | `api.kufar.by/insertion/v1/meta/bootstrap` | ✅ works |
| Photo upload | `ads-image-uploader.kufar.by/v1/images` | ✅ works |
| Ad creation | `api.kufar.by/insertion/v1/processing/insert` | ❓ not verified (requires a real publish) |

## If Kufar changes its API

The API is unofficial; endpoints are collected in `ENDPOINTS` at the top of `kufar-api.js`. The site keeps the current
endpoints in `window.__APP_CONFIG__` on https://www.kufar.by/ain/create, and the request format in that page's JS.
Ask Claude: "look at how kufar.by/ain/create currently uploads photos and creates an ad, and fix kufar-api.js".

## License

MIT
