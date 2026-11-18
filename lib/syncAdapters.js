'use strict';

/**
 * sync adapters
 *
 * Synchronises the Weblate repositories of ioBroker adapter components with
 * their upstream GitHub repositories: it commits all pending translation
 * changes, then for every (non-linked) component triggers a repository update
 * (pull) followed by a push.
 *
 * Steps performed (each reported via info logging):
 *   1. Log the parameters the run was started with.
 *   2. Commit all pending changes of the project to the Weblate repositories
 *      and wait for completion.
 *   3. Retrieve all components of the project.
 *   4. Process every component matching the requested adapter name (or all
 *      components when none was given), one after the other:
 *        - components linked to another component are skipped (logged);
 *        - an update (pull) is triggered and awaited;
 *        - a push is triggered and awaited;
 *        - any failing operation is retried once after 30 s;
 *        - between two processed components the script waits a configurable
 *          time (default 30 s); no wait is spent around skipped components.
 *   5. Produce a report listing every processed adapter and its state
 *      (success / failure), written both to the log and to report files
 *      (`.syncAdapters_subject.txt` / `.syncAdapters_body.md`) so a workflow can
 *      send it by mail.
 *
 * Usage (interactive):
 *   WEBLATE_TOKEN=... node lib/syncAdapters.js [--adapter <name>] [--project <slug>] [--wait <seconds>] [--debug]
 *
 * The script also accepts input via environment variables so it can be driven
 * from a GitHub workflow:
 *   ADAPTER / INPUT_ADAPTER - the adapter name to sync (empty = all adapters)
 *   PROJECT / INPUT_PROJECT - the Weblate project slug (default: adapters)
 *   WAIT    / INPUT_WAIT     - seconds to wait between components (default: 30)
 *   DEBUG   / INPUT_DEBUG   - "true" to enable debug logging
 */

const fs = require('fs');
const path = require('path');

const { log, setLogLevel, getEnv } = require('./common');
const { DEFAULT_PROJECT } = require('./config');
const {
    getProjectComponents,
    commitProjectRepository,
    pullComponentRepository,
    pushComponentRepository,
} = require('./weblateTools');

/** Delay (ms) waited before the single retry of a failed operation. */
const RETRY_DELAY_MS = 30000;

/** Default wait (seconds) between processing two components. */
const DEFAULT_WAIT_SECONDS = 30;

/** Base file names of the report written for the mail step. */
const REPORT_SUBJECT_FILE = '.syncAdapters_subject.txt';
const REPORT_BODY_FILE = '.syncAdapters_body.md';

/** Human-readable name of this tool / workflow (noted in the mail report). */
const WORKFLOW_NAME = 'sync adapters';

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse command line arguments and environment variables into options.
 * CLI arguments take precedence over environment variables.
 *
 * @param {string[]} argv - process arguments (without node/script).
 * @returns {{ adapter: string|undefined, project: string, waitSeconds: number, debug: boolean }}
 */
function parseOptions(argv) {
    let adapter = getEnv('ADAPTER') || getEnv('INPUT_ADAPTER');
    let project = getEnv('PROJECT') || getEnv('INPUT_PROJECT') || DEFAULT_PROJECT.slug;
    let waitRaw = getEnv('WAIT') || getEnv('INPUT_WAIT');
    let debug = /^true$/i.test(getEnv('DEBUG', '') || getEnv('INPUT_DEBUG', ''));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--adapter' || arg === '-a') {
            adapter = argv[++i];
        } else if (arg.startsWith('--adapter=')) {
            adapter = arg.slice('--adapter='.length);
        } else if (arg === '--project' || arg === '-p') {
            project = argv[++i];
        } else if (arg.startsWith('--project=')) {
            project = arg.slice('--project='.length);
        } else if (arg === '--wait' || arg === '-w') {
            waitRaw = argv[++i];
        } else if (arg.startsWith('--wait=')) {
            waitRaw = arg.slice('--wait='.length);
        } else if (arg === '--debug' || arg === '-d') {
            debug = true;
        } else if (arg.startsWith('--debug=')) {
            debug = /^true$/i.test(arg.slice('--debug='.length));
        }
    }

    // An empty adapter string means "all adapters".
    adapter = adapter && adapter.trim() ? adapter.trim() : undefined;

    // Wait time (seconds) between components; non-numeric/negative falls back to
    // the default.
    const parsedWait = Number(waitRaw);
    const waitSeconds = Number.isFinite(parsedWait) && parsedWait >= 0 ? parsedWait : DEFAULT_WAIT_SECONDS;

    return { adapter, project, waitSeconds, debug };
}

