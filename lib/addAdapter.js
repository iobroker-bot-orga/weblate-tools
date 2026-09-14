'use strict';

/**
 * add adapter
 *
 * Adds a new Weblate component for an ioBroker adapter GitHub repository.
 *
 * Steps performed (each reported via info logging):
 *   1. Parse the GitHub repository reference (full URL or shortform).
 *   2. Fetch repository metadata and resolve the head branch (main/master).
 *   3. Retrieve the repository tree and list all detected i18n directories.
 *   4. Select the i18n tree to use: `src-admin/i18n` if present, otherwise
 *      `admin/i18n`; abort with an error if neither exists.
 *   5. Determine the language file layout (`i18n/*.json` or
 *      `i18n/*​/translation.json`).
 *   6. Calculate the base component name (identical to the adapter name).
 *   7. Abort if a component with that slug already exists in the project.
 *   8. Create the component.
 *
 * The component-creation step is encapsulated in `buildComponentSpec` +
 * `weblateTools.createComponent`, so multiple components (one per detected
 * i18n tree) can be created later without duplicating code. For now only the
 * main (selected) i18n tree is turned into a component.
 *
 * Usage (interactive):
 *   WEBLATE_TOKEN=... GITHUB_TOKEN=... \
 *     node lib/addAdapter.js --repo <github-url-or-owner/ioBroker.name> [--debug]
 *
 * The script also accepts input via environment variables so it can be driven
 * from a GitHub workflow:
 *   REPO / INPUT_REPO   - the GitHub repository reference
 *   DEBUG / INPUT_DEBUG - "true" to enable debug logging
 */

const { log, setLogLevel, getEnv } = require('./common');
const {
    DEFAULT_PROJECT,
    DEFAULT_VCS,
    DEFAULT_FILE_FORMAT,
    DEFAULT_BASE_LANGUAGE,
    DEFAULT_COMMIT_PENDING_AGE,
    REPOWEB_TEMPLATE,
    COMPONENT_ADDONS,
} = require('./config');
const {
    parseRepoReference,
    getRepository,
    getRepoTree,
    getFileContent,
} = require('./githubTools');
const {
    getComponent,
    createComponent,
    pullComponentRepository,
    installAddon,
    markComponentNeedsEditing,
} = require('./weblateTools');
const { LICENSE_FILE_NAMES, detectLicense } = require('./licenses');
const { evaluateI18nTrees, formatReport } = require('./i18nEvaluation');

/**
 * Parse command line arguments and environment variables into options.
 * CLI arguments take precedence over environment variables.
 *
 * @param {string[]} argv - process arguments (without node/script).
 * @returns {{ repo: string|undefined, debug: boolean, precheckOnly: boolean }}
 */
function parseOptions(argv) {
    let repo = getEnv('REPO') || getEnv('INPUT_REPO');
    let debug = /^true$/i.test(getEnv('DEBUG', '') || getEnv('INPUT_DEBUG', ''));
    let precheckOnly = /^true$/i.test(getEnv('PRECHECK_ONLY', '') || getEnv('INPUT_PRECHECK_ONLY', ''));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--repo' || arg === '-r') {
            repo = argv[++i];
        } else if (arg.startsWith('--repo=')) {
            repo = arg.slice('--repo='.length);
        } else if (arg === '--debug' || arg === '-d') {
            debug = true;
        } else if (arg.startsWith('--debug=')) {
            debug = /^true$/i.test(arg.slice('--debug='.length));
        } else if (arg === '--precheck-only' || arg === '--precheckOnly' || arg === '--precheck') {
            precheckOnly = true;
        } else if (arg.startsWith('--precheck-only=')) {
            precheckOnly = /^true$/i.test(arg.slice('--precheck-only='.length));
        }
    }

    return { repo, debug, precheckOnly };
}

