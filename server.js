const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MEMBERS = 2;
const DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/MajoSissi/animeko-source/main/dist/online.json";
const DEFAULT_SOURCE_FALLBACK_URLS = [
  DEFAULT_SOURCE_URL,
  "https://cdn.jsdelivr.net/gh/MajoSissi/animeko-source@main/dist/online.json",
  "https://fastly.jsdelivr.net/gh/MajoSissi/animeko-source@main/dist/online.json",
  "https://gcore.jsdelivr.net/gh/MajoSissi/animeko-source@main/dist/online.json"
];
const SOURCE_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 60000);
const MAC_PARSE_PLAYER_URL = "https://xn--z6uz08g.992588.xyz/player/";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const rooms = new Map();
const sourceCache = new Map();

function createId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeRoomId(roomId) {
  return String(roomId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

function sanitizeName(name) {
  const safeName = String(name || "").trim().slice(0, 24);
  return safeName || "观影伙伴";
}

function clampTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 24 * 60 * 60);
}

function sanitizeVideoUrl(value) {
  const url = String(value || "").trim();
  if (!url || url.length > 2048) return "";

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sanitizeHttpUrl(value) {
  const url = String(value || "").trim();
  if (!url || url.length > 2048) return "";

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sendJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendApiError(res, statusCode, code, message) {
  sendJsonResponse(res, statusCode, { error: { code, message } });
}

function cleanKeyword(keyword, config) {
  let value = String(keyword || "").trim();
  if (config.searchRemoveSpecial) {
    value = value.replace(/[^\p{L}\p{N}\s_-]/gu, " ");
  }
  value = value.replace(/\s+/g, " ").trim();
  if (config.searchUseOnlyFirstWord) {
    value = value.split(/\s+/)[0] || value;
  }
  return value.slice(0, 80);
}

function resolveLink(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function decodeEscapedText(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\/g, "");
}

function decodeUriLoose(value) {
  let decoded = String(value || "");

  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  return decoded;
}

function decodeBase64Loose(value) {
  const compact = String(value || "").trim();
  if (!compact || compact.length % 4 === 1 || !/^[a-zA-Z0-9+/=_-]+$/.test(compact)) return "";

  try {
    return Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripTags(value) {
  return htmlDecode(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getAttribute(attributes, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(attributes || "");
  return htmlDecode(match ? match[2] || match[3] || match[4] || "" : "");
}

function firstImageUrl(fragment, baseUrl) {
  const imageMatch = /<img\b([^>]*)>/i.exec(fragment || "");
  if (imageMatch) {
    const attributes = imageMatch[1] || "";
    const raw =
      getAttribute(attributes, "data-src") ||
      getAttribute(attributes, "data-original") ||
      getAttribute(attributes, "data-lazy-src") ||
      getAttribute(attributes, "src");
    const resolved = resolveLink(raw, baseUrl);
    if (resolved) return resolved;
  }

  const backgroundMatch = /background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/i.exec(fragment || "");
  return backgroundMatch ? resolveLink(backgroundMatch[2], baseUrl) : "";
}

function selectorParts(selector) {
  const compact = String(selector || "")
    .replace(/:nth-child\([^)]+\)/g, "")
    .replace(/:first-child|:last-child/g, "")
    .trim();
  const tokens = compact.split(/\s*>\s*|\s+/).filter(Boolean);
  const target = tokens[tokens.length - 1] || "a";
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(target);
  const idMatch = /#([\w-]+)/.exec(target);
  return {
    compact,
    target,
    tag: tagMatch ? tagMatch[1].toLowerCase() : null,
    id: idMatch ? idMatch[1] : "",
    classes: Array.from(target.matchAll(/\.([\w-]+)/g), (match) => match[1]),
    contextClasses: Array.from(compact.matchAll(/\.([\w-]+)/g), (match) => match[1]),
    attrs: Array.from(target.matchAll(/\[([\w-]+)/g), (match) => match[1])
  };
}

function elementMatches(attributes, parts, context) {
  if (parts.id && getAttribute(attributes, "id") !== parts.id) return false;

  const classList = getAttribute(attributes, "class").split(/\s+/).filter(Boolean);
  for (const className of parts.classes) {
    if (!classList.includes(className)) return false;
  }

  for (const attrName of parts.attrs) {
    if (!getAttribute(attributes, attrName)) return false;
  }

  if (!parts.classes.length && parts.contextClasses.length) {
    const hasContext = parts.contextClasses.some((className) => context.includes(className));
    if (!hasContext) return false;
  }

  return true;
}

function extractElements(html, selector, baseUrl) {
  const parts = selectorParts(selector);
  const tagPattern = parts.tag || "[a-zA-Z][\\w-]*";
  const pattern = new RegExp(`<(${tagPattern})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
  const items = [];
  let match;

  while ((match = pattern.exec(html)) && items.length < 120) {
    const tag = match[1].toLowerCase();
    const attributes = match[2] || "";
    const body = match[3] || "";
    const context = html.slice(Math.max(0, match.index - 500), Math.min(html.length, pattern.lastIndex + 500));

    if (parts.tag && tag !== parts.tag) continue;
    if (!elementMatches(attributes, parts, context)) continue;

    const href = getAttribute(attributes, "href") || getAttribute(attributes, "data-href") || getAttribute(attributes, "src");
    const title = getAttribute(attributes, "title") || getAttribute(attributes, "aria-label");
    const text = stripTags(title || body);

    if (!text && !href) continue;
    items.push({
      text,
      url: href ? resolveLink(href, baseUrl) : "",
      html: match[0],
      context
    });
  }

  return items;
}

function uniqueMediaItems(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const name = String(item.name || item.text || "").trim();
    const url = String(item.url || "").trim();
    if (!name || !url) continue;

    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      name,
      url,
      imageUrl: sanitizeHttpUrl(item.imageUrl) || ""
    });
  }

  return output.slice(0, 40);
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 Towwatch/0.1",
        ...headers
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError" || /aborted/i.test(error.message || "")) {
      throw new Error(`请求超时（${Math.round(FETCH_TIMEOUT_MS / 1000)}s）：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sourceFallbackUrls(sourceUrl) {
  const normalizedUrl = sanitizeHttpUrl(sourceUrl) || DEFAULT_SOURCE_URL;
  const configuredFallbacks = String(process.env.SOURCE_FALLBACK_URLS || "")
    .split(",")
    .map((url) => sanitizeHttpUrl(url))
    .filter(Boolean);
  const defaults = normalizedUrl === DEFAULT_SOURCE_URL ? DEFAULT_SOURCE_FALLBACK_URLS : [normalizedUrl];
  return Array.from(new Set([normalizedUrl, ...configuredFallbacks, ...defaults]));
}

function normalizeSource(rawSource, index) {
  const args = rawSource.arguments || {};
  const searchConfig = args.searchConfig || {};
  const seed = `${index}:${args.name || ""}:${searchConfig.searchUrl || ""}`;
  const id = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);

  return {
    id,
    index,
    factoryId: rawSource.factoryId || "",
    name: args.name || `Source ${index + 1}`,
    description: args.description || "",
    iconUrl: args.iconUrl || "",
    tier: args.tier ?? null,
    config: searchConfig
  };
}

function publicSource(source) {
  return {
    id: source.id,
    index: source.index,
    name: source.name,
    description: source.description,
    iconUrl: source.iconUrl,
    tier: source.tier,
    searchUrl: source.config.searchUrl || "",
    defaultResolution: source.config.defaultResolution || "",
    supportsSearch: Boolean(source.config.searchUrl)
  };
}

async function loadSourceBundle(sourceUrl = DEFAULT_SOURCE_URL) {
  const candidates = sourceFallbackUrls(sourceUrl);
  const cached = candidates
    .map((url) => sourceCache.get(url))
    .find((item) => item && Date.now() - item.loadedAt < SOURCE_CACHE_MS);

  if (cached) return cached.bundle;

  const errors = [];
  for (const candidateUrl of candidates) {
    try {
      const text = await fetchText(candidateUrl);
      const data = JSON.parse(text);
      const rawSources =
        data.exportedMediaSourceDataList?.mediaSources ||
        data.mediaSources ||
        data.sources ||
        [];

      const sources = rawSources
        .map((source, index) => normalizeSource(source, index))
        .filter((source) => source.config && source.config.searchUrl);
      const bundle = { sourceUrl: candidateUrl, sources };

      for (const cacheKey of candidates) {
        sourceCache.set(cacheKey, { loadedAt: Date.now(), bundle });
      }

      return bundle;
    } catch (error) {
      errors.push(`${candidateUrl}: ${error.message}`);
    }
  }

  throw new Error(`源列表加载失败，已尝试 ${candidates.length} 个地址。最后错误：${errors.at(-1) || "unknown"}`);
}

function findSource(bundle, sourceId) {
  return bundle.sources.find((source) => source.id === sourceId || String(source.index) === String(sourceId));
}

function parseJsonSearch(text, baseUrl) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const rows = Array.isArray(data) ? data : data.list || data.data || data.results || [];
  if (!Array.isArray(rows)) return [];

  return uniqueMediaItems(
    rows.map((row) => ({
      name: row.title || row.name || row.vod_name || row.text,
      url: resolveLink(row.url || row.link || row.href || row.vod_play_url, baseUrl),
      imageUrl: resolveLink(row.image || row.img || row.pic || row.cover || row.poster || row.vod_pic, baseUrl)
    }))
  );
}

function resultImage(item, baseUrl) {
  return firstImageUrl(item.html, baseUrl) || firstImageUrl(item.context, baseUrl);
}

function parseHtmlSearch(html, source, baseUrl) {
  const config = source.config || {};
  const formatId = config.subjectFormatId || "a";

  if (formatId === "indexed") {
    const selector = config.selectorSubjectFormatIndexed || {};
    const names = extractElements(html, selector.selectNames || "a", baseUrl);
    const links = extractElements(html, selector.selectLinks || "a", baseUrl);
    return uniqueMediaItems(
      links.map((link, index) => ({
        name: names[index]?.text || link.text,
        url: link.url,
        imageUrl: resultImage(link, baseUrl) || resultImage(names[index], baseUrl)
      }))
    );
  }

  const selector = config.selectorSubjectFormatA?.selectLists || config.selectorSubjectFormatIndexed?.selectLinks || "a";
  return uniqueMediaItems(
    extractElements(html, selector, baseUrl).map((item) => ({
      name: item.text,
      url: item.url,
      imageUrl: resultImage(item, baseUrl)
    }))
  );
}

async function searchSource(bundle, source, query) {
  const config = source.config || {};
  const keyword = cleanKeyword(query, config);
  if (!keyword) return { searchUrl: "", items: [] };

  const template = String(config.searchUrl || "");
  const searchUrl = resolveLink(template.replaceAll("{keyword}", encodeURIComponent(keyword)), bundle.sourceUrl);
  if (!searchUrl) return { searchUrl: "", items: [] };

  const html = await fetchText(searchUrl);
  const jsonItems = parseJsonSearch(html, searchUrl);
  return {
    searchUrl,
    items: jsonItems.length ? jsonItems : parseHtmlSearch(html, source, searchUrl)
  };
}

function parseEpisodes(html, source, pageUrl) {
  const config = source.config || {};
  const noChannel = config.selectorChannelFormatNoChannel || {};
  const flattened = config.selectorChannelFormatFlattened || {};
  const preferFlattened = config.channelFormatId !== "no-channel";
  const primaryEpisodeSelector = preferFlattened ? flattened.selectEpisodesFromList : noChannel.selectEpisodes;
  const primaryLinkSelector = preferFlattened ? flattened.selectEpisodeLinksFromList : noChannel.selectEpisodeLinks;
  const primaryListSelector = preferFlattened ? flattened.selectEpisodeLists : "";
  const fallbackEpisodeSelector = preferFlattened ? noChannel.selectEpisodes : flattened.selectEpisodesFromList;
  const fallbackLinkSelector = preferFlattened ? noChannel.selectEpisodeLinks : flattened.selectEpisodeLinksFromList;
  const episodeSelector = primaryEpisodeSelector || fallbackEpisodeSelector || "a";
  const linkSelector = primaryLinkSelector || fallbackLinkSelector || "";
  let episodes;

  const episodeHtmlBlocks = primaryListSelector
    ? extractElements(html, primaryListSelector, pageUrl).map((item) => item.html)
    : [html];

  if (linkSelector) {
    const names = episodeHtmlBlocks.flatMap((block) => extractElements(block, episodeSelector, pageUrl));
    const links = episodeHtmlBlocks.flatMap((block) => extractElements(block, linkSelector, pageUrl));
    episodes = uniqueMediaItems(
      links.map((link, index) => ({
        name: names[index]?.text || link.text,
        url: link.url
      }))
    );
  } else {
    episodes = uniqueMediaItems(
      episodeHtmlBlocks.flatMap((block) => extractElements(block, episodeSelector, pageUrl)).map((item) => ({
        name: item.text,
        url: item.url
      }))
    );
  }

  const likelyEpisodes = episodes.filter((item) => /\/(?:bofang|play|vodplay)\//i.test(item.url));
  if (likelyEpisodes.length) return likelyEpisodes;
  if (episodes.length) return episodes.filter((item) => !/^javascript:/i.test(item.url));

  return uniqueMediaItems(
    Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi))
      .map((match) => {
        const href = getAttribute(match[1], "href");
        return {
          name: stripTags(match[2]) || getAttribute(match[1], "title"),
          url: resolveLink(href, pageUrl)
        };
      })
      .filter((item) => /\/(?:bofang|play|vodplay)\//i.test(item.url))
  );
}

function compileSourceRegex(pattern) {
  if (!pattern) return null;

  try {
    return new RegExp(pattern, "i");
  } catch {
    try {
      return new RegExp(pattern.replace(/\(\?<[^>]+>/g, "("), "i");
    } catch {
      return null;
    }
  }
}

function normalizeCandidateUrl(value, baseUrl) {
  let url = decodeEscapedText(htmlDecode(String(value || "")))
    .replace(/^['"]|['"]$/g, "")
    .replace(/[),;]+$/g, "")
    .trim();

  const paramMatch = /(?:^|[?&])url=([^&]+)/i.exec(url) || /\burl=([^&]+)/i.exec(url);
  if (paramMatch) {
    url = paramMatch[1];
  }

  url = decodeUriLoose(url);
  if (url.startsWith("//")) {
    url = `${new URL(baseUrl).protocol}${url}`;
  }
  return sanitizeHttpUrl(resolveLink(url, baseUrl));
}

function extractCandidateUrls(text, baseUrl) {
  const candidates = new Set();
  const normalizedText = decodeEscapedText(htmlDecode(text));
  const patterns = [
    /https?:\\?\/\\?\/[^\s"'<>]+/gi,
    /\/\/[^\s"'<>]+/g,
    /\b(?:url|src|href|data-src|data-play|playurl)\s*[:=]\s*['"]?([^'"<>\s]+)['"]?/gi,
    /["'](?:url|src|href|v|playUrl|playurl)["']\s*:\s*["']([^"']+)["']/gi,
    /[?&]url=([^&"'<>]+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(normalizedText)) && candidates.size < 240) {
      const raw = match[1] || match[0];
      const url = normalizeCandidateUrl(raw, baseUrl);
      if (url) candidates.add(url);
    }
  }

  return Array.from(candidates);
}

function normalizeMediaUrlCandidate(value, baseUrl) {
  const raw = String(value || "");
  if (!/^(https?:)?\/\//i.test(raw) && !raw.startsWith("/") && !/\.(mp4|webm|m3u8|mkv|flv)(\?|$)/i.test(raw)) {
    return "";
  }

  return normalizeCandidateUrl(raw, baseUrl);
}

function parseLooseObject(rawObject) {
  const normalized = decodeEscapedText(rawObject)
    .replace(/'/g, "\"")
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, "$1\"$2\":")
    .replace(/,\s*}/g, "}");

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function decodePlayerUrl(value, encrypt) {
  let decoded = decodeEscapedText(htmlDecode(value));
  const encryptMode = String(encrypt ?? "");

  if (encryptMode === "1") {
    decoded = decodeUriLoose(decoded);
  } else if (encryptMode === "2") {
    decoded = decodeUriLoose(decodeBase64Loose(decoded) || decoded);
  } else {
    decoded = decodeUriLoose(decoded);
  }

  return decoded;
}

function readBalancedObject(text, startIndex) {
  if (text[startIndex] !== "{") return null;

  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          raw: text.slice(startIndex, index + 1),
          endIndex: index + 1
        };
      }
    }
  }

  return null;
}

function extractPlayerConfigs(text) {
  const configs = [];
  const normalizedText = decodeEscapedText(htmlDecode(text));
  const assignPattern = /\b(?:var\s+|let\s+|const\s+)?(?:player_[a-zA-Z0-9_$]+|player|playData|play_data)\s*=\s*/gi;
  let match;

  while ((match = assignPattern.exec(normalizedText)) && configs.length < 20) {
    const objectStart = normalizedText.indexOf("{", assignPattern.lastIndex);
    if (objectStart === -1) continue;

    const objectLiteral = readBalancedObject(normalizedText, objectStart);
    if (!objectLiteral) continue;

    assignPattern.lastIndex = objectLiteral.endIndex;
    const data = parseLooseObject(objectLiteral.raw);
    if (data) configs.push(data);
  }

  return configs;
}

function extractPlayerConfigUrlsFromConfigs(configs, baseUrl) {
  const urls = new Set();

  for (const data of configs) {
    for (const key of ["url", "url_next", "playUrl", "playurl", "video", "src", "link"]) {
      if (!data[key]) continue;
      for (const part of String(data[key]).split(/[#]+/)) {
        const maybeUrl = part.includes("$") ? part.split("$").pop() : part;
        const url = normalizeMediaUrlCandidate(decodePlayerUrl(maybeUrl, data.encrypt), baseUrl);
        if (url) urls.add(url);
      }
    }
  }

  return Array.from(urls);
}

function extractPlayerConfigUrls(text, baseUrl) {
  return extractPlayerConfigUrlsFromConfigs(extractPlayerConfigs(text), baseUrl);
}

function buildMacParserUrl(data, pageUrl) {
  if (!data?.url) return "";

  const decodedUrl = decodePlayerUrl(data.url, data.encrypt);
  if (!decodedUrl || sanitizeHttpUrl(decodedUrl)) return "";

  let host = "";
  try {
    host = new URL(pageUrl).host;
  } catch {
    return "";
  }

  const nextPath = decodeEscapedText(htmlDecode(String(data.link_next || "")));
  const next = nextPath ? `//${host}${nextPath}` : "";
  const title = data.vod_data?.vod_name || data.title || "";
  const parserUrl = `${MAC_PARSE_PLAYER_URL}?url=${decodedUrl}${next ? `&next=${next}` : ""}${title ? `&title=${encodeURIComponent(title)}` : ""}`;
  return sanitizeHttpUrl(parserUrl);
}

function extractMacParserUrls(configs, pageUrl) {
  return Array.from(new Set(configs.map((data) => buildMacParserUrl(data, pageUrl)).filter(Boolean)));
}

function summarizePlayerConfigs(configs, pageUrl) {
  return configs.slice(0, 8).map((data) => ({
    from: data.from || "",
    encrypt: data.encrypt ?? "",
    id: data.id || "",
    sid: data.sid || "",
    nid: data.nid || "",
    title: data.vod_data?.vod_name || data.title || "",
    rawUrl: data.url || "",
    decodedUrl: data.url ? decodePlayerUrl(data.url, data.encrypt) : "",
    parserUrl: buildMacParserUrl(data, pageUrl)
  }));
}

function isLikelyPlayableUrl(url) {
  return /\.(mp4|webm|m3u8|mkv|flv)(\?|$)/i.test(url) ||
    /(bilivideo|akamaized|bytetos|byteimg|mcloud\.139|cloudflarestorage|tos-cn|mime_type=video)/i.test(url);
}

function isStaticAssetUrl(url) {
  return /\.(?:css|js|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)(?:\?|$)/i.test(url);
}

function stripUrlHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "").split("#")[0];
  }
}

function shouldExploreCandidateUrl(candidate, currentUrl, nestedPattern) {
  if (!candidate || isStaticAssetUrl(candidate) || /[?&]url=$/i.test(candidate)) return false;
  if (stripUrlHash(candidate) === stripUrlHash(currentUrl)) return false;

  return Boolean(nestedPattern?.test(candidate)) ||
    /(?:player|vip|xigua|parse|jx|url=|\/vodplay|\/play\/|\/bofang\/|\/video|iframe)/i.test(candidate);
}

function pickRegexUrl(match, baseUrl) {
  const values = [
    match.groups?.v,
    ...Array.from(match).slice(1),
    match[0]
  ].filter(Boolean);

  for (const value of values) {
    const url = normalizeCandidateUrl(value, baseUrl);
    if (sanitizeHttpUrl(url)) return url;
  }

  return "";
}

function findVideoUrl(text, source, pageUrl) {
  const matchVideo = source.config?.matchVideo || {};
  const videoPattern = compileSourceRegex(matchVideo.matchVideoUrl);
  const candidates = [
    ...extractPlayerConfigUrls(text, pageUrl),
    ...extractCandidateUrls(text, pageUrl)
  ];

  if (!videoPattern) {
    return candidates.find(isLikelyPlayableUrl) || "";
  }

  for (const candidate of candidates) {
    const match = videoPattern.exec(candidate);
    if (match) {
      return pickRegexUrl(match, pageUrl);
    }

    if (isLikelyPlayableUrl(candidate)) {
      return candidate;
    }
  }

  const rawPattern = new RegExp(videoPattern.source, videoPattern.flags.includes("g") ? videoPattern.flags : `${videoPattern.flags}g`);
  let rawMatch;
  while ((rawMatch = rawPattern.exec(decodeEscapedText(htmlDecode(text))))) {
    const url = pickRegexUrl(rawMatch, pageUrl);
    if (url) return url;
  }

  return "";
}

async function resolveEpisodeVideo(source, episodeUrl, options = {}) {
  const matchVideo = source.config?.matchVideo || {};
  const headers = matchVideo.addHeadersToVideo || {};
  const requestHeaders = {};
  const trace = options.trace;

  if (headers.referer) requestHeaders.referer = headers.referer;
  if (headers.userAgent) requestHeaders["user-agent"] = headers.userAgent;

  const nestedPattern = compileSourceRegex(matchVideo.matchNestedUrl);
  const queue = [{ url: episodeUrl, depth: 0 }];
  const visited = new Set();

  if (trace) {
    trace.push({
      step: "start",
      episodeUrl,
      matchVideoUrl: matchVideo.matchVideoUrl || "",
      matchNestedUrl: matchVideo.matchNestedUrl || "",
      enableNestedUrl: Boolean(matchVideo.enableNestedUrl)
    });
  }

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current.url) || current.depth > 3) continue;
    visited.add(current.url);

    if (trace) {
      trace.push({ step: "fetch", depth: current.depth, url: current.url });
    }

    let html;
    try {
      html = await fetchText(current.url, requestHeaders);
    } catch (error) {
      if (trace) {
        trace.push({ step: "fetch-error", depth: current.depth, url: current.url, message: error.message });
      }
      continue;
    }

    const playerConfigs = extractPlayerConfigs(html);
    const playerUrls = extractPlayerConfigUrlsFromConfigs(playerConfigs, current.url);
    const parserUrls = extractMacParserUrls(playerConfigs, current.url);
    const candidateUrls = extractCandidateUrls(html, current.url);
    if (trace) {
      trace.push({
        step: "scan",
        depth: current.depth,
        url: current.url,
        htmlLength: html.length,
        playerConfigs: summarizePlayerConfigs(playerConfigs, current.url),
        parserUrls: parserUrls.slice(0, 10),
        playerUrls: playerUrls.slice(0, 20),
        candidateUrls: candidateUrls.slice(0, 30)
      });
    }

    const directUrl = findVideoUrl(html, source, current.url);
    if (directUrl) {
      if (trace) {
        trace.push({ step: "found", depth: current.depth, pageUrl: current.url, videoUrl: directUrl });
      }
      return directUrl;
    }

    const candidates = [
      ...parserUrls,
      ...playerUrls,
      ...candidateUrls
    ];

    for (const candidate of candidates) {
      if (visited.has(candidate)) continue;
      if (isLikelyPlayableUrl(candidate)) {
        if (trace) {
          trace.push({ step: "found-candidate", depth: current.depth, pageUrl: current.url, videoUrl: candidate });
        }
        return candidate;
      }

      const shouldFollow = shouldExploreCandidateUrl(candidate, current.url, nestedPattern);

      if (shouldFollow && queue.length < 12) {
        queue.push({ url: candidate, depth: current.depth + 1 });
        if (trace) {
          trace.push({ step: "queue", from: current.url, to: candidate, depth: current.depth + 1 });
        }
      }
    }
  }

  if (trace) {
    trace.push({ step: "not-found", visited: Array.from(visited) });
  }

  return "";
}

async function handleApi(req, res, requestUrl) {
  try {
    if (requestUrl.pathname === "/api/sources") {
      const bundle = await loadSourceBundle(requestUrl.searchParams.get("url") || DEFAULT_SOURCE_URL);
      sendJsonResponse(res, 200, {
        sourceUrl: bundle.sourceUrl,
        count: bundle.sources.length,
        sources: bundle.sources.map(publicSource)
      });
      return;
    }

    if (requestUrl.pathname === "/api/search") {
      const bundle = await loadSourceBundle(requestUrl.searchParams.get("sourceUrl") || DEFAULT_SOURCE_URL);
      const source = findSource(bundle, requestUrl.searchParams.get("sourceId"));
      if (!source) {
        sendApiError(res, 404, "source_not_found", "Source not found.");
        return;
      }

      const result = await searchSource(bundle, source, requestUrl.searchParams.get("q"));
      sendJsonResponse(res, 200, {
        source: publicSource(source),
        searchUrl: result.searchUrl,
        items: result.items
      });
      return;
    }

    if (requestUrl.pathname === "/api/episodes") {
      const bundle = await loadSourceBundle(requestUrl.searchParams.get("sourceUrl") || DEFAULT_SOURCE_URL);
      const source = findSource(bundle, requestUrl.searchParams.get("sourceId"));
      const pageUrl = sanitizeHttpUrl(requestUrl.searchParams.get("url"));
      if (!source || !pageUrl) {
        sendApiError(res, 400, "bad_episode_request", "Source and page URL are required.");
        return;
      }

      const html = await fetchText(pageUrl);
      sendJsonResponse(res, 200, {
        source: publicSource(source),
        pageUrl,
        episodes: parseEpisodes(html, source, pageUrl)
      });
      return;
    }

    if (requestUrl.pathname === "/api/resolve") {
      const bundle = await loadSourceBundle(requestUrl.searchParams.get("sourceUrl") || DEFAULT_SOURCE_URL);
      const source = findSource(bundle, requestUrl.searchParams.get("sourceId"));
      const episodeUrl = sanitizeHttpUrl(requestUrl.searchParams.get("url"));
      const debug = requestUrl.searchParams.get("debug") === "1";
      const trace = [];
      if (!source || !episodeUrl) {
        sendApiError(res, 400, "bad_resolve_request", "Source and episode URL are required.");
        return;
      }

      const videoUrl = await resolveEpisodeVideo(source, episodeUrl, { trace: debug ? trace : null });
      if (!videoUrl) {
        if (debug) {
          sendJsonResponse(res, 404, {
            error: {
              code: "video_not_found",
              message: "未解析到可播放地址，请切换源或换一个搜索结果。"
            },
            source: publicSource(source),
            episodeUrl,
            trace
          });
          return;
        }

        sendApiError(res, 404, "video_not_found", "未解析到可播放地址，请切换源或换一个搜索结果。");
        return;
      }

      sendJsonResponse(res, 200, {
        source: publicSource(source),
        episodeUrl,
        videoUrl,
        ...(debug ? { trace } : {})
      });
      return;
    }

    sendApiError(res, 404, "api_not_found", "API endpoint not found.");
  } catch (error) {
    sendApiError(res, 500, "api_error", error.message || "API request failed.");
  }
}

class Room {
  constructor(id) {
    this.id = id;
    this.members = new Map();
    this.version = 0;
    this.videoUrl = "";
    this.currentTime = 0;
    this.isPlaying = false;
    this.updatedAt = Date.now();
  }

  addMember(socket, name) {
    const member = {
      id: createId(),
      name: sanitizeName(name),
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };

    this.members.set(socket.id, member);
    return member;
  }

  removeMember(socketId) {
    const member = this.members.get(socketId);
    this.members.delete(socketId);
    this.version += 1;
    return member;
  }

  anchorPlaybackState(now = Date.now()) {
    this.version += 1;
    this.updatedAt = now;
  }

  effectiveCurrentTime(now = Date.now()) {
    if (!this.isPlaying) return this.currentTime;
    return this.currentTime + Math.max(0, now - this.updatedAt) / 1000;
  }

  setVideo(url) {
    this.videoUrl = url;
    this.currentTime = 0;
    this.isPlaying = false;
    this.anchorPlaybackState();
  }

  applyControl({ action, currentTime, isPlaying }) {
    const now = Date.now();
    this.currentTime = clampTime(currentTime);

    if (action === "play") {
      this.isPlaying = true;
    } else if (action === "pause") {
      this.isPlaying = false;
    } else if (action === "seek") {
      this.isPlaying = Boolean(isPlaying);
    }

    this.version += 1;
    this.updatedAt = now;
  }

  snapshot(now = Date.now()) {
    return {
      roomId: this.id,
      videoUrl: this.videoUrl,
      currentTime: this.currentTime,
      effectiveCurrentTime: this.effectiveCurrentTime(now),
      isPlaying: this.isPlaying,
      updatedAt: this.updatedAt,
      version: this.version,
      members: Array.from(this.members.values()).map((member) => ({
        id: member.id,
        name: member.name,
        joinedAt: member.joinedAt,
        lastSeen: member.lastSeen
      }))
    };
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Room(roomId));
  }
  return rooms.get(roomId);
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  const length = data.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x81;
  return Buffer.concat([header, data]);
}

function decodeFrames(socket, chunk) {
  socket.buffer = Buffer.concat([socket.buffer || Buffer.alloc(0), chunk]);
  const messages = [];

  while (socket.buffer.length >= 2) {
    const secondByte = socket.buffer[1];
    const opcode = socket.buffer[0] & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (socket.buffer.length < offset + 2) break;
      length = socket.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (socket.buffer.length < offset + 8) break;
      const largeLength = socket.buffer.readBigUInt64BE(offset);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        socket.destroy();
        return messages;
      }
      length = Number(largeLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + maskLength + length;
    if (socket.buffer.length < frameEnd) break;

    const mask = masked ? socket.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(socket.buffer.subarray(offset, offset + length));
    socket.buffer = socket.buffer.subarray(frameEnd);

    if (opcode === 0x8) {
      socket.end();
      return messages;
    }

    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }

    if (opcode !== 0x1) continue;

    if (masked && mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    messages.push(payload.toString("utf8"));
  }

  return messages;
}

function send(socket, message) {
  if (socket.destroyed) return;
  socket.write(encodeFrame(JSON.stringify(message)));
}

function broadcast(room, message, exceptSocketId = null) {
  for (const socket of room.sockets || []) {
    if (socket.id !== exceptSocketId) {
      send(socket, message);
    }
  }
}

function broadcastState(room, reason) {
  const now = Date.now();
  broadcast(room, {
    type: "state",
    reason,
    serverNow: now,
    state: room.snapshot(now)
  });
}

function handleClientMessage(socket, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    send(socket, { type: "error", code: "bad_json", message: "消息格式无效。" });
    return;
  }

  const room = socket.room;
  const member = room.members.get(socket.id);
  if (member) member.lastSeen = Date.now();

  if (message.type === "sync_ping") {
    send(socket, {
      type: "sync_pong",
      clientSentAt: message.clientSentAt,
      serverNow: Date.now()
    });
    return;
  }

  if (message.type === "request_state") {
    const now = Date.now();
    send(socket, {
      type: "state",
      reason: "request",
      serverNow: now,
      state: room.snapshot(now)
    });
    return;
  }

  if (message.type === "set_video") {
    const videoUrl = sanitizeVideoUrl(message.videoUrl);
    if (!videoUrl) {
      send(socket, { type: "error", code: "bad_video_url", message: "请使用有效的 http/https 视频 URL。" });
      return;
    }

    room.setVideo(videoUrl);
    broadcastState(room, "video");
    return;
  }

  if (message.type === "control") {
    const action = String(message.action || "");
    if (!["play", "pause", "seek"].includes(action)) return;

    room.applyControl({
      action,
      currentTime: message.currentTime,
      isPlaying: message.isPlaying
    });
    broadcastState(room, action);
    return;
  }

  if (message.type === "chat") {
    const text = String(message.text || "").trim().slice(0, 500);
    if (!text) return;

    broadcast(room, {
      type: "chat",
      id: createId(6),
      memberId: member ? member.id : socket.id,
      name: member ? member.name : "观影伙伴",
      text,
      createdAt: Date.now()
    });
  }
}

function handleUpgrade(req, socket) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const roomId = normalizeRoomId(requestUrl.searchParams.get("room"));
  if (!roomId) {
    socket.destroy();
    return;
  }

  const room = getOrCreateRoom(roomId);
  if (room.members.size >= MAX_MEMBERS) {
    const accept = crypto
      .createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    send(socket, { type: "error", code: "room_full", message: "这个房间已经有两个人了。" });
    socket.end();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  socket.id = createId();
  socket.room = room;
  socket.buffer = Buffer.alloc(0);
  room.sockets = room.sockets || new Set();
  room.sockets.add(socket);

  const member = room.addMember(socket, requestUrl.searchParams.get("name"));
  const now = Date.now();

  send(socket, {
    type: "welcome",
    memberId: member.id,
    maxMembers: MAX_MEMBERS,
    serverNow: now,
    state: room.snapshot(now)
  });
  broadcastState(room, "presence");

  socket.on("data", (chunk) => {
    for (const message of decodeFrames(socket, chunk)) {
      handleClientMessage(socket, message);
    }
  });

  socket.on("close", () => {
    room.sockets.delete(socket);
    const departed = room.removeMember(socket.id);

    if (room.members.size === 0) {
      rooms.delete(room.id);
      return;
    }

    broadcast(room, {
      type: "system",
      text: `${departed ? departed.name : "观影伙伴"} 离开了房间。`,
      createdAt: Date.now()
    });
    broadcastState(room, "presence");
  });

  socket.on("error", () => {
    socket.destroy();
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, requestUrl);
    return;
  }

  serveStatic(req, res);
});
server.on("upgrade", handleUpgrade);

function start(port = PORT, callback) {
  return server.listen(port, () => {
    console.log(`Towwatch is running at http://localhost:${port}`);
    if (callback) callback();
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  DEFAULT_SOURCE_URL,
  DEFAULT_SOURCE_FALLBACK_URLS,
  MAX_MEMBERS,
  Room,
  fetchText,
  findSource,
  loadSourceBundle,
  parseEpisodes,
  publicSource,
  resolveEpisodeVideo,
  rooms,
  searchSource,
  server,
  start
};