/**
 * Whether a component is linked to another component (shares that component's
 * repository) rather than linking to a real VCS repository of its own.
 *
 * The authoritative indicator is the `linked_component` field: Weblate's `repo`
 * field reports the *resolved* upstream URL even for linked components (the API
 * docs tell callers to use `linked_component` to detect this), so the `repo`
 * value is only used as a fallback.
 *
 * @param {object} component - a component object.
 * @returns {boolean}
 */
function isLinkedComponent(component) {
    if (component.linked_component) {
        return true;
    }
    return typeof component.repo === 'string' && component.repo.startsWith('weblate://');
}

/**
 * Whether a component belongs to the requested adapter. The main component of an
 * adapter uses the adapter name as its slug; additional components use
 * `<adapter>_<suffix>`. When no adapter was requested, every component matches.
 *
 * @param {object} component - a component object.
 * @param {string|undefined} adapter - the requested adapter name (or undefined).
 * @returns {boolean}
 */
function matchesAdapter(component, adapter) {
    if (!adapter) {
        return true;
    }
    const slug = String(component.slug || '');
    return slug === adapter || slug.startsWith(`${adapter}_`);
}

/**
 * Run an async operation, retrying it once after a 30 s wait if it fails (e.g.
 * on a timeout). The error of the final attempt is thrown.
 *
 * @template T
 * @param {string} label - description used in log lines.
 * @param {() => Promise<T>} fn - the operation to run.
 * @returns {Promise<T>}
 */
