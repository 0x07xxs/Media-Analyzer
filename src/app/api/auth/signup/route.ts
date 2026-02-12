import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { initDatabase, createUser, getUserByEmail } from "@/lib/db";
import { hashPassword, setAuthCookie } from "@/lib/auth";

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
    const { email, password, name } = (await request.json()) as {
      email?: string;
      password?: string;
      name?: string;
    };

    // Validation
    if (!email?.trim()) {
      return NextResponse.json(
        { error: "Email is required." },
        { status: 400 }
      );
    }

    if (!password || password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    // Check if email already exists
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 }
      );
    }

    // Get visitor ID from cookie to transfer upload history
    const cookieStore = await cookies();
    const visitorId = cookieStore.get("visitor_id")?.value || undefined;

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const user = await createUser(email, passwordHash, name, visitorId);

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
    console.error("Signup error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to create account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
