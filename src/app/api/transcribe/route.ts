import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import OpenAI, { toFile } from "openai";
import ffmpeg from "fluent-ffmpeg";
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  initDatabase,
  getOrCreateVisitor,
  canUpload,
  incrementUpload,
  incrementUserUpload,
  FREE_UPLOAD_LIMIT,
} from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 900;

let dbInitialized = false;

const require = createRequire(import.meta.url);

async function firstAccessiblePath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveFfmpegBinary() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  // 1) Most reliable in Next dev on Windows: real project root node_modules.
  const cwdCandidate = path.join(process.cwd(), "node_modules", "ffmpeg-static", exe);

  // 2) Fallback: resolve package.json then join (may be virtualized by bundler).
  const pkgJson = require.resolve("ffmpeg-static/package.json");
  const pkgRoot = path.dirname(pkgJson);
  const pkgCandidate = path.join(pkgRoot, exe);

  const found = await firstAccessiblePath([cwdCandidate, pkgCandidate]);
  if (found) return found;

  throw new Error(
    `ffmpeg binary not found. Tried:\n- ${cwdCandidate}\n- ${pkgCandidate}`
  );
}

async function resolveFfprobeBinary() {
  // ffprobe-static layout: bin/<platform>/<arch>/ffprobe(.exe)
  const exe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

  const cwdCandidate = path.join(
    process.cwd(),
    "node_modules",
    "ffprobe-static",
    "bin",
    process.platform,
    process.arch,
    exe
  );

  const pkgJson = require.resolve("ffprobe-static/package.json");
  const pkgRoot = path.dirname(pkgJson);
  const pkgCandidate = path.join(
    pkgRoot,
    "bin",
    process.platform,
    process.arch,
    exe
  );

  const found = await firstAccessiblePath([cwdCandidate, pkgCandidate]);
  if (found) return found;

  throw new Error(
    `ffprobe binary not found. Tried:\n- ${cwdCandidate}\n- ${pkgCandidate}`
  );
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function splitTextByNewlines(text: string, maxChars: number) {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let buf = "";

  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > maxChars && buf) {
      chunks.push(buf);
      buf = line;
      continue;
    }
    buf = next;
  }

  if (buf.trim()) chunks.push(buf);
  return chunks;
}