/**
 * Derive the adapter name from a GitHub repository name. ioBroker adapter
 * repositories are named `ioBroker.<adaptername>`; the adapter name is the part
 * after the `ioBroker.` prefix. If the prefix is absent the repository name is
 * used unchanged.
 *
 * @param {string} repoName - the GitHub repository name.
 * @returns {string} the adapter name.
 */
function adapterNameFromRepo(repoName) {
    const match = repoName.match(/^iobroker\.(.+)$/i);
    return match ? match[1] : repoName;
}

/**
 * Count the language files present for an i18n tree, i.e. the number of
 * translations Weblate should end up creating for it. Used to wait until the
 * fresh component has finished processing.
 *
 * @param {Array<{ path: string, type: string }>} tree - recursive git tree.
 * @param {{ basePath: string, format: string }} i18nTree - the tree descriptor.
 * @returns {number} the number of distinct language files.
 */
function countLanguages(tree, i18nTree) {
    const base = i18nTree.basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = i18nTree.format === 'nested'
        ? new RegExp(`^${base}/([^/]+)/translations\\.json$`)
        : new RegExp(`^${base}/([^/]+)\\.json$`);
    const langs = new Set();
    for (const entry of tree) {
        const match = entry.path.match(re);
        if (match) {
            langs.add(match[1]);
        }
    }
    return langs.size;
}

/**
 * Build the Weblate "Repository browser" URL (`repoweb`) for a repository,
 * filling the owner/repo placeholders and leaving Weblate's own
 * `{{branch}}`/`{{filename}}`/`{{line}}` markers intact.
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @returns {string}
 */
function buildRepoweb(owner, repo) {
    return REPOWEB_TEMPLATE.replace('{owner}', owner).replace('{repo}', repo);
}

/**
 * Try to identify the license of a repository from its LICENSE file. Common
 * license file names are tried in turn; the first existing file is matched
 * against the static list of known licenses.
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @param {string} branch - branch to read from.
 * @param {Set<string>} treePaths - set of top-level paths present in the repo.
 * @returns {Promise<{ spdx: string, name: string }|null>}
 */
async function extractLicense(owner, repo, branch, treePaths) {
    for (const fileName of LICENSE_FILE_NAMES) {
        if (treePaths && !treePaths.has(fileName)) {
            continue;
        }
        const content = await getFileContent(owner, repo, fileName, branch);
        if (!content) {
            continue;
        }
        const license = detectLicense(content);
        if (license) {
            log.info(`License detected from ${fileName}: ${license.spdx} (${license.name})`);
            return license;
        }
        log.info(`Found ${fileName} but could not match it to a known license`);
        return null;
    }
    log.info('No LICENSE file found in the repository');
    return null;
}

/**
 * Build the component specification for a single i18n tree. Centralising this
 * lets the caller create several components (one per tree) from the same code.
 *
 * @param {object} params
 * @param {string} params.adapterName - the adapter name (component name/slug).
 * @param {string} params.repoUrl - full HTTPS repository URL.
 * @param {string} params.branch - repository head branch.
 * @param {object} params.i18nTree - a descriptor from `detectI18nTrees`.
 * @param {string} params.repoweb - repository browser URL template.
 * @param {string|null} params.license - SPDX license identifier, or null.
 * @returns {object} a spec accepted by `weblateTools.createComponent`.
 */
function buildComponentSpec({ adapterName, repoUrl, branch, i18nTree, repoweb, license }) {
    // Component name and slug are always identical to the adapter name.
    return {
        project: DEFAULT_PROJECT.slug,
        name: adapterName,
        slug: adapterName,
        repo: repoUrl,
        branch,
        vcs: DEFAULT_VCS,
        fileFormat: DEFAULT_FILE_FORMAT,
        fileMask: i18nTree.fileMask,
        baseFile: i18nTree.baseFile,
        baseLanguage: DEFAULT_BASE_LANGUAGE,
        repoweb,
        commitPendingAge: DEFAULT_COMMIT_PENDING_AGE,
        license: license ? license.spdx : undefined,
    };
}

