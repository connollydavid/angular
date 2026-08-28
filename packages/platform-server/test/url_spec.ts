/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {parseUrl} from '../src/location';

describe('parseUrl', () => {
  it('parses ordinary absolute and relative URLs', () => {
    const url = parseUrl('https://example.com:8080/a/b?c=d#e');
    expect(url.hostname).toBe('example.com');
    expect(url.protocol).toBe('https:');
    expect(url.port).toBe('8080');
    expect(url.pathname).toBe('/a/b');
    expect(url.search).toBe('?c=d');
    expect(url.hash).toBe('#e');
  });

  it('treats backslashes as slashes, exposing the true hostname', () => {
    const url = parseUrl('/\\attacker.example/collect');
    expect(url.hostname).toBe('attacker.example');
    expect(url.pathname).toBe('/collect');
  });

  it('throws on URLs prefixed with characters that parsers disagree on', () => {
    for (const url of ['\u00A0//attacker.example/collect', '\uFEFF//attacker.example/collect']) {
      expect(() => parseUrl(url))
          .toThrowError(/contains characters that are parsed inconsistently/);
    }
  });
});
