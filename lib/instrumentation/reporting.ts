import { tmpdir } from 'node:os';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { isNullOrUndefined, isUndefined } from '@sindresorhus/is';
import cleanGitRef from 'clean-git-ref';
import fs from 'fs-extra';
import upath from 'upath';
import type { RenovateConfig } from '../config/types.ts';
import { getProblems, logger } from '../logger/index.ts';
import type {
  BranchCache,
  BranchUpgradeCache,
} from '../util/cache/repository/types.ts';
import { exec } from '../util/exec/index.ts';
import { writeSystemFile } from '../util/fs/index.ts';
import { getS3Client, parseS3Url } from '../util/s3.ts';
import type { ExtractResult } from '../workers/repository/process/extract-update.ts';
import type { LibYearsWithStatus, Report } from './types.ts';

const report: Report = {
  problems: [],
  repositories: {},
};

/**
 * Reset the report
 * Should only be used for testing
 */
export function resetReport(): void {
  report.problems = [];
  report.repositories = {};
}

export function addBranchStats(
  config: RenovateConfig,
  branchesInformation: Partial<BranchCache>[],
): void {
  if (isNullOrUndefined(config.reportType)) {
    return;
  }

  coerceRepo(config.repository!);
  report.repositories[config.repository!].branches = branchesInformation;
}

export function addExtractionStats(
  config: RenovateConfig,
  extractResult: ExtractResult,
): void {
  if (isNullOrUndefined(config.reportType)) {
    return;
  }

  coerceRepo(config.repository!);
  report.repositories[config.repository!].packageFiles =
    extractResult.packageFiles;
}

export function addLibYears(
  config: RenovateConfig,
  libYearsWithDepCount: LibYearsWithStatus,
): void {
  if (isNullOrUndefined(config.reportType)) {
    return;
  }

  coerceRepo(config.repository!);
  report.repositories[config.repository!].libYearsWithStatus =
    libYearsWithDepCount;
}

export function finalizeReport(): void {
  const allProblems = structuredClone(getProblems());
  for (const problem of allProblems) {
    const repository = problem.repository;
    delete problem.repository;

    // if the problem can be connected to a repository add it their else add to the root list
    if (repository) {
      coerceRepo(repository);
      report.repositories[repository].problems.push(problem);
    } else {
      report.problems.push(problem);
    }
  }
}

export async function exportStats(config: RenovateConfig): Promise<void> {
  try {
    if (isNullOrUndefined(config.reportType)) {
      return;
    }

    if (config.reportType === 'logging') {
      logger.info({ report }, 'Printing report');
      return;
    }

    if (config.reportType === 'file') {
      const path = config.reportPath!;
      await writeSystemFile(path, JSON.stringify(report));
      logger.debug({ path }, 'Writing report');
      return;
    }

    if (config.reportType === 'mailing-list') {
      const mailReport = renderMailingListReport(config, report);
      if (!isNullOrUndefined(config.reportPath)) {
        await writeSystemFile(config.reportPath, mailReport);
        logger.debug(
          { path: config.reportPath },
          'Writing mailing list report',
        );
      } else {
        logger.info({ mailReport }, 'Printing mailing list report');
      }

      await pushMailingListReportToGit(config, mailReport);
      return;
    }

    // v8 ignore else -- TODO: add test #40625
    if (config.reportType === 's3') {
      const s3Url = parseS3Url(config.reportPath!);
      if (isNullOrUndefined(s3Url)) {
        logger.warn(
          { reportPath: config.reportPath },
          'Failed to parse s3 URL',
        );
        return;
      }

      const s3Params: PutObjectCommandInput = {
        Bucket: s3Url.Bucket,
        Key: s3Url.Key,
        Body: JSON.stringify(report),
        ContentType: 'application/json',
      };

      const client = getS3Client(config.s3Endpoint, config.s3PathStyle);
      const command = new PutObjectCommand(s3Params);
      await client.send(command);
    }
  } catch (err) {
    logger.warn({ err }, 'Reporting.exportStats() - failure');
  }
}

export function getReport(): Report {
  return structuredClone(report);
}

function coerceRepo(repository: string): void {
  if (!isUndefined(report.repositories[repository])) {
    return;
  }

  report.repositories[repository] = {
    problems: [],
    branches: [],
    packageFiles: {},
  };
}

