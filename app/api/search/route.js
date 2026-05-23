import { NextResponse } from "next/server";
import sourceService from "../../../src/server/source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const bundle = await sourceService.loadSourceBundle(searchParams.get("sourceUrl") || sourceService.DEFAULT_SOURCE_URL);
    const source = sourceService.findSource(bundle, searchParams.get("sourceId"));

    if (!source) {
      return NextResponse.json(
        { error: { code: "source_not_found", message: "Source not found." } },
        { status: 404 }
      );
    }

    const result = await sourceService.searchSource(bundle, source, searchParams.get("q"));
    return NextResponse.json({
      source: sourceService.publicSource(source),
      searchUrl: result.searchUrl,
      items: result.items
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "api_error", message: error.message || "搜索失败。" } },
      { status: 500 }
    );
  }
}
