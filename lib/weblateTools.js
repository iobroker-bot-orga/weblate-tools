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
const { log, requireEnv, maskSensitive, createIpv4Agents, mapWithConcurrency } = require('./common');

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
            // A 404 is an expected outcome of "does this exist?" checks (e.g.
            // getComponent) and callers handle it, so it is only logged at
            // debug level to avoid noise when debug logging is disabled.
            if (error.response && error.response.status === 404) {
                log.debug('Weblate request not found (404):', maskSensitive(info));
            } else {
                log.error('Weblate request failed:', maskSensitive(info));
            }
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
 * @param {string} [spec.repoweb] - repository browser URL template.
 * @param {number} [spec.commitPendingAge] - age (hours) before committing
 *        pending changes (`commit_pending_age`).
 * @param {string} [spec.license] - SPDX license identifier, if known.
 * @returns {Promise<object>} the created component object.
 */
async function createComponent(spec) {
    const client = getWeblateClient();
    const project = encodeURIComponent(spec.project);

    const payload = {
        name: spec.name,
        slug: spec.slug,
        repo: spec.repo,
        file_format: spec.fileFormat,
        filemask: spec.fileMask,
        // Monolingual JSON: the base language file is both the template used
        // for translation and the base for adding new languages.
        template: spec.baseFile,
        new_base: spec.baseFile,
        source_language: { code: spec.baseLanguage },
    };

    // Linked components (repo = weblate://project/component) inherit the VCS
    // configuration of the main component, so branch/vcs are only sent when
    // provided (i.e. for the main, directly-linked component).
    if (spec.branch) {
        payload.branch = spec.branch;
    }
    if (spec.vcs) {
        payload.vcs = spec.vcs;
    }

    // Optional fields are only sent when provided, so unset values keep the
    // Weblate defaults instead of being overwritten with empty/undefined data.
    if (spec.repoweb) {
        payload.repoweb = spec.repoweb;
    }
    if (spec.commitPendingAge !== undefined && spec.commitPendingAge !== null) {
        payload.commit_pending_age = spec.commitPendingAge;
    }
    if (spec.license) {
        payload.license = spec.license;
    }

    const response = await client.post(`projects/${project}/components/`, payload);
    return response.data;
}

/**
 * Update (PATCH) fields of an existing component.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {object} patch - fields to change (e.g. `{ filemask, vcs }`).
 * @returns {Promise<object>} the updated component object.
 */
async function updateComponent(project, component, patch) {
    const client = getWeblateClient();
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    const response = await client.patch(`components/${p}/${c}/`, patch);
    return response.data;
}

/**
 * Resolve the add-ons of a component object to full add-on objects.
 *
 * The component's `addons` field is a list of hyperlinks to the add-on detail
 * endpoint (the component-level `addons` endpoint is POST-only, so it cannot be
 * listed with GET). Each detail URL is fetched to obtain the add-on `name`.
 *
 * @param {object} component - a component object (with an `addons` URL list).
 * @returns {Promise<Array<object>>} add-on objects (each has a `name`).
 */
async function listComponentAddons(component) {
    const urls = Array.isArray(component && component.addons) ? component.addons : [];
    const client = getWeblateClient();
    const addons = [];
    for (const url of urls) {
        // `url` is an absolute add-on-detail URL; axios ignores baseURL for it.
        const response = await client.get(url);
        addons.push(response.data);
    }
    return addons;
}

/**
 * List the add-ons installed on a component (by project/component slug).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<Array<object>>} add-on objects (each has a `name`).
 */
async function getComponentAddons(project, component) {
    const comp = await getComponent(project, component);
    return comp ? listComponentAddons(comp) : [];
}

/**
 * Trigger a repository operation on a component (e.g. a full `pull` from the
 * upstream repository).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {string} [operation='pull'] - the repository operation to perform.
 * @returns {Promise<object>} the operation result.
 */
async function componentRepositoryOperation(project, component, operation = 'pull') {
    const client = getWeblateClient();
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    const response = await client.post(`components/${p}/${c}/repository/`, { operation });
    return response.data;
}

