import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const SUMMARY_INSTRUCTIONS: Record<string, string> = {
  brief: "Provide a concise 2-4 sentence summary focused on the core message.",
  detailed:
    "Write a detailed summary with key context, major points, and any conclusions.",
  bullets:
    "Summarize the content as clear bullet points, each capturing a main idea.",
  action: "List action items, decisions, and next steps as short bullet points.",
};

function splitIntoChunks(text: string, maxChars: number) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let buf = "";

  for (const p of paragraphs) {
    const next = buf ? `${buf}\n\n${p}` : p;
    if (next.length > maxChars && buf) {
      chunks.push(buf);
      buf = p;
      continue;
    }
    buf = next;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

async function callOpenAICompatible(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPUS_TIMEOUT_MS ?? 90_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(opts.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        stream: false,
        messages: opts.messages,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Opus request failed (${response.status}): ${raw || response.statusText}`
      );
    }

    const data = JSON.parse(raw) as {
      choices?: Array<{
        message?: { content?: string };
        text?: string;
      }>;
    };
    const content =
      data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text;
    if (!content?.trim()) throw new Error("Opus response missing content.");
    return content.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    const cause =
      err instanceof Error && "cause" in err
        ? (err as unknown as { cause?: unknown }).cause
        : undefined;
    if (cause && typeof cause === "object") {
      const anyCause = cause as { code?: string; message?: string };
      const extra = [anyCause.code, anyCause.message].filter(Boolean).join(" ");
      throw new Error(extra ? `${message} (${extra})` : message);
    }
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(opts: {
  url: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
}) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPUS_TIMEOUT_MS ?? 90_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": process.env.ANTHROPIC_VERSION ?? "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: Number(process.env.OPUS_MAX_TOKENS ?? 800),
        temperature: 0.2,
        system: opts.system,
        messages: [
          { role: "user", content: [{ type: "text", text: opts.user }] },
        ],
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Anthropic request failed (${response.status}): ${
          raw || response.statusText
        }`
      );
    }

    const data = JSON.parse(raw) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (!text?.trim()) throw new Error("Anthropic response missing text.");
    return text.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    const cause =
      err instanceof Error && "cause" in err
        ? (err as unknown as { cause?: unknown }).cause
        : undefined;
    if (cause && typeof cause === "object") {
      const anyCause = cause as { code?: string; message?: string };
      const extra = [anyCause.code, anyCause.message].filter(Boolean).join(" ");
      throw new Error(extra ? `${message} (${extra})` : message);
    }
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const { transcript, summaryType } = (await request.json()) as {
    transcript?: string;
    summaryType?: keyof typeof SUMMARY_INSTRUCTIONS;
  };

  if (!transcript?.trim()) {
    return NextResponse.json({ error: "Transcript is required." }, { status: 400 });
  }

  if (!process.env.OPUS_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPUS_API_KEY in environment." },
      { status: 500 }
    );
  }

  const provider =
    (process.env.OPUS_PROVIDER ?? "").toLowerCase() ||
    (process.env.OPUS_API_KEY.startsWith("sk-ant-") ? "anthropic" : "openai-compatible");

  const rawBaseUrl = process.env.OPUS_API_BASE_URL?.trim();
  const isPlaceholderUrl = !!rawBaseUrl && rawBaseUrl.includes("your-opus-provider");

  const instruction =
    SUMMARY_INSTRUCTIONS[summaryType ?? "brief"] ?? SUMMARY_INSTRUCTIONS.brief;

  try {
    const model =
      process.env.OPUS_MODEL ??
      (provider === "anthropic" ? "claude-opus-4-5-20251101" : "opus-4.5");
    const system =
      "You are a helpful assistant that summarizes transcripts accurately. Do not invent details.";

    const chunks = splitIntoChunks(transcript, 12_000);

    const openAICompatibleUrl = (() => {
      if (provider !== "openai-compatible") return undefined;
      if (!rawBaseUrl || isPlaceholderUrl) {
        throw new Error(
          "Missing OPUS_API_BASE_URL for openai-compatible provider. Set it to something like https://.../v1/chat/completions"
        );
      }
      return new URL(rawBaseUrl).toString();
    })();

    const anthropicUrl = (() => {
      if (provider !== "anthropic") return undefined;
      if (!rawBaseUrl || isPlaceholderUrl) return "https://api.anthropic.com/v1/messages";
      return new URL(rawBaseUrl).toString();
    })();

    const runOnce = async (user: string) => {
      return provider === "anthropic"
        ? callAnthropic({
            url: anthropicUrl!,
            apiKey: process.env.OPUS_API_KEY!,
            model,
            system,
            user,
          })
        : callOpenAICompatible({
            url: openAICompatibleUrl!,
            apiKey: process.env.OPUS_API_KEY!,
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          });
    };

    if (chunks.length === 1) {
      const summary = await runOnce(`${instruction}\n\nTranscript:\n${chunks[0]}`);
      return NextResponse.json({ summary });
    }

    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      partials.push(
        await runOnce(
          `Summarize chunk ${i + 1} of ${chunks.length}.\n\n${instruction}\n\nTranscript chunk:\n${chunks[i]}`
        )
      );
    }

    const final = await runOnce(
      `${instruction}\n\nHere are chunk summaries. Combine them into a single coherent result:\n\n${partials
        .map((s, i) => `Chunk ${i + 1} summary:\n${s}`)
        .join("\n\n")}`
    );

    return NextResponse.json({ summary: final });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to summarize transcript.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
