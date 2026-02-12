import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { initDatabase } from "@/lib/db";

export const runtime = "nodejs";

let dbInitialized = false;

export async function GET() {
  // Initialize database
  if (!dbInitialized) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (err) {
      console.error("Database init failed:", err);
      return NextResponse.json(
        { error: "Database connection failed." },
        { status: 500 }
      );
    }
  }

  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json({ user: null });
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        uploadCount: user.uploadCount,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    return NextResponse.json({ user: null });
  }
}