/**
 * Trigger a complete `pull` of a component's repository from upstream.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<object>} the pull result.
 */
async function pullComponentRepository(project, component) {
    return componentRepositoryOperation(project, component, 'pull');
}

/**
 * Install an add-on on a component.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {string} name - the add-on API identifier (e.g. `weblate.cleanup.generic`).
 * @param {object} [configuration={}] - add-on-specific configuration.
 * @returns {Promise<object>} the created add-on object.
 */
async function installAddon(project, component, name, configuration = {}) {
    const client = getWeblateClient();
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    const response = await client.post(`components/${p}/${c}/addons/`, { name, configuration });
    return response.data;
}

/**
 * Unit translation states used by the Weblate API.
 *   0   empty (untranslated)
 *   10  needs editing (fuzzy)
 *   20  translated
 *   30  approved
 *   100 read-only
 */
const UNIT_STATE = {
    EMPTY: 0,
    NEEDS_EDITING: 10,
    TRANSLATED: 20,
    APPROVED: 30,
    READONLY: 100,
};

/**
 * List all translations (per language) of a component.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @returns {Promise<Array<object>>} translation objects (each has a `language`).
 */
async function getComponentTranslations(project, component) {
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    return getPaginated(`components/${p}/${c}/translations/`);
}

/**
 * List all units of a single translation (project/component/language).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {string} language - the language code.
 * @returns {Promise<Array<object>>} unit objects.
 */
async function getTranslationUnits(project, component, language) {
    const p = encodeURIComponent(project);
    const c = encodeURIComponent(component);
    const l = encodeURIComponent(language);
    return getPaginated(`translations/${p}/${c}/${l}/units/`);
}

/**
 * Update a single unit's state (and target). Weblate requires BOTH `state` and
 * a non-empty `target` for a partial state update, so the existing target is
 * passed back unchanged.
 *
 * @param {number|string} unitId - the unit id.
 * @param {number} state - the target state (see UNIT_STATE).
 * @param {string[]} target - the unit's target string(s) (plural array).
 * @returns {Promise<object>} the updated unit.
 */
async function updateUnitState(unitId, state, target) {
    const client = getWeblateClient();
    const response = await client.patch(`units/${encodeURIComponent(unitId)}/`, { state, target });
    return response.data;
}

/**
 * Wait until a freshly created/pulled component has finished Weblate's
 * asynchronous processing, so its translations and units actually exist before
 * they are edited. Right after creation the API can report only the source
 * language with zero units.
 *
 * "Ready" means every listed translation has parsed units (`total > 0`) and, if
 * `expectedLanguages` is given, at least that many translations exist. On
 * timeout it logs a warning and returns whatever is available (the caller then
 * simply edits what exists).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {object} [options]
 * @param {number} [options.expectedLanguages=0] - expected translation count.
 * @param {number} [options.timeoutMs=300000] - max time to wait.
 * @param {number} [options.pollMs=5000] - delay between polls.
 * @returns {Promise<Array<object>>} the (best available) translations list.
 */
async function waitForComponentReady(project, component, options = {}) {
    const expectedLanguages = options.expectedLanguages || 0;
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : 300000;
    const pollMs = options.pollMs !== undefined ? options.pollMs : 5000;

    const start = Date.now();
    let translations = [];
    for (;;) {
        translations = await getComponentTranslations(project, component);
        const withUnits = translations.filter((t) => (t.total || 0) > 0).length;
        const allParsed = translations.length > 0 && withUnits === translations.length;
        const enough = expectedLanguages ? translations.length >= expectedLanguages : translations.length > 0;

        if (allParsed && enough) {
            log.info(`Component "${component}" is ready (${translations.length} translation(s), all with units)`);
            return translations;
        }

        const elapsed = Date.now() - start;
        if (elapsed >= timeoutMs) {
            log.warn(`Component "${component}" not fully processed after ${Math.round(elapsed / 1000)}s `
                + `(translations: ${translations.length}${expectedLanguages ? `/${expectedLanguages}` : ''}, `
                + `with units: ${withUnits}); proceeding with what is available`);
            return translations;
        }

        log.info(`Waiting for component "${component}" to finish processing `
            + `(translations: ${translations.length}${expectedLanguages ? `/${expectedLanguages}` : ''}, `
            + `with units: ${withUnits}); retrying in ${pollMs} ms`);
        await sleep(pollMs);
    }
}

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a unit has any non-empty target string (plural-aware). */
function hasTargetContent(unit) {
    return Array.isArray(unit.target) ? unit.target.some((s) => s) : Boolean(unit.target);
}

