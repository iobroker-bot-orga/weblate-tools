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
    getProjectComponents,
    createComponent,
    updateComponent,
    getComponentAddons,
    listComponentAddons,
    pullComponentRepository,
    installAddon,
    markComponentNeedsEditing,
} = require('./weblateTools');
const { LICENSE_FILE_NAMES, detectLicense } = require('./licenses');
const { evaluateI18nTrees, formatReport, componentNameFor } = require('./i18nEvaluation');

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
 * The add-ons that should be installed on every component of this repository.
 * The conditional words.js add-on is included only when its trigger file is
 * present; if its identifier is not configured it is skipped with a warning.
 *
 * @param {Set<string>} treePaths - set of paths present in the repository.
 * @returns {Array<{ name: string, configuration: object }>}
 */
function expectedAddons(treePaths) {
    const result = [];
    for (const addon of COMPONENT_ADDONS) {
        if (addon.triggerFile && !treePaths.has(addon.triggerFile)) {
            continue;
        }
        if (!addon.name) {
            log.warn('The "ioBroker: Save translations into words.js" add-on applies '
                + `("${addon.triggerFile}" present) but WORDS_ADDON_NAME is not set; it will be skipped.`);
            continue;
        }
        result.push(addon);
    }
    return result;
}

/**
 * Build a component spec for `weblateTools.createComponent`. The main component
 * links directly to the GitHub repository; every other component is a linked
 * component that shares the main component's repository via a `weblate://` URL.
 *
 * @param {object} params
 * @param {object} params.comp - a component descriptor (name, fileMask, baseFile, isMain).
 * @param {string} params.repoUrl - full HTTPS repository URL (for the main).
 * @param {string} params.branch - repository head branch (for the main).
 * @param {string} params.mainSlug - the main component slug (for linked repos).
 * @param {string} params.repoweb - repository browser URL template.
 * @param {object|null} params.license - detected license, or null.
 * @returns {object}
 */
function buildComponentSpec({ comp, repoUrl, branch, mainSlug, repoweb, license }) {
    const spec = {
        project: DEFAULT_PROJECT.slug,
        name: comp.name,
        slug: comp.name,
        fileFormat: DEFAULT_FILE_FORMAT,
        fileMask: comp.fileMask,
        baseFile: comp.baseFile,
        baseLanguage: DEFAULT_BASE_LANGUAGE,
        repoweb,
        commitPendingAge: DEFAULT_COMMIT_PENDING_AGE,
        license: license ? license.spdx : undefined,
    };
    if (comp.isMain) {
        spec.repo = repoUrl;
        spec.branch = branch;
        spec.vcs = DEFAULT_VCS;
    } else {
        // Linked component: share the main component's repository checkout.
        spec.repo = `weblate://${DEFAULT_PROJECT.slug}/${mainSlug}`;
    }
    return spec;
}

/**
 * Ensure a component has all expected add-ons, installing any that are missing.
 * Records each installed add-on in `changes`.
 *
 * @param {string} project - the project slug.
 * @param {string} component - the component slug.
 * @param {Array<{ name: string, configuration: object }>} expected - expected add-ons.
 * @param {string[]} changes - change log to append to.
 * @param {Array<object>} [knownAddons] - already-fetched add-on list (optional).
 * @returns {Promise<void>}
 * @throws {Error} if an add-on installation fails.
 */
async function ensureAddons(project, component, expected, changes, knownAddons) {
    const existing = knownAddons || await getComponentAddons(project, component);
    const have = new Set(existing.map((a) => a.name));
    for (const addon of expected) {
        if (have.has(addon.name)) {
            continue;
        }
        try {
            await installAddon(project, component, addon.name, addon.configuration);
            changes.push(`component ${component}: add-on ${addon.name} added`);
        } catch (error) {
            const detail = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
            throw new Error(`Failed to install add-on "${addon.name}" on component "${component}": ${detail}`);
        }
    }
}

