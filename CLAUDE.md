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
  repo metadata, retrieves the repo tree and lists all detected `i18n`
  directories, selects `src-admin/i18n` if present else `admin/i18n`
  (aborts with an error if neither exists), determines the language file
  layout (`i18n/*.json` or `i18n/*/translation.json`), calculates the base
  component name (**identical to the adapter name**; name == slug), aborts if
  a component with that slug already exists, then creates the component. The
  create step is encapsulated (`buildComponentSpec` + `createComponent`) so
  multiple components (one per detected i18n tree) can be created later without
  code duplication — currently only the main tree is added. Every step logs at
  **info**. Defaults come from `config.js` (`DEFAULT_PROJECT`, `DEFAULT_VCS`,
  `DEFAULT_FILE_FORMAT`, `DEFAULT_BASE_LANGUAGE`); base language is always `en`.
  - Interactive: `WEBLATE_TOKEN=... GITHUB_TOKEN=... node lib/addAdapter.js --repo <url-or-owner/ioBroker.name> [--debug]`
  - Also reads `REPO`/`INPUT_REPO` and `DEBUG`/`INPUT_DEBUG` env vars.
- `.github/workflows/add-adapter.yml` — **"add adapter"**, manual
  (`workflow_dispatch`) with inputs `repo` (string, the adapter repo URL) and
  `debug` (boolean).

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
