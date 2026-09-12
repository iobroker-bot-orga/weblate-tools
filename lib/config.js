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

module.exports = {
    WEBLATE_URL,
    GITHUB_API_URL,
    REQUEST_TIMEOUT_MS,
};
