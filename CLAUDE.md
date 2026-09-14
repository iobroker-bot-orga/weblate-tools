# weblate-tools

Tools to manage the ioBroker Weblate instance at **https://weblate.iobroker.net**.
Jobs are triggered primarily via GitHub workflows, but **every tool must also be
usable interactively** from the command line.

## Language & conventions

- Language: **JavaScript** (CommonJS, Node.js >= 18).
- Use **async/await with try/catch**. Do **not** use `.then().catch()` chains.
- All **logging is in English** and supports two levels: **info** and **debug**.
- Scripts live in the **`lib/`** directory.

## Module layout

- `lib/config.js` — static, non-secret configuration constants. First constant
  is `WEBLATE_URL` (`https://weblate.iobroker.net`). No secrets here.
- `lib/common.js` — shared helpers: the logger (`log`, `setLogLevel`,
  `isDebugEnabled`), `maskSensitive`/`maskToken`, and env helpers
  (`requireEnv`, `getEnv`).
- `lib/weblateTools.js` — Weblate REST access. Owns its **own axios instance**
  (`getWeblateClient`). Helpers: `getPaginated`, `getProjectComponents`,
  `getProject`.
- `lib/githubTools.js` — GitHub REST access. Owns its **own axios instance**
  (`getGithubClient`).

**No global axios instance** — Weblate and GitHub each use a separate instance
created via `axios.create()`.

## Authorization & secrets

- All REST operations are **authorized**.
- Weblate: token from env var **`WEBLATE_TOKEN`**, sent as `Authorization: Token <token>`.
- GitHub: token from env var **`GITHUB_TOKEN`**, sent as `Authorization: Bearer <token>`.
- Both axios instances install **request/response interceptors** that log at
  **debug** level and **mask** tokens and other sensitive data via
  `maskSensitive` before anything is logged.
- Workflows read the GitHub secret `WEBLATE_TOKEN` and pass it to scripts via
  the `WEBLATE_TOKEN` env var.

## Weblate API

- REST API docs: https://docs.weblate.org/en/latest/api.html
- **Important:** confirm the documented API version matches the Weblate release
  actually running at weblate.iobroker.net before relying on newer endpoints.
  (The server was unreachable from the dev environment at initial setup, so the
  version was not verified — code uses long-stable endpoints and cursor
  pagination via the `next` link.)

## Scripts & workflows

- `lib/checkStatus.js` — connects to Weblate and lists all components of a
  project (component names via **info** logging; REST ops at **debug**).
  Components are listed **alphabetically**; locked ones are flagged with
  `🔴 LOCKED`; a summary reports the total processed, locked and unlocked
  counts. Lock state is resolved **authoritatively** via
  `GET /api/components/{project}/{component}/lock/` for every component — the
  components-list `locked` field is unreliable (can report `false` for a locked
  component) and is intentionally ignored. Lock requests use bounded
  concurrency (`mapWithConcurrency` in `common.js`) to avoid overloading the
  slow server.
  - Interactive: `WEBLATE_TOKEN=... node lib/checkStatus.js --project <slug> [--debug]`
  - Also reads `PROJECT`/`INPUT_PROJECT` and `DEBUG`/`INPUT_DEBUG` env vars.
- `.github/workflows/check-status.yml` — **"check status"**, manual
  (`workflow_dispatch`) with inputs `project` (string) and `debug` (boolean).