/**
 * Fetch the units of a translation, re-fetching a few times while units that
 * should be editable are still read-only. Weblate may recompute a translation's
 * read-only state asynchronously after its source strings change, so the first
 * read can still show stale read-only units.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {string} language - the language code.
 * @param {number} retries - how many times to re-fetch.
 * @param {number} retryDelayMs - delay between re-fetches.
 * @returns {Promise<Array<object>>} the (best available) unit list.
 */
async function getTranslationUnitsSettled(project, component, language, retries, retryDelayMs) {
    let units = await getTranslationUnits(project, component, language);
    const readonlyCandidates = (list) => list.filter((u) => hasTargetContent(u) && u.state === UNIT_STATE.READONLY).length;

    let attempt = 0;
    while (attempt < retries && readonlyCandidates(units) > 0) {
        attempt += 1;
        const count = readonlyCandidates(units);
        log.info(`Language "${language}": ${count} translated unit(s) still read-only; `
            + `re-fetching (attempt ${attempt}/${retries}) after ${retryDelayMs} ms`);
        await sleep(retryDelayMs);
        units = await getTranslationUnits(project, component, language);
    }
    return units;
}

/**
 * Set every "needs editing" unit of a single translation to "translated",
 * clearing the fuzzy flag. Only units with a non-empty target that are
 * currently "needs editing" are touched.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {string} language - the language code.
 * @param {number} concurrency - max concurrent unit updates.
 * @returns {Promise<{ updated: number, failed: number }>}
 */
async function clearNeedsEditing(project, component, language, concurrency) {
    const units = await getTranslationUnits(project, component, language);
    const results = await mapWithConcurrency(units, concurrency, async (unit) => {
        const hasTarget = hasTargetContent(unit);
        if (!hasTarget || unit.state !== UNIT_STATE.NEEDS_EDITING) {
            return 'skipped';
        }
        try {
            await updateUnitState(unit.id, UNIT_STATE.TRANSLATED, unit.target);
            return 'updated';
        } catch (error) {
            const detail = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
            log.error(`Failed to clear needs editing on unit ${unit.id} (${language}): ${detail}`);
            return 'failed';
        }
    });
    return {
        updated: results.filter((r) => r === 'updated').length,
        failed: results.filter((r) => r === 'failed').length,
    };
}

/**
 * Mark every translated string in all non-base languages of a component as
 * "needs editing". There is no bulk-edit REST endpoint in Weblate, so this is
 * done per unit via PATCH /api/units/{id}/.
 *
 * Weblate makes a translation read-only while its source (base language) string
 * is itself in "needs editing" — which blocks marking the translations. So this
 * runs in two phases:
 *   1. Clear "needs editing" on the base language (English) → "translated".
 *      This lifts the derived read-only state on all translations.
 *   2. For every other language, set translated strings to "needs editing".
 *
 * In phase 2 only units that actually have a translation are touched;
 * empty/untranslated units, still-read-only units (cannot be edited) and units
 * already "needs editing" are skipped.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {object} [options]
 * @param {string} [options.baseLanguage='en'] - source language cleared in phase 1.
 * @param {number} [options.concurrency=4] - max concurrent unit updates.
 * @param {number} [options.retries=3] - re-fetch attempts while phase-2 units
 *        are still read-only (read-only may be recomputed asynchronously).
 * @param {number} [options.retryDelayMs=2000] - delay between those re-fetches.
 * @param {number} [options.expectedLanguages=0] - expected translation count,
 *        used to wait for Weblate to finish processing a fresh component.
 * @param {number} [options.readyTimeoutMs=300000] - max wait for processing.
 * @param {number} [options.readyPollMs=5000] - delay between readiness polls.
 * @returns {Promise<{ baseCleared: number, languages: number, updated: number, skipped: number, failed: number }>}
 */
