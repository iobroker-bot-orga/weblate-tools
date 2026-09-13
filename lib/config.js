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

module.exports = {
    WEBLATE_URL,
    GITHUB_API_URL,
    REQUEST_TIMEOUT_MS,
    DEFAULT_PROJECT,
    DEFAULT_VCS,
    DEFAULT_FILE_FORMAT,
    DEFAULT_BASE_LANGUAGE,
};
