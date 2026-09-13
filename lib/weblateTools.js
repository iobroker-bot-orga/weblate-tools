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
const { log, requireEnv, maskSensitive, createIpv4Agents } = require('./common');

let weblateClient = null;

/**
 * Resolve the full request URL (baseURL + url) for logging, so log lines show
 * the complete target and not just the relative path.
 *
 * @param {import('axios').AxiosRequestConfig} requestConfig
 * @returns {string}
 */
function fullUrl(requestConfig) {
    const url = requestConfig.url || '';
    const base = requestConfig.baseURL || '';
    if (/^https?:\/\//i.test(url) || !base) {
        return url;
    }
    return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

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

    const { httpAgent, httpsAgent } = createIpv4Agents();

    const client = axios.create({
        baseURL: `${WEBLATE_URL.replace(/\/+$/, '')}/api/`,
        timeout: REQUEST_TIMEOUT_MS,
        // Connect over IPv4 only; IPv6 is never attempted.
        httpAgent,
        httpsAgent,
        headers: {
            // All REST operations are performed as authorized operations.
            Authorization: `Token ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });

    client.interceptors.request.use((requestConfig) => {
        log.debug('Weblate request:', {
            method: (requestConfig.method || 'get').toUpperCase(),
            url: fullUrl(requestConfig),
            params: requestConfig.params,
            headers: requestConfig.headers,
        });
        return requestConfig;
    });

    client.interceptors.response.use(
        (response) => {
            log.debug('Weblate response:', {
                status: response.status,
                url: response.config && fullUrl(response.config),
                data: response.data,
            });
            return response;
        },
        (error) => {
            const info = {
                message: error.message,
                status: error.response && error.response.status,
                url: error.config && fullUrl(error.config),
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
    let page = 0;

    while (nextUrl) {
        page += 1;
        const response = await client.get(nextUrl, { params: nextParams });
        const body = response.data;

        if (Array.isArray(body)) {
            results.push(...body);
            log.debug(`Page ${page}: fetched ${body.length} item(s) (no pagination envelope), total ${results.length}`);
            break;
        }

        const pageCount = body && Array.isArray(body.results) ? body.results.length : 0;
        if (pageCount) {
            results.push(...body.results);
        }
        log.debug(`Page ${page}: fetched ${pageCount} item(s), total ${results.length}, count=${body && body.count}`);

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
async function getProjectComponents(project) {
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
 * Get the authoritative lock status of a single component via the dedicated
 * lock endpoint (`GET /api/components/{project}/{component}/lock/`).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<boolean>} whether the component is currently locked.
 */
async function getComponentLockStatus(project, component) {
    const client = getWeblateClient();
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    const response = await client.get(`components/${p}/${c}/lock/`);
    return Boolean(response.data && response.data.locked);
}

/**
 * Determine whether a component is locked using the authoritative lock
 * endpoint. The `locked` field carried by the components-list serializer is
 * NOT reliable (it can report `false` for a component that is actually locked),
 * so it is intentionally ignored in favour of GET .../lock/.
 *
 * @param {object} component - a component object (must have `project` + `slug`).
 * @returns {Promise<boolean>}
 */
async function isComponentLocked(component) {
    const projectSlug = component.project && (component.project.slug || component.project);
    if (!projectSlug || !component.slug) {
        // Nothing to query with; fall back to whatever the object claims.
        return Boolean(component.locked);
    }
    return getComponentLockStatus(projectSlug, component.slug);
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

/**
 * Fetch a single component by project and component slug.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<object|null>} the component object, or `null` if it does
 *          not exist (HTTP 404).
 */
async function getComponent(project, component) {
    const client = getWeblateClient();
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    try {
        const response = await client.get(`components/${p}/${c}/`);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Check whether a component with the given slug already exists in a project.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<boolean>}
 */
async function componentExists(project, component) {
    return (await getComponent(project, component)) !== null;
}

/**
 * Create a new component in a Weblate project.
 *
 * This is the single, reusable component-creation step: callers building
 * several components (e.g. one per detected i18n tree) invoke it repeatedly
 * with different specs instead of duplicating the request logic.
 *
 * @param {object} spec - the component specification.
 * @param {string} spec.project - target project slug.
 * @param {string} spec.name - component name.
 * @param {string} spec.slug - component slug.
 * @param {string} spec.repo - full HTTPS repository URL.
 * @param {string} spec.branch - repository branch to track.
 * @param {string} spec.vcs - version-control-system integration.
 * @param {string} spec.fileFormat - Weblate file format.
 * @param {string} spec.fileMask - language file mask (uses `*` for the code).
 * @param {string} spec.baseFile - path to the base/template language file.
 * @param {string} spec.baseLanguage - base (source) language code.
 * @returns {Promise<object>} the created component object.
 */
async function createComponent(spec) {
    const client = getWeblateClient();
    const project = encodeURIComponent(spec.project);

    const payload = {
        name: spec.name,
        slug: spec.slug,
        repo: spec.repo,
        branch: spec.branch,
        vcs: spec.vcs,
        file_format: spec.fileFormat,
        filemask: spec.fileMask,
        // Monolingual JSON: the base language file is both the template used
        // for translation and the base for adding new languages.
        template: spec.baseFile,
        new_base: spec.baseFile,
        source_language: { code: spec.baseLanguage },
    };

    const response = await client.post(`projects/${project}/components/`, payload);
    return response.data;
}

module.exports = {
    getWeblateClient,
    getPaginated,
    getProjectComponents,
    getComponentLockStatus,
    isComponentLocked,
    getProject,
    getComponent,
    componentExists,
    createComponent,
};
