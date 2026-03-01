/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ReactNode} from 'react';
import type {Operation} from './operations/Operation';
import type {ValidatedRepoInfo} from './types';

import {Banner, BannerKind} from 'isl-components/Banner';
import {Button} from 'isl-components/Button';
import {Column, Row} from 'isl-components/Flex';
import {Icon} from 'isl-components/Icon';
import {Subtle} from 'isl-components/Subtle';
import {Tooltip} from 'isl-components/Tooltip';
import {atom, useAtom, useAtomValue} from 'jotai';
import {notEmpty, truncate} from 'shared/utils';
import {Delayed} from './Delayed';
import {LogRenderExposures} from './analytics/LogRenderExposures';
import {codeReviewProvider} from './codeReview/CodeReviewInfo';
import {T, t} from './i18n';
import {
  EXIT_CODE_FORGET,
  operationList,
  queuedOperations,
  queuedOperationsErrorAtom,
  useAbortRunningOperation,
} from './operationsState';
import {repositoryInfo} from './serverAPIState';
import {processTerminalLines} from './terminalOutput';
import {CommandRunner} from './types';
import {short} from './utils';

import './CommandHistoryAndProgress.css';

/**
 * Translate Sapling-style operation args to their Git equivalents for display.
 * Mirrors the server-side normalizeOperationArgs translation in GitDriver.
 */
