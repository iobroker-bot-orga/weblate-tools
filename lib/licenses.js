'use strict';

/**
 * Static license detection.
 *
 * Weblate expects the `license` field of a component to be an SPDX license
 * identifier (e.g. `MIT`, `Apache-2.0`). GitHub's own auto-detection is not
 * used here; instead a repository's LICENSE file content is matched against
 * the static list of known licenses below and mapped to the SPDX identifier
 * that Weblate accepts.
 *
 * Each entry:
 *   - `spdx`    - the SPDX identifier (this is also the value passed to Weblate).
 *   - `name`    - human-readable name (for logging).
 *   - `markers` - distinctive phrases that must ALL appear in the license text
 *                 (case-insensitive, whitespace-normalized) for a match.
 *
 * Order matters: more specific licenses are listed before more generic ones so
 * the first match wins (e.g. LGPL before GPL, BSD-3 before BSD-2).
 */
const KNOWN_LICENSES = [
    {
        spdx: 'MIT',
        name: 'MIT License',
        markers: ['permission is hereby granted, free of charge', 'without restriction, including without limitation the rights'],
    },
    {
        spdx: 'Apache-2.0',
        name: 'Apache License 2.0',
        markers: ['apache license', 'version 2.0'],
    },
    {
        spdx: 'LGPL-3.0-only',
        name: 'GNU Lesser General Public License v3.0',
        markers: ['gnu lesser general public license', 'version 3'],
    },
    {
        spdx: 'LGPL-2.1-only',
        name: 'GNU Lesser General Public License v2.1',
        markers: ['gnu lesser general public license', 'version 2.1'],
    },
    {
        spdx: 'GPL-3.0-only',
        name: 'GNU General Public License v3.0',
        markers: ['gnu general public license', 'version 3'],
    },
    {
        spdx: 'GPL-2.0-only',
        name: 'GNU General Public License v2.0',
        markers: ['gnu general public license', 'version 2'],
    },
    {
        spdx: 'AGPL-3.0-only',
        name: 'GNU Affero General Public License v3.0',
        markers: ['gnu affero general public license', 'version 3'],
    },
    {
        spdx: 'MPL-2.0',
        name: 'Mozilla Public License 2.0',
        markers: ['mozilla public license', 'version 2.0'],
    },
    {
        spdx: 'BSD-3-Clause',
        name: 'BSD 3-Clause License',
        markers: ['redistribution and use in source and binary forms', 'neither the name of'],
    },
    {
        spdx: 'BSD-2-Clause',
        name: 'BSD 2-Clause License',
        markers: ['redistribution and use in source and binary forms', 'this software is provided by'],
    },
    {
        spdx: 'ISC',
        name: 'ISC License',
        markers: ['permission to use, copy, modify, and/or distribute this software'],
    },
    {
        spdx: 'Unlicense',
        name: 'The Unlicense',
        markers: ['this is free and unencumbered software released into the public domain'],
    },
    {
        spdx: 'CC0-1.0',
        name: 'Creative Commons Zero v1.0 Universal',
        markers: ['cc0 1.0 universal'],
    },
];

/** Common file names that hold a repository's license text. */
const LICENSE_FILE_NAMES = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
    'COPYING',
    'COPYING.md',
    'COPYING.txt',
];

/**
 * Normalize license text for matching: lowercase and collapse all runs of
 * whitespace to single spaces, so line wrapping does not defeat phrase matches.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
    return String(text).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Detect the license of a repository from its LICENSE file content.
 *
 * @param {string} text - the raw content of the LICENSE file.
 * @returns {{ spdx: string, name: string }|null} the detected license, or
 *          `null` if no known license matched.
 */
function detectLicense(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    const haystack = normalize(text);
    for (const license of KNOWN_LICENSES) {
        if (license.markers.every((marker) => haystack.includes(normalize(marker)))) {
            return { spdx: license.spdx, name: license.name };
        }
    }
    return null;
}

module.exports = {
    KNOWN_LICENSES,
    LICENSE_FILE_NAMES,
    detectLicense,
};
