'use strict';

/**
 * Common routines for accessing GitHub via its REST API.
 *
 * A dedicated axios instance is used for GitHub (no global axios instance).
 * All REST operations are authorized using the token from the GITHUB_TOKEN
 * environment variable, and are logged at debug level. Sensitive data is
 * masked before logging.
 */

const axios = require('axios');
const { GITHUB_API_URL, REQUEST_TIMEOUT_MS } = require('./config');
const { log, requireEnv, maskSensitive, createIpv4Agents } = require('./common');

let githubClient = null;

/**
 * Create (once) and return the dedicated axios instance for GitHub.
 * The token is read from GITHUB_TOKEN. Request/response interceptors log at
 * debug level and mask any sensitive data.
 *
 * @returns {import('axios').AxiosInstance}
 */
function getGithubClient() {
    if (githubClient) {
        return githubClient;
    }

    const token = requireEnv('GITHUB_TOKEN');

    const { httpAgent, httpsAgent } = createIpv4Agents();

    const client = axios.create({
        baseURL: `${GITHUB_API_URL.replace(/\/+$/, '')}/`,
        timeout: REQUEST_TIMEOUT_MS,
        // Connect over IPv4 only; IPv6 is never attempted.
        httpAgent,
        httpsAgent,
        headers: {
            // All REST operations are performed as authorized operations.
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });

    client.interceptors.request.use((requestConfig) => {
        log.debug('GitHub request:', {
            method: (requestConfig.method || 'get').toUpperCase(),
            url: requestConfig.url,
            params: requestConfig.params,
            headers: requestConfig.headers,
        });
        return requestConfig;
    });

    client.interceptors.response.use(
        (response) => {
            log.debug('GitHub response:', {
                status: response.status,
                url: response.config && response.config.url,
                data: response.data,
            });
            return response;
        },
        (error) => {
            const info = {
                message: error.message,
                status: error.response && error.response.status,
                url: error.config && error.config.url,
                data: error.response && error.response.data,
            };
            log.error('GitHub request failed:', maskSensitive(info));
            return Promise.reject(error);
        },
    );

    githubClient = client;
    return githubClient;
}

/**
 * Parse a GitHub adapter repository reference into its parts.
 *
 * Accepts either a full GitHub URL (e.g.
 * `https://github.com/owner/ioBroker.adaptername` with optional `.git` suffix
 * or trailing path) or the shortform `owner/ioBroker.adaptername`.
 *
 * @param {string} input - the repository reference.
 * @returns {{ owner: string, repo: string, htmlUrl: string }}
 *          `owner`/`repo` as on GitHub and the canonical HTTPS clone URL.
 * @throws {Error} if the reference cannot be parsed.
 */
function parseRepoReference(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('A GitHub repository reference is required');
    }
    const trimmed = input.trim();

    let owner;
    let repo;

    const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
    if (urlMatch) {
        owner = urlMatch[1];
        repo = urlMatch[2];
    } else {
        const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
        if (!shortMatch) {
            throw new Error(`Cannot parse GitHub repository reference "${input}". `
                + 'Provide a full GitHub URL or the shortform "owner/ioBroker.adaptername".');
        }
        owner = shortMatch[1];
        repo = shortMatch[2];
    }

    // Strip a trailing ".git" from the repository name if present.
    repo = repo.replace(/\.git$/i, '');

    return {
        owner,
        repo,
        htmlUrl: `https://github.com/${owner}/${repo}`,
    };
}

/**
 * Fetch a repository's metadata.
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @returns {Promise<object>} the repository object (includes `default_branch`).
 */
async function getRepository(owner, repo) {
    const client = getGithubClient();
    const response = await client.get(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return response.data;
}

/**
 * Retrieve the full (recursive) git tree of a repository at the given ref.
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @param {string} ref - branch name or commit SHA.
 * @returns {Promise<Array<{ path: string, type: string }>>} the tree entries.
 */
async function getRepoTree(owner, repo, ref) {
    const client = getGithubClient();
    const o = encodeURIComponent(owner);
    const r = encodeURIComponent(repo);
    const response = await client.get(
        `repos/${o}/${r}/git/trees/${encodeURIComponent(ref)}`,
        { params: { recursive: 1 } },
    );
    const tree = (response.data && response.data.tree) || [];
    if (response.data && response.data.truncated) {
        log.warn(`GitHub tree for ${owner}/${repo}@${ref} was truncated; some paths may be missing`);
    }
    return tree;
}

/**
 * Fetch the decoded text content of a single file from a repository.
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @param {string} path - file path within the repository.
 * @param {string} ref - branch name or commit SHA.
 * @returns {Promise<string|null>} the file content as UTF-8 text, or `null` if
 *          the file does not exist (HTTP 404).
 */
async function getFileContent(owner, repo, path, ref) {
    const client = getGithubClient();
    const o = encodeURIComponent(owner);
    const r = encodeURIComponent(repo);
    // The path may contain slashes; encode each segment but keep separators.
    const p = String(path).split('/').map(encodeURIComponent).join('/');
    try {
        const response = await client.get(`repos/${o}/${r}/contents/${p}`, { params: { ref } });
        const data = response.data;
        if (data && typeof data.content === 'string') {
            return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
        }
        return null;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }
        throw error;
    }
}

module.exports = {
    getGithubClient,
    parseRepoReference,
    getRepository,
    getRepoTree,
    getFileContent,
};
