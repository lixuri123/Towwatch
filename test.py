import json
import re
from dataclasses import dataclass
from typing import List, Dict, Optional, Any
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


@dataclass
class Subject:
    name: str
    url: str


@dataclass
class Episode:
    name: str
    url: str
    sort_key: Optional[str] = None


@dataclass
class Channel:
    name: str
    episodes: List[Episode]


class WebSelectorParser:
    def __init__(self, config: Dict[str, Any], timeout: int = 15):
        self.config = config
        self.search_config = config["arguments"]["searchConfig"]
        self.session = requests.Session()
        self.timeout = timeout

        cookies_str = self.search_config.get("matchVideo", {}).get("cookies", "")
        if cookies_str:
            self._load_cookies_from_string(cookies_str)

    def _load_cookies_from_string(self, cookies_str: str) -> None:
        """
        支持类似: 'quality=1080; foo=bar'
        """
        for part in cookies_str.split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            k, v = part.split("=", 1)
            self.session.cookies.set(k.strip(), v.strip())

    def _get(self, url: str) -> requests.Response:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
            )
        }
        resp = self.session.get(url, headers=headers, timeout=self.timeout)
        resp.raise_for_status()
        return resp

    def _soup(self, html: str) -> BeautifulSoup:
        return BeautifulSoup(html, "lxml")

    def build_search_url(self, keyword: str) -> str:
        url = self.search_config["searchUrl"]
        if self.search_config.get("searchUseOnlyFirstWord", False):
            keyword = keyword.strip().split()[0]
        return url.replace("{keyword}", keyword)

    def search_subjects(self, keyword: str) -> List[Subject]:
        """
        用 CSS 选择器从搜索页提取作品列表
        """
        search_url = self.build_search_url(keyword)
        resp = self._get(search_url)
        soup = self._soup(resp.text)

        subject_format_id = self.search_config.get("subjectFormatId")
        if subject_format_id != "a":
            raise NotImplementedError("当前示例仅实现 subjectFormatId='a'")

        selector_cfg = self.search_config["selectorSubjectFormatA"]
        css = selector_cfg["selectLists"]
        nodes = soup.select(css)

        subjects = []
        for node in nodes:
            href = node.get("href", "").strip()
            name = node.get("title", "").strip() or node.get_text(" ", strip=True)

            if not href:
                continue
            abs_url = urljoin(resp.url, href)
            if not name:
                name = abs_url

            subjects.append(Subject(name=name, url=abs_url))
        return subjects

    def get_channels_and_episodes(self, detail_url: str) -> List[Channel]:
        """
        从详情页提取线路和剧集
        这里实现的是最常见的“按索引对应”方式：
        - 先取所有线路名节点
        - 再取所有线路对应的剧集列表节点
        - names[i] 对应 episode_lists[i]
        """
        resp = self._get(detail_url)
        soup = self._soup(resp.text)

        if self.search_config.get("channelFormatId") != "index-grouped":
            raise NotImplementedError("当前示例仅实现 channelFormatId='index-grouped'")

        cfg = self.search_config["selectorChannelFormatFlattened"]
        channel_name_css = cfg["selectChannelNames"]
        episode_list_css = cfg["selectEpisodeLists"]
        episode_css = cfg["selectEpisodesFromList"]
        match_channel_name = cfg.get("matchChannelName", "")
        match_ep_sort = cfg.get("matchEpisodeSortFromName", "")

        channel_name_nodes = soup.select(channel_name_css)
        episode_list_nodes = soup.select(episode_list_css)

        channel_name_re = re.compile(match_channel_name) if match_channel_name else None
        ep_sort_re = re.compile(match_ep_sort) if match_ep_sort else None

        channels: List[Channel] = []

        count = min(len(channel_name_nodes), len(episode_list_nodes))
        for i in range(count):
            raw_channel_name = channel_name_nodes[i].get_text(" ", strip=True)
            if not raw_channel_name:
                raw_channel_name = f"线路{i+1}"

            channel_name = raw_channel_name
            if channel_name_re:
                m = channel_name_re.search(raw_channel_name)
                if not m:
                    continue
                if "ch" in m.groupdict() and m.group("ch"):
                    channel_name = m.group("ch")
                else:
                    channel_name = m.group(0)

            ep_list_node = episode_list_nodes[i]
            ep_nodes = ep_list_node.select(episode_css)

            episodes: List[Episode] = []
            for ep_node in ep_nodes:
                ep_name = ep_node.get_text(" ", strip=True)
                ep_href = ep_node.get("href", "").strip()
                if not ep_href:
                    continue

                sort_key = None
                if ep_sort_re:
                    m = ep_sort_re.search(ep_name)
                    if m and "ep" in m.groupdict():
                        sort_key = m.group("ep")

                episodes.append(
                    Episode(
                        name=ep_name,
                        url=urljoin(resp.url, ep_href),
                        sort_key=sort_key,
                    )
                )

            channels.append(Channel(name=channel_name, episodes=episodes))

        return channels

    def extract_video_candidates(self, page_url: str) -> List[str]:
        """
        从页面源码文本中，按正则提取视频候选链接
        这里只是“匹配候选”，不做站点专属解密/反混淆
        """
        resp = self._get(page_url)
        text = resp.text

        match_video_cfg = self.search_config.get("matchVideo", {})
        pattern = match_video_cfg.get("matchVideoUrl")
        if not pattern:
            return []

        video_re = re.compile(pattern)
        found = []

        for m in video_re.finditer(text):
            # 优先取命名组 v，否则取整体匹配
            if "v" in m.groupdict() and m.group("v"):
                url = m.group("v")
            else:
                url = m.group(0)

            url = self._cleanup_candidate(url)
            if url and url not in found:
                found.append(url)

        return found

    @staticmethod
    def _cleanup_candidate(url: str) -> str:
        # 清理一些常见前缀
        if url.startswith("url="):
            url = url[4:]
        return url.strip().strip('"').strip("'")

    def get_video_request_headers(self) -> Dict[str, str]:
        """
        播放视频时可能需要的附加请求头
        """
        cfg = self.search_config.get("matchVideo", {}).get("addHeadersToVideo", {})
        headers = {}
        referer = cfg.get("referer", "")
        if referer:
            headers["Referer"] = referer
        return headers


