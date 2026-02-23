/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {VCSDriver} from './VCSDriver';
import type {RepositoryContext} from '../serverTypes';

import path from 'node:path';
import {exists} from 'shared/fs';
import {GitDriver} from './GitDriver';
import {SaplingDriver} from './SaplingDriver';

/**
 * Detect which VCS driver to use for the given working directory.
 *
 * Detection order:
 * 1. Sapling (.sl directory) - always takes priority
 * 2. Git (.git directory) - future: detect Graphite / Git Branchless variants
 *
 * @throws Error if no supported VCS is found
 */
export async function detectDriver(ctx: RepositoryContext): Promise<VCSDriver> {
  // Walk up directories looking for VCS markers
  let dir = ctx.cwd;
  const root = path.parse(dir).root;

  while (dir !== root) {
    // Check for Sapling repository
    if (await exists(path.join(dir, '.sl'))) {
      return new SaplingDriver();
    }

    // Check for Git repository
    if (await exists(path.join(dir, '.git'))) {
      // TODO: Phase 3 - detect Git variant (Graphite, Git Branchless)
      // For now, use raw Git driver.
      return new GitDriver();
    }

    dir = path.dirname(dir);
  }

  throw new Error(`No supported VCS found in ${ctx.cwd} or any parent directory.`);
}

// TODO: Phase 3 - uncomment and implement when Git drivers are available
// async function detectGitVariant(ctx: RepositoryContext, repoRoot: string): Promise<VCSDriver> {
//   // Check for Graphite
//   if (await isGraphiteRepo(repoRoot)) {
//     return new GraphiteDriver();
//   }
//
//   // Check for Git Branchless
//   if (await isGitBranchlessRepo(repoRoot)) {
//     return new GitBranchlessDriver();
//   }
//
//   // Default to raw Git
//   return new GitDriver();
// }