/**
 * Compute the planned components (one per valid i18n directory) and resolve
 * each one's status against Weblate.
 *
 * Status/flag:
 *   🟢 valid   - a component with that slug exists and its filemask matches;
 *   🟡 missing - no component with that slug exists;
 *   🔴 invalid - a component exists but its filemask does not match.
 *
 * @param {Array<object>} entries - evaluation entries (from evaluateI18nTrees).
 * @param {string} adapterName - the base component name.
 * @param {string} project - the Weblate project slug.
 * @returns {Promise<Array<object>>} component descriptors with status.
 */
async function resolveComponents(entries, adapterName, project, expected) {
    const expectedNames = new Set(expected.map((a) => a.name));

    const components = entries
        .filter((e) => e.valid)
        .map((e) => ({
            name: componentNameFor(adapterName, e.path, e.isMain),
            dir: e.path,
            format: e.format,
            fileMask: e.fileMask,
            baseFile: e.baseFile,
            isMain: e.isMain,
            existing: null,
            existingAddons: [],
            problems: [],
        }));

    for (const comp of components) {
        const existing = await getComponent(project, comp.name);
        comp.existing = existing;

        if (!existing) {
            comp.status = 'missing';
            comp.flag = '🟡';
            comp.info = 'missing';
            continue;
        }

        // Verify file mask.
        const fileMaskOk = existing.filemask === comp.fileMask;
        if (!fileMaskOk) {
            comp.problems.push(`file mask is "${existing.filemask}", expected "${comp.fileMask}"`);
        }

        // Verify VCS setup. Only the main component links directly to the repo;
        // linked components inherit the main's VCS, so vcs is only checked there.
        if (comp.isMain && existing.vcs !== DEFAULT_VCS) {
            comp.problems.push(`vcs is "${existing.vcs}", expected "${DEFAULT_VCS}"`);
        }

        // Verify attached add-ons.
        // Read installed add-ons via the component object's `addons` links
        // (the component-level addons endpoint is POST-only).
        comp.existingAddons = await listComponentAddons(existing);
        const have = new Set(comp.existingAddons.map((a) => a.name));
        for (const name of expectedNames) {
            if (!have.has(name)) {
                comp.problems.push(`missing add-on ${name}`);
            }
        }

        comp.status = comp.problems.length === 0 ? 'valid' : 'invalid';
        comp.flag = comp.problems.length === 0 ? '🟢' : '🔴';
        comp.info = comp.problems.length === 0 ? 'valid' : 'invalid';
    }

    return components;
}

/**
 * Find components in the project that are linked to this adapter's repository
 * but whose slug is not one of the expected component names (misnamed / stale).
 *
 * @param {Array<object>} projectComponents - all components of the project.
 * @param {string} htmlUrl - the adapter's GitHub HTTPS URL.
 * @param {Set<string>} expectedNames - expected component slugs.
 * @returns {Array<{ slug: string, name: string, dir: string }>}
 */