async function withSingleRetry(label, fn) {
    try {
        return await fn();
    } catch (error) {
        log.warn(`${label} failed (${error.message}); retrying once after ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        return fn();
    }
}

/**
 * Process a single component: trigger an update (pull) and then a push, waiting
 * for each operation and retrying it once on failure.
 *
 * @param {string} project - the project slug.
 * @param {object} component - the component object.
 * @returns {Promise<void>} resolves on success, rejects on failure.
 */
async function processComponent(project, component) {
    const slug = component.slug;

    log.info(`Updating (pull) component "${slug}"`);
    await withSingleRetry(`Update (pull) of component "${slug}"`, () => pullComponentRepository(project, slug));
    log.info(`Update (pull) of component "${slug}" completed`);

    log.info(`Pushing component "${slug}"`);
    await withSingleRetry(`Push of component "${slug}"`, () => pushComponentRepository(project, slug));
    log.info(`Push of component "${slug}" completed`);
}

/**
 * Build the report lines (subject + markdown body) from the processing results.
 *
 * @param {object} params
 * @param {string} params.project - the project slug.
 * @param {string|undefined} params.adapter - the requested adapter (or undefined).
 * @param {string|null} params.commitError - the commit error message, or null.
 * @param {Array<{ slug: string, name: string, state: string, error?: string }>} params.results
 * @returns {{ subject: string, body: string }}
 */
function buildReport({ project, adapter, commitError, results }) {
    const processed = results.filter((r) => r.state !== 'skipped');
    const success = processed.filter((r) => r.state === 'success');
    const failed = processed.filter((r) => r.state === 'failure');
    const skipped = results.filter((r) => r.state === 'skipped');

    const subject = `[weblate] ${WORKFLOW_NAME}: ${success.length} ok, ${failed.length} failed`
        + ` (${adapter || 'all adapters'})`;

    const lines = [];
    lines.push(`# ${WORKFLOW_NAME} report`);
    lines.push('');
    lines.push(`This report was generated by the **${WORKFLOW_NAME}** workflow.`);
    lines.push('');
    lines.push(`- Project: \`${project}\``);
    lines.push(`- Adapter filter: ${adapter ? `\`${adapter}\`` : 'all adapters'}`);
    lines.push(`- Components processed: ${processed.length}`);
    lines.push(`- Succeeded: ${success.length}`);
    lines.push(`- Failed: ${failed.length}`);
    lines.push(`- Skipped (linked): ${skipped.length}`);
    lines.push('');
    if (commitError) {
        lines.push(`> ⚠️ Committing pending changes failed: ${commitError}`);
        lines.push('');
    }

    lines.push('## Processed adapters');
    lines.push('');
    lines.push('| Component | Slug | State | Details |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of results) {
        const stateLabel = r.state === 'success'
            ? '✅ success'
            : r.state === 'failure'
                ? '❌ failure'
                : '⚪ skipped (linked)';
        const details = r.error ? r.error.replace(/\|/g, '\\|') : '';
        lines.push(`| ${r.name} | ${r.slug} | ${stateLabel} | ${details} |`);
    }
    lines.push('');

    return { subject, body: lines.join('\n') };
}

/**
 * Write the report files used by the mail step of the workflow. Failure to
 * write them is logged but does not abort the run.
 *
 * @param {{ subject: string, body: string }} report
 */
function writeReportFiles(report) {
    try {
        fs.writeFileSync(path.resolve(process.cwd(), REPORT_SUBJECT_FILE), `${report.subject}\n`, 'utf8');
        fs.writeFileSync(path.resolve(process.cwd(), REPORT_BODY_FILE), report.body, 'utf8');
        log.info(`Report written to ${REPORT_SUBJECT_FILE} and ${REPORT_BODY_FILE}`);
    } catch (error) {
        log.error(`Failed to write report files: ${error.message}`);
    }
}

async function main() {
    const { adapter, project, waitSeconds, debug } = parseOptions(process.argv.slice(2));

    setLogLevel(debug);

    // Step 1: log the parameters the run was started with.
    log.info('Starting sync adapters with parameters:');
    log.info(`  adapter: ${adapter || '(all adapters)'}`);
    log.info(`  project: ${project}`);
    log.info(`  wait:    ${waitSeconds}s between components`);
    log.info(`  debug:   ${debug}`);

    // Step 2: commit all pending changes of the project and wait for completion.
    let commitError = null;
    log.info(`Committing all pending changes of project "${project}" to the Weblate repositories`);
    try {
        await withSingleRetry(`Commit of pending changes for project "${project}"`,
            () => commitProjectRepository(project));
        log.info(`Commit of pending changes for project "${project}" completed`);
    } catch (error) {
        commitError = error.message;
        log.error(`Commit of pending changes for project "${project}" failed: ${error.message}; `
            + 'continuing with component processing');
    }

    // Step 3: retrieve all components of the project.
    log.info(`Retrieving components of project "${project}"`);
    const components = await getProjectComponents(project);
    log.info(`Project "${project}" has ${components.length} component(s)`);

    // Select the components matching the requested adapter (all when none), in a
    // stable alphabetical order.
    const selected = components
        .filter((c) => matchesAdapter(c, adapter))
        .sort((a, b) => String(a.slug).localeCompare(String(b.slug), 'en'));

    if (adapter && selected.length === 0) {
        log.warn(`No component matching adapter "${adapter}" was found in project "${project}"`);
    }
    log.info(`${selected.length} component(s) selected for processing`);

    // Step 4: process the selected components one after the other.
    const waitMs = waitSeconds * 1000;
    const results = [];
    // Whether a real (non-skipped) component was already processed. The wait is
    // applied only between two processed components, so no wait is spent before
    // or after a skipped (linked) component.
    let processedAny = false;
    for (const component of selected) {
        const slug = component.slug;
        const linked = isLinkedComponent(component);

        // Wait before a component we will actually process, but only when another
        // component was already processed.
        if (!linked && processedAny && waitMs > 0) {
            log.info(`Waiting ${waitSeconds}s before processing the next component`);
            await sleep(waitMs);
        }

        log.info(`Start processing component "${slug}" ("${component.name}")`);

        // Components linked to another component are skipped (processing them
        // would sync the same repository again). No wait is applied for a skip.
        if (linked) {
            const target = component.linked_component || component.repo;
            log.info(`Component "${slug}" is linked to another component (${target}); skipping`);
            results.push({ slug, name: component.name, state: 'skipped' });
            continue;
        }

        try {
            await processComponent(project, component);
            results.push({ slug, name: component.name, state: 'success' });
            log.info(`Finished processing component "${slug}": success`);
        } catch (error) {
            const detail = error.response && error.response.data
                ? JSON.stringify(error.response.data)
                : error.message;
            results.push({ slug, name: component.name, state: 'failure', error: detail });
            log.error(`Finished processing component "${slug}": failure (${detail})`);
        }
        // A real component was processed (success or failure); the next processed
        // component will be preceded by the wait.
        processedAny = true;
    }

    // Step 5: build and emit the report.
    const report = buildReport({ project, adapter, commitError, results });
    writeReportFiles(report);

    const processed = results.filter((r) => r.state !== 'skipped');
    const failed = processed.filter((r) => r.state === 'failure');
    const skipped = results.filter((r) => r.state === 'skipped');

    log.info('');
    log.info('Sync adapters report:');
    log.info(`  Components processed: ${processed.length}`);
    log.info(`  Succeeded:           ${processed.length - failed.length}`);
    log.info(`  Failed:              ${failed.length}`);
    log.info(`  Skipped (linked):    ${skipped.length}`);
    for (const r of results) {
        const stateLabel = r.state === 'success' ? 'success' : r.state === 'failure' ? 'FAILURE' : 'skipped';
        log.info(`  - ${r.slug}: ${stateLabel}${r.error ? ` (${r.error})` : ''}`);
    }

    if (failed.length > 0) {
        log.error(`sync adapters finished with ${failed.length} failed component(s)`);
        process.exit(1);
        return;
    }

    log.info('sync adapters finished successfully');
}

main().catch((error) => {
    log.error('sync adapters failed:', error.message);
    process.exit(1);
});
