// =============================================================================
// src/nlp.worker.js
// NLP engine running in a dedicated Web Worker thread.
//
// WHY A WORKER AT ALL?
// JavaScript is single-threaded. The NER model inference takes 200–800ms.
// If this ran on the main thread, React's rendering loop would freeze for
// that entire duration on every call — the UI would visibly stutter.
// Workers run on a separate OS thread, so the main thread stays smooth
// at 60fps while this file does all the heavy lifting in the background.
// =============================================================================

import { pipeline, env } from "@xenova/transformers";

// ---------------------------------------------------------------------------
// WORKER ENVIRONMENT CONFIGURATION
// ---------------------------------------------------------------------------

// WHY disable local model check:
// By default, Transformers.js first looks for a model in a local cache,
// then falls back to the HuggingFace CDN. In a Vite dev environment the
// local path resolution can silently fail and produce a confusing error.
// Setting this to false tells it: "always use the remote CDN." In
// production you'd want caching — but for a hackathon demo, reliability
// beats the ~2s saved on repeat loads.
env.allowLocalModels = false;

// WHY set the remote host explicitly:
// Newer Transformers.js (2.x) changed the default CDN endpoint. Pinning
// it here future-proofs the worker against CDN migration changes that
// would otherwise break silently at the worst possible moment.
env.remoteHost = "https://huggingface.co";
env.remotePathTemplate = "{model}/resolve/{revision}/";

// ---------------------------------------------------------------------------
// SINGLETON PIPELINE — loaded once, reused forever
// ---------------------------------------------------------------------------

// WHY a module-level variable (not inside the message handler):
// The NER pipeline is expensive to initialize — it downloads ~85MB of
// model weights and compiles a WebAssembly module. We do this ONCE and
// store the resulting pipeline function here. Every subsequent call to
// the worker just invokes this function — which takes ~200ms, not ~5s.
let nerPipeline = null;

// Track whether we're currently processing an inference.
// WHY: The main thread might send messages faster than we can process them
// (before the throttle is fully tuned, or during demo mode). This flag
// ensures we never run two inferences in parallel — which would corrupt
// the shared pipeline state and produce garbage output.
let isProcessing = false;

// ---------------------------------------------------------------------------
// HELPER: Normalize NER output into clean, typed entities
// ---------------------------------------------------------------------------

/**
 * Transforms raw Transformers.js NER output into the shape our D3 graph needs.
 *
 * Raw output from the pipeline looks like:
 *   [{ word: "##ris", entity: "I-PER", score: 0.99, index: 3 }, ...]
 *
 * Problems we solve here:
 *   1. WordPiece tokenization splits "Paris" into ["Par", "##is"] — we must
 *      rejoin tokens that share a consecutive entity span.
 *   2. B- / I- / O- prefix notation (BIO tagging) marks span boundaries —
 *      B- = Beginning of entity, I- = Inside entity, O- = Outside (ignore).
 *      We use this to know when one entity ends and a new one starts.
 *   3. Low-confidence predictions (< 0.75) are noisy and should be dropped.
 *   4. Very short tokens (1–2 chars) are usually tokenization artifacts.
 *
 * @param {Array} rawEntities  - Direct output from nerPipeline()
 * @returns {Array<{id, label, group, score}>} - Clean node-ready objects
 */
