'use strict';

/**
 * Common routines for accessing the ioBroker Weblate instance via its REST API.
 *
 * Weblate REST API reference: https://docs.weblate.org/en/latest/api.html
 * (Confirm the documented version matches the release running at
 * weblate.iobroker.net before relying on newer endpoints.)
 *
 * A dedicated axios instance is used for Weblate (no global axios instance).
 * All REST operations are authorized using the token from the WEBLATE_TOKEN
 * environment variable, and are logged at debug level. Sensitive data is
 * masked before logging.
 */

const axios = require('axios');
const { WEBLATE_URL, REQUEST_TIMEOUT_MS } = require('./config');
const { log, requireEnv, maskSensitive } = require('./common');

let weblateClient = null;

/**
 * Create (once) and return the dedicated axios instance for Weblate.
 * The token is read from WEBLATE_TOKEN. Request/response interceptors log at
 * debug level and mask any sensitive data.
 *
 * @returns {import('axios').AxiosInstance}
 */
function getWeblateClient() {
    if (weblateClient) {
        return weblateClient;
    }

    const token = requireEnv('WEBLATE_TOKEN');

    const client = axios.create({
        baseURL: `${WEBLATE_URL.replace(/\/+$/, '')}/api/`,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
            // All REST operations are performed as authorized operations.
            Authorization: `Token ${token}`,
            Accept: 'application/json',
        },
    });

    client.interceptors.request.use((requestConfig) => {
        log.debug('Weblate request:', {
            method: (requestConfig.method || 'get').toUpperCase(),
            url: requestConfig.url,
            params: requestConfig.params,
            headers: requestConfig.headers,
        });
        return requestConfig;
    });

    client.interceptors.response.use(
        (response) => {
            log.debug('Weblate response:', {
                status: response.status,
                url: response.config && response.config.url,
                data: response.data,
            });
            return response;
        },
        (error) => {
            const info = {
                message: error.message,
                status: error.response && error.response.status,
                url: error.config && error.config.url,
                data: error.response && error.response.data,
            };
            log.error('Weblate request failed:', maskSensitive(info));
            return Promise.reject(error);
        },
    );

    weblateClient = client;
    return weblateClient;
}

/**
 * Perform a GET request against the Weblate API and follow pagination,
 * returning the concatenated `results` array of all pages.
 *
 * @param {string} url - API path relative to `/api/` (e.g. `projects/`), or an
 *        absolute URL (used internally for `next` page links).
 * @param {object} [params] - query parameters for the first request.
 * @returns {Promise<Array<object>>} all results across every page.
 */
async function getPaginated(url, params) {
    const client = getWeblateClient();
    const results = [];
    let nextUrl = url;
    let nextParams = params;

    while (nextUrl) {
        const response = await client.get(nextUrl, { params: nextParams });
        const body = response.data;

        if (Array.isArray(body)) {
            results.push(...body);
            break;
        }

        if (body && Array.isArray(body.results)) {
            results.push(...body.results);
        }

        // Follow the absolute `next` link; params are already encoded in it.
        nextUrl = body && body.next ? body.next : null;
        nextParams = undefined;
    }

    return results;
}

/**
 * List all components belonging to a Weblate project.
 *
 * @param {string} project - the project slug (as used in Weblate URLs).
 * @returns {Promise<Array<object>>} the component objects of the project.
 */
async function listProjectComponents(project) {
    if (!project) {
        throw new Error('A project slug is required to list components');
    }
    const slug = encodeURIComponent(project);
    log.debug(`Fetching components for project "${project}"`);
    const components = await getPaginated(`projects/${slug}/components/`);
    log.debug(`Fetched ${components.length} component(s) for project "${project}"`);
    return components;
}

/**
 * Fetch a single Weblate project by slug.
 *
 * @param {string} project - the project slug.
 * @returns {Promise<object>} the project object.
 */
async function getProject(project) {
    if (!project) {
        throw new Error('A project slug is required');
    }
    const client = getWeblateClient();
    const slug = encodeURIComponent(project);
    const response = await client.get(`projects/${slug}/`);
    return response.data;
}

module.exports = {
    getWeblateClient,
    getPaginated,
    listProjectComponents,
    getProject,
};
