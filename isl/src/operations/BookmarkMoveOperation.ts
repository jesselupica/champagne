/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag} from '../previews';
import type {Hash} from '../types';

import {Operation} from './Operation';

export class BookmarkMoveOperation extends Operation {
  constructor(
    private bookmark: string,
    private destination: Hash,
  ) {
    super('BookmarkMoveOperation');
  }

  static opName = 'BookmarkMove';

  getArgs() {
    return ['bookmark', '--move', this.bookmark, '--rev', this.destination];
  }

  previewDag(dag: Dag): Dag {
    return this.applyBookmarkMove(dag);
  }

  optimisticDag(dag: Dag): Dag {
    return this.applyBookmarkMove(dag);
  }

  private applyBookmarkMove(dag: Dag): Dag {
    // Remove bookmark from its current commit
    const oldCommit = dag.resolve(this.bookmark);
    if (oldCommit) {
      dag = dag.replaceWith(oldCommit.hash, (_h, c) =>
        c?.merge({
          bookmarks: oldCommit.bookmarks.filter(b => b !== this.bookmark),
        }),
      );
    }
    // Add bookmark to the destination commit
    const newCommit = dag.get(this.destination);
    if (newCommit) {
      dag = dag.replaceWith(newCommit.hash, (_h, c) =>
        c?.merge({
          bookmarks: [...(newCommit.bookmarks ?? []), this.bookmark],
        }),
      );
    }
    return dag;
  }
}