async function segmentAudioFromVideo(opts: {
  inputPath: string;
  outDir: string;
  segmentSeconds: number;
}) {
  // Ensure ffmpeg binaries are correctly resolved at runtime (Windows-safe).
  ffmpeg.setFfmpegPath(await resolveFfmpegBinary());
  ffmpeg.setFfprobePath(await resolveFfprobeBinary());

  const pattern = path.join(opts.outDir, "chunk-%03d.mp3");

  await new Promise<void>((resolve, reject) => {
    ffmpeg(opts.inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate("64k")
      .format("segment")
      .outputOptions([
        "-segment_time",
        String(opts.segmentSeconds),
        "-reset_timestamps",
        "1",
      ])
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .save(pattern);
  });

  const entries = await fs.readdir(opts.outDir);
  const files = entries
    .filter((name) => name.startsWith("chunk-") && name.endsWith(".mp3"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(opts.outDir, name));

  return files;
}

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY in environment." },
      { status: 500 }
    );
  }

  // Initialize database on first request
  if (!dbInitialized) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (dbError) {
      console.error("Database init failed:", dbError);
      return NextResponse.json(
        { error: "Database connection failed." },
        { status: 500 }
      );
    }
  }

  // Check if user is logged in (authenticated users have unlimited uploads)
  let loggedInUserId: string | null = null;
  try {
    loggedInUserId = await getCurrentUserId();
  } catch {
    // Not logged in, continue as visitor
  }

  // For non-logged-in users, check visitor limits
  const cookieStore = await cookies();
  const visitorCookie = cookieStore.get("visitor_id")?.value || null;
  const fingerprint = request.headers.get("x-fingerprint") || null;

  let visitor: { id: string; uploadCount: number; isNew: boolean } | null = null;

  if (!loggedInUserId) {
    // Look up or create visitor
    try {
      visitor = await getOrCreateVisitor(visitorCookie, fingerprint);
    } catch (dbError) {
      console.error("Visitor lookup failed:", dbError);
      return NextResponse.json(
        { error: "Database error." },
        { status: 500 }
      );
    }

    // Check usage limit for visitors only
    const usage = await canUpload(visitor.id);
    if (!usage.allowed) {
      const response = NextResponse.json(
        {
          error: "limit_reached",
          message: `You've used all ${FREE_UPLOAD_LIMIT} free uploads. Create an account to continue.`,
          used: usage.used,
          remaining: 0,
        },
        { status: 403 }
      );
      // Still set cookie for new visitors even when blocked
      if (visitor.isNew) {
        response.cookies.set("visitor_id", visitor.id, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 60 * 60 * 24 * 365, // 1 year
        });
      }
      return response;
    }
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "No video file provided." },
      { status: 400 }
    );
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_AUDIO_MODEL ?? "whisper-1";
    const segmentSeconds = Number(process.env.TRANSCRIBE_CHUNK_SECONDS ?? 600);

    const tmpRoot = path.join(os.tmpdir(), "video-transcriber");
    const jobDir = path.join(tmpRoot, crypto.randomUUID());
    const videoPath = path.join(jobDir, file.name || "upload");
    const audioDir = path.join(jobDir, "audio");

    await fs.mkdir(audioDir, { recursive: true });
    await fs.writeFile(videoPath, Buffer.from(await file.arrayBuffer()));

    let transcriptParts: string[] = [];

    // Prefer chunked transcription for long videos.
    const chunkFiles = await segmentAudioFromVideo({
      inputPath: videoPath,
      outDir: audioDir,
      segmentSeconds: Number.isFinite(segmentSeconds) ? segmentSeconds : 600,
    });

    if (chunkFiles.length === 0) {
      throw new Error("Failed to extract audio chunks from the video.");
    }

    for (const chunkPath of chunkFiles) {
      const chunkBuffer = await fs.readFile(chunkPath);
      const upload = await toFile(chunkBuffer, path.basename(chunkPath), {
        type: "audio/mpeg",
      });
      const transcription = await client.audio.transcriptions.create({
        file: upload,
        model,
      });
      if (transcription.text?.trim()) transcriptParts.push(transcription.text);
    }

    const combined = transcriptParts.join("\n\n").trim();
    const finalTranscript = combined || "No transcript text was produced.";

    // Safety: some models can return extremely large text; keep it manageable.
    const safeTranscript = splitTextByNewlines(finalTranscript, 200_000).join(
      "\n\n"
    );

    // Cleanup (best-effort).
    try {
      if (await pathExists(jobDir)) {
        await fs.rm(jobDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }

    // Increment upload count after successful transcription
    let responseData: { transcript: string; used?: number; remaining?: number; unlimited?: boolean };

    if (loggedInUserId) {
      // Logged-in user: unlimited uploads, just track count
      const newCount = await incrementUserUpload(loggedInUserId);
      responseData = {
        transcript: safeTranscript,
        used: newCount,
        unlimited: true,
      };
    } else if (visitor) {
      // Visitor: limited uploads
      const newCount = await incrementUpload(visitor.id);
      const remaining = Math.max(0, FREE_UPLOAD_LIMIT - newCount);
      responseData = {
        transcript: safeTranscript,
        used: newCount,
        remaining,
      };
    } else {
      responseData = { transcript: safeTranscript };
    }

    const response = NextResponse.json(responseData);

    // Set cookie for new visitors
    if (visitor?.isNew) {
      response.cookies.set("visitor_id", visitor.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365, // 1 year
      });
    }

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to transcribe video.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
