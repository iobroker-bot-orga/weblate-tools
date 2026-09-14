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
let githubBotClient = null;

/**
 * Build a dedicated axios instance for GitHub authorized with `token`.
 * Request/response interceptors log at debug level and mask sensitive data.
 *
 * @param {string} token - the bearer token.
 * @returns {import('axios').AxiosInstance}
 */
function buildGithubClient(token) {
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

    return client;
}

/**
 * Create (once) and return the dedicated axios instance for GitHub reads,
 * authorized with the token from GITHUB_TOKEN.
 *
 * @returns {import('axios').AxiosInstance}
 */
function getGithubClient() {
    if (!githubClient) {
        githubClient = buildGithubClient(requireEnv('GITHUB_TOKEN'));
    }
    return githubClient;
}

/**
 * Create (once) and return the axios instance used for writes performed as the
 * ioBroker bot (e.g. creating issues), authorized with IOBBOT_GITHUB_TOKEN.
 *
 * @returns {import('axios').AxiosInstance}
 */
function getGithubBotClient() {
    if (!githubBotClient) {
        githubBotClient = buildGithubClient(requireEnv('IOBBOT_GITHUB_TOKEN'));
    }
    return githubBotClient;
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

/**
 * Create an issue in a repository, authorized as the ioBroker bot
 * (IOBBOT_GITHUB_TOKEN).
 *
 * @param {string} owner - repository owner.
 * @param {string} repo - repository name.
 * @param {string} title - issue title.
 * @param {string} body - issue body (Markdown).
 * @returns {Promise<object>} the created issue object (includes `html_url`).
 */
async function createIssue(owner, repo, title, body) {
    const client = getGithubBotClient();
    const o = encodeURIComponent(owner);
    const r = encodeURIComponent(repo);
    const response = await client.post(`repos/${o}/${r}/issues`, { title, body });
    return response.data;
}

module.exports = {
    getGithubClient,
    getGithubBotClient,
    parseRepoReference,
    getRepository,
    getRepoTree,
    getFileContent,
    createIssue,
};