/**
 * Install the standard add-ons on a component, plus the ioBroker words.js
 * add-on when the repository contains the trigger file. A failure to install
 * any add-on aborts the run (the error is re-thrown so the top-level handler
 * exits with a non-zero code).
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {Set<string>} treePaths - set of paths present in the repository.
 * @returns {Promise<void>}
 * @throws {Error} if any add-on fails to install.
 */
async function installComponentAddons(project, component, treePaths) {
    for (const addon of COMPONENT_ADDONS) {
        // Conditional add-ons only apply when their trigger file is present.
        if (addon.triggerFile && !treePaths.has(addon.triggerFile)) {
            log.info(`"${addon.triggerFile}" not present: skipping conditional add-on`
                + `${addon.name ? ` "${addon.name}"` : ''}`);
            continue;
        }
        // A configured trigger file is present (or the add-on is unconditional)
        // but its identifier is unknown: skip with a warning rather than abort,
        // since there is nothing valid to install.
        if (!addon.name) {
            log.warn('Skipping the "ioBroker: Save translations into words.js" add-on: '
                + `its trigger file "${addon.triggerFile}" is present but WORDS_ADDON_NAME `
                + 'is not set. Set WORDS_ADDON_NAME to its API identifier to enable it.');
            continue;
        }
        try {
            log.info(`Installing add-on "${addon.name}" on component "${component}"`);
            await installAddon(project, component, addon.name, addon.configuration);
            log.info(`Add-on "${addon.name}" installed`);
        } catch (error) {
            const detail = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
            // A failed add-on installation aborts the run.
            throw new Error(`Failed to install add-on "${addon.name}" on component "${component}": ${detail}`);
        }
    }
}

