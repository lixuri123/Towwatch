import { NextResponse } from "next/server";
import { loadWatchHistory } from "../../../src/server/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeRoomId(roomId) {
  return String(roomId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = normalizeRoomId(searchParams.get("roomId") || searchParams.get("room"));
    if (!roomId) {
      return NextResponse.json({ error: { code: "bad_request", message: "缺少房间号。" } }, { status: 400 });
    }

    const items = await loadWatchHistory(roomId);
    return NextResponse.json({ roomId, items });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "api_error", message: error.message || "读取观看历史失败。" } },
      { status: 500 }
    );
  }
}
