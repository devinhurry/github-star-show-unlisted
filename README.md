# GitHub Star Show Unlisted

> A Chrome extension that filters **unlisted starred repositories** on GitHub
> profile star pages — showing only the stars that aren't in any of your GitHub
> Star Lists.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

GitHub lets you organize starred repositories into **Star Lists**, but there's
no built-in way to see which starred repos _aren't_ in any list. This extension
adds an **Unlisted** button to every GitHub profile star page that does exactly
that — it cross-references all starred repos against every list (including
private lists) and shows only the unlisted ones, paginated locally.

## Features

- **Unlisted filter** — One click hides every starred repo that already belongs
  to a list, leaving only the ones you still need to organize.
- **List membership capsules** — Each unlisted star card shows colored pill
  badges for the lists it's already in, so you can see membership at a glance.
- **Add to list from the card** — The star card's list dropdown works on
  filtered results. Add a repo to a list and its capsule appears instantly.
- **Fast parallel loading** — List pages and star pages are fetched
  concurrently with a shared connection pool, so profiles with hundreds of
  stars load in a fraction of the time.
- **Live progress** — A spinner and page counter show loading progress while
  lists and stars are being indexed.
- **Local pagination** — Unlisted results are paginated client-side with
  Previous / Next controls, no extra network round-trips.
- **Private lists supported** — Reads lists through your signed-in browser
  session, so private lists are included in the comparison.
- **Graceful errors** — If GitHub's markup changes or a request fails, the
  extension shows an error and leaves all stars visible.

## Install

### From source (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this project directory.

The **Unlisted** button will appear on the toolbar of any GitHub profile star
page, e.g. `https://github.com/<username>?tab=stars`.

## How it works

1. When you click **Unlisted**, the extension reads the signed-in account's
   Star Lists from the GitHub list pages using your current browser session.
2. In parallel, it fetches every page of starred repositories for the profile
   you're viewing.
3. It cross-references the two sets and keeps only the repos that aren't in any
   list.
4. The unlisted repos are rendered with local pagination, and each card shows
   capsules for the lists it belongs to (if any were added during the session).

GitHub does not provide a public API for Star Lists, so the extension reads the
existing GitHub list pages directly. You must be signed in to GitHub for list
detection to work.

## Project structure

```
.
├── manifest.json   # Chrome extension manifest (MV3)
├── content.js      # Content script: filtering, dropdowns, capsules
├── styles.css      # Extension styles (capsules, spinner, pagination)
├── tests/
 │   └── smoke.cjs  # Playwright smoke test against a live profile
└── README.md
```

## Development

### Run the smoke test

The smoke test uses [Playwright](https://playwright.dev) to load the extension
into a headless Chromium and verify the end-to-end flow against a live GitHub
profile.

```bash
npm install playwright
node tests/smoke.cjs
```

> The test targets a real public GitHub profile and requires network access.
> It injects a mock `user-login` meta tag so the extension treats the session
> as signed in.

## Limitations

- The extension depends on GitHub's current DOM markup. If GitHub changes the
  star card or list page structure, the extension may need updating.
- Star and list pages are fetched with the browser session, so rate limits and
  private-list visibility follow whatever account is signed in.
- In-session list additions are tracked in memory; navigating away or reloading
  re-indexes from GitHub.

## License

MIT — see [LICENSE](LICENSE).