function translateArgsForDisplay(
  args: ReturnType<Operation['getArgs']>,
  command: string,
): ReturnType<Operation['getArgs']> {
  if (!command.endsWith('git')) {
    return args;
  }
  const first = args[0];
  if (first === 'fold') {
    const exactIdx = args.indexOf('--exact');
    const revset = exactIdx !== -1 ? String(args[exactIdx + 1]) : '??';
    const [bottom] = revset.split('::');
    return ['reset', '--soft', bottom + '^', '&&', 'commit', '(fold)'];
  }
  if (first === 'hide') {
    const revIdx = args.indexOf('--rev');
    const hash = revIdx !== -1 ? String(args[revIdx + 1]) : '??';
    return ['branch', '-D', '<branches-at-' + hash.slice(0, 8) + '>'];
  }
  if (first === 'pull' && !args.includes('--rev')) {
    return ['fetch', '--all'];
  }
  if (first === 'pull' && args.includes('--rev')) {
    const revIdx = args.indexOf('--rev');
    const hash = revIdx !== -1 ? args[revIdx + 1] : '??';
    return ['fetch', 'origin', hash];
  }
  if (first === 'purge') {
    const files = args.filter(a => a !== 'purge' && a !== '--files' && a !== '--abort-on-err');
    return ['rm', '-f', ...files];
  }
  if (first === 'push') {
    let rev: typeof args[0] = '??', branch: typeof args[0] = '??', remote: typeof args[0] = 'origin';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--rev' && i + 1 < args.length) { rev = args[i + 1]; i++; continue; }
      if (args[i] === '--to' && i + 1 < args.length) { branch = args[i + 1]; i++; continue; }
      if (typeof args[i] === 'string' && !String(args[i]).startsWith('-')) remote = args[i];
    }
    return ['push', remote, String(rev) + ':' + String(branch)];
  }
  if (first === 'forget') {
    return ['rm', '--cached', ...args.slice(1)];
  }
  if (first === 'commit') {
    return args.filter(a => a !== '--addremove');
  }
  if (first === 'amend') {
    const out: typeof args = ['commit', '--amend'];
    let hasMessage = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--addremove') continue;
      if (a === '--user') { out.push('--author', args[i + 1]); i++; continue; }
      if (a === '--message') hasMessage = true;
      out.push(a);
    }
    if (!hasMessage) out.push('--no-edit');
    return out;
  }
  if (first === 'metaedit') {
    const msgIdx = args.indexOf('--message');
    return ['commit', '--amend', '--only', '--message', msgIdx !== -1 ? args[msgIdx + 1] : '...'];
  }
  if (first === 'goto') {
    if (args.includes('--clean')) {
      const files = args.filter(a => a !== 'goto' && a !== '--clean');
      return ['checkout', '--', ...files];
    }
    const revIdx = args.indexOf('--rev');
    const hash = revIdx !== -1 ? args[revIdx + 1] : args[1];
    return ['checkout', hash];
  }
  if (first === 'revert') {
    const revIdx = args.indexOf('--rev');
    const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
    const files = args.slice(1).filter((a, i, arr) =>
      a !== '--rev' && (arr[i - 1] as unknown) !== '--rev'
    );
    return ['checkout', hash, '--', ...files];
  }
  if (first === 'bookmark') {
    if (args[1] === '--delete') return ['branch', '-d', args[2]];
    const name = args[1];
    const revIdx = args.indexOf('--rev');
    const hash = revIdx !== -1 ? args[revIdx + 1] : 'HEAD';
    return ['branch', name, hash];
  }
  if (first === 'shelve') {
    if (args[1] === '--delete') return ['stash', 'drop'];
    const out: typeof args = ['stash', 'push'];
    let name: typeof args[0] | undefined;
    const files: typeof args = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--unknown') { out.push('-u'); continue; }
      if (a === '--name' && i + 1 < args.length) { name = args[i + 1]; i++; continue; }
      files.push(a);
    }
    if (name !== undefined) out.push('-m', name);
    if (files.length > 0) out.push('--', ...files);
    return out;
  }
  if (first === 'unshelve') {
    return ['stash', args.includes('--keep') ? 'apply' : 'pop'];
  }
  if (first === 'graft') return ['cherry-pick', ...args.slice(1)];
  if (first === 'uncommit') return ['reset', '--soft', 'HEAD~1'];
  if (first === 'resolve') {
    if (args.includes('--mark')) {
      return ['add', ...args.filter(a => a !== 'resolve' && a !== '--mark')];
    }
    if (args.includes('--unmark')) {
      return ['rm', '--cached', ...args.filter(a => a !== 'resolve' && a !== '--unmark')];
    }
    const toolIdx = args.indexOf('--tool');
    const hasAll = args.includes('--all');
    if (toolIdx !== -1) {
      const tool = String(args[toolIdx + 1]);
      const fileArgs = args.filter((a, i) =>
        a !== 'resolve' && a !== '--tool' && String(a) !== tool && a !== '--all' &&
        !String(a).startsWith('-') && i !== toolIdx + 1
      );
      const file = fileArgs[0];
      if (tool === 'internal:merge-local') {
        return ['checkout', '--ours', '--', ...(file !== undefined ? [file] : [])];
      }
      if (tool === 'internal:merge-other') {
        return ['checkout', '--theirs', '--', ...(file !== undefined ? [file] : [])];
      }
      if (tool === 'internal:union') {
        return ['merge-file', '--union', ...(file !== undefined ? [file] : [])];
      }
      // External merge tool
      if (hasAll || file === undefined) {
        return ['mergetool', `--tool=${tool}`];
      }
      return ['mergetool', `--tool=${tool}`, file];
    }
    if (hasAll) {
      return ['mergetool'];
    }
    return args;
  }
  // Slash-separated because the actual command is determined at runtime based on git state
  if (first === 'continue') return ['rebase/merge/cherry-pick', '--continue'];
  if (first === 'rebase') {
    if (args.includes('--abort')) return ['rebase', '--abort'];
    if (args.includes('--quit')) return ['rebase', '--abort', '(partial)'];
    if (args.includes('--keep')) {
      const revIdx = args.indexOf('--rev');
      const destIdx = Math.max(args.indexOf('--dest'), args.indexOf('-d'));
      const src = revIdx !== -1 ? args[revIdx + 1] : '??';
      const dest = destIdx !== -1 ? args[destIdx + 1] : null;
      if (dest) return ['checkout', dest, '&&', 'cherry-pick', src];
      return ['cherry-pick', src];
    }
    if (args.includes('--rev') && !args.includes('-s') && !args.includes('--source')) {
      const revs: typeof args = [];
      let dest: (typeof args)[0] = '??';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--rev' && i + 1 < args.length) { revs.push(args[i + 1]); i++; continue; }
        if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) { dest = args[i + 1]; i++; continue; }
      }
      return ['cherry-pick', ...revs, '(onto', dest + ')'];
    }
    let src: typeof args[0] = '??';
    let dest: typeof args[0] = '??';
    for (let i = 1; i < args.length; i++) {
      if ((args[i] === '-s' || args[i] === '--source') && i + 1 < args.length) src = args[i + 1];
      else if ((args[i] === '-d' || args[i] === '--dest') && i + 1 < args.length) dest = args[i + 1];
    }
    // RebaseAllDraftCommitsOperation display
    if (typeof src === 'string' && src.startsWith('draft()')) {
      return ['rebase', '--onto', dest ?? '??', '$(merge-base)', 'HEAD'];
    }
    const srcStr =
      typeof src === 'string'
        ? src
        : typeof src === 'object' && src != null && 'revset' in src
          ? (src as {revset: string}).revset
          : String(src);
    return ['rebase', '--onto', dest, srcStr + '^', src];
  }
  return args;
}

