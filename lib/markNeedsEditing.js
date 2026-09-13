'use strict';

/**
 * mark needs editing
 *
 * Runs the "needs editing" bulk edit on an EXISTING Weblate component, without
 * creating anything. Useful to (re)apply the flag on a component that already
 * exists (addAdapter aborts when the component exists) and to capture a debug
 * log of exactly what happens per unit.
 *
 * Two phases (see weblateTools.markComponentNeedsEditing):
 *   1. clear "needs editing" on the base language (English) → "translated";
 *   2. mark the translated strings of every other language as "needs editing".
 *
 * Usage (interactive):
 *   WEBLATE_TOKEN=... node lib/markNeedsEditing.js --component <slug> [--project <slug>] [--base en] [--debug]
 *
 * Env-var input (for workflows):
 *   PROJECT/INPUT_PROJECT, COMPONENT/INPUT_COMPONENT, BASE/INPUT_BASE,
 *   DEBUG/INPUT_DEBUG.
 */

const { log, setLogLevel, getEnv } = require('./common');
const { DEFAULT_PROJECT, DEFAULT_BASE_LANGUAGE } = require('./config');
const { getComponent, markComponentNeedsEditing } = require('./weblateTools');

/**
 * Parse CLI args and env vars. CLI args take precedence.
 *
 * @param {string[]} argv
 * @returns {{ project: string, component: string|undefined, base: string, debug: boolean }}
 */
function parseOptions(argv) {
    let project = getEnv('PROJECT') || getEnv('INPUT_PROJECT') || DEFAULT_PROJECT.slug;
    let component = getEnv('COMPONENT') || getEnv('INPUT_COMPONENT');
    let base = getEnv('BASE') || getEnv('INPUT_BASE') || DEFAULT_BASE_LANGUAGE;
    let debug = /^true$/i.test(getEnv('DEBUG', '') || getEnv('INPUT_DEBUG', ''));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--project' || arg === '-p') {
            project = argv[++i];
        } else if (arg.startsWith('--project=')) {
            project = arg.slice('--project='.length);
        } else if (arg === '--component' || arg === '-c') {
            component = argv[++i];
        } else if (arg.startsWith('--component=')) {
            component = arg.slice('--component='.length);
        } else if (arg === '--base' || arg === '-b') {
            base = argv[++i];
        } else if (arg.startsWith('--base=')) {
            base = arg.slice('--base='.length);
        } else if (arg === '--debug' || arg === '-d') {
            debug = true;
        } else if (arg.startsWith('--debug=')) {
            debug = /^true$/i.test(arg.slice('--debug='.length));
        }
    }

    return { project, component, base, debug };
}

async function main() {
    const { project, component, base, debug } = parseOptions(process.argv.slice(2));

    setLogLevel(debug);

    if (!component) {
        log.error('No component specified. Provide --component <slug> or set the COMPONENT environment variable.');
        process.exit(2);
        return;
    }

    log.info(`Marking needs editing on component "${component}" in project "${project}" (base language "${base}")`);

    const existing = await getComponent(project, component);
    if (!existing) {
        log.error(`Component "${component}" does not exist in project "${project}"; aborting.`);
        process.exit(1);
        return;
    }

    const summary = await markComponentNeedsEditing(project, component, { baseLanguage: base });
    log.info(`Done: base "${base}" cleared ${summary.baseCleared} string(s); `
        + `${summary.languages} language(s), ${summary.updated} string(s) set to needs editing, `
        + `${summary.skipped} skipped, ${summary.failed} failed`);

    if (summary.failed > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    log.error('mark needs editing failed:', error.message);
    process.exit(1);
});