- `lib/addAdapter.js` — creates a Weblate component for an ioBroker adapter
  GitHub repository. Parses the repo reference (full URL or shortform
  `owner/ioBroker.adaptername`), resolves the head branch (main/master) from
  repo metadata, retrieves the repo tree and **evaluates all `i18n` directories**
  (`lib/i18nEvaluation.js`): each is flat or nested; directories under a
  `build/` folder are ignored; an `admin/` tree whose **English file** is
  identical to a tree outside `admin/` is ignored as a duplicate. The **main**
  directory is chosen in order: valid `admin/i18n` → the tree that `admin/i18n`
  duplicates (if it was removed as a duplicate) → `src-admin/i18n` → else
  undefined. An **evaluation report** (table sorted alphabetically: flag
  🟢 valid / 🔴 ignored, main marker, directory, flat/nested, reason, duplicate)
  is logged **always**. If no main directory is identified the run **aborts**.
  It then calculates a **component name/slug per valid i18n directory**
  (`componentNameFor`): the main directory → the base component name (adapter
  name); every other directory → `<adapterName>_<dir>` with the trailing `i18n`
  segment removed and `/` replaced by `_` (e.g. `src-admin/src/i18n` →
  `<adapter>_src-admin_src`). Each existing component is **verified** (file
  mask, VCS, attached add-ons); logged **always** (reading Weblate, so
  `WEBLATE_TOKEN` is needed even for a precheck): a **component report** table
  (flag 🟢 exists+correct / 🟡 missing / 🔴 exists+problems, name, i18n
  directory, info), a **problems** table (component + problem detected), a
  **mismatch** table listing components already linked to this repo whose slug
  is not in the expected set (component + related directory, resolving
  `weblate://` links), and a **setup summary** (which components will be created
  / fixed). The `precheckOnly` flag (`--precheck-only` / `PRECHECK_ONLY` /
  `INPUT_PRECHECK_ONLY`) stops right after the reports with **no changes** to
  Weblate. Otherwise it **processes all components**: extracts the repository
  **license** (see `lib/licenses.js`), then **creates** the missing ones (the
  main links directly to the GitHub repo; every other is a **linked** component
  `repo: weblate://<project>/<mainSlug>`) and **fixes** the existing ones
  (corrects file mask/template, corrects the main's VCS, adds missing add-ons),
  and finally logs a **change report** (`component X added`, `component X
  filemask changed to Y`, `component X add-on Y added`, …). Newly created
  components then get a repository **pull** (`pullComponentRepository`) and are
  **bulk-marked so every non-English translation is "needs editing"**
  (`markComponentNeedsEditing`). Because Weblate processes a freshly created
  component **asynchronously** (right after creation the API can report only the
  source language with zero units), it first **waits until processing finishes**
  (`waitForComponentReady`: polls until every translation has parsed units and
  at least the expected number of languages — counted from the repo tree — is
  present, with a timeout). Weblate has no bulk-edit REST endpoint, so the edit
  is done per unit via `PATCH /api/units/{id}/` (state `10` = needs editing,
  target sent unchanged). It runs in **two phases**: (1) clear "needs editing"
  on the base language (English) → "translated" (`clearNeedsEditing`), because
  while a source string is "needs editing" Weblate makes its translations
  **read-only** and they cannot be edited; (2) mark the translated strings of
  every other language as "needs editing". Because Weblate may recompute the
  translations' read-only state **asynchronously** after phase 1, phase 2
  re-fetches a language's units a few times (default 3, 2 s apart) while
  translated units are still read-only. Empty, still-read-only and
  already-fuzzy units are skipped. Any failed unit update aborts the run.
  Add-ons installed come from the shared `COMPONENT_ADDONS` list in
  `config.js` (the single source of truth, reusable by a verification job):
  `weblate.flags.same_edit`, `weblate.flags.source_edit`,
  `weblate.flags.target_edit`, `weblate.cleanup.generic`, and — only when the
  repo contains `admin/words.js` (`WORDS_TRIGGER_FILE`) — the custom "ioBroker:
  Save translations into words.js" add-on
  (`iobroker.weblate.gulp.adminLanguages2words`), whose identifier defaults to
  that value and can be overridden via the `WORDS_ADDON_NAME` env var / repo
  variable. A failure to install any add-on aborts the run. The create step
  is encapsulated (`buildComponentSpec` + `createComponent`) so multiple
  components (one per detected i18n tree) can be created later without code
  duplication — currently only the main tree is added. Every step logs at
  **info**. Defaults come from `config.js` (`DEFAULT_PROJECT`, `DEFAULT_VCS`,
  `DEFAULT_FILE_FORMAT`, `DEFAULT_BASE_LANGUAGE`, `DEFAULT_COMMIT_PENDING_AGE`,
  `REPOWEB_TEMPLATE`); base language is always `en`. Extra creation parameters:
  `repoweb` (repository browser URL, built from `REPOWEB_TEMPLATE` with the
  owner/repo filled in and Weblate's `{{branch}}`/`{{filename}}`/`{{line}}`
  markers left intact), `commit_pending_age` (`3` hours) and, when detected,
  the SPDX `license`.
- `lib/licenses.js` — static list of known licenses (`KNOWN_LICENSES`) with
  distinctive text markers, `LICENSE_FILE_NAMES`, and `detectLicense(text)`
  which matches a repository's LICENSE file content and returns the SPDX
  identifier Weblate expects (the SPDX id is the value passed to Weblate's
  `license` field). GitHub's own auto-detection is intentionally not used.
  - Interactive: `WEBLATE_TOKEN=... GITHUB_TOKEN=... node lib/addAdapter.js --repo <url-or-owner/ioBroker.name> [--precheck-only] [--debug]`
  - Also reads `REPO`/`INPUT_REPO`, `PRECHECK_ONLY`/`INPUT_PRECHECK_ONLY`,
    `DEBUG`/`INPUT_DEBUG` and the optional `WORDS_ADDON_NAME` env vars.
- `lib/i18nEvaluation.js` — evaluates a repo's `i18n` directories:
  `findI18nDirectories`, `detectFormat` (flat/nested), `evaluateI18nTrees`
  (ignores `build/`, ignores `admin/` duplicates of outside trees by comparing
  the English file JSON-canonically, selects the main directory) and
  `formatReport` (the alphabetical table).
- `.github/workflows/add-adapter.yml` — **"add adapter"**, manual
  (`workflow_dispatch`) with inputs `repo` (string, the adapter repo URL),
  `precheckOnly` (boolean) and `debug` (boolean).

**Workflow input defaults:** the `project` input defaults to `adapters`
in this and every future workflow that has a `project` parameter.

**Networking:** IPv6 is disabled process-wide — all REST access connects over
**IPv4 only** (see `createIpv4Agents` in `common.js`; used by both axios
instances). Requests to Weblate send `Content-Type: application/json`.

## Adding a new tool

1. Put the script in `lib/`.
2. Reuse `common.js` for logging/masking and `weblateTools.js`/`githubTools.js`
   for REST access — never create a global axios instance.
3. Support both CLI args and env-var input so it runs interactively and in a
   workflow.
4. Add a matching manually-triggered workflow under `.github/workflows/` that
   passes `WEBLATE_TOKEN` (and `GITHUB_TOKEN` if needed) via env.