function OperationDescription(props: {
  info: ValidatedRepoInfo;
  operation: Operation;
  className?: string;
  long?: boolean;
}): React.ReactElement {
  const {info, operation, className} = props;
  const desc = operation.getDescriptionForDisplay();

  const reviewProvider = useAtomValue(codeReviewProvider);

  if (desc?.description) {
    return <span className={className}>{desc.description}</span>;
  }

  const commandName =
    operation.runner === CommandRunner.Sapling
      ? (/[^\\/]+$/.exec(info.command)?.[0] ?? 'sl')
      : operation.runner === CommandRunner.CodeReviewProvider
        ? reviewProvider?.cliName
        : operation.runner === CommandRunner.InternalArcanist
          ? CommandRunner.InternalArcanist
          : null;

  const displayArgs = translateArgsForDisplay(operation.getArgs(), info.command);

  return (
    <code className={className}>
      {(commandName ?? '') +
        ' ' +
        displayArgs
          .map(arg => {
            if (typeof arg === 'object') {
              switch (arg.type) {
                case 'config':
                  // don't show configs in the UI
                  return undefined;
                case 'repo-relative-file':
                  return arg.path;
                case 'repo-relative-file-list':
                  return truncate(arg.paths.join(' '), 200);
                case 'exact-revset':
                case 'succeedable-revset':
                case 'optimistic-revset':
                  return props.long
                    ? arg.revset
                    : // truncate full commit hashes to short representation visually
                      // revset could also be a remote bookmark, so only do this if it looks like a hash
                      /^[a-z0-9]{40}$/.test(arg.revset)
                      ? short(arg.revset)
                      : truncate(arg.revset, 80);
              }
            }
            if (/\s/.test(arg)) {
              return `"${props.long ? arg : truncate(arg, 30)}"`;
            }
            return arg;
          })
          .filter(notEmpty)
          .join(' ')}
    </code>
  );
}

const nextToRunCollapsedAtom = atom(false);
const queueErrorCollapsedAtom = atom(true);

