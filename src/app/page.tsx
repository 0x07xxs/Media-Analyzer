"use client";

import { useEffect, useMemo, useState } from "react";
import { getFingerprint } from "@/lib/fingerprint";

type SummaryOption = {
  id: "brief" | "detailed" | "bullets" | "action";
  label: string;
  helper: string;
};

const SUMMARY_OPTIONS: SummaryOption[] = [
  {
    id: "brief",
    label: "Brief overview",
    helper: "2-4 sentences capturing the core message.",
  },
  {
    id: "detailed",
    label: "Detailed summary",
    helper: "Multi-paragraph summary with key context.",
  },
  {
    id: "bullets",
    label: "Bullet points",
    helper: "Clear bullet list of the main takeaways.",
  },
  {
    id: "action",
    label: "Action items",
    helper: "Actionable tasks and decisions highlighted.",
  },
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [summaryType, setSummaryType] =
    useState<SummaryOption["id"]>("brief");
  const [status, setStatus] = useState<
    "idle" | "transcribing" | "summarizing"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  // Load fingerprint silently on mount
  useEffect(() => {
    getFingerprint().then(setFingerprint).catch(() => {});
  }, []);

  const isBusy = status !== "idle";
  const statusLabel = useMemo(() => {
    if (status === "transcribing") return "Transcribing video…";
    if (status === "summarizing") return "Summarizing with Opus 4.5…";
    if (remaining !== null && remaining > 0) {
      return `Ready to transcribe · ${remaining} free upload${remaining === 1 ? "" : "s"} remaining`;
    }
    return "Ready to transcribe";
  }, [status, remaining]);

  const selectedOption = SUMMARY_OPTIONS.find(
    (option) => option.id === summaryType
  );

  const handleSubmit = async () => {
    if (!file) {
      setError("Please upload a video first.");
      return;
    }

    if (limitReached) {
      return;
    }

    setError("");
    setTranscript("");
    setSummary("");
    setStatus("transcribing");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const headers: Record<string, string> = {};
      if (fingerprint) {
        headers["x-fingerprint"] = fingerprint;
      }

      const transcribeResponse = await fetch("/api/transcribe", {
        method: "POST",
        headers,
        body: formData,
      });

      if (!transcribeResponse.ok) {
        const body = await transcribeResponse.json().catch(() => ({}));
        
        // Handle limit reached specially
        if (body.error === "limit_reached") {
          setLimitReached(true);
          setRemaining(0);
          return;
        }
        
        throw new Error(body.message || body.error || "Transcription failed.");
      }

      const transcribePayload = (await transcribeResponse.json()) as {
        transcript: string;
        remaining?: number;
        used?: number;
      };

      setTranscript(transcribePayload.transcript);
      
      // Update remaining count
      if (typeof transcribePayload.remaining === "number") {
        setRemaining(transcribePayload.remaining);
        if (transcribePayload.remaining === 0) {
          setLimitReached(true);
        }
      }

      setStatus("summarizing");

      const summaryResponse = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcribePayload.transcript,
          summaryType,
        }),
      });

      if (!summaryResponse.ok) {
        const body = await summaryResponse.json().catch(() => ({}));
        throw new Error(body.error || "Summary failed.");
      }

      const summaryPayload = (await summaryResponse.json()) as {
        summary: string;
      };
      setSummary(summaryPayload.summary);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong."
      );
    } finally {
      setStatus("idle");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Minimal Video Transcriber
          </span>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Upload a video, transcribe it, and summarize with Opus 4.5.
          </h1>
          <p className="max-w-2xl text-base leading-7 text-zinc-600">
            This tool focuses on speed and clarity. Drop a video file, choose a
            summary style, and get a transcript plus a tailored summary.
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-zinc-700">
                  Video file
                </label>
                <input
                  type="file"
                  accept="video/*"
                  className="w-full rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-sm text-zinc-600 file:mr-4 file:rounded-full file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-zinc-800"
                  onChange={(event) =>
                    setFile(event.target.files?.[0] ?? null)
                  }
                  disabled={isBusy}
                />
                <p className="text-xs text-zinc-500">
                  MP4, MOV, MKV, or any video format your browser supports.
                </p>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium text-zinc-700">
                  Summary style
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {SUMMARY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setSummaryType(option.id)}
                      disabled={isBusy}
                      className={`rounded-xl border px-4 py-3 text-left transition ${
                        summaryType === option.id
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
                      }`}
                    >
                      <p className="text-sm font-semibold">{option.label}</p>
                      <p
                        className={`text-xs ${
                          summaryType === option.id
                            ? "text-zinc-200"
                            : "text-zinc-500"
                        }`}
                      >
                        {option.helper}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-zinc-600">{statusLabel}</div>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isBusy || !file || limitReached}
                  className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                >
                  {limitReached
                    ? "Limit reached"
                    : isBusy
                    ? "Working..."
                    : "Transcribe & Summarize"}
                </button>
              </div>

              {limitReached ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm">
                  <p className="font-semibold text-amber-800">
                    You&apos;ve used all 10 free uploads
                  </p>
                  <p className="mt-1 text-amber-700">
                    Create an account to continue transcribing videos.
                  </p>
                  <button
                    type="button"
                    className="mt-3 rounded-full bg-amber-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-amber-700"
                    onClick={() => {
                      // TODO: Navigate to signup page
                      alert("Sign up flow coming soon!");
                    }}
                  >
                    Create free account
                  </button>
                </div>
              ) : error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}
            </div>
          </div>

          <aside className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-2">
              <h2 className="text-base font-semibold text-zinc-900">
                Current selection
              </h2>
              <p className="text-sm text-zinc-600">
                {selectedOption?.label}
              </p>
              <p className="text-xs text-zinc-500">
                {selectedOption?.helper}
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
              Output is generated from your transcript and summarized by Opus
              4.5. Configure API keys in <code>.env.local</code>.
            </div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Transcript</h2>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(transcript || "")
                }
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-700"
                disabled={!transcript}
              >
                Copy
              </button>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-zinc-600">
              {transcript || "Your transcript will appear here."}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Summary</h2>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(summary || "")
                }
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-700"
                disabled={!summary}
              >
                Copy
              </button>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-zinc-600">
              {summary || "Your summary will appear here."}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
