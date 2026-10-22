# Web3 Audience Explorer

A Chrome Manifest V3 extension for researching X audiences through the **official Sorsa API v3**. Built with TypeScript and Vite. It does not open or scrape Sorsa pages, access X cookies, or send the API key to another host.

## Install

1. Install Node.js 20 or newer.
2. Run `npm ci` and `npm run build` in this folder.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this folder's **`dist`** directory.
4. Click the extension icon to open the dashboard. Enter your Sorsa API key under **API settings**. The key is stored in `chrome.storage.session` only for the browser session. You can remove it with **Forget key**.

To package a ZIP, run `npm run package`. The file is written under `release/`. Extract the ZIP before using **Load unpacked**.

If collection reports a network error, open **API settings → Test connection**. It makes one request without a key and one through the same API client as **Check quota**, using a fixed invalid test key; it never uses your stored key. A `400`, `401`, or `403` response still proves the relevant request reached the server. This check distinguishes basic extension access from trouble in the normal request path. If both checks receive HTTP responses but **Check quota** fails, verify that you entered a real, single-line Sorsa key. Never share request headers or your key.

The `webRequest` permission is scoped by the Sorsa host permission. It lets the dashboard append Chrome's network error code to a failed API request. The extension does not inspect request headers or bodies, and does not save these error codes.

## Usage

Enter an X username without `@` (for example `xrp`, `solana`, or `asterium`) and choose a mode:

- **All followers:** documented `GET /followers?username=...&next_cursor=...`, up to 200 users per page. The extension follows the returned cursor until it ends or the specified unique-account limit is reached.
- **New followers · 7 days:** documented `GET /new-followers-7d?username=...`. This separate endpoint returns one response and includes only followers tracked in Sorsa's crypto-focused database. It is not a complete list of all recent followers.

Collections are saved automatically to the extension's local IndexedDB after each page. **Stop** aborts the current HTTP request and preserves the last committed cursor. **Resume** retries that page; increase the limit if collection stopped at its limit. Closing the dashboard pauses work. Reopen it and resume. Duplicate X IDs are merged. Each record retains its username and available profile values.

**Check quota** calls the documented `GET /key-usage-info`; the displayed remaining balance is a snapshot. The request-attempt counter includes retries. `401` asks for a valid key; `403` reports access, plan, or quota restrictions; `429` respects `Retry-After` up to 60 seconds and pauses after bounded retries. Network and `5xx` errors also retry twice, then pause without moving the cursor. A missing result never becomes a made-up value.

The followers endpoint supplies username, display name, follower count, and bio when present. It **does not** include per-user Sorsa Score, category, or first-seen time. Use **Enrich scores** to explicitly run up to the selected number of extra `GET /score` requests, one per account; a `404` leaves its score blank. The new-followers endpoint supplies `followerDate`, displayed as **Followed on**. This is a follow date, not a first-seen timestamp. Per-user category and first-seen are shown only when they come from an imported CSV.

Filter on follower count, score, keyword (username/name/bio/category), and local or imported tags. Missing numeric values do not match an active numeric filter. Click a row's tag cell to annotate it locally. **Export filtered CSV** includes every matching row, not just the visible table page. The CSV uses UTF-8 with BOM and quotes/escapes fields for Excel and Google Sheets, including protection against spreadsheet formulas. **Import CSV** accepts the extension's CSV format or a CSV containing a `username` column; optional recognized columns are `account_id`, `display_name`, `followers_count`, `sorsa_score`, `category`, `first_seen`, `followed_at`, `tags`, and `description`.

All collections live in the browser profile. Deleting the extension deletes its local storage. An exported CSV stays wherever you downloaded it. Imports are marked as imported research; they are not represented as Sorsa API results.

## Build and test

```sh
npm ci
npm run build
npm test
npm run test:browser
npm run package
```

The unit tests exercise pagination and cursor precision, deduplication, stop/resume, API retry behavior, and CSV import/export. The browser smoke test runs the built dashboard in Chromium with local simulated Sorsa responses. For live API testing, load `dist` in Chrome and try a key with Sorsa account access. This environment may block `api.sorsa.io` and cannot verify your account's quota or live API response.

## API basis and limits

Implementation follows [Sorsa's official v3 OpenAPI repository](https://github.com/Sorsa-io/sorsa-mcp/blob/01b3f520375221a6a9603fef934818a80e7efb43/swagger.json) and its [endpoint declarations](https://github.com/Sorsa-io/sorsa-mcp/blob/01b3f520375221a6a9603fef934818a80e7efb43/src/endpoints.ts). The user-provided [v3 text documentation](https://api.sorsa.io/v3/static/sorsa_api_v3_documentation_en.txt) and live `api.sorsa.io` currently return `403` through this cloud environment's network gateway, so live integration requires testing in a browser that can reach Sorsa. Endpoint and field names are taken from Sorsa's published OpenAPI, with unsupported per-user values kept blank.
