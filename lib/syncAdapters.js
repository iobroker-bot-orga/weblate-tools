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
 *        - components linked to another component are skipped (logged). As the
 *          API does not reliably expose the link, linkage is detected mainly by
 *          caching each processed component's resolved repository URL: a later
 *          component resolving to the same URL is skipped and the component that
 *          already handled that repository is logged;
 *        - an update (pull) is triggered and awaited;
 *        - a push is triggered and awaited;
 *        - any failing operation is retried once after 30 s;
 *        - between two processed components the script waits a configurable
 *          time (default 10 s); no wait is spent around skipped components.
 *   5. Run an extra project-wide scan for LOCKED components (regardless of the
 *      adapter filter) and resolve a best-effort reason for each (the lock
 *      endpoint exposes only a boolean, so the repository status' `merge_failure`
 *      / `status` is used as the reason hint).
 *   6. Produce a report listing every processed adapter and its state
 *      (success / failure) and the locked components with their reason, written
 *      both to the log and to report files (`.syncAdapters_subject.txt` /
 *      `.syncAdapters_body.md`) so a workflow can send it by mail.
 *
 * Usage (interactive):
 *   WEBLATE_TOKEN=... node lib/syncAdapters.js [--adapter <name>] [--project <slug>] [--wait <seconds>] [--locked-only] [--debug]
 *
 * The script also accepts input via environment variables so it can be driven
 * from a GitHub workflow:
 *   ADAPTER / INPUT_ADAPTER - the adapter name to sync (empty = all adapters)
 *   PROJECT / INPUT_PROJECT - the Weblate project slug (default: adapters)
 *   WAIT    / INPUT_WAIT     - seconds to wait between components (default: 10)
 *   LOCKED_ONLY / INPUT_LOCKED_ONLY - "true" to process only currently locked
 *                             components
 *   DEBUG   / INPUT_DEBUG   - "true" to enable debug logging
 */

const fs = require('fs');
const path = require('path');

const { log, setLogLevel, getEnv, mapWithConcurrency } = require('./common');
const { DEFAULT_PROJECT, WEBLATE_MAX_CONCURRENCY } = require('./config');
const {
    getProjectComponents,
    getComponentLockStatus,
    getComponentRepositoryStatus,
    commitProjectRepository,
    pullComponentRepository,
    pushComponentRepository,
} = require('./weblateTools');

/** Delay (ms) waited before the single retry of a failed operation. */
const RETRY_DELAY_MS = 30000;

/** Default wait (seconds) between processing two components. */
const DEFAULT_WAIT_SECONDS = 10;

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
 * @returns {{ adapter: string|undefined, project: string, waitSeconds: number, lockedOnly: boolean, debug: boolean }}
 */
function parseOptions(argv) {
    let adapter = getEnv('ADAPTER') || getEnv('INPUT_ADAPTER');
    let project = getEnv('PROJECT') || getEnv('INPUT_PROJECT') || DEFAULT_PROJECT.slug;
    let waitRaw = getEnv('WAIT') || getEnv('INPUT_WAIT');
    let lockedOnly = /^true$/i.test(getEnv('LOCKED_ONLY', '') || getEnv('INPUT_LOCKED_ONLY', ''));
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
        } else if (arg === '--locked-only' || arg === '-l') {
            lockedOnly = true;
        } else if (arg.startsWith('--locked-only=')) {
            lockedOnly = /^true$/i.test(arg.slice('--locked-only='.length));
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

    return { adapter, project, waitSeconds, lockedOnly, debug };
}

/**
 * The resolved upstream repository URL of a component, or '' when none is
 * exposed. Weblate's `repo` field returns the *resolved* upstream URL even for
 * linked components, so a main component and every component linked to it share
 * the same value — which is exactly what lets us deduplicate them.
 *
 * @param {object} component - a component object.
 * @returns {string}
 */
function repoUrlOf(component) {
    return typeof component.repo === 'string' ? component.repo.trim() : '';
}

/**
 * If a component can be recognised as linked to another component purely from
 * its own fields, return a human-readable reason; otherwise null. This catches
 * the cases the API does expose (the `linked_component` hyperlink, or a
 * `weblate://` value in `repo`). It is a best-effort complement to the
 * repository-URL deduplication done in the main loop, since the API does not
 * reliably populate `linked_component` for every component/permission.
 *
 * @param {object} component - a component object.
 * @returns {string|null}
 */
