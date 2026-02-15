import type { S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { s3 } from '~test/s3.ts';
import { fs, logger } from '~test/util.ts';
import type { RenovateConfig } from '../config/types.ts';
import type { PackageFile } from '../modules/manager/types.ts';
import type { BranchCache } from '../util/cache/repository/types.ts';
import * as _exec from '../util/exec/index.ts';
import {
  addBranchStats,
  addExtractionStats,
  addLibYears,
  exportStats,
  finalizeReport,
  getReport,
  resetReport,
} from './reporting.ts';
import type { Report } from './types.ts';

vi.mock('../util/fs/index.ts', () => mockDeep());
vi.mock('../util/s3.ts', () => mockDeep());
vi.mock('../util/exec/index.ts', () => mockDeep());
vi.mock('../logger/index.ts', () => mockDeep());

const exec = vi.mocked(_exec);

describe('instrumentation/reporting', () => {
  beforeEach(() => {
    resetReport();
    exec.exec.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const branchInformation: Partial<BranchCache>[] = [
    {
      branchName: 'a-branch-name',
      prNo: 20,
      upgrades: [
        {
          currentVersion: '21.1.1',
          currentValue: 'v21.1.1',
          newVersion: '22.0.0',
          newValue: 'v22.0.0',
        },
      ],
    },
  ];
  const packageFiles: Record<string, PackageFile[]> = {
    terraform: [
      {
        packageFile: 'terraform/versions.tf',
        deps: [
          {
            currentValue: 'v21.1.1',
            currentVersion: '4.4.3',
            updates: [
              {
                bucket: 'non-major',
                newVersion: '4.7.0',
                newValue: '~> 4.7.0',
              },
            ],
          },
        ],
      },
    ],
  };

  const expectedReport: Report = {
    problems: [],
    repositories: {
      'myOrg/myRepo': {
        problems: [],
        branches: branchInformation,
        packageFiles,
      },
    },
  };

  it('return empty report if no stats have been added', () => {
    const config = {};
    addBranchStats(config, []);
    addExtractionStats(config, {
      branchList: [],
      branches: [],
      packageFiles: {},
    });
    addLibYears(config, {
      libYears: { managers: {}, total: 0 },
      dependencyStatus: { outdated: 0, total: 0 },
    });

    expect(getReport()).toEqual({
      problems: [],
      repositories: {},
    });
  });

  it('return report if reportType is set to logging', () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'logging',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    expect(getReport()).toEqual(expectedReport);
  });

  it('log report if reportType is set to logging', async () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'logging',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);

    expect(logger.logger.info).toHaveBeenCalledWith(
      { report: expectedReport },
      'Printing report',
    );
  });

  it('write report if reportType is set to file', async () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'file',
      reportPath: './report.json',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);
    expect(fs.writeSystemFile).toHaveBeenCalledExactlyOnceWith(
      config.reportPath,
      JSON.stringify(expectedReport),
    );
  });

  it('write RFC822 report if reportType is set to mailing-list', async () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'mailing-list',
      reportPath: './report.eml',
      mailingListFrom: 'renovate@example.com',
      mailingListTo: ['deps@example.com'],
      mailingListCc: ['maintainers@example.com'],
      mailingListSubject: 'Weekly Renovate Summary',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);
    expect(fs.writeSystemFile).toHaveBeenCalledTimes(1);
    expect(fs.writeSystemFile.mock.calls[0][0]).toBe(config.reportPath);
    const emlBody = fs.writeSystemFile.mock.calls[0][1] as string;
    expect(emlBody).toContain('From: renovate@example.com');
    expect(emlBody).toContain('To: deps@example.com');
    expect(emlBody).toContain('Cc: maintainers@example.com');
    expect(emlBody).toContain('Subject: Weekly Renovate Summary');
    expect(emlBody).toContain('Repository: myOrg/myRepo');
    expect(emlBody).toContain('Branch: a-branch-name');
    expect(emlBody).toContain('21.1.1 -> 22.0.0');
  });

  it('pushes mailing-list report to a separate git branch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-08T00:00:00Z'));
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'mailing-list',
      mailingListGitRepo: 'https://example.com/org/reports.git',
      mailingListGitBranchTemplate: 'renovate/mailing-list/{{date}}',
      mailingListGitFile: 'mail/summary.eml',
      mailingListGitCommitMessage: 'chore: update summary',
      gitAuthor: 'Renovate Bot <renovate@example.com>',
    };

    exec.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ stdout: 'M  mail/summary.eml\n', stderr: '' }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git config name
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git config email
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // push

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);

    expect(exec.exec).toHaveBeenCalledTimes(8);
    expect(exec.exec).toHaveBeenCalledWith(
      [
        {
          command: [
            'git',
            'checkout',
            '-B',
            'renovate/mailing-list/2026-02-08',
          ],
        },
      ],
      expect.any(Object),
    );
    expect(exec.exec).toHaveBeenCalledWith(
      [
        {
          command: [
            'git',
            'push',
            '--force-with-lease',
            'origin',
            'HEAD:renovate/mailing-list/2026-02-08',
          ],
        },
      ],
      expect.any(Object),
    );
  });

  it('send report to an S3 bucket if reportType is s3', async () => {
    const mockClient = mock<S3Client>();
    s3.parseS3Url.mockReturnValue({ Bucket: 'bucket-name', Key: 'key-name' });
    s3.getS3Client.mockReturnValue(mockClient);

    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 's3',
      reportPath: 's3://bucket-name/key-name',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);
    expect(mockClient.send.mock.calls[0][0]).toMatchObject({
      input: {
        Body: JSON.stringify(expectedReport),
      },
    });
  });

  it('handle failed parsing of S3 url', async () => {
    s3.parseS3Url.mockReturnValue(null);

    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 's3',
      reportPath: 'aPath',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    await exportStats(config);

    expect(logger.logger.warn).toHaveBeenCalledWith(
      { reportPath: config.reportPath },
      'Failed to parse s3 URL',
    );
  });

  it('catch exception', async () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'file',
      reportPath: './report.json',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    fs.writeSystemFile.mockRejectedValue(null);
    await expect(exportStats(config)).toResolve();
  });

  it('should add problems to report', () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'logging',
    };
    const expectedReport = {
      problems: [
        {
          level: 30,
          msg: 'a root problem',
        },
      ],
      repositories: {
        'myOrg/myRepo': {
          problems: [
            {
              level: 30,
              msg: 'a repo problem',
            },
          ],
          branches: branchInformation,
          packageFiles,
        },
      },
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });

    logger.getProblems.mockReturnValue([
      {
        repository: 'myOrg/myRepo',
        level: 30,
        msg: 'a repo problem',
      },
      {
        level: 30,
        msg: 'a root problem',
      },
    ]);
    finalizeReport();

    expect(getReport()).toEqual(expectedReport);
  });

  it('should handle libyears addition', () => {
    const config: RenovateConfig = {
      repository: 'myOrg/myRepo',
      reportType: 'logging',
    };

    addBranchStats(config, branchInformation);
    addExtractionStats(config, { branchList: [], branches: [], packageFiles });
    addLibYears(config, {
      libYears: { managers: { npm: 1 }, total: 1 },
      dependencyStatus: { outdated: 1, total: 1 },
    });

    expect(getReport()).toEqual({
      problems: [],
      repositories: {
        'myOrg/myRepo': {
          problems: [],
          branches: branchInformation,
          packageFiles,
          libYearsWithStatus: {
            libYears: {
              managers: {
                npm: 1,
              },
              total: 1,
            },
            dependencyStatus: {
              outdated: 1,
              total: 1,
            },
          },
        },
      },
    });
  });
});
