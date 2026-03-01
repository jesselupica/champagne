/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {GitDriver} from '../vcs/GitDriver';

const driver = new GitDriver();

// git hashes are exactly 40 hex characters
const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 40 chars
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 40 chars

// Sample git blame --porcelain output (two lines from two different commits)
const SAMPLE_BLAME_OUTPUT = `${HASH_A} 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0000
summary first commit
filename src/app.ts
\thello world
${HASH_B} 2 2 1
author Bob
author-mail <bob@example.com>
author-time 1700000001
author-tz +0000
committer Bob
committer-mail <bob@example.com>
committer-time 1700000001
committer-tz +0000
summary second commit
filename src/app.ts
\tsecond line
`;

// Porcelain output where a commit hash appears more than once — the second occurrence
// has no metadata block (only the hash header + filename + content line).
const REPEATED_HASH_OUTPUT = `${HASH_A} 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0000
summary first commit
filename src/app.ts
\thello world
${HASH_A} 3 2 1
filename src/app.ts
\tanother line by Alice
`;

describe('GitDriver.parseBlameOutput', () => {
  it('returns two entries for two-line sample output', () => {
    const result = driver.parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result).toHaveLength(2);
  });

  it('first entry has correct line content', () => {
    const result = driver.parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result[0].line).toBe('hello world');
  });

  it('first entry has correct commit hash', () => {
    const result = driver.parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result[0].node).toBe(HASH_A);
  });

  it('second entry has correct line content', () => {
    const result = driver.parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result[1].line).toBe('second line');
  });

  it('second entry has correct commit hash', () => {
    const result = driver.parseBlameOutput(SAMPLE_BLAME_OUTPUT);
    expect(result[1].node).toBe(HASH_B);
  });

  it('handles repeated hash (second occurrence has no metadata block)', () => {
    const result = driver.parseBlameOutput(REPEATED_HASH_OUTPUT);
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe('hello world');
    expect(result[0].node).toBe(HASH_A);
    expect(result[1].line).toBe('another line by Alice');
    expect(result[1].node).toBe(HASH_A);
  });

  it('returns empty array for empty input', () => {
    expect(driver.parseBlameOutput('')).toEqual([]);
  });
});
