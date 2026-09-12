'use strict';

/**
 * Common routines shared by all weblate-tools scripts.
 *
 * Provides:
 *   - a small logger supporting `info` and `debug` levels (English only),
 *   - helpers to read required environment variables,
 *   - a helper to mask sensitive data (tokens, secrets) before logging.
 *
 * All logging in this project is done in English.
 */

const https = require('https');
const http = require('http');
const dns = require('dns');

// Force IPv4 for all DNS resolution performed by this process. IPv6 access
// must never be attempted (the Weblate host is only reachable over IPv4).
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

/**
 * Custom DNS lookup that only ever resolves to IPv4 addresses, so no IPv6
 * connection is attempted.
 */
function ipv4OnlyLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    return dns.lookup(hostname, { family: 4, all: false }, cb);
}

/**
 * Create HTTP/HTTPS agents that connect over IPv4 only. Shared by the Weblate
 * and GitHub axios instances so that IPv6 is never tried.
 *
 * @returns {{ httpAgent: import('http').Agent, httpsAgent: import('https').Agent }}
 */
function createIpv4Agents() {
    const opts = { keepAlive: true, family: 4, lookup: ipv4OnlyLookup };
    return {
        httpAgent: new http.Agent(opts),
        httpsAgent: new https.Agent(opts),
    };
}

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LOG_LEVELS.info;

/**
 * Set the active log level.
 * @param {'debug'|'info'|'warn'|'error'|boolean} level - level name, or a
 *        boolean where `true` enables debug logging and `false` keeps info.
 */
function setLogLevel(level) {
    if (typeof level === 'boolean') {
        currentLevel = level ? LOG_LEVELS.debug : LOG_LEVELS.info;
        return;
    }
    if (typeof level === 'string' && LOG_LEVELS[level] !== undefined) {
        currentLevel = LOG_LEVELS[level];
    }
}

/** @returns {boolean} whether debug logging is currently enabled. */
function isDebugEnabled() {
    return currentLevel <= LOG_LEVELS.debug;
}

function timestamp() {
    return new Date().toISOString();
}

function logAt(levelName, args) {
    if (LOG_LEVELS[levelName] < currentLevel) {
        return;
    }
    const prefix = `${timestamp()} [${levelName.toUpperCase()}]`;
    const sink = levelName === 'error' || levelName === 'warn' ? console.error : console.log;
    sink(prefix, ...args.map(formatArg));
}

/**
 * Format a single log argument. Strings and primitives are returned as-is;
 * objects/arrays are masked and fully serialized with JSON.stringify so that
 * nested structures are readable (console.log otherwise truncates them to
 * "[Object]" / "[Array]").
 *
 * @param {*} value
 * @returns {string|*}
 */
function formatArg(value) {
    if (value === null || typeof value !== 'object') {
        return maskSensitive(value);
    }
    try {
        return JSON.stringify(maskSensitive(value), null, 2);
    } catch (err) {
        // Fallback for anything JSON cannot serialize (e.g. BigInt).
        return String(maskSensitive(value));
    }
}

const log = {
    debug: (...args) => logAt('debug', args),
    info: (...args) => logAt('info', args),
    warn: (...args) => logAt('warn', args),
    error: (...args) => logAt('error', args),
};

/**
 * Mask sensitive data (tokens, authorization headers, secrets) so it is safe
 * to log. Works on strings and on (nested) plain objects/arrays; other values
 * are returned unchanged.
 *
 * @param {*} value - value to mask.
 * @returns {*} a masked copy of the value.
 */
function maskSensitive(value) {
    return maskValue(value, new WeakSet());
}

// Keys whose values should always be fully masked.
const SENSITIVE_KEY_RE = /(token|authorization|auth|secret|password|passwd|api[-_]?key|access[-_]?key|cookie|set-cookie)/i;

// Patterns of secret-looking tokens embedded in free text.
const INLINE_SECRET_PATTERNS = [
    /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g,
];

function maskString(str) {
    let out = str;
    for (const re of INLINE_SECRET_PATTERNS) {
        out = out.replace(re, (m) => {
            const keyword = m.split(/\s+/)[0];
            return /\s/.test(m) ? `${keyword} ${maskToken(m.split(/\s+/).slice(1).join(' '))}` : maskToken(m);
        });
    }
    return out;
}

/** Mask a raw token value, keeping only a short suffix for correlation. */
function maskToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
        return '***';
    }
    if (token.length <= 4) {
        return '***';
    }
    return `***${token.slice(-4)}`;
}

function maskValue(value, seen) {
    if (typeof value === 'string') {
        return maskString(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => maskValue(item, seen));
    }

    const result = {};
    for (const [key, val] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            result[key] = typeof val === 'string' ? maskToken(val) : '***';
        } else {
            result[key] = maskValue(val, seen);
        }
    }
    return result;
}

/**
 * Read a required environment variable.
 * @param {string} name - variable name.
 * @returns {string} the value.
 * @throws {Error} if the variable is missing or empty.
 */
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
}

/**
 * Read an optional environment variable.
 * @param {string} name - variable name.
 * @param {string} [fallback] - value to return when unset.
 * @returns {string|undefined}
 */
function getEnv(name, fallback) {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

module.exports = {
    log,
    setLogLevel,
    isDebugEnabled,
    maskSensitive,
    maskToken,
    requireEnv,
    getEnv,
    createIpv4Agents,
    LOG_LEVELS,
};