async function main() {
    const { repo, debug, precheckOnly } = parseOptions(process.argv.slice(2));

    setLogLevel(debug);

    if (!repo) {
        log.error('No repository specified. Provide --repo <github-url-or-owner/ioBroker.name> '
            + 'or set the REPO environment variable.');
        process.exit(2);
        return;
    }

    // Step 1: parse the repository reference.
    const { owner, repo: repoName, htmlUrl } = parseRepoReference(repo);
    log.info(`Adapter repository: ${owner}/${repoName} (${htmlUrl})`);

    // Step 2: resolve the head branch (main/master) from repository metadata.
    log.info('Fetching repository metadata from GitHub');
    const repository = await getRepository(owner, repoName);
    const branch = repository.default_branch;
    log.info(`Head branch: ${branch}`);

    // Step 3: retrieve the repository tree.
    log.info('Retrieving repository tree');
    const tree = await getRepoTree(owner, repoName, branch);

    // Step 4: evaluate all i18n directories and log the report (always, even
    // when changes will be applied afterwards).
    log.info('Evaluating i18n directories');
    const { entries, main } = await evaluateI18nTrees({ tree, owner, repo: repoName, branch });
    log.info(`i18n evaluation report (${entries.length} director(y/ies)):`);
    for (const line of formatReport(entries)) {
        log.info(line);
    }

    // Step 5: a main/base i18n directory is required; abort in any case if none.
    if (!main) {
        log.error('No main/base i18n directory could be identified; aborting.');
        process.exit(1);
        return;
    }
    log.info(`Main i18n directory: ${main.path} [format: ${main.format}, mask: ${main.fileMask}, base: ${main.baseFile}]`);
    const mainTree = {
        basePath: main.path,
        format: main.format,
        fileMask: main.fileMask,
        baseFile: main.baseFile,
    };

    // Step 6: in precheck-only mode, stop after the report without any changes.
    if (precheckOnly) {
        log.info('precheckOnly is set: stopping after the evaluation report; no changes were made to Weblate.');
        return;
    }

    // Step 7: calculate the base component name (identical to adapter name).
    const adapterName = adapterNameFromRepo(repoName);
    log.info(`Component name/slug: ${adapterName}`);

    // Step 8: abort if a component with that slug already exists. Log the
    // concrete reason, including the existing component's identifying details,
    // so the workflow log makes clear why it stopped.
    log.info(`Checking whether component "${adapterName}" already exists in project "${DEFAULT_PROJECT.slug}"`);
    const existing = await getComponent(DEFAULT_PROJECT.slug, adapterName);
    if (existing) {
        const existingUrl = existing.web_url || existing.url || '';
        log.error(`Aborting: a component "${adapterName}" already exists in project `
            + `"${DEFAULT_PROJECT.slug}" (name: "${existing.name}", slug: "${existing.slug}"`
            + `${existingUrl ? `, url: ${existingUrl}` : ''}). `
            + 'A repository can only be registered once; delete or rename the existing '
            + 'component if it must be recreated.');
        process.exit(1);
        return;
    }
    log.info(`No existing component "${adapterName}" found; proceeding.`);

    // Step 9: try to extract the repository license (best effort).
    log.info('Extracting repository license');
    const treePaths = new Set(tree.map((entry) => entry.path));
    const license = await extractLicense(owner, repoName, branch, treePaths);
    if (!license) {
        log.info('License could not be determined; the component will be created without a license');
    }

    // Repository browser URL is the same for every component of this repo.
    const repoweb = buildRepoweb(owner, repoName);

    // Step 10: create the component. Only the main tree is created for now, but
    // the loop makes adding one component per detected tree trivial later.
    const treesToCreate = [mainTree];
    for (const i18nTree of treesToCreate) {
        const spec = buildComponentSpec({ adapterName, repoUrl: htmlUrl, branch, i18nTree, repoweb, license });
        log.info(`Creating component "${spec.name}" in project "${spec.project}" `
            + `(repo: ${spec.repo}, branch: ${spec.branch}, vcs: ${spec.vcs}, `
            + `format: ${spec.fileFormat}, mask: ${spec.fileMask}, `
            + `repoweb: ${spec.repoweb}, commit_pending_age: ${spec.commitPendingAge}, `
            + `license: ${spec.license || '(none)'})`);
        const created = await createComponent(spec);
        log.info(`Component created: ${created.name} [slug: ${created.slug}]`);

        // Step 11: install the standard add-ons (and the ioBroker words.js
        // add-on when admin/words.js is present).
        await installComponentAddons(spec.project, created.slug, treePaths);

        // Step 12: trigger a complete pull of the component from upstream so
        // all translation data is loaded before the bulk edit.
        log.info(`Triggering a complete pull of component "${created.slug}"`);
        await pullComponentRepository(spec.project, created.slug);
        log.info(`Pull triggered for component "${created.slug}"`);

        // Step 13: bulk-mark every non-English translation as "needs editing".
        // Weblate has no bulk-edit REST endpoint, so this is done per unit.
        const expectedLanguages = countLanguages(tree, i18nTree);
        log.info(`Marking all non-"${spec.baseLanguage}" translations of "${created.slug}" as needs editing `
            + `(expecting ${expectedLanguages} language(s) once processed)`);
        const summary = await markComponentNeedsEditing(spec.project, created.slug, {
            baseLanguage: spec.baseLanguage,
            expectedLanguages,
        });
        log.info(`Needs-editing bulk update done for "${created.slug}": `
            + `base "${spec.baseLanguage}" cleared ${summary.baseCleared} string(s); `
            + `${summary.languages} language(s), ${summary.updated} string(s) updated, `
            + `${summary.skipped} skipped, ${summary.failed} failed`);
        if (summary.failed > 0) {
            throw new Error(`${summary.failed} string(s) failed to update to "needs editing" for component "${created.slug}"`);
        }
    }

    log.info('add adapter finished successfully');
}

main().catch((error) => {
    log.error('add adapter failed:', error.message);
    process.exit(1);
});
