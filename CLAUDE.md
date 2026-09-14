# weblate-tools

Tools to manage the ioBroker Weblate instance at **https://weblate.iobroker.net**.
Jobs run primarily via manually-triggered GitHub workflows, but **every tool must
also be usable interactively** from the command line.

## Conventions

- **JavaScript** (CommonJS, Node.js >= 18). Use `async/await` with `try/catch`;
  no `.then().catch()` chains.
- Logging is **English**, two levels **info**/**debug** (`log` / `setLogLevel`
  in `lib/common.js`).
- Scripts live in **`lib/`**; each has a matching `workflow_dispatch` workflow
  in `.github/workflows/`, and takes input from both CLI args and env vars.
- **No global axios instance** — `weblateTools.js` and `githubTools.js` each
  create their own via `axios.create()`, with request/response interceptors
  that log at debug and **mask** tokens/secrets (`maskSensitive`).
- **IPv4 only** process-wide (`createIpv4Agents`); Weblate requests send
  `Content-Type: application/json`.
- `mapWithConcurrency`-based Weblate batches use at most
  **`WEBLATE_MAX_CONCURRENCY`** (5) parallel requests so the slow server is not
  overloaded. The Weblate client also retries transient failures — timeouts (up
  to 3×, after 1/2/5 min) and throttling (HTTP 429, after `Retry-After` + 30 s)
  — logging each wait at `warn`.

## Authorization & secrets

- All REST ops are authorized. Weblate token from **`WEBLATE_TOKEN`**
  (`Authorization: Token …`), GitHub token from **`GITHUB_TOKEN`**
  (`Authorization: Bearer …`). No secrets in `config.js`. Workflows pass the
  `WEBLATE_TOKEN` secret via env.

## Weblate API

Docs: https://docs.weblate.org/en/latest/api.html — the version running at
weblate.iobroker.net is unverified, so prefer long-stable endpoints and cursor
pagination (`next`). Non-obvious facts (confirmed against Weblate source / the
live server — keep these, they cost real debugging):

- The `vcs` field wants the backend **code** `github` (the "GitHub pull request"
  backend), **not** the display label.
- Component **add-ons cannot be listed** with `GET …/{component}/addons/`
  (POST-only → 405). Read them from the component object's `addons` links
  (`/api/addons/{id}/`); install via `POST …/addons/`.
- **No bulk-edit endpoint.** Set unit state per unit via `PATCH /api/units/{id}/`,
  which needs **both** `state` and a non-empty `target`. States: `0` empty,
  `10` needs-editing, `20` translated, `30` approved, `100` read-only.
- A translation is **read-only while its source string is "needs editing"** —
  clear the source (→ translated) first; the read-only recompute is
  **asynchronous**.
- A freshly created/pulled component is processed **asynchronously**
  (translations/units appear later) — wait before editing.
- The components-list `locked` field is unreliable — resolve lock state via
  `GET …/{component}/lock/`.
- Link a component to another's repo with `repo: weblate://<project>/<component>`;
  `slug` is writable (rename via PATCH `{slug,name}`).

## ioBroker specifics

- Adapter admin translations live under `admin/i18n` (or `src-admin/i18n` for
  React admin), in flat (`i18n/<lang>.json`) or nested
  (`i18n/<lang>/translations.json` — **plural**, the ioBroker convention) layout.
- Custom add-on "ioBroker: Save translations into words.js" =
  `iobroker.weblate.gulp.adminLanguages2words`, relevant only when the repo has
  `admin/words.js`.

## Tools

- **`checkStatus.js`** — lists a project's components alphabetically, flags
  locked ones (🔴, via the authoritative lock endpoint), prints a summary.
  `WEBLATE_TOKEN=… node lib/checkStatus.js --project <slug> [--debug]`.

- **`addAdapter.js`** — sets up Weblate components for an ioBroker adapter repo.
  `WEBLATE_TOKEN=… GITHUB_TOKEN=… node lib/addAdapter.js --repo <url-or-owner/ioBroker.name> [--precheck-only] [--debug]`.
  1. Evaluate all `i18n` directories (`i18nEvaluation.js`): flat vs nested;
     ignore dirs under `build/`; ignore an `admin/` tree that duplicates a
     non-admin tree (compared by the English file, JSON-canonically).
  2. Pick the **main** directory: valid `admin/i18n` → the tree it duplicates
     (if removed as a duplicate) → `src-admin/i18n` → else **abort**.
  3. Per valid directory compute a **slug** (`componentSlugFor`: main = adapter
     name; others `<adapter>_<dir>` with `i18n` stripped and `/`→`_`) and a
     **name** (`componentDisplayName`: `<adapter> (/<dir>)`).
  4. **Verify** each existing component (file mask, name, VCS, license, add-ons)
     and log reports **always** (needs `WEBLATE_TOKEN` even for a precheck),
     each line carrying slug + name: evaluation table, component table, problems
     table, mismatch table (repo-linked components with an unexpected slug — one
     whose directory matches a *missing* component is a 🟠 **rename**), and a
     setup summary.
  5. `precheckOnly` (`--precheck-only` / `PRECHECK_ONLY`) stops after the
     reports with no changes. Otherwise **process all components**: create
     missing (the main links to the GitHub repo, others are linked via
     `weblate://<project>/<mainSlug>`), rename mismatched, fix existing (file
     mask/template, name, the main's VCS, license, missing add-ons); **pull
     every component**; apply **needs-editing only to newly created**
     components; then log a **change report**.
  - Add-ons come from `COMPONENT_ADDONS` (`config.js`); other component defaults
    (project `adapters`, base language `en`, `commit_pending_age` 3, repoweb
    template) live there too.
  - **needs-editing** is per-unit (no bulk endpoint), two-phase: clear the
    English source (→ translated) so translations stop being read-only, then
    mark other languages "needs editing"; it waits for async processing and
    retries while units are still read-only.

- **`licenses.js`** — `detectLicense(text)` matches a repo LICENSE file to an
  SPDX id (Weblate's `license` value); GitHub auto-detection is intentionally
  not used.

## Adding a new tool

1. Put the script in `lib/`; reuse `common.js` (logging/masking) and
   `weblateTools.js` / `githubTools.js` (REST) — never a global axios instance.
2. Support both CLI args and env-var input (interactive + workflow).
3. Add a manually-triggered workflow passing `WEBLATE_TOKEN` (and `GITHUB_TOKEN`
   if needed) via env. A `project` input defaults to `adapters`.
