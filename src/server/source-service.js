const legacySourceService = require("../../server");

module.exports = {
  DEFAULT_SOURCE_URL: legacySourceService.DEFAULT_SOURCE_URL,
  DEFAULT_SOURCE_FALLBACK_URLS: legacySourceService.DEFAULT_SOURCE_FALLBACK_URLS,
  fetchText: legacySourceService.fetchText,
  findSource: legacySourceService.findSource,
  loadSourceBundle: legacySourceService.loadSourceBundle,
  parseEpisodes: legacySourceService.parseEpisodes,
  publicSource: legacySourceService.publicSource,
  resolveEpisodeVideo: legacySourceService.resolveEpisodeVideo,
  searchSource: legacySourceService.searchSource
};
