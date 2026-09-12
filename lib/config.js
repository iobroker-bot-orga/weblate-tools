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

/** Default request timeout in milliseconds for REST operations. */
const REQUEST_TIMEOUT_MS = 30000;

module.exports = {
    WEBLATE_URL,
    GITHUB_API_URL,
    REQUEST_TIMEOUT_MS,
};
