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
} = require('./config');
const { parseRepoReference, getRepository, getRepoTree } = require('./githubTools');
const { componentExists, createComponent } = require('./weblateTools');

/**
 * Parse command line arguments and environment variables into options.
 * CLI arguments take precedence over environment variables.
 *
 * @param {string[]} argv - process arguments (without node/script).
 * @returns {{ repo: string|undefined, debug: boolean }}
 */
function parseOptions(argv) {
    let repo = getEnv('REPO') || getEnv('INPUT_REPO');
    let debug = /^true$/i.test(getEnv('DEBUG', '') || getEnv('INPUT_DEBUG', ''));

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
        }
    }

    return { repo, debug };
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
 * Detect all i18n directories present in a repository tree and describe the
 * language-file layout of each.
 *
 * @param {Array<{ path: string, type: string }>} tree - recursive git tree.
 * @returns {Array<{ basePath: string, format: 'flat'|'nested'|'unknown',
 *          fileMask: string|null, baseFile: string|null }>}
 */
function detectI18nTrees(tree) {
    const paths = new Set(tree.map((entry) => entry.path));
    // Every directory whose last segment is "i18n".
    const dirs = tree
        .filter((entry) => entry.type === 'tree' && /(^|\/)i18n$/.test(entry.path))
        .map((entry) => entry.path);

    return dirs.map((basePath) => {
        const flatBase = `${basePath}/${DEFAULT_BASE_LANGUAGE}.json`;
        const nestedBase = `${basePath}/${DEFAULT_BASE_LANGUAGE}/translation.json`;

        if (paths.has(flatBase)) {
            return { basePath, format: 'flat', fileMask: `${basePath}/*.json`, baseFile: flatBase };
        }
        if (paths.has(nestedBase)) {
            return { basePath, format: 'nested', fileMask: `${basePath}/*/translation.json`, baseFile: nestedBase };
        }
        return { basePath, format: 'unknown', fileMask: null, baseFile: null };
    });
}

/**
 * Select the main i18n tree from the detected trees: prefer `src-admin/i18n`,
 * otherwise `admin/i18n`.
 *
 * @param {ReturnType<typeof detectI18nTrees>} trees
 * @returns {object|null} the selected tree descriptor, or `null` if neither
 *          preferred directory exists.
 */
function selectMainI18nTree(trees) {
    return (
        trees.find((t) => t.basePath === 'src-admin/i18n')
        || trees.find((t) => t.basePath === 'admin/i18n')
        || null
    );
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
 * @returns {object} a spec accepted by `weblateTools.createComponent`.
 */
function buildComponentSpec({ adapterName, repoUrl, branch, i18nTree }) {
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
    };
}

async function main() {
    const { repo, debug } = parseOptions(process.argv.slice(2));

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

    // Step 3: retrieve the repository tree and list all i18n directories.
    log.info('Retrieving repository tree');
    const tree = await getRepoTree(owner, repoName, branch);
    const i18nTrees = detectI18nTrees(tree);
    if (i18nTrees.length === 0) {
        log.info('No i18n directories detected in the repository');
    } else {
        log.info(`Detected ${i18nTrees.length} i18n director(y/ies):`);
        for (const t of i18nTrees) {
            log.info(`  - ${t.basePath} [format: ${t.format}]`);
        }
    }

    // Step 4: select the i18n tree to use (src-admin/i18n preferred).
    const mainTree = selectMainI18nTree(i18nTrees);
    if (!mainTree) {
        log.error('Neither "src-admin/i18n" nor "admin/i18n" exists in the repository; aborting.');
        process.exit(1);
        return;
    }
    log.info(`Using i18n tree: ${mainTree.basePath}`);

    // Step 5: determine the language file layout.
    if (mainTree.format === 'unknown' || !mainTree.fileMask || !mainTree.baseFile) {
        log.error(`Could not determine the language file layout under "${mainTree.basePath}". `
            + `Expected "${mainTree.basePath}/${DEFAULT_BASE_LANGUAGE}.json" `
            + `or "${mainTree.basePath}/${DEFAULT_BASE_LANGUAGE}/translation.json"; aborting.`);
        process.exit(1);
        return;
    }
    log.info(`Language file layout: ${mainTree.format} (mask: ${mainTree.fileMask}, base: ${mainTree.baseFile})`);

    // Step 6: calculate the base component name (identical to adapter name).
    const adapterName = adapterNameFromRepo(repoName);
    log.info(`Component name/slug: ${adapterName}`);

    // Step 7: abort if a component with that slug already exists.
    log.info(`Checking whether component "${adapterName}" already exists in project "${DEFAULT_PROJECT.slug}"`);
    if (await componentExists(DEFAULT_PROJECT.slug, adapterName)) {
        log.error(`A component "${adapterName}" already exists in project "${DEFAULT_PROJECT.slug}"; aborting.`);
        process.exit(1);
        return;
    }

    // Step 8: create the component. Only the main tree is created for now, but
    // the loop makes adding one component per detected tree trivial later.
    const treesToCreate = [mainTree];
    for (const i18nTree of treesToCreate) {
        const spec = buildComponentSpec({ adapterName, repoUrl: htmlUrl, branch, i18nTree });
        log.info(`Creating component "${spec.name}" in project "${spec.project}" `
            + `(repo: ${spec.repo}, branch: ${spec.branch}, vcs: ${spec.vcs}, `
            + `format: ${spec.fileFormat}, mask: ${spec.fileMask})`);
        const created = await createComponent(spec);
        log.info(`Component created: ${created.name} [slug: ${created.slug}]`);
    }

    log.info('add adapter finished successfully');
}

main().catch((error) => {
    log.error('add adapter failed:', error.message);
    process.exit(1);
});