function linkedReason(component) {
    if (component.linked_component) {
        return `linked to another component (${component.linked_component})`;
    }
    const repo = repoUrlOf(component);
    if (repo.startsWith('weblate://')) {
        return `linked to another component (${repo})`;
    }
    return null;
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
 * Best-effort lock reason for a component. The lock endpoint exposes only a
 * boolean, so the repository status is inspected for a `merge_failure` (the
 * usual cause of an automatic lock) or a free `status` text. Returns a short
 * reason string, or '' when none could be determined.
 *
 * @param {string} project - the project slug.
 * @param {string} slug - the component slug.
 * @returns {Promise<string>}
 */
async function lockReasonFor(project, slug) {
    try {
        const status = await getComponentRepositoryStatus(project, slug);
        const reason = (status.merge_failure || status.status || '').toString().trim();
        // Collapse whitespace and keep the reason to a single, readable line.
        return reason.replace(/\s+/g, ' ').slice(0, 300);
    } catch (error) {
        log.debug(`Could not read repository status of "${slug}" for a lock reason: ${error.message}`);
        return '';
    }
}

/**
 * Scan every component of the project for its lock state (via the authoritative
 * per-component lock endpoint, since the list `locked` field is unreliable) and,
 * for the locked ones, resolve a best-effort reason. Lock checks run with the
 * same bounded concurrency as other Weblate batches.
 *
 * @param {string} project - the project slug.
 * @param {Array<object>} components - all components of the project.
 * @returns {Promise<Array<{ slug: string, name: string, reason: string }>>}
 *          the locked components (sorted by slug).
 */
async function scanLockedComponents(project, components) {
    log.info(`Scanning ${components.length} component(s) for lock state`);
    const concurrency = Math.min(WEBLATE_MAX_CONCURRENCY, Math.max(1, components.length));
    const lockStates = await mapWithConcurrency(components, concurrency, async (component) => {
        try {
            return await getComponentLockStatus(project, component.slug);
        } catch (error) {
            log.warn(`Could not read lock state of "${component.slug}": ${error.message}`);
            return false;
        }
    });

    const locked = components.filter((_c, index) => lockStates[index]);
    // Resolve a reason per locked component (sequentially: there are usually few,
    // and it keeps the slow server lightly loaded).
    const result = [];
    for (const component of locked) {
        const reason = await lockReasonFor(project, component.slug);
        result.push({ slug: component.slug, name: component.name, reason });
    }
    result.sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
    return result;
}

/**
 * Build the report lines (subject + markdown body) from the processing results.
 *
 * @param {object} params
 * @param {string} params.project - the project slug.
 * @param {string|undefined} params.adapter - the requested adapter (or undefined).
 * @param {string|null} params.commitError - the commit error message, or null.
 * @param {Array<{ slug: string, name: string, state: string, error?: string }>} params.results
 * @param {Array<{ slug: string, name: string, reason: string }>} [params.locked] - locked components.
 * @returns {{ subject: string, body: string }}
 */
function buildReport({ project, adapter, commitError, results, locked = [] }) {
    const processed = results.filter((r) => r.state !== 'skipped');
    const success = processed.filter((r) => r.state === 'success');
    const failed = processed.filter((r) => r.state === 'failure');
    const skipped = results.filter((r) => r.state === 'skipped');

    const subject = `[weblate] ${WORKFLOW_NAME}: ${success.length} ok, ${failed.length} failed,`
        + ` ${locked.length} locked (${adapter || 'all adapters'})`;

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
    lines.push(`- Skipped (linked / duplicate repository): ${skipped.length}`);
    lines.push(`- Locked components (project-wide): ${locked.length}`);
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
                : '⚪ skipped';
        const details = r.error ? r.error.replace(/\|/g, '\\|') : '';
        lines.push(`| ${r.name} | ${r.slug} | ${stateLabel} | ${details} |`);
    }
    lines.push('');

    // Project-wide locked components (extra scan).
    lines.push('## Locked components (project-wide)');
    lines.push('');
    if (locked.length === 0) {
        lines.push('No locked components found.');
    } else {
        lines.push('| Component | Slug | Reason (best effort) |');
        lines.push('| --- | --- | --- |');
        for (const c of locked) {
            const reason = (c.reason || '_not exposed by the API_').replace(/\|/g, '\\|');
            lines.push(`| ${c.name} | ${c.slug} | ${reason} |`);
        }
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
    const { adapter, project, waitSeconds, lockedOnly, debug } = parseOptions(process.argv.slice(2));

    setLogLevel(debug);

    // Step 1: log the parameters the run was started with.
    log.info('Starting sync adapters with parameters:');
    log.info(`  adapter:     ${adapter || '(all adapters)'}`);
    log.info(`  project:     ${project}`);
    log.info(`  wait:        ${waitSeconds}s between components`);
    log.info(`  locked only: ${lockedOnly}`);
    log.info(`  debug:       ${debug}`);

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
    let selected = components
        .filter((c) => matchesAdapter(c, adapter))
        .sort((a, b) => String(a.slug).localeCompare(String(b.slug), 'en'));

    if (adapter && selected.length === 0) {
        log.warn(`No component matching adapter "${adapter}" was found in project "${project}"`);
    }

    // When "locked only" is requested, keep only the components that are
    // currently locked (resolved via the authoritative per-component lock
    // endpoint, since the list `locked` field is unreliable). Lock checks run
    // with the same bounded concurrency as other Weblate batches.
    if (lockedOnly && selected.length > 0) {
        log.info(`Locked-only mode: resolving lock state of ${selected.length} candidate component(s)`);
        const concurrency = Math.min(WEBLATE_MAX_CONCURRENCY, Math.max(1, selected.length));
        const lockStates = await mapWithConcurrency(selected, concurrency, async (component) => {
            try {
                return await getComponentLockStatus(project, component.slug);
            } catch (error) {
                log.warn(`Could not read lock state of "${component.slug}": ${error.message}`);
                return false;
            }
        });
        selected = selected.filter((_c, index) => lockStates[index]);
        log.info(`Locked-only mode: ${selected.length} component(s) are currently locked`);
    }

    log.info(`${selected.length} component(s) selected for processing`);

    // Step 4: process the selected components one after the other.
    const waitMs = waitSeconds * 1000;
    const results = [];
    // Whether a real (non-skipped) component was already processed. The wait is
    // applied only between two processed components, so no wait is spent before
    // or after a skipped component.
    let processedAny = false;
    // Cache of repository URL -> the slug of the component that first handled it.
    // Weblate's `repo` field resolves to the same upstream URL for a main
    // component and every component linked to it, and `linked_component` is not
    // reliably populated, so this URL cache is the authoritative way to avoid
    // syncing the same repository more than once.
    const repoOwners = new Map();
    for (const component of selected) {
        const slug = component.slug;
        const repoUrl = repoUrlOf(component);

        // Decide whether this component is to be skipped BEFORE applying any
        // wait, so no time is spent around a skipped component. A component is
        // skipped when it is recognisably linked, or when its repository URL was
        // already processed by an earlier component (the link we cannot read
        // from the API otherwise).
        let skipReason = linkedReason(component);
        if (!skipReason && repoUrl && repoOwners.has(repoUrl)) {
            skipReason = `repository ${repoUrl} already processed by component "${repoOwners.get(repoUrl)}"`;
        }

        // Wait before a component we will actually process, but only when another
        // component was already processed.
        if (!skipReason && processedAny && waitMs > 0) {
            log.info(`Waiting ${waitSeconds}s before processing the next component`);
            await sleep(waitMs);
        }

        log.info(`Start processing component "${slug}" ("${component.name}")`);

        if (skipReason) {
            log.info(`Component "${slug}" skipped: ${skipReason}`);
            results.push({ slug, name: component.name, state: 'skipped' });
            continue;
        }

        // Claim this repository URL immediately, so any later component resolving
        // to the same URL is skipped even if the sync below fails.
        if (repoUrl) {
            repoOwners.set(repoUrl, slug);
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

    // Step 5: extra project-wide scan for locked components (with best-effort
    // reasons). This always covers every component of the project, regardless of
    // the adapter filter applied to the sync above.
    log.info('');
    const locked = await scanLockedComponents(project, components);

    // Step 6: build and emit the report.
    const report = buildReport({ project, adapter, commitError, results, locked });
    writeReportFiles(report);

    const processed = results.filter((r) => r.state !== 'skipped');
    const failed = processed.filter((r) => r.state === 'failure');
    const skipped = results.filter((r) => r.state === 'skipped');

    log.info('');
    log.info('Sync adapters report:');
    log.info(`  Components processed: ${processed.length}`);
    log.info(`  Succeeded:           ${processed.length - failed.length}`);
    log.info(`  Failed:              ${failed.length}`);
    log.info(`  Skipped:             ${skipped.length}`);
    log.info(`  Locked (project):    ${locked.length}`);
    for (const r of results) {
        const stateLabel = r.state === 'success' ? 'success' : r.state === 'failure' ? 'FAILURE' : 'skipped';
        log.info(`  - ${r.slug}: ${stateLabel}${r.error ? ` (${r.error})` : ''}`);
    }
    if (locked.length > 0) {
        log.info(`Locked components (${locked.length}):`);
        for (const c of locked) {
            log.info(`  🔴 ${c.name} [slug: ${c.slug}]${c.reason ? ` — ${c.reason}` : ' — (reason not exposed by the API)'}`);
        }
    } else {
        log.info('No locked components found.');
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