function findMismatchedComponents(projectComponents, htmlUrl, expectedNames) {
    const normalize = (url) => String(url || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    const target = normalize(htmlUrl);
    const bySlug = new Map(projectComponents.map((c) => [c.slug, c]));

    // Resolve weblate://project/component links to the underlying git repo.
    const effectiveRepo = (comp, depth = 0) => {
        if (comp && typeof comp.repo === 'string' && comp.repo.startsWith('weblate://') && depth < 5) {
            const [, linkedSlug] = comp.repo.replace('weblate://', '').split('/');
            const linked = bySlug.get(linkedSlug);
            return linked ? effectiveRepo(linked, depth + 1) : comp.repo;
        }
        return comp ? comp.repo : '';
    };

    const dirFromFileMask = (mask) => {
        if (!mask) {
            return '';
        }
        const star = mask.indexOf('/*');
        return star >= 0 ? mask.slice(0, star) : mask.replace(/\/[^/]*$/, '');
    };

    const mismatched = [];
    for (const comp of projectComponents) {
        if (expectedNames.has(comp.slug)) {
            continue;
        }
        if (normalize(effectiveRepo(comp)) === target) {
            mismatched.push({ slug: comp.slug, name: comp.name, dir: dirFromFileMask(comp.filemask) });
        }
    }
    return mismatched;
}

/**
 * Render the components as an aligned text table (array of lines), sorted
 * alphabetically by component name.
 *
 * @param {Array<object>} components - from `resolveComponents`.
 * @returns {string[]} report lines.
 */
function formatComponentTable(components) {
    const rows = [...components].sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const nameHeader = 'Component';
    const dirHeader = 'i18n directory';
    const nameW = Math.max(nameHeader.length, ...rows.map((r) => r.name.length));
    const dirW = Math.max(dirHeader.length, ...rows.map((r) => r.dir.length));

    const lines = [];
    lines.push(`   ${nameHeader.padEnd(nameW)}  ${dirHeader.padEnd(dirW)}  Info`);
    for (const r of rows) {
        lines.push(`${r.flag} ${r.name.padEnd(nameW)}  ${r.dir.padEnd(dirW)}  ${r.info}`);
    }
    return lines;
}

/**
 * Render the detected configuration problems (component + problem) as a table.
 *
 * @param {Array<object>} components - from `resolveComponents`.
 * @returns {string[]} report lines (empty if there are no problems).
 */
function formatProblemTable(components) {
    const rows = [];
    for (const comp of [...components].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        for (const problem of comp.problems) {
            rows.push({ component: comp.name, problem });
        }
    }
    if (rows.length === 0) {
        return [];
    }
    const compHeader = 'Component';
    const compW = Math.max(compHeader.length, ...rows.map((r) => r.component.length));
    const lines = [`${compHeader.padEnd(compW)}  Problem detected`];
    for (const r of rows) {
        lines.push(`${r.component.padEnd(compW)}  ${r.problem}`);
    }
    return lines;
}

/**
 * Render the mismatched (misnamed/stale) components as a table.
 *
 * @param {Array<{ slug: string, dir: string }>} mismatched
 * @returns {string[]} report lines (empty if none).
 */
function formatMismatchTable(mismatched) {
    if (mismatched.length === 0) {
        return [];
    }
    const rows = [...mismatched].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    const compHeader = 'Component';
    const compW = Math.max(compHeader.length, ...rows.map((r) => r.slug.length));
    const lines = [`${compHeader.padEnd(compW)}  Related directory`];
    for (const r of rows) {
        lines.push(`${r.slug.padEnd(compW)}  ${r.dir || '(unknown)'}`);
    }
    return lines;
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
    // Step 6: compute the base component name and, for every valid i18n
    // directory, the component name/slug; then resolve each against Weblate
    // (verifying file mask, VCS and add-ons) and log the reports (always).
    const treePaths = new Set(tree.map((entry) => entry.path));
    const adapterName = adapterNameFromRepo(repoName);
    log.info(`Base component name/slug: ${adapterName}`);

    const expected = expectedAddons(treePaths);
    const components = await resolveComponents(entries, adapterName, DEFAULT_PROJECT.slug, expected);

    log.info(`Component report (${components.length} component(s)):`);
    for (const line of formatComponentTable(components)) {
        log.info(line);
    }

    const problemLines = formatProblemTable(components);
    if (problemLines.length) {
        log.info('Configuration problems detected on existing components:');
        for (const line of problemLines) {
            log.info(line);
        }
    } else {
        log.info('No configuration problems detected on existing components.');
    }

    // Components already linked to this repository whose slug does not match
    // the expected set (misnamed / stale).
    const expectedNames = new Set(components.map((c) => c.name));
    const projectComponents = await getProjectComponents(DEFAULT_PROJECT.slug);
    const mismatched = findMismatchedComponents(projectComponents, htmlUrl, expectedNames);
    const mismatchLines = formatMismatchTable(mismatched);
    if (mismatchLines.length) {
        log.info('Components linked to this repository with a non-matching name/slug:');
        for (const line of mismatchLines) {
            log.info(line);
        }
    }

    // Setup summary (the plan).
    const missing = components.filter((c) => c.status === 'missing');
    const toFix = components.filter((c) => c.status === 'invalid');
    log.info('Setup summary:');
    log.info(missing.length
        ? `  To be created: ${missing.map((c) => c.name).join(', ')}`
        : '  No components need to be created.');
    if (toFix.length) {
        log.info(`  To be fixed: ${toFix.map((c) => c.name).join(', ')}`);
    }

    // Step 7: in precheck-only mode, stop after the reports without any changes.
    if (precheckOnly) {
        log.info('precheckOnly is set: stopping after the reports; no changes were made to Weblate.');
        return;
    }

    // Step 8: license + repository browser URL (shared by all components).
    log.info('Extracting repository license');
    const license = await extractLicense(owner, repoName, branch, treePaths);
    if (!license) {
        log.info('License could not be determined; components will be created without a license');
    }
    const repoweb = buildRepoweb(owner, repoName);

    // Step 9: process ALL components — create the missing ones (the main links
    // to the repo, the others are linked to the main), and fix the existing
    // ones (file mask, VCS, add-ons). The main must exist before linked
    // components can reference it, so it is processed first.
    const changes = [];
    const createdComponents = [];
    const mainComp = components.find((c) => c.isMain);
    const ordered = [
        mainComp,
        ...components.filter((c) => !c.isMain).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    ].filter(Boolean);

    for (const comp of ordered) {
        if (comp.status === 'missing') {
            const spec = buildComponentSpec({ comp, repoUrl: htmlUrl, branch, mainSlug: adapterName, repoweb, license });
            log.info(`Creating component "${comp.name}" (repo: ${spec.repo}`
                + `${spec.vcs ? `, vcs: ${spec.vcs}` : ' [linked]'}, mask: ${spec.fileMask})`);
            const created = await createComponent(spec);
            changes.push(`component ${created.slug} added`);
            createdComponents.push(comp);
            await ensureAddons(DEFAULT_PROJECT.slug, created.slug, expected, changes, await listComponentAddons(created));
            continue;
        }

        // Existing component: correct file mask / VCS, then add missing add-ons.
        const patch = {};
        if (comp.existing.filemask !== comp.fileMask) {
            patch.filemask = comp.fileMask;
            patch.template = comp.baseFile;
            patch.new_base = comp.baseFile;
        }
        if (comp.isMain && comp.existing.vcs !== DEFAULT_VCS) {
            patch.vcs = DEFAULT_VCS;
        }
        if (Object.keys(patch).length) {
            log.info(`Fixing component "${comp.name}": ${JSON.stringify(patch)}`);
            await updateComponent(DEFAULT_PROJECT.slug, comp.name, patch);
            if (patch.filemask) {
                changes.push(`component ${comp.name} filemask changed to ${patch.filemask}`);
            }
            if (patch.vcs) {
                changes.push(`component ${comp.name} vcs changed to ${patch.vcs}`);
            }
        }
        await ensureAddons(DEFAULT_PROJECT.slug, comp.name, expected, changes, comp.existingAddons);
    }

    // Step 10: trigger a complete pull for EVERY component (existing and newly
    // created). Linked components share the main's checkout, but each is pulled
    // as requested.
    for (const comp of ordered) {
        log.info(`Triggering a complete pull of component "${comp.name}"`);
        await pullComponentRepository(DEFAULT_PROJECT.slug, comp.name);
    }

    // Step 11: bulk-mark non-English translations as "needs editing" only for
    // NEWLY created components. Existing components are left unchanged.
    for (const comp of createdComponents) {
        const expectedLanguages = countLanguages(tree, { basePath: comp.dir, format: comp.format });
        log.info(`Marking non-"${DEFAULT_BASE_LANGUAGE}" translations of "${comp.name}" as needs editing `
            + `(expecting ${expectedLanguages} language(s))`);
        const summary = await markComponentNeedsEditing(DEFAULT_PROJECT.slug, comp.name, {
            baseLanguage: DEFAULT_BASE_LANGUAGE,
            expectedLanguages,
        });
        log.info(`  "${comp.name}": base cleared ${summary.baseCleared}, `
            + `${summary.updated} set to needs editing, ${summary.skipped} skipped, ${summary.failed} failed`);
        if (summary.failed > 0) {
            throw new Error(`${summary.failed} string(s) failed to update to "needs editing" for component "${comp.name}"`);
        }
    }

    // Step 12: final report of all changes done.
    if (changes.length) {
        log.info('Changes applied:');
        for (const change of changes) {
            log.info(`  ${change}`);
        }
    } else {
        log.info('Changes applied: none (everything was already up to date)');
    }

    log.info('add adapter finished successfully');
}

main().catch((error) => {
    log.error('add adapter failed:', error.message);
    process.exit(1);
});
