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
  (`getWeblateClient`). Helpers: `getPaginated`, `listProjectComponents`,
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
  - Interactive: `WEBLATE_TOKEN=... node lib/checkStatus.js --project <slug> [--debug]`
  - Also reads `PROJECT`/`INPUT_PROJECT` and `DEBUG`/`INPUT_DEBUG` env vars.
- `.github/workflows/check-status.yml` — **"check status"**, manual
  (`workflow_dispatch`) with inputs `project` (string) and `debug` (boolean).

**Workflow input defaults:** the `project` input defaults to `ioBroker Adapters`
in this and every future workflow that has a `project` parameter.

## Adding a new tool

1. Put the script in `lib/`.
2. Reuse `common.js` for logging/masking and `weblateTools.js`/`githubTools.js`
   for REST access — never create a global axios instance.
3. Support both CLI args and env-var input so it runs interactively and in a
   workflow.
4. Add a matching manually-triggered workflow under `.github/workflows/` that
   passes `WEBLATE_TOKEN` (and `GITHUB_TOKEN` if needed) via env.
