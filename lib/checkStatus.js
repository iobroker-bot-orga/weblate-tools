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

const { log, setLogLevel, getEnv } = require('./common');
const { listProjectComponents } = require('./weblateTools');

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

    const components = await listProjectComponents(project);

    if (components.length === 0) {
        log.info(`Project "${project}" has no components (or the project does not exist).`);
        return;
    }

    log.info(`Project "${project}" has ${components.length} component(s):`);
    for (const component of components) {
        log.info(`  - ${component.name} [slug: ${component.slug}]`);
    }
}

main().catch((error) => {
    log.error('check status failed:', error.message);
    process.exit(1);
});
