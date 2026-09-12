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

module.exports = {
    getGithubClient,
};
