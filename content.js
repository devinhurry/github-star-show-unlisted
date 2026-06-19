(() => {
  "use strict";

  const BUTTON_ID = "github-star-show-unlisted-filter";
  const STATUS_ID = "github-star-show-unlisted-status";
  const PAGINATION_ID = "github-star-show-unlisted-pagination";
  const EMPTY_ID = "github-star-show-unlisted-empty";
  const ACTIVE_CLASS = "github-star-show-unlisted-active";
  const PAGE_SIZE = 30;
  const CONCURRENCY = 6;
  const LIST_LINK_SELECTOR =
    '#profile-lists-container a[href^="/stars/"][href*="/lists/"]';
  const STAR_CARD_SELECTOR =
    "#user-starred-repos .col-12.d-block.width-full";
  const LIST_REPO_CARD_SELECTOR =
    "#user-list-repositories .col-12.d-block.width-full";

  let active = false;
  let listedRepositories = null;
  let repoToLists = null;
  const sessionListAdditions = new Map();
  let unlistedStars = null;
  let indexedUser = null;
  let indexedStarsUser = null;
  let indexingPromise = null;
  let originalResultNodes = null;
  let localPage = 1;
  let lastRenderedPage = null;
  let observerTimer = null;
  let suppressObserver = false;

  function getStarsUser() {
    const match = window.location.pathname.match(/^\/([^/]+)$/);
    const params = new URLSearchParams(window.location.search);
    return match && params.get("tab") === "stars" ? match[1] : null;
  }

  function normalizeRepositoryPath(href) {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }

    return `/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  }

  function parseDocument(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function fetchDocument(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${url}`);
    }

    return parseDocument(await response.text());
  }

  function getRepositoryFromCard(card, headingSelector) {
    const link = card.querySelector(`${headingSelector} > a[href^="/"]`);
    return link
      ? normalizeRepositoryPath(link.getAttribute("href"))
      : null;
  }

  function extractRepositories(documentRoot, cardSelector, headingSelector) {
    return [...documentRoot.querySelectorAll(cardSelector)]
      .map((card) => getRepositoryFromCard(card, headingSelector))
      .filter(Boolean);
  }

  function getSignedInUser() {
    return document.querySelector('meta[name="user-login"]')?.content || null;
  }

  async function getListUrls(user) {
    const starsDocument = await fetchDocument(
      `/${encodeURIComponent(user)}?tab=stars`,
    );
    const listLinks = [...starsDocument.querySelectorAll(LIST_LINK_SELECTOR)];
    const listUrls = listLinks.map((link) => ({
      url: new URL(link.getAttribute("href"), window.location.origin).href,
      name: link.textContent.trim(),
    }));

    if (listUrls.some((item) => !item.url.includes(`/stars/${user}/lists/`))) {
      throw new Error("GitHub returned lists for an unexpected user");
    }

    return listUrls;
  }

  function getNextPageUrl(documentRoot) {
    const nextLink = [...documentRoot.querySelectorAll(".paginate-container a")].find(
      (link) => link.textContent.trim() === "Next",
    );

    return nextLink
      ? new URL(nextLink.getAttribute("href"), window.location.origin).href
      : null;
  }

  function getPageCount(documentRoot) {
    let maxPage = 0;
    for (const link of documentRoot.querySelectorAll(".paginate-container a")) {
      const match = (link.getAttribute("href") || "").match(/[?&]page=(\d+)/);
      if (match) {
        maxPage = Math.max(maxPage, Number(match[1]));
      }
    }
    return maxPage > 1 ? maxPage : null;
  }

  function withPageQuery(url, page) {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("page", String(page));
    return parsed.href;
  }

  function createSemaphore(limit) {
    let active = 0;
    const waiters = [];
    return {
      acquire() {
        if (active < limit) {
          active += 1;
          return Promise.resolve();
        }
        return new Promise((resolve) => waiters.push(resolve));
      },
      release() {
        active -= 1;
        if (waiters.length > 0) {
          active += 1;
          waiters.shift()();
        }
      },
    };
  }

  async function withSemaphore(semaphore, fn) {
    await semaphore.acquire();
    try {
      return await fn();
    } finally {
      semaphore.release();
    }
  }

  async function fetchPaginatedDocuments(
    firstUrl,
    containerSelector,
    semaphore,
    onProgress,
  ) {
    const firstDoc = await withSemaphore(semaphore, () => fetchDocument(firstUrl));
    if (!firstDoc.querySelector(containerSelector)) {
      throw new Error(`GitHub markup was not found at ${firstUrl}`);
    }
    if (onProgress) {
      onProgress();
    }

    const documents = [firstDoc];
    const visited = new Set([firstUrl]);
    let pending = [];

    const maxPage = getPageCount(firstDoc);
    if (maxPage && maxPage > 1) {
      for (let page = 2; page <= maxPage; page++) {
        const url = withPageQuery(firstUrl, page);
        if (!visited.has(url)) {
          visited.add(url);
          pending.push(url);
        }
      }
    } else {
      const next = getNextPageUrl(firstDoc);
      if (next && !visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }

    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      const docs = await Promise.all(
        batch.map((url) =>
          withSemaphore(semaphore, async () => {
            const doc = await fetchDocument(url);
            if (onProgress) {
              onProgress();
            }
            return doc;
          }),
        ),
      );
      for (const doc of docs) {
        documents.push(doc);
        const next = getNextPageUrl(doc);
        if (next && !visited.has(next)) {
          visited.add(next);
          pending.push(next);
        }
      }
    }

    return documents;
  }

  async function indexListedRepositories(user, semaphore, onProgress) {
    const listItems = await getListUrls(user);
    const documentsPerList = await Promise.all(
      listItems.map((item) =>
        fetchPaginatedDocuments(
          item.url,
          "#user-list-repositories",
          semaphore,
          onProgress,
        ).then((documents) => ({ ...item, documents })),
      ),
    );

    const repositories = new Set();
    const repoToListsMap = new Map();
    for (const { name, url, documents } of documentsPerList) {
      for (const documentRoot of documents) {
        for (const repository of extractRepositories(
          documentRoot,
          LIST_REPO_CARD_SELECTOR,
          "h2",
        )) {
          repositories.add(repository);
          if (!repoToListsMap.has(repository)) {
            repoToListsMap.set(repository, []);
          }
          repoToListsMap.get(repository).push({ name, url });
        }
      }
    }
    return { repositories, repoToLists: repoToListsMap };
  }

  async function fetchStarDocuments(starsUser, semaphore, onProgress) {
    return fetchPaginatedDocuments(
      `/${encodeURIComponent(starsUser)}?tab=stars`,
      "#user-starred-repos",
      semaphore,
      onProgress,
    );
  }

  function buildUnlistedStars(starDocuments, listed) {
    const stars = [];
    let totalStars = 0;
    for (const documentRoot of starDocuments) {
      for (const card of documentRoot.querySelectorAll(STAR_CARD_SELECTOR)) {
        const repository = getRepositoryFromCard(card, "h3");
        if (!repository) {
          throw new Error("GitHub star card markup was not found");
        }

        totalStars += 1;
        if (!listed.has(repository)) {
          stars.push({
            html: card.outerHTML,
            repository,
          });
        }
      }
    }

    return { stars, totalStars };
  }

  const LOADING_SPINNER_SVG =
    '<svg class="github-star-show-unlisted-spinner" viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.7s" repeatCount="indefinite"/></path></svg>';

  function setStatus(message, isError = false) {
    const status = document.getElementById(STATUS_ID);
    if (!status) {
      return;
    }

    const isLoading = /^Loading/.test(message);
    const currentText = status.textContent;
    const currentIsLoading = status.classList.contains(
      "github-star-show-unlisted-loading",
    );

    if (isLoading !== currentIsLoading || currentText !== message) {
      status.classList.toggle("github-star-show-unlisted-loading", isLoading);
      status.classList.toggle("github-star-show-unlisted-error", isError);
      status.hidden = !message;
      if (isLoading) {
        status.innerHTML =
          LOADING_SPINNER_SVG + "<span>" + message + "</span>";
      } else {
        status.textContent = message;
      }
    } else if (isError !== status.classList.contains("github-star-show-unlisted-error")) {
      status.classList.toggle("github-star-show-unlisted-error", isError);
    }
  }

  function setButtonState({ label, disabled = false }) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    button.disabled = disabled;
    button.classList.toggle(ACTIVE_CLASS, active);
    button.setAttribute("aria-pressed", String(active));
    const labelElement = button.querySelector(".Button-label");
    if (labelElement.textContent !== label) {
      labelElement.textContent = label;
    }
  }

  function getStarsContainer() {
    const container = document.querySelector("#user-starred-repos");
    if (!container) {
      throw new Error("GitHub stars container was not found");
    }

    return container;
  }

  function getToolbar() {
    const toolbar = document.querySelector(
      "#user-starred-repos .d-flex.flex-column.flex-lg-row.flex-items-center",
    );
    if (!toolbar) {
      throw new Error("GitHub stars toolbar was not found");
    }

    return toolbar;
  }

  function getResultNodes(container = getStarsContainer()) {
    return [
      ...container.querySelectorAll(".col-12.d-block.width-full"),
      ...container.querySelectorAll(".paginate-container"),
      ...container.querySelectorAll(`#${EMPTY_ID}`),
    ];
  }

  function captureOriginalResults() {
    if (!originalResultNodes) {
      originalResultNodes = getResultNodes();
    }
  }

  function clearRenderedResults(container = getStarsContainer()) {
    for (const node of getResultNodes(container)) {
      node.remove();
    }
  }

  function runWithoutObserver(callback) {
    suppressObserver = true;
    try {
      callback();
    } finally {
      window.setTimeout(() => {
        suppressObserver = false;
      }, 0);
    }
  }

  function createStarCard(html, repo) {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const card = template.content.firstElementChild;
    if (!card) {
      throw new Error("Saved GitHub star card markup could not be rendered");
    }

    card.hidden = false;
    card.style.removeProperty("display");
    neutralizeIncludeFragments(card);
    if (repo) {
      addCapsulesToCard(card, repo);
    }
    return card;
  }

  function getRepoListNames(repo) {
    const names = new Set();
    if (repoToLists && repoToLists.has(repo)) {
      for (const { name } of repoToLists.get(repo)) {
        names.add(name);
      }
    }
    if (sessionListAdditions.has(repo)) {
      for (const name of sessionListAdditions.get(repo)) {
        names.add(name);
      }
    }
    return names;
  }

  function addCapsulesToCard(card, repo) {
    const h3 = card.querySelector("h3");
    if (!h3) {
      return;
    }

    card.querySelector(".github-star-show-unlisted-capsules")?.remove();

    const listNames = getRepoListNames(repo);
    if (listNames.size === 0) {
      return;
    }

    const container = document.createElement("div");
    container.className = "github-star-show-unlisted-capsules";

    for (const name of listNames) {
      const capsule = document.createElement("span");
      capsule.className = "github-star-show-unlisted-capsule";
      capsule.textContent = name;
      container.append(capsule);
    }

    h3.insertAdjacentElement("afterend", container);
  }

  function neutralizeIncludeFragments(card) {
    for (const fragment of card.querySelectorAll("include-fragment")) {
      const src = fragment.getAttribute("src");
      if (src) {
        fragment.setAttribute("data-original-src", src);
        fragment.removeAttribute("src");
      }
    }
  }

  const LIST_DIALOG_MARKER = "data-star-enhance-list-handled";

  async function loadListMenuContent(dialog) {
    const fragment = dialog.querySelector("include-fragment");
    if (!fragment || fragment.hasAttribute(LIST_DIALOG_MARKER)) {
      return;
    }
    fragment.setAttribute(LIST_DIALOG_MARKER, "");

    const src = fragment.getAttribute("data-original-src");
    if (!src) {
      return;
    }

    try {
      const response = await fetch(src, {
        headers: { Accept: "text/fragment+html" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      fragment.innerHTML = html;
      fragment.setAttribute("loaded", "");

      const loadingPanel = fragment.querySelector("[data-hide-on-error]");
      if (loadingPanel) {
        loadingPanel.hidden = true;
      }

      setupListMenuSelection(dialog, fragment);
    } catch (error) {
      fragment.classList.add("is-error");
      console.error("[GitHub Star Show Unlisted] List menu load failed:", error);
    }
  }

  function setupListMenuSelection(dialog, contentRoot) {
    const form = contentRoot.querySelector("form.js-user-list-menu-form");
    const items = [
      ...contentRoot.querySelectorAll("button.ActionListContent[role=option]"),
    ];

    if (!form || items.length === 0) {
      return;
    }

    const selectedIds = new Set();
    let dirty = false;

    for (const item of items) {
      if (item.getAttribute("aria-selected") === "true") {
        const id = item.getAttribute("data-value");
        if (id) {
          selectedIds.add(id);
        }
      }

      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = item.getAttribute("data-value");
        if (!id) {
          return;
        }
        dirty = true;
        if (selectedIds.has(id)) {
          selectedIds.delete(id);
          item.setAttribute("aria-selected", "false");
        } else {
          selectedIds.add(id);
          item.setAttribute("aria-selected", "true");
        }
      });
    }

    const submitForm = () => {
      if (!dirty) {
        return;
      }
      dirty = false;

      for (const input of form.querySelectorAll('input[name="list_ids[]"]')) {
        input.remove();
      }
      for (const id of selectedIds) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "list_ids[]";
        input.value = id;
        form.append(input);
      }
      const dirtyFlag = form.querySelector(
        'input[name="user_list_menu_dirty"]',
      );
      if (dirtyFlag) {
        dirtyFlag.value = "1";
      }

      const formData = new FormData(form);
      fetch(form.getAttribute("action") || form.action, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      })
        .then(() => {
          const card = dialog.closest(".col-12.d-block.width-full");
          const repoLink = card?.querySelector("h3 > a[href^='/']");
          const repo = repoLink
            ? normalizeRepositoryPath(repoLink.getAttribute("href"))
            : null;
          if (repo && card) {
            const names = new Set();
            for (const id of selectedIds) {
              const item = items.find(
                (i) => i.getAttribute("data-value") === id,
              );
              const name = item
                ?.querySelector(".ActionListItem-label")
                ?.textContent?.trim();
              if (name) {
                names.add(name);
              }
            }
            sessionListAdditions.set(repo, names);
            addCapsulesToCard(card, repo);
          }
        })
        .catch((error) => {
          console.error("[GitHub Star Show Unlisted] List update failed:", error);
        });
    };

    // The native <dialog> close event may not fire for cloned dialogs, so
    // watch the open attribute via MutationObserver as a fallback.
    new MutationObserver((mutations, observer) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === "open" && !dialog.hasAttribute("open")) {
          observer.disconnect();
          submitForm();
          break;
        }
      }
    }).observe(dialog, { attributes: true, attributeFilter: ["open"] });

    // Also intercept clicks on the dialog's close button.
    for (const closeBtn of dialog.querySelectorAll("[data-close-dialog-id]")) {
      closeBtn.addEventListener("click", () => {
        submitForm();
      }, { once: true });
    }
  }

  function handleListDropdownClick(event) {
    if (!active) {
      return;
    }
    const button = event.target.closest("[aria-haspopup=dialog]");
    if (!button) {
      return;
    }
    const dialogId = button.getAttribute("aria-controls");
    if (!dialogId || !dialogId.startsWith("details-user-list-")) {
      return;
    }
    const dialog = document.getElementById(dialogId);
    if (dialog) {
      void loadListMenuContent(dialog);
    }
  }

  function createPagination(pageCount) {
    const pagination = document.createElement("nav");
    pagination.id = PAGINATION_ID;
    pagination.className =
      "paginate-container github-star-show-unlisted-pagination";
    pagination.setAttribute("aria-label", "Unlisted stars pagination");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "Button Button--secondary Button--small";
    previous.textContent = "Previous";
    previous.disabled = localPage === 1;
    previous.addEventListener("click", () => {
      if (localPage > 1) {
        localPage -= 1;
        renderUnlistedPage();
      }
    });

    const pageText = document.createElement("span");
    pageText.className = "github-star-show-unlisted-page-text";
    pageText.textContent = `Page ${localPage} of ${pageCount}`;

    const next = document.createElement("button");
    next.type = "button";
    next.className = "Button Button--secondary Button--small";
    next.textContent = "Next";
    next.disabled = localPage === pageCount;
    next.addEventListener("click", () => {
      if (localPage < pageCount) {
        localPage += 1;
        renderUnlistedPage();
      }
    });

    pagination.append(previous, pageText, next);
    return pagination;
  }

  function updateUnlistedStatus(pageCount) {
    if (!listedRepositories || !unlistedStars) {
      setStatus("");
      return;
    }

    if (unlistedStars.length === 0) {
      setStatus(`No unlisted stars. ${listedRepositories.size} listed overall.`);
      return;
    }

    const start = (localPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(localPage * PAGE_SIZE, unlistedStars.length);
    setStatus(
      `Showing ${start}-${end} of ${unlistedStars.length} unlisted stars. ` +
        `${listedRepositories.size} listed overall.`,
    );
  }

  function renderUnlistedPage() {
    if (!active || !unlistedStars) {
      return;
    }

    const pageCount = Math.max(Math.ceil(unlistedStars.length / PAGE_SIZE), 1);
    localPage = Math.min(Math.max(localPage, 1), pageCount);

    runWithoutObserver(() => {
      const container = getStarsContainer();
      clearRenderedResults(container);

      const fragment = document.createDocumentFragment();
      const pageStars = unlistedStars.slice(
        (localPage - 1) * PAGE_SIZE,
        localPage * PAGE_SIZE,
      );

      if (pageStars.length === 0) {
        const empty = document.createElement("div");
        empty.id = EMPTY_ID;
        empty.className = "github-star-show-unlisted-empty";
        empty.textContent = "No unlisted stars found.";
        fragment.append(empty);
      } else {
        for (const star of pageStars) {
          fragment.append(createStarCard(star.html, star.repository));
        }
      }

      fragment.append(createPagination(pageCount));
      container.append(fragment);
      lastRenderedPage = localPage;
      updateUnlistedStatus(pageCount);
    });
  }

  function restoreOriginalResults() {
    if (!originalResultNodes) {
      return;
    }

    runWithoutObserver(() => {
      const container = getStarsContainer();
      clearRenderedResults(container);
      container.append(...originalResultNodes);
      originalResultNodes = null;
    });
  }

  async function enableFilter() {
    active = true;
    localPage = 1;
    captureOriginalResults();
    setButtonState({ label: "Loading...", disabled: true });
    setStatus("Loading lists and stars...");

    try {
      indexingPromise ??= (async () => {
        const semaphore = createSemaphore(CONCURRENCY);
        let pagesFetched = 0;
        const onProgress = () => {
          pagesFetched += 1;
          setStatus(
            `Loading lists and stars... (${pagesFetched} pages loaded)`,
          );
        };

        const [listedResult, starDocuments] = await Promise.all([
          indexListedRepositories(indexedUser, semaphore, onProgress),
          fetchStarDocuments(indexedStarsUser, semaphore, onProgress),
        ]);
        const unlisted = buildUnlistedStars(
          starDocuments,
          listedResult.repositories,
        );
        return {
          listed: listedResult.repositories,
          repoToLists: listedResult.repoToLists,
          unlisted,
        };
      })();
      const result = await indexingPromise;
      listedRepositories = result.listed;
      repoToLists = result.repoToLists;
      unlistedStars = result.unlisted.stars;
      setButtonState({ label: "Unlisted" });
      renderUnlistedPage();
    } catch (error) {
      active = false;
      listedRepositories = null;
      repoToLists = null;
      sessionListAdditions.clear();
      unlistedStars = null;
      indexingPromise = null;
      lastRenderedPage = null;
      restoreOriginalResults();
      setButtonState({ label: "Unlisted" });
      setStatus(`Could not check lists: ${error.message}`, true);
      console.error("[GitHub Star Show Unlisted]", error);
    }
  }

  function disableFilter() {
    active = false;
    listedRepositories = null;
    repoToLists = null;
    sessionListAdditions.clear();
    unlistedStars = null;
    indexingPromise = null;
    localPage = 1;
    lastRenderedPage = null;
    restoreOriginalResults();
    setButtonState({ label: "Unlisted" });
    setStatus("");
  }

  function createControls(toolbar) {
    const wrapper = document.createElement("div");
    wrapper.className = "github-star-show-unlisted-controls";

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "Button--secondary Button--medium Button";
    button.setAttribute("aria-pressed", "false");
    button.innerHTML =
      '<span class="Button-content">' +
      '<span class="Button-visual Button-leadingVisual" aria-hidden="true">' +
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">' +
      '<path d="M2.5 2.75A.75.75 0 0 1 3.25 2h9.5a.75.75 0 0 1 .53 1.28L9.5 7.06v4.69a.75.75 0 0 1-.416.671l-2 1A.75.75 0 0 1 6 12.75V7.06L2.72 3.28a.75.75 0 0 1-.22-.53Zm2.56.75 2.22 2.22A.75.75 0 0 1 7.5 6.25v5.286l.5-.25V6.75a.75.75 0 0 1 .22-.53l2.72-2.72Z"></path>' +
      "</svg></span>" +
      '<span class="Button-label">Unlisted</span></span>';
    button.addEventListener("click", () => {
      if (active) {
        disableFilter();
      } else {
        void enableFilter();
      }
    });

    wrapper.append(button);
    toolbar.append(wrapper);
  }

  function createStatus(toolbar) {
    const status = document.createElement("div");
    status.id = STATUS_ID;
    status.className = "github-star-show-unlisted-status";
    status.setAttribute("aria-live", "polite");
    status.hidden = true;

    toolbar.insertAdjacentElement("afterend", status);
  }

  function initialize() {
    const starsUser = getStarsUser();
    const signedInUser = getSignedInUser();
    const toolbar = document.querySelector(
      "#user-starred-repos .d-flex.flex-column.flex-lg-row.flex-items-center",
    );

    if (!starsUser || !toolbar) {
      return;
    }

    if (!document.getElementById(BUTTON_ID)) {
      createControls(toolbar);
    }

    if (!document.getElementById(STATUS_ID)) {
      createStatus(toolbar);
    }

    if (!signedInUser) {
      restoreOriginalResults();
      active = false;
      listedRepositories = null;
      repoToLists = null;
      sessionListAdditions.clear();
      unlistedStars = null;
      indexingPromise = null;
      indexedUser = null;
      indexedStarsUser = null;
      localPage = 1;
      lastRenderedPage = null;
      setButtonState({ label: "Unlisted", disabled: true });
      setStatus("Sign in to GitHub to check your lists.", true);
      return;
    }

    if (indexedUser !== signedInUser || indexedStarsUser !== starsUser) {
      restoreOriginalResults();
      active = false;
      listedRepositories = null;
      repoToLists = null;
      sessionListAdditions.clear();
      unlistedStars = null;
      indexingPromise = null;
      localPage = 1;
      lastRenderedPage = null;
      indexedUser = signedInUser;
      indexedStarsUser = starsUser;
    }

    if (active) {
      setButtonState({
        label: unlistedStars ? "Unlisted" : "Loading...",
        disabled: !unlistedStars,
      });
      if (
        unlistedStars &&
        (lastRenderedPage !== localPage ||
          !document.body.contains(document.getElementById(PAGINATION_ID)))
      ) {
        renderUnlistedPage();
      }
    }
  }

  function scheduleInitialize() {
    if (suppressObserver) {
      return;
    }

    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(initialize, 50);
  }

  document.addEventListener("turbo:render", scheduleInitialize);
  document.addEventListener("turbo:frame-render", scheduleInitialize);
  document.addEventListener("turbo:load", scheduleInitialize);
  document.addEventListener("click", handleListDropdownClick, true);
  new MutationObserver(scheduleInitialize).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["href"],
    characterData: true,
    childList: true,
    subtree: true,
  });

  initialize();
})();
