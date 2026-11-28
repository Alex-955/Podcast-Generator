(function (root) {
  'use strict';

  var GITHUB_REPO = 'https://github.com/Alex-955/Podcast-Generator';
  var GITHUB_RELEASES = GITHUB_REPO + '/releases/tag/v1.0.1';
  var RELEASE_DOWNLOAD_BASE = GITHUB_REPO + '/releases/download/v1.0.1/';

  var MAC_ARM64_FILE = 'InkCast-v1.0.1-mac-arm64.dmg';
  var MAC_X64_FILE = 'InkCast-v1.0.1-mac-x64.dmg';
  var WIN_X64_FILE = 'InkCast-v1.0.1-win-x64-setup.exe';
  var PORTABLE_ZIP_FILE = 'InkCast-v1.0.1-portable.zip';
  var PORTABLE_TAR_FILE = 'InkCast-v1.0.1-portable.tar.gz';
  var SHA256SUMS_FILE = 'SHA256SUMS.txt';

  var SITE_CONFIG = {
    brandName: '拾声集',
    brandEn: 'InkCast',
    brandSub: '双人对话播客生成器',
    versionBadge: 'v1.0.1 桌面正式版',
    versionTag: 'v1.0.1',
    requireNodeNotice: false,
    nodeRequirement: '免装 Node.js · 下载即用桌面客户端',
    githubRepo: GITHUB_REPO,
    githubReleases: GITHUB_RELEASES,
    links: {
      githubRepo: GITHUB_REPO,
      githubReleases: GITHUB_RELEASES,
      githubLicense: GITHUB_REPO + '/blob/main/LICENSE',
      githubTrademark: GITHUB_REPO + '/blob/main/TRADEMARK.md',
      sha256Sums: RELEASE_DOWNLOAD_BASE + SHA256SUMS_FILE,
      portableZip: RELEASE_DOWNLOAD_BASE + PORTABLE_ZIP_FILE,
      portableTar: RELEASE_DOWNLOAD_BASE + PORTABLE_TAR_FILE,
      nodejsDownload: 'https://nodejs.org/'
    },
    texts: {
      versionBadge: 'v1.0.1 桌面正式版'
    },
    downloads: {
      mac: {
        os: 'mac',
        osLabel: 'macOS',
        heroButtonLabel: '下载 macOS 桌面版（v1.0.1）',
        switchButtonLabel: '切到 Windows 版',
        filename: MAC_ARM64_FILE,
        directUrl: RELEASE_DOWNLOAD_BASE + MAC_ARM64_FILE,
        directLabel: '下载 Apple Silicon (.dmg)',
        githubAssetUrl: RELEASE_DOWNLOAD_BASE + MAC_X64_FILE,
        secondaryLabel: '下载 Intel 芯片 (.dmg)',
        githubReleasesUrl: GITHUB_RELEASES,
        sha256: 'shasum -a 256 InkCast-v1.0.1-mac-*.dmg',
        shaCommand: 'shasum -a 256 InkCast-v1.0.1-mac-*.dmg',
        intelFilename: MAC_X64_FILE,
        intelUrl: RELEASE_DOWNLOAD_BASE + MAC_X64_FILE
      },
      win: {
        os: 'win',
        osLabel: 'Windows',
        heroButtonLabel: '下载 Windows 安装版（v1.0.1）',
        switchButtonLabel: '切到 macOS 版',
        filename: WIN_X64_FILE,
        directUrl: RELEASE_DOWNLOAD_BASE + WIN_X64_FILE,
        directLabel: '下载 Windows 64 位安装版 (.exe)',
        githubAssetUrl: GITHUB_RELEASES,
        secondaryLabel: '前往 GitHub Releases v1.0.1',
        githubReleasesUrl: GITHUB_RELEASES,
        sha256: 'certutil -hashfile InkCast-v1.0.1-win-x64-setup.exe SHA256',
        shaCommand: 'certutil -hashfile InkCast-v1.0.1-win-x64-setup.exe SHA256'
      },
      portable: {
        zipFilename: PORTABLE_ZIP_FILE,
        zipUrl: RELEASE_DOWNLOAD_BASE + PORTABLE_ZIP_FILE,
        tarFilename: PORTABLE_TAR_FILE,
        tarUrl: RELEASE_DOWNLOAD_BASE + PORTABLE_TAR_FILE,
        sha256SumsUrl: RELEASE_DOWNLOAD_BASE + SHA256SUMS_FILE
      }
    }
  };

  root.SITE_CONFIG = SITE_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
