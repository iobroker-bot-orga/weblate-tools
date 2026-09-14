'use strict';

/**
 * Evaluation of the i18n directories of an ioBroker adapter repository.
 *
 * Decides which i18n directory should become the Weblate component (the "main"
 * directory) and which directories are ignored (located under a build folder,
 * or an admin/ tree that merely duplicates a tree outside admin/). Comparison
 * of "identical" trees is done on the English language file only.
 *
 * The result is a list of per-directory evaluation entries (for the report) and
 * the selected main directory descriptor (or null).
 */

const { getFileContent } = require('./githubTools');

const BASE_LANGUAGE = 'en';

/** Escape a string for use inside a RegExp. */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every i18n directory in a repository tree. An i18n directory is any path
 * segment named `i18n`; the directory path is everything up to and including
 * that segment. Derived from all paths so directories are found even when only
 * their files appear in the tree.
 *
 * @param {Array<{ path: string }>} tree - recursive git tree.
 * @returns {string[]} distinct i18n directory paths.
 */
function findI18nDirectories(tree) {
    const dirs = new Set();
    for (const entry of tree) {
        const parts = entry.path.split('/');
        for (let i = 0; i < parts.length; i++) {
            if (parts[i] === 'i18n') {
                dirs.add(parts.slice(0, i + 1).join('/'));
            }
        }
    }
    return [...dirs];
}

/**
 * Determine whether an i18n directory uses the flat (`i18n/<lang>.json`) or
 * nested (`i18n/<lang>/translations.json`) layout. English is checked first;
 * otherwise any language file decides.
 *
 * @param {Set<string>} paths - all repository paths.
 * @param {string} basePath - the i18n directory path.
 * @returns {'flat'|'nested'|'unknown'}
 */
function detectFormat(paths, basePath) {
    if (paths.has(`${basePath}/${BASE_LANGUAGE}/translations.json`)) {
        return 'nested';
    }
    if (paths.has(`${basePath}/${BASE_LANGUAGE}.json`)) {
        return 'flat';
    }
    const flatRe = new RegExp(`^${escapeRegExp(basePath)}/([^/]+)\\.json$`);
    const nestedRe = new RegExp(`^${escapeRegExp(basePath)}/([^/]+)/translations\\.json$`);
    let flat = false;
    let nested = false;
    for (const p of paths) {
        if (nestedRe.test(p)) {
            nested = true;
        } else if (flatRe.test(p)) {
            flat = true;
        }
    }
    if (nested) {
        return 'nested';
    }
    if (flat) {
        return 'flat';
    }
    return 'unknown';
}

/** The Weblate file mask for a directory/format. */
function fileMaskFor(basePath, format) {
    return format === 'nested' ? `${basePath}/*/translations.json` : `${basePath}/*.json`;
}

/** The base (English) language file for a directory/format. */
function baseFileFor(basePath, format) {
    return format === 'nested'
        ? `${basePath}/${BASE_LANGUAGE}/translations.json`
        : `${basePath}/${BASE_LANGUAGE}.json`;
}

/** Path of the English language file for a directory/format (null if unknown). */
function englishFileFor(basePath, format) {
    if (format === 'flat' || format === 'nested') {
        return baseFileFor(basePath, format);
    }
    return null;
}

/** Canonical JSON (keys sorted) for stable comparison, or null if not JSON. */
function canonicalJson(text) {
    try {
        return JSON.stringify(sortKeys(JSON.parse(text)));
    } catch (err) {
        return null;
    }
}

function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortKeys(value[key]);
        }
        return out;
    }
    return value;
}

/** Whether two English files are identical (JSON-aware, else raw). */
function englishEqual(a, b) {
    const ca = canonicalJson(a);
    const cb = canonicalJson(b);
    if (ca !== null && cb !== null) {
        return ca === cb;
    }
    return String(a).trim() === String(b).trim();
}

/**
 * Evaluate all i18n directories of a repository.
 *
 * @param {object} params
 * @param {Array<{ path: string }>} params.tree - recursive git tree.
 * @param {string} params.owner - repository owner.
 * @param {string} params.repo - repository name.
 * @param {string} params.branch - branch to read files from.
 * @returns {Promise<{ entries: Array<object>, main: object|null }>}
 */
