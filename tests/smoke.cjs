const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

async function getVisibleListedRepositories(page) {
  return page.evaluate(async () => {
    const normalize = (href) => {
      const url = new URL(href, location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length === 2
        ? `/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
        : null;
    };
    const listed = new Set();
    const listUrls = [
      ...document.querySelectorAll(
        '#profile-lists-container a[href^="/stars/"][href*="/lists/"]',
      ),
    ].map((link) => link.href);

    for (const listUrl of listUrls) {
      const html = await fetch(listUrl).then((response) => response.text());
      const listDocument = new DOMParser().parseFromString(html, "text/html");
      for (const card of listDocument.querySelectorAll(
        "#user-list-repositories .col-12.d-block.width-full",
      )) {
        const repository = normalize(
          card.querySelector('h2 > a[href^="/"]')?.href || "",
        );
        if (repository) {
          listed.add(repository);
        }
      }
    }

    return [
      ...document.querySelectorAll(
        "#user-starred-repos .col-12.d-block.width-full",
      ),
    ]
      .map((card) => {
        return normalize(card.querySelector('h3 > a[href^="/"]')?.href || "");
      })
      .filter((repository) => repository && listed.has(repository));
  });
}

async function assertUnlistedRendered(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector("#github-star-show-unlisted-filter");
    const status = document.querySelector("#github-star-show-unlisted-status");
    return (
      button?.getAttribute("aria-pressed") === "true" &&
      /^Showing \d+-\d+ of \d+ unlisted stars\. \d+ listed overall\.$/.test(
        status?.textContent || "",
      )
    );
  });
  assert.deepEqual(await getVisibleListedRepositories(page), []);
  assert.equal(await page.locator("#github-star-show-unlisted-pagination").count(), 1);
}

async function main() {
  const extensionPath = path.resolve(__dirname, "..");
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "github-star-show-unlisted-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.head && !document.querySelector('meta[name="user-login"]')) {
          const meta = document.createElement("meta");
          meta.name = "user-login";
          meta.content = "devinhurry";
          document.head.append(meta);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto("https://github.com/devinhurry?tab=stars", {
      waitUntil: "domcontentloaded",
    });

    const button = page.locator("#github-star-show-unlisted-filter");
    await button.waitFor();
    await button.click();

    const status = page.locator("#github-star-show-unlisted-status");
    await status.waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector("#github-star-show-unlisted-status");
      return /^Showing \d+-\d+ of \d+ unlisted stars\. \d+ listed overall\.$/.test(
        element?.textContent || "",
      );
    });

    const active = await button.getAttribute("aria-pressed");
    const statusText = await status.textContent();
    const statusLayout = await status.evaluate((element) => ({
      parentWidth: element.parentElement.getBoundingClientRect().width,
      statusWidth: element.getBoundingClientRect().width,
      toolbarIsPreviousSibling: element.previousElementSibling?.matches(
        ".d-flex.flex-column.flex-lg-row.flex-items-center",
      ),
    }));

    assert.equal(active, "true");
    assert.match(
      statusText,
      /^Showing \d+-\d+ of \d+ unlisted stars\. \d+ listed overall\.$/,
    );
    assert.equal(statusLayout.toolbarIsPreviousSibling, true);
    assert.ok(statusLayout.statusWidth >= statusLayout.parentWidth - 1);
    await assertUnlistedRendered(page);

    const nextPage = page.locator("#github-star-show-unlisted-pagination button", {
      hasText: "Next",
    });
    if ((await nextPage.count()) && !(await nextPage.isDisabled())) {
      const firstRepository = await page
        .locator("#user-starred-repos h3 > a")
        .first()
        .textContent();
      await nextPage.click();
      await page.waitForFunction(
        (previousFirstRepository) =>
          document
            .querySelector("#user-starred-repos h3 > a")
            ?.textContent.trim() !== previousFirstRepository.trim(),
        firstRepository,
      );
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      await assertUnlistedRendered(page);
    }

    await button.click();
    assert.equal(await page.locator("#github-star-show-unlisted-pagination").count(), 0);
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    assert.equal(
      await page
        .locator("#user-starred-repos .col-12.d-block.width-full")
        .evaluateAll((cards) =>
          cards.some((card) => getComputedStyle(card).display === "none"),
        ),
      false,
    );

    console.log(JSON.stringify({ statusText }, null, 2));
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
