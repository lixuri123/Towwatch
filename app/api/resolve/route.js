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
    const episodeUrl = sanitizeHttpUrl(searchParams.get("url"));
    const debug = searchParams.get("debug") === "1";
    const trace = [];

    if (!source || !episodeUrl) {
      return NextResponse.json(
        { error: { code: "bad_resolve_request", message: "Source and episode URL are required." } },
        { status: 400 }
      );
    }

    const videoUrl = await sourceService.resolveEpisodeVideo(source, episodeUrl, {
      trace: debug ? trace : null
    });

    if (!videoUrl) {
      return NextResponse.json(
        {
          error: {
            code: "video_not_found",
            message: "未解析到可播放地址，请切换源或换一个搜索结果。"
          },
          source: sourceService.publicSource(source),
          episodeUrl,
          ...(debug ? { trace } : {})
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      source: sourceService.publicSource(source),
      episodeUrl,
      videoUrl,
      ...(debug ? { trace } : {})
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "api_error", message: error.message || "解析播放地址失败。" } },
      { status: 500 }
    );
  }
}
