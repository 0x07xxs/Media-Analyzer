import { NextResponse } from "next/server";
import { initDatabase, getUserByEmail, updateLastLogin } from "@/lib/db";
import { verifyPassword, setAuthCookie } from "@/lib/auth";

export const runtime = "nodejs";

let dbInitialized = false;

export async function POST(request: Request) {
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
    const { email, password } = (await request.json()) as {
      email?: string;
      password?: string;
    };

    // Validation
    if (!email?.trim() || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    // Find user
    const user = await getUserByEmail(email);
    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    // Update last login
    await updateLastLogin(user.id);

    // Set auth cookie
    await setAuthCookie(user.id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to log in.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
