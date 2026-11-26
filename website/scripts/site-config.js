(function (root) {
  'use strict';

  var GITHUB_REPO = 'https://github.com/Alex-955/Podcast-Generator';
  var GITHUB_RELEASES = 'https://github.com/Alex-955/Podcast-Generator/releases/tag/v0.2.0';
  var PORTABLE_FILENAME = 'ai-podcast-generator-v0.2.0-portable.zip';
  var PORTABLE_DIRECT_URL = '/downloads/' + PORTABLE_FILENAME;
  var PORTABLE_GITHUB_ASSET_URL =
    'https://github.com/Alex-955/Podcast-Generator/releases/download/v0.2.0/ai-podcast-generator-v0.2.0-portable.zip';
  var PORTABLE_SHA256 =
    '3b7b8ddb627d8be55c2c9872e568a74f71c13f3015700ea29d5d4cc48ea0aab5';

  var SITE_CONFIG = {
    brandName: 'AI 妙听',
    brandSub: '双人对话播客生成器',
    versionBadge: 'v0.2 便携尝鲜版',
    versionTag: 'v0.2.0',
    requireNodeNotice: true,
    nodeRequirement: '本机需提前安装 Node.js 22+',
    githubRepo: GITHUB_REPO,
    githubReleases: GITHUB_RELEASES,
    links: {
      githubRepo: GITHUB_REPO,
      githubReleases: GITHUB_RELEASES,
      nodejsDownload: 'https://nodejs.org/'
    },
    texts: {
      versionBadge: 'v0.2 便携尝鲜版'
    },
    downloads: {
      mac: {
        os: 'mac',
        osLabel: 'macOS',
        heroButtonLabel: '下载 macOS 便携包（v0.2）',
        switchButtonLabel: '切到 Windows 版',
        filename: PORTABLE_FILENAME,
        directUrl: PORTABLE_DIRECT_URL,
        githubAssetUrl: PORTABLE_GITHUB_ASSET_URL,
        githubReleasesUrl: GITHUB_RELEASES,
        sha256: PORTABLE_SHA256,
        launcherScript: 'AI 妙听.command'
      },
      win: {
        os: 'win',
        osLabel: 'Windows',
        heroButtonLabel: '下载 Windows 便携包（v0.2）',
        switchButtonLabel: '切到 macOS 版',
        filename: PORTABLE_FILENAME,
        directUrl: PORTABLE_DIRECT_URL,
        githubAssetUrl: PORTABLE_GITHUB_ASSET_URL,
        githubReleasesUrl: GITHUB_RELEASES,
        sha256: PORTABLE_SHA256,
        launcherScript: 'AI 妙听.bat'
      }
    }
  };

  root.SITE_CONFIG = SITE_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
