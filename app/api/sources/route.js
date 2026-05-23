import { NextResponse } from "next/server";
import sourceService from "../../../src/server/source-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const bundle = await sourceService.loadSourceBundle(searchParams.get("url") || sourceService.DEFAULT_SOURCE_URL);

    return NextResponse.json({
      sourceUrl: bundle.sourceUrl,
      count: bundle.sources.length,
      sources: bundle.sources.map(sourceService.publicSource)
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "api_error", message: error.message || "加载源失败。" } },
      { status: 500 }
    );
  }
}