function normalizeEntities(rawEntities) {
  if (!rawEntities || rawEntities.length === 0) return [];

  const merged = [];
  let current = null;

  for (const token of rawEntities) {
    const { word, entity, score } = token;

    // Discard low-confidence predictions.
    // WHY 0.75 threshold: empirically, BERT-NER on conversational speech
    // produces a lot of "maybe" predictions at 0.5–0.74 (common words
    // mistaken for proper nouns). Above 0.75, precision improves sharply.
    if (score < 0.75) continue;

    // Parse BIO prefix and entity type from strings like "B-PER", "I-LOC"
    const dashIndex = entity.indexOf("-");
    const bio  = dashIndex !== -1 ? entity.slice(0, dashIndex) : "B";
    const type = dashIndex !== -1 ? entity.slice(dashIndex + 1) : entity;

    // Ignore "Outside" tokens — they're not named entities
    if (type === "O") {
      current = null;
      continue;
    }

    const isWordpieceContinuation = word.startsWith("##");
    const isInsideSpan = bio === "I" && current && current.type === type;

    if (isInsideSpan || isWordpieceContinuation) {
      // Continue building the current entity span.
      // WHY strip "##": WordPiece uses ## to mark subword tokens.
      // "##is" should become "is" when rejoined with "Par" → "Paris".
      if (current) {
        current.label += isWordpieceContinuation
          ? word.slice(2)   // strip "##", no space
          : " " + word;     // new word in span, add space
        // Track the highest confidence score across the span
        current.score = Math.max(current.score, score);
      }
    } else {
      // Beginning of a new entity span — save the previous one first
      if (current) merged.push(current);
      current = { label: word, type, score };
    }
  }

  // Don't forget the last entity (loop ends before it's pushed)
  if (current) merged.push(current);

  // Final cleanup and deduplication
  const seen = new Set();
  return merged
    .filter(e => {
      const clean = e.label.trim();
      // Filter out short artifacts and duplicates (case-insensitive)
      const key = clean.toLowerCase();
      if (clean.length <= 2 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(e => ({
      // Stable ID: lowercase, spaces-to-hyphens
      // WHY: D3 uses this as a key in its data join. It must be stable
      // across re-renders. Using the raw label (with casing or spaces)
      // would create duplicate nodes for "Paris" vs "paris".
      id:    e.label.trim().toLowerCase().replace(/\s+/g, "-"),
      label: e.label.trim(),
      group: e.type,   // "PER" | "LOC" | "ORG" | "MISC"
      score: parseFloat(e.score.toFixed(3)),
    }));
}

// ---------------------------------------------------------------------------
// HELPER: Send a typed message back to the main thread
// ---------------------------------------------------------------------------

/**
 * Centralized postMessage wrapper.
 * WHY: Having one place to format outgoing messages makes the contract
 * between this worker and the main thread explicit and easy to change.
 * It also prevents typos in status strings ("progres" vs "progress").
 */
function send(type, payload) {
  self.postMessage({ type, ...payload });
}

// ---------------------------------------------------------------------------
// PIPELINE INITIALIZER — called once on first use
// ---------------------------------------------------------------------------

/**
 * Downloads and compiles the NER model, streaming progress back to the UI.
 *
 * WHY stream progress?
 * The model file is ~85MB. On a 50Mbps connection that's ~14 seconds.
 * Without a progress signal, the judge sees a frozen UI and assumes the
 * app is broken. With a progress bar, they see "Loading AI model: 67%"
 * and understand it's working. This single UX touch saves the demo.
 */
async function initPipeline() {
  nerPipeline = await pipeline(
    "token-classification",   // The NLP task — token-level classification

    // WHY this specific model:
    // "bert-base-NER" is a BERT model fine-tuned on the CoNLL-2003 NER
    // dataset. It recognises PER/LOC/ORG/MISC entities. The Xenova/
    // prefix is the Transformers.js-compatible quantised port — ~4x
    // smaller than the original PyTorch model with minimal accuracy loss.
    "Xenova/bert-base-NER",

    {
      // WHY aggregation_strategy "simple":
      // Without this, the pipeline returns raw per-token predictions,
      // including all the B-/I- fragments and ##wordpiece tokens we'd
      // have to manually rejoin. With "simple", it merges adjacent tokens
      // of the same entity type — we still do our own merging above for
      // edge cases, but this handles the common case cleanly.
      aggregation_strategy: "simple",

      // Progress callback — fires for every chunk of the model download
      progress_callback: (progressData) => {
        // progressData shape: { status, name, file, progress, loaded, total }
        // "status" can be: "initiate" | "download" | "done" | "ready"
        if (progressData.status === "download" || progressData.status === "progress") {
          send("progress", {
            // Math.round prevents "67.000001%" flickering in the UI
            percent: Math.round(progressData.progress ?? 0),
            file:    progressData.file ?? "model weights",
          });
        }
        if (progressData.status === "ready") {
          send("ready", { message: "NER model ready" });
        }
      },
    }
  );
}

// ---------------------------------------------------------------------------
// MAIN MESSAGE HANDLER
// ---------------------------------------------------------------------------

/**
 * The worker's event loop. The main thread sends messages here.
 *
 * Expected incoming message shapes:
 *   { type: "init" }                      — Pre-warm the pipeline
 *   { type: "analyze", text: string }     — Run NER on this text
 *
 * WHY separate "init" from "analyze":
 * The main thread can send "init" as soon as the app loads (before the
 * user even clicks the mic), giving the model ~14s to download in the
 * background. If we waited until the first "analyze" call, the user
 * would click Start and then wait 14 seconds with a frozen graph.
 */
self.onmessage = async ({ data }) => {
  const { type, text } = data;

  // ── INIT: pre-warm the model ──────────────────────────────────────────────
  if (type === "init") {
    try {
      send("status", { message: "Downloading NER model…" });
      await initPipeline();
      // "ready" is also sent inside the progress_callback above,
      // but we send it here too in case the callback fires before
      // the pipeline() Promise resolves (race condition in some versions).
      send("ready", { message: "NER model ready" });
    } catch (err) {
      send("error", { message: `Model init failed: ${err.message}` });
    }
    return;
  }

  // ── ANALYZE: run NER on incoming text ────────────────────────────────────
  if (type === "analyze") {
    // Guard: drop the message if we're still processing the previous one.
    // WHY: Running two inferences concurrently on the same pipeline singleton
    // is undefined behaviour in Transformers.js — it can corrupt the WASM
    // heap. Better to skip one batch than to crash the worker.
    if (isProcessing) {
      send("skipped", { reason: "Worker busy — batch dropped safely" });
      return;
    }

    // Guard: don't attempt inference if the model isn't loaded yet.
    if (!nerPipeline) {
      try {
        send("status", { message: "Model not ready — initializing now…" });
        await initPipeline();
      } catch (err) {
        send("error", { message: `Late init failed: ${err.message}` });
        return;
      }
    }

    isProcessing = true;

    try {
      // Sanitize input: NER models degrade on very long inputs.
      // WHY 512 chars: BERT has a hard limit of 512 WordPiece tokens.
      // Characters aren't tokens (ratio ~3:1 on average English text),
      // so 512 chars ≈ 170 tokens — well within the safe zone, and fast.
      // We take the LAST 512 chars because the most recent speech is
      // the most relevant for the current graph update.
      const safeText = text.slice(-512).trim();

      if (safeText.length < 3) {
        send("result", { entities: [] });
        return;
      }

      // Run the NER pipeline. This is the expensive call.
      const raw = await nerPipeline(safeText);

      // Normalize the raw output into clean D3-ready node objects
      const entities = normalizeEntities(raw);

      send("result", { entities });

    } catch (err) {
      // WHY catch and send instead of throw:
      // An unhandled exception in a Worker terminates the entire worker
      // process. The next message from the main thread would then hang
      // forever waiting for a reply that never comes. By catching here
      // and sending an error message, the worker stays alive and the
      // main thread can show a graceful warning.
      send("error", { message: `NER failed: ${err.message}`, stack: err.stack });
    } finally {
      // ALWAYS clear the processing flag, even if inference threw.
      // WHY finally: if we used an if/else and the catch block returned
      // early, isProcessing would stay true forever — deadlocking the worker.
      isProcessing = false;
    }
  }
};