async function markComponentNeedsEditing(project, component, options = {}) {
    const baseLanguage = options.baseLanguage || 'en';
    const concurrency = options.concurrency || 4;
    const retries = options.retries !== undefined ? options.retries : 3;
    const retryDelayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : 2000;

    // A freshly created component is processed asynchronously by Weblate, so
    // translations/units may not exist yet. Wait until they do before editing.
    const translations = await waitForComponentReady(project, component, {
        expectedLanguages: options.expectedLanguages || 0,
        timeoutMs: options.readyTimeoutMs,
        pollMs: options.readyPollMs,
    });
    const codeOf = (t) => t.language && (t.language.code || t.language);

    const summary = { baseCleared: 0, languages: 0, updated: 0, skipped: 0, failed: 0 };

    // Phase 1: clear "needs editing" on the base language so translations are no
    // longer read-only.
    if (translations.some((t) => codeOf(t) === baseLanguage)) {
        log.info(`Clearing "needs editing" on base language "${baseLanguage}" (so translations are editable)`);
        const baseResult = await clearNeedsEditing(project, component, baseLanguage, concurrency);
        summary.baseCleared = baseResult.updated;
        summary.failed += baseResult.failed;
        log.info(`Base language "${baseLanguage}": ${baseResult.updated} string(s) set to translated, ${baseResult.failed} failed`);
    } else {
        log.warn(`No base-language ("${baseLanguage}") translation found; cannot clear source "needs editing"`);
    }

    // Phase 2: mark every other language as "needs editing". Units are fetched
    // fresh here, so the read-only state recomputed after phase 1 is reflected.
    const targets = translations.filter((t) => {
        const code = codeOf(t);
        return code && code !== baseLanguage;
    });

    for (const translation of targets) {
        const code = codeOf(translation);
        summary.languages += 1;
        log.info(`Marking translations as "needs editing" for language "${code}"`);

        // Re-fetch while translated units are still read-only, in case phase 1's
        // source change has not yet propagated to the translations' read-only state.
        const units = await getTranslationUnitsSettled(project, component, code, retries, retryDelayMs);

        const results = await mapWithConcurrency(units, concurrency, async (unit) => {
            const hasTarget = hasTargetContent(unit);
            // Skip: nothing to review, cannot edit, or already needs editing.
            if (!hasTarget || unit.state === UNIT_STATE.EMPTY) {
                return 'skipped';
            }
            if (unit.state === UNIT_STATE.NEEDS_EDITING || unit.state === UNIT_STATE.READONLY) {
                return 'skipped';
            }
            try {
                await updateUnitState(unit.id, UNIT_STATE.NEEDS_EDITING, unit.target);
                return 'updated';
            } catch (error) {
                const detail = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
                log.error(`Failed to update unit ${unit.id} (${code}): ${detail}`);
                return 'failed';
            }
        });

        const updated = results.filter((r) => r === 'updated').length;
        const skipped = results.filter((r) => r === 'skipped').length;
        const failed = results.filter((r) => r === 'failed').length;
        summary.updated += updated;
        summary.skipped += skipped;
        summary.failed += failed;
        log.info(`Language "${code}": ${updated} set to needs editing, ${skipped} skipped, ${failed} failed`);
    }

    return summary;
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
    updateComponent,
    getComponentAddons,
    listComponentAddons,
    componentRepositoryOperation,
    pullComponentRepository,
    installAddon,
    UNIT_STATE,
    getComponentTranslations,
    getTranslationUnits,
    updateUnitState,
    waitForComponentReady,
    clearNeedsEditing,
    markComponentNeedsEditing,
};