def demo_main():
    # 这里放“通用格式”的配置
    source_config = {
        "factoryId": "web-selector",
        "version": 2,
        "arguments": {
            "name": "示例源",
            "searchConfig": {
                "searchUrl": "https://www.aafun.cc/feng-s.html?wd={keyword}&submit=",
                "searchUseOnlyFirstWord": True,
                "subjectFormatId": "a",
                "selectorSubjectFormatA": {
                    "selectLists": "a.item-link",
                    "preferShorterName": True
                },
                "channelFormatId": "index-grouped",
                "selectorChannelFormatFlattened": {
                    "selectChannelNames": ".tabs .tab",
                    "matchChannelName": "^(?<ch>.+)$",
                    "selectEpisodeLists": ".episode-group",
                    "selectEpisodesFromList": "a",
                    "selectEpisodeLinksFromList": "",
                    "matchEpisodeSortFromName": "第\\s*(?<ep>.+)\\s*[话集]"
                },
                "defaultResolution": "1080P",
                "defaultSubtitleLanguage": "CHS",
                "onlySupportsPlayers": [],
                "selectMedia": {
                    "distinguishSubjectName": True,
                    "distinguishChannelName": True
                },
                "matchVideo": {
                    "enableNestedUrl": True,
                    "matchNestedUrl": "$^",
                    "matchVideoUrl": r'(^https?:\/\/(?!.*http).+\.(mp4|m3u8|flv|mkv))|(url=(?P<v>https?:\/\/.+\.(mp4|m3u8|flv|mkv)))',
                    "cookies": "",
                    "addHeadersToVideo": {
                        "referer": ""
                    }
                }
            },
            "tier": 1
        }
    }

    parser = WebSelectorParser(source_config)

    keyword = "灵能百分百"
    print(f"搜索关键词: {keyword}")
    print("1) 调用 search_subjects(keyword)")
    subjects = parser.search_subjects(keyword)
    print(f"找到 {len(subjects)} 个相关作品:")



if __name__ == "__main__":
    demo_main()