/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {t} from '../i18n';
import {DagCommitInfo} from './dagCommitInfo';

/**
 * The "wdir()" virtual hash.
 * This needs to match the CLI's interpretation of "wdir()". See `wdirhex` in sapling/node.py.
 */
export const WDIR_NODE = 'ffffffffffffffffffffffffffffffffffffffff';

/** Virtual hash for the main head dummy node. */
export const MAIN_HEAD_NODE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const MAIN_HEAD_VIRTUAL_COMMIT: DagCommitInfo = DagCommitInfo.fromCommitInfo({
  hash: MAIN_HEAD_NODE,
  title: '',
  parents: [],
  phase: 'public',
  isDot: false,
  date: new Date(8640000000000000),
  bookmarks: [],
  remoteBookmarks: [],
  author: '',
  description: '',
  filePathsSample: [],
  totalFileCount: 0,
  isMainHead: true,
});

export const YOU_ARE_HERE_VIRTUAL_COMMIT: DagCommitInfo = DagCommitInfo.fromCommitInfo({
  hash: WDIR_NODE,
  title: '',
  parents: [],
  phase: 'draft',
  isDot: false,
  date: new Date(8640000000000000),
  bookmarks: [],
  remoteBookmarks: [],
  author: '',
  description: t('You are here'),
  filePathsSample: [],
  totalFileCount: 0,
  isYouAreHere: true,
});