export function CommandHistoryAndProgress() {
  const list = useAtomValue(operationList);
  const queued = useAtomValue(queuedOperations);
  const [queuedError, setQueuedError] = useAtom(queuedOperationsErrorAtom);
  const abortRunningOperation = useAbortRunningOperation();

  const [collapsed, setCollapsed] = useAtom(nextToRunCollapsedAtom);
  const [errorCollapsed, setErrorCollapsed] = useAtom(queueErrorCollapsedAtom);

  const info = useAtomValue(repositoryInfo);
  if (!info) {
    return null;
  }

  const progress = list.currentOperation;
  if (progress == null) {
    return null;
  }

  const desc = progress.operation.getDescriptionForDisplay();
  const command = (
    <OperationDescription
      info={info}
      operation={progress.operation}
      className="progress-container-command"
    />
  );

  let label;
  let icon;
  let abort = null;
  let showLastLineOfOutput = false;
  if (progress.exitCode == null) {
    label = desc?.description ? command : <T replace={{$command: command}}>Running $command</T>;
    icon = <Icon icon="loading" />;
    showLastLineOfOutput = desc?.tooltip == null;
    // Only show "Abort" for slow commands, since "Abort" might leave modified
    // files or pending commits around.
    const slowThreshold = 10000;
    const hideUntil = new Date((progress.startTime?.getTime() || 0) + slowThreshold);
    abort = (
      <Delayed hideUntil={hideUntil}>
        <Button
          data-testid="abort-button"
          disabled={progress.aborting}
          onClick={() => {
            abortRunningOperation(progress.operation.id);
          }}>
          <Icon slot="start" icon={progress.aborting ? 'loading' : 'stop-circle'} />
          <T>Abort</T>
        </Button>
      </Delayed>
    );
  } else if (progress.exitCode === 0) {
    label = <span>{command}</span>;
    icon = <Icon icon="pass" aria-label={t('Command exited successfully')} />;
  } else if (progress.aborting) {
    // Exited (tested above) by abort.
    label = <T replace={{$command: command}}>Aborted $command</T>;
    icon = <Icon icon="stop-circle" aria-label={t('Command aborted')} />;
  } else if (progress.exitCode === EXIT_CODE_FORGET) {
    label = <span>{command}</span>;
    icon = (
      <Icon
        icon="question"
        aria-label={t('Command ran during disconnection. Exit status is lost.')}
      />
    );
  } else {
    label = <span>{command}</span>;
    icon = <Icon icon="error" aria-label={t('Command exited unsuccessfully')} />;
    showLastLineOfOutput = true;
  }

  let processedLines = processTerminalLines(progress.commandOutput ?? []);
  if (desc?.tooltip != null) {
    // Output might contain a JSON string not suitable for human reading.
    // Filter the line out.
    processedLines = processedLines.filter(line => !line.startsWith('{'));
  }

  return (
    <div className="progress-container" data-testid="progress-container">
      {queuedError != null || queued.length > 0 ? (
        <div className="queued-operations-container" data-testid="queued-commands">
          {queuedError != null && (
            <LogRenderExposures eventName="QueueCancelledWarningShown">
              <Column alignStart data-testid="cancelled-queued-commands">
                <Tooltip
                  title={t(
                    'When an operation process fails or is aborted, any operations queued after that are cancelled, as they may depend on the previous operation succeeding.',
                  )}>
                  <Row
                    style={{cursor: 'pointer'}}
                    onClick={() => {
                      setErrorCollapsed(!errorCollapsed);
                    }}>
                    <Icon icon={errorCollapsed ? 'chevron-right' : 'chevron-down'} />
                    <Banner kind={BannerKind.warning}>
                      <Icon icon="warning" color="yellow" />
                      <T count={queuedError.operations.length}>queuedOperationsWereCancelled</T>
                    </Banner>
                    <Tooltip title={t('Dismiss')}>
                      <Button
                        icon
                        onClick={() => {
                          setQueuedError(undefined);
                        }}>
                        <Icon icon="x" />
                      </Button>
                    </Tooltip>
                  </Row>
                </Tooltip>
                {errorCollapsed ? null : (
                  <TruncatedOperationList operations={queuedError.operations} info={info} />
                )}
              </Column>
            </LogRenderExposures>
          )}
          {queued.length > 0 ? (
            <>
              <Row
                style={{cursor: 'pointer'}}
                onClick={() => {
                  setCollapsed(!collapsed);
                }}>
                <Icon icon={collapsed ? 'chevron-right' : 'chevron-down'} />
                <strong>
                  <T>Next to run</T>
                </strong>
              </Row>
              {collapsed ? (
                <div>
                  <T count={queued.length}>moreCommandsToRun</T>
                </div>
              ) : (
                <TruncatedOperationList operations={queued} info={info} />
              )}
            </>
          ) : null}
        </div>
      ) : null}

      <Tooltip
        component={() => (
          <div className="progress-command-tooltip">
            {desc?.tooltip || (
              <>
                <div className="progress-command-tooltip-command">
                  <strong>Command: </strong>
                  <OperationDescription info={info} operation={progress.operation} long />
                </div>
              </>
            )}
            <br />
            <b>Command output:</b>
            <br />
            {processedLines.length === 0 ? (
              <Subtle>
                <T>No output</T>
              </Subtle>
            ) : (
              <pre>
                {processedLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </pre>
            )}
          </div>
        )}
        interactive>
        <div className="progress-container-row">
          {icon}
          {label}
          {progress.warnings?.map(warning => (
            <Banner
              icon={<Icon icon="warning" color="yellow" />}
              alwaysShowButtons
              kind={BannerKind.warning}>
              <T replace={{$provider: warning}}>$provider</T>
            </Banner>
          ))}
        </div>
        {showLastLineOfOutput ? (
          <div className="progress-container-row">
            <div className="progress-container-last-output">
              {progress.currentProgress != null && progress.currentProgress.unit != null ? (
                <ProgressLine
                  progress={progress.currentProgress.progress}
                  progressTotal={progress.currentProgress.progressTotal}>
                  {progress.currentProgress.message +
                    ` - ${progress.currentProgress.progress}/${progress.currentProgress.progressTotal} ${progress.currentProgress.unit}`}
                </ProgressLine>
              ) : (
                processedLines.length > 0 && <ProgressLine>{processedLines.at(-1)}</ProgressLine>
              )}
            </div>
          </div>
        ) : null}
        {abort}
      </Tooltip>
    </div>
  );
}

const MAX_VISIBLE_NEXT_TO_RUN = 10;
function TruncatedOperationList({
  info,
  operations,
}: {
  info: ValidatedRepoInfo;
  operations: Array<Operation>;
}) {
  return (
    <>
      {(operations.length > MAX_VISIBLE_NEXT_TO_RUN
        ? operations.slice(0, MAX_VISIBLE_NEXT_TO_RUN)
        : operations
      ).map(op => (
        <div key={op.id} id={op.id} className="queued-operation">
          <OperationDescription info={info} operation={op} />
        </div>
      ))}
      {operations.length > MAX_VISIBLE_NEXT_TO_RUN && (
        <div>
          <T replace={{$count: operations.length - MAX_VISIBLE_NEXT_TO_RUN}}>+$count more</T>
        </div>
      )}
    </>
  );
}

function ProgressLine({
  children,
  progress,
  progressTotal,
}: {
  children: ReactNode;
  progress?: number;
  progressTotal?: number;
}) {
  return (
    <span className="progress-line">
      {progress != null && progressTotal != null ? (
        <ProgressBar progress={progress} progressTotal={progressTotal} />
      ) : null}
      <code>{children}</code>
    </span>
  );
}

function ProgressBar({progress, progressTotal}: {progress: number; progressTotal: number}) {
  const pct = progress / progressTotal;
  return (
    <span className="progress-bar">
      <span className="progress-bar-filled" style={{width: `${Math.round(100 * pct)}%`}} />
    </span>
  );
}