async function evaluateI18nTrees({ tree, owner, repo, branch }) {
    const paths = new Set(tree.map((entry) => entry.path));

    const entries = findI18nDirectories(tree).map((path) => ({
        path,
        format: detectFormat(paths, path),
        isAdmin: path.startsWith('admin/'),
        underBuild: path.split('/').includes('build'),
        ignored: false,
        reason: null,
        duplicateOf: null,      // for a valid tree: the ignored dir that duplicates it
        duplicateRelated: null, // for an ignored admin tree: the outside tree it duplicates
        valid: false,
        enPath: null,
        enContent: null,
        fileMask: null,
        baseFile: null,
        isMain: false,
    }));

    // Ignore anything located under a build/ folder.
    for (const entry of entries) {
        if (entry.underBuild) {
            entry.ignored = true;
            entry.reason = 'located under build/';
        }
    }

    // Fetch the English file for every non-ignored directory.
    for (const entry of entries) {
        if (entry.ignored) {
            continue;
        }
        const enPath = englishFileFor(entry.path, entry.format);
        if (enPath && paths.has(enPath)) {
            entry.enContent = await getFileContent(owner, repo, enPath, branch);
            if (entry.enContent != null) {
                entry.enPath = enPath;
            }
        }
        if (!entry.enContent) {
            entry.reason = entry.reason || 'no English language file';
        } else if (entry.format === 'unknown') {
            entry.reason = entry.reason || 'unknown i18n structure';
        }
    }

    // Ignore admin/ trees that are identical (English file) to a tree outside
    // admin/. The outside tree is remembered as their duplicate.
    const outside = entries.filter((e) => !e.isAdmin && !e.ignored && e.enContent);
    for (const entry of entries) {
        if (entry.ignored || !entry.isAdmin || !entry.enContent) {
            continue;
        }
        const match = outside.find((o) => englishEqual(o.enContent, entry.enContent));
        if (match) {
            entry.ignored = true;
            entry.reason = `duplicate of ${match.path}`;
            entry.duplicateRelated = match.path;
            match.duplicateOf = entry.path;
        }
    }

    // Mark validity and compute Weblate masks for valid trees.
    for (const entry of entries) {
        entry.valid = !entry.ignored && !!entry.enContent && entry.format !== 'unknown';
        if (entry.valid) {
            entry.fileMask = fileMaskFor(entry.path, entry.format);
            entry.baseFile = baseFileFor(entry.path, entry.format);
        }
    }

    const byPath = (p) => entries.find((e) => e.path === p);

    // Determine the main/base directory by the required sequence.
    let main = null;
    const adminI18n = byPath('admin/i18n');
    if (adminI18n && adminI18n.valid) {
        main = adminI18n;
    } else if (adminI18n && adminI18n.ignored && adminI18n.duplicateRelated) {
        const related = byPath(adminI18n.duplicateRelated);
        main = related && related.valid ? related : null;
    } else {
        const srcAdmin = byPath('src-admin/i18n');
        if (srcAdmin && srcAdmin.valid) {
            main = srcAdmin;
        }
    }
    if (main) {
        main.isMain = true;
    }

    return { entries, main };
}

/**
 * Render the evaluation as an aligned text table (array of lines), sorted
 * alphabetically by directory.
 *
 * Columns: flag (🟢 valid / 🔴 ignored-or-invalid), main marker, directory,
 * type (flat/nested), reason (if ignored/invalid), duplicate (for a valid tree
 * that has a duplicate).
 *
 * @param {Array<object>} entries
 * @returns {string[]} report lines.
 */
function formatReport(entries) {
    const rows = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));

    const dirHeader = 'Directory';
    const typeHeader = 'Type';
    const reasonHeader = 'Reason';
    const dupHeader = 'Duplicate';

    const dirW = Math.max(dirHeader.length, ...rows.map((r) => r.path.length));
    const typeW = Math.max(typeHeader.length, ...rows.map((r) => (r.format || '').length));
    const reasonW = Math.max(
        reasonHeader.length,
        ...rows.map((r) => (r.ignored || !r.valid ? (r.reason || '').length : 0)),
    );

    const lines = [];
    // Two leading spaces stand in for the emoji flag column width in the header.
    lines.push(`   ${'M'} ${dirHeader.padEnd(dirW)}  ${typeHeader.padEnd(typeW)}  ${reasonHeader.padEnd(reasonW)}  ${dupHeader}`);

    for (const r of rows) {
        const flag = r.valid ? '🟢' : '🔴';
        const mark = r.isMain ? '►' : ' ';
        const type = (r.format || '').padEnd(typeW);
        const reason = (r.ignored || !r.valid ? (r.reason || '') : '').padEnd(reasonW);
        const dup = r.valid && r.duplicateOf ? r.duplicateOf : '';
        lines.push(`${flag} ${mark} ${r.path.padEnd(dirW)}  ${type}  ${reason}  ${dup}`.replace(/\s+$/, ''));
    }

    return lines;
}

/**
 * Calculate the Weblate component name/slug for an i18n directory.
 *
 * The main directory maps to the base component name (the adapter name). Every
 * other directory becomes `<adapterName>_<dir>` where `<dir>` is the directory
 * path without the trailing `i18n` segment and with `/` replaced by `_`.
 * e.g. adapter `foo`, dir `src-admin/src/i18n` → `foo_src-admin_src`.
 *
 * @param {string} adapterName - the base component name (adapter name).
 * @param {string} dirPath - the i18n directory path.
 * @param {boolean} isMain - whether this is the main directory.
 * @returns {string} the component name/slug.
 */
function componentNameFor(adapterName, dirPath, isMain) {
    if (isMain) {
        return adapterName;
    }
    // Strip the trailing "i18n" segment and replace "/" with "_". For an i18n
    // directory at the repo root this leaves an empty suffix, giving
    // "<adapterName>_" (with a trailing underscore) as specified.
    const stripped = dirPath.replace(/(^|\/)i18n$/, '').replace(/^\/+|\/+$/g, '');
    return `${adapterName}_${stripped.replace(/\//g, '_')}`;
}

module.exports = {
    findI18nDirectories,
    detectFormat,
    fileMaskFor,
    baseFileFor,
    evaluateI18nTrees,
    formatReport,
    componentNameFor,
};
