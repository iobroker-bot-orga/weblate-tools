'use strict';

/**
 * Static configuration data for the weblate-tools.
 *
 * This module contains only static, non-secret configuration constants.
 * Secrets (tokens) are never stored here; they are read from environment
 * variables at runtime (see lib/common.js).
 */

/** Base URL of the ioBroker Weblate server. */
const WEBLATE_URL = 'https://weblate.iobroker.net';

/** Base URL of the GitHub REST API. */
const GITHUB_API_URL = 'https://api.github.com';

/**
 * Default request timeout in milliseconds for REST operations.
 *
 * The ioBroker Weblate server can be very slow: a single request may take up
 * to a minute to answer. The timeout is therefore set to 120 s (2 minutes) to
 * leave comfortable headroom and avoid premature client-side timeouts. It can
 * be overridden via the REQUEST_TIMEOUT_MS environment variable.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) > 0
    ? Number(process.env.REQUEST_TIMEOUT_MS)
    : 120000;

/**
 * Default Weblate project a new component is added to. Used whenever no more
 * specific project is provided. `name` is the human-readable project name,
 * `slug` is the project slug used in Weblate URLs and the REST API.
 */
const DEFAULT_PROJECT = {
    name: 'iobroker Adapters',
    slug: 'adapters',
};

/**
 * Default version-control-system integration used for new components.
 *
 * This is Weblate's internal VCS backend *code* (not the human-readable label
 * "GitHub pull request"): `'github'` selects the GitHub backend, which pushes
 * translation changes back as pull requests instead of committing directly.
 * The API rejects the display label with `"... is not a valid choice."`.
 */
const DEFAULT_VCS = 'github';

/** Default Weblate file format used for new components (monolingual JSON). */
const DEFAULT_FILE_FORMAT = 'json';

/** Base (source) language used for new components. */
const DEFAULT_BASE_LANGUAGE = 'en';

/**
 * Default age (in hours) of pending changes before Weblate commits them to the
 * repository (`commit_pending_age`). New components use 3 hours.
 */
const DEFAULT_COMMIT_PENDING_AGE = 3;

/**
 * Template for the Weblate "Repository browser" URL (`repoweb`). The
 * `{owner}`/`{repo}` placeholders are filled with the GitHub owner and
 * repository name; the `{{branch}}`, `{{filename}}` and `{{line}}` markers are
 * left intact for Weblate to substitute at runtime.
 */
const REPOWEB_TEMPLATE = 'https://github.com/{owner}/{repo}/blob/{{branch}}/{{filename}}#L{{line}}';

/**
 * Repository file whose presence triggers installation of the ioBroker
 * words.js add-on (see WORDS_ADDON_NAME / the COMPONENT_ADDONS entry).
 */
const WORDS_TRIGGER_FILE = 'admin/words.js';

/**
 * API identifier (`name`) of the custom "ioBroker: Save translations into
 * words.js" add-on. This is instance-specific and NOT a built-in Weblate
 * add-on, so it is left empty here and must be supplied via the
 * WORDS_ADDON_NAME environment variable (retrieve it from an existing
 * component: GET /api/components/adapters/<slug>/addons/).
 */
const WORDS_ADDON_NAME = process.env.WORDS_ADDON_NAME || '';

/**
 * The canonical list of Weblate add-ons a new component should have. This is
 * the single source of truth, shared by the component-creation flow (which
 * installs them) and by a verification job (which can check that an existing
 * component has exactly these add-ons).
 *
 * Each entry:
 *   - `name`          - the add-on's API identifier.
 *   - `configuration` - add-on-specific settings (empty when none needed).
 *   - `triggerFile`   - optional; when set, the add-on only applies to repos
 *                       that contain this file.
 *
 * The first four are Weblate's stable built-in add-ons:
 *   - weblate.flags.same_edit    → Flag unchanged translations as "Needs editing"
 *   - weblate.flags.source_edit  → Flag new source strings as "Needs editing"
 *   - weblate.flags.target_edit  → Flag new translations as "Needs editing"
 *   - weblate.cleanup.generic    → Cleanup translation files
 *
 * The last entry is the CUSTOM "ioBroker: Save translations into words.js"
 * add-on. It is instance-specific (not built into Weblate) and only applies to
 * repositories that contain `admin/words.js` (WORDS_TRIGGER_FILE). Its API
 * identifier is not hard-coded because it is specific to weblate.iobroker.net;
 * it comes from WORDS_ADDON_NAME. When that is empty the entry has an empty
 * `name` and consumers skip it (the creation flow warns; a verification job
 * cannot assert an add-on whose identifier is unknown).
 */
const COMPONENT_ADDONS = [
    { name: 'weblate.flags.same_edit', configuration: {} },
    { name: 'weblate.flags.source_edit', configuration: {} },
    { name: 'weblate.flags.target_edit', configuration: {} },
    { name: 'weblate.cleanup.generic', configuration: {} },
    { name: WORDS_ADDON_NAME, configuration: {}, triggerFile: WORDS_TRIGGER_FILE },
];

module.exports = {
    WEBLATE_URL,
    GITHUB_API_URL,
    REQUEST_TIMEOUT_MS,
    DEFAULT_PROJECT,
    DEFAULT_VCS,
    DEFAULT_FILE_FORMAT,
    DEFAULT_BASE_LANGUAGE,
    DEFAULT_COMMIT_PENDING_AGE,
    REPOWEB_TEMPLATE,
    COMPONENT_ADDONS,
    WORDS_TRIGGER_FILE,
    WORDS_ADDON_NAME,
};
