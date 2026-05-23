import { NextResponse } from "next/server";
import sourceService from "../../../src/server/source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const bundle = await sourceService.loadSourceBundle(searchParams.get("sourceUrl") || sourceService.DEFAULT_SOURCE_URL);
    const source = sourceService.findSource(bundle, searchParams.get("sourceId"));
    const pageUrl = sanitizeHttpUrl(searchParams.get("url"));

    if (!source || !pageUrl) {
      return NextResponse.json(
        { error: { code: "bad_episode_request", message: "Source and page URL are required." } },
        { status: 400 }
      );
    }

    const html = await sourceService.fetchText(pageUrl);
    return NextResponse.json({
      source: sourceService.publicSource(source),
      pageUrl,
      episodes: sourceService.parseEpisodes(html, source, pageUrl)
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "api_error", message: error.message || "读取剧集失败。" } },
      { status: 500 }
    );
  }
}