function renderMailingListReport(
  config: RenovateConfig,
  statsReport: Report,
): string {
  const repositoryNames = Object.keys(statsReport.repositories).sort();
  const recipients = config.mailingListTo?.length
    ? config.mailingListTo.join(', ')
    : '';
  const subject =
    config.mailingListSubject ??
    `Renovate dependency update summary (${repositoryNames.length} repositories)`;

  const headers = [
    `From: ${config.mailingListFrom ?? 'renovate@localhost'}`,
    `To: ${recipients || 'undisclosed-recipients:;'}`,
    ...(config.mailingListCc?.length
      ? [`Cc: ${config.mailingListCc.join(', ')}`]
      : []),
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  const body: string[] = [
    'Renovate mailing list summary',
    `Generated: ${new Date().toISOString()}`,
    `Repositories: ${repositoryNames.length}`,
    `Global problems: ${statsReport.problems.length}`,
    '',
  ];

  for (const repositoryName of repositoryNames) {
    const repoReport = statsReport.repositories[repositoryName];
    body.push(`Repository: ${repositoryName}`);
    body.push(`Repository problems: ${repoReport.problems.length}`);
    body.push(`Tracked branches: ${repoReport.branches.length}`);

    if (repoReport.branches.length === 0) {
      body.push('- No branch updates in this run.');
      body.push('');
      continue;
    }

    for (const branch of repoReport.branches) {
      body.push(renderBranchSummary(branch));
      const upgrades = branch.upgrades ?? [];
      if (!upgrades.length) {
        body.push('  - No upgrades listed.');
        continue;
      }
      for (const upgrade of upgrades) {
        body.push(`  ${renderUpgradeSummary(upgrade)}`);
      }
    }
    body.push('');
  }

  return `${headers.join('\n')}\n\n${body.join('\n').trimEnd()}\n`;
}

function renderBranchSummary(branch: Partial<BranchCache>): string {
  const details: string[] = [];
  if (branch.result) {
    details.push(`result=${branch.result}`);
  }
  if (!isNullOrUndefined(branch.prNo)) {
    details.push(`pr=${branch.prNo}`);
  }
  if (branch.prBlockedBy) {
    details.push(`blocked=${branch.prBlockedBy}`);
  }

  const suffix = details.length ? ` (${details.join(', ')})` : '';
  return `- Branch: ${branch.branchName ?? 'unknown'}${suffix}`;
}

function renderUpgradeSummary(upgrade: Partial<BranchUpgradeCache>): string {
  const dependencyName = upgrade.packageName ?? upgrade.depName ?? 'unknown';
  const current =
    upgrade.currentVersion ?? upgrade.currentValue ?? upgrade.currentDigest;
  const next = upgrade.newVersion ?? upgrade.newValue ?? upgrade.newDigest;
  const fileInfo = upgrade.packageFile ? ` [${upgrade.packageFile}]` : '';
  const updateType = upgrade.updateType ? ` (${upgrade.updateType})` : '';
  return `- ${dependencyName}: ${current ?? '?'} -> ${next ?? '?'}${updateType}${fileInfo}`;
}

async function pushMailingListReportToGit(
  config: RenovateConfig,
  mailReport: string,
): Promise<void> {
  const gitRepo = config.mailingListGitRepo;
  if (isNullOrUndefined(gitRepo)) {
    return;
  }

  const branch = getMailingListGitBranch(config);
  const fileName = config.mailingListGitFile ?? 'reports/renovate-summary.eml';
  const commitMessage =
    config.mailingListGitCommitMessage ??
    'chore(mailing-list): update renovate summary';
  const tempDir = await fs.mkdtemp(
    upath.join(tmpdir(), 'renovate-mailing-list-'),
  );

  try {
    await exec(
      [{ command: ['git', 'clone', '--depth', '1', gitRepo, tempDir] }],
      {},
    );
    await exec([{ command: ['git', 'checkout', '-B', branch] }], {
      cwd: tempDir,
    });

    const targetFilePath = upath.join(tempDir, fileName);
    await fs.ensureDir(upath.dirname(targetFilePath));
    await fs.writeFile(targetFilePath, mailReport, 'utf8');

    await exec([{ command: ['git', 'add', fileName] }], {
      cwd: tempDir,
    });

    const status = await exec([{ command: ['git', 'status', '--porcelain'] }], {
      cwd: tempDir,
    });
    if (!status.stdout.trim()) {
      logger.debug('No mailing list Git changes to commit');
      return;
    }

    const { name, email } = parseGitAuthor(config.gitAuthor);
    await exec([{ command: ['git', 'config', 'user.name', name] }], {
      cwd: tempDir,
    });
    await exec([{ command: ['git', 'config', 'user.email', email] }], {
      cwd: tempDir,
    });

    await exec([{ command: ['git', 'commit', '-m', commitMessage] }], {
      cwd: tempDir,
    });
    await exec(
      [
        {
          command: [
            'git',
            'push',
            '--force-with-lease',
            'origin',
            `HEAD:${branch}`,
          ],
        },
      ],
      { cwd: tempDir },
    );
    logger.info(
      { branch, fileName },
      'Pushed mailing list report to git repository',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to push mailing list report to git');
  } finally {
    await fs.remove(tempDir);
  }
}

function getMailingListGitBranch(config: RenovateConfig): string {
  const fallback =
    config.mailingListGitBranch ?? 'renovate/mailing-list-report';
  const template = config.mailingListGitBranchTemplate?.trim();
  if (!template) {
    return cleanMailingListBranchName(fallback);
  }

  const now = new Date();
  const replacements: Record<string, string> = {
    '{{date}}': formatDate(now),
    '{{timestamp}}': formatTimestamp(now),
    '{{epoch}}': String(now.getTime()),
  };

  let branch = template;
  for (const [token, value] of Object.entries(replacements)) {
    branch = branch.replaceAll(token, value);
  }

  if (!branch.trim()) {
    branch = fallback;
  }

  return cleanMailingListBranchName(branch);
}

function formatDate(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function cleanMailingListBranchName(branchName: string): string {
  return cleanGitRef
    .clean(branchName)
    .replace(/^\.+|\.+$/g, '')
    .replace(/\/\./g, '/')
    .replace(/\s/g, '')
    .replace(/[[\]?:\\^~]/g, '-')
    .replace(/(^|\/)-+/g, '$1')
    .replace(/-+(\/|$)/g, '$1')
    .replace(/--+/g, '-');
}

function parseGitAuthor(gitAuthor?: string): { name: string; email: string } {
  const defaultAuthor = { name: 'Renovate Bot', email: 'renovate@localhost' };
  if (isNullOrUndefined(gitAuthor)) {
    return defaultAuthor;
  }

  const parsed = /^(?<name>[^<]+?)\s*<(?<email>[^>]+)>$/.exec(
    gitAuthor.trim(),
  )?.groups;
  if (parsed?.name && parsed.email) {
    return { name: parsed.name.trim(), email: parsed.email.trim() };
  }

  return defaultAuthor;
}
