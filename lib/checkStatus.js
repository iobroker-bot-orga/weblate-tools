'use strict';

/**
 * check status
 *
 * Connects to Weblate and scans all components that are part of a given
 * project. The components are listed via info logging. All REST operations
 * are logged at debug level.
 *
 * Usage (interactive):
 *   WEBLATE_TOKEN=... node lib/checkStatus.js --project <slug> [--debug]
 *
 * The script also accepts input via environment variables, so it can be
 * driven from a GitHub workflow:
 *   PROJECT / INPUT_PROJECT  - the Weblate project slug
 *   DEBUG   / INPUT_DEBUG    - "true" to enable debug logging
 */

const { log, setLogLevel, getEnv, mapWithConcurrency } = require('./common');
const { getProjectComponents, getComponentLockStatus } = require('./weblateTools');

/** Max number of concurrent lock-status requests against the slow server. */
const LOCK_CHECK_CONCURRENCY = 8;

/**
 * Parse command line arguments and environment variables into options.
 * CLI arguments take precedence over environment variables.
 *
 * @param {string[]} argv - process arguments (without node/script).
 * @returns {{ project: string|undefined, debug: boolean }}
 */
function parseOptions(argv) {
    let project = getEnv('PROJECT') || getEnv('INPUT_PROJECT');
    let debug = /^true$/i.test(getEnv('DEBUG', '') || getEnv('INPUT_DEBUG', ''));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--project' || arg === '-p') {
            project = argv[++i];
        } else if (arg.startsWith('--project=')) {
            project = arg.slice('--project='.length);
        } else if (arg === '--debug' || arg === '-d') {
            debug = true;
        } else if (arg.startsWith('--debug=')) {
            debug = /^true$/i.test(arg.slice('--debug='.length));
        }
    }

    return { project, debug };
}

async function main() {
    const { project, debug } = parseOptions(process.argv.slice(2));

    setLogLevel(debug);

    if (!project) {
        log.error('No project specified. Provide --project <slug> or set the PROJECT environment variable.');
        process.exit(2);
        return;
    }

    log.info(`Checking status of Weblate project "${project}"`);

    const components = await getProjectComponents(project);

    if (components.length === 0) {
        log.info(`Project "${project}" has no components (or the project does not exist).`);
        return;
    }

    // Red alert symbol used to flag locked components in the listing.
    const LOCKED_MARK = '🔴 LOCKED'; // 🔴 LOCKED

    // Sort components alphabetically by name (case-insensitive), then slug.
    const sorted = [...components].sort((a, b) => {
        const byName = String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' });
        return byName !== 0 ? byName : String(a.slug || '').localeCompare(String(b.slug || ''), 'en');
    });

    // Resolve the lock state authoritatively via the per-component lock
    // endpoint. The components-list `locked` field is not reliable, so it is
    // ignored. Requests run with bounded concurrency to avoid overloading the
    // (slow) server.
    log.debug(`Resolving lock status for ${sorted.length} component(s) via the lock endpoint`);
    const lockStates = await mapWithConcurrency(sorted, LOCK_CHECK_CONCURRENCY, (component) =>
        getComponentLockStatus(project, component.slug));
    const lockedComponents = sorted.filter((_component, index) => lockStates[index]);

    log.info(`Project "${project}" has ${components.length} component(s):`);
    sorted.forEach((component, index) => {
        const marker = lockStates[index] ? ` ${LOCKED_MARK}` : '';
        log.info(`  - ${component.name} [slug: ${component.slug}]${marker}`);
    });

    log.info('Summary:');
    log.info(`  Total components processed: ${components.length}`);
    log.info(`  Locked components:          ${lockedComponents.length}`);
    log.info(`  Unlocked components:        ${components.length - lockedComponents.length}`);

    if (lockedComponents.length > 0) {
        log.info(`${LOCKED_MARK}: ${lockedComponents.length} of ${components.length} component(s) are locked:`);
        for (const component of lockedComponents) {
            log.info(`  ${LOCKED_MARK} ${component.name} [slug: ${component.slug}]`);
        }
    } else {
        log.info('No locked components found.');
    }
}

main().catch((error) => {
    log.error('check status failed:', error.message);
    process.exit(1);
});
