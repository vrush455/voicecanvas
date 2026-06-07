// =============================================================================
// src/hooks/useSpeechRecognition.js
//
// A production-hardened React hook that wraps the Web Speech API and
// implements a dual-trigger throttle buffer before dispatching to the
// NLP Worker.
//
// THE CORE PROBLEM THIS SOLVES (essential for your Q&A):
// -------------------------------------------------------
// The Web Speech API fires onresult events roughly 8–12 times per second
// while you're talking. Each event carries the entire transcript so far,
// not just new words. If we sent every event to the NLP Worker:
//
//   Event 1: "The climate"          → Worker call #1
//   Event 2: "The climate is"       → Worker call #2  (still processing #1!)
//   Event 3: "The climate is chang" → Worker call #3  (queue building up...)
//   ...12 events per second...
//
// The worker can only process one request at a time (~400ms each).
// After 3 seconds you'd have a queue of ~36 pending calls.
// They'd resolve out of order. D3 would receive contradictory graph updates.
// The app would crash or produce garbage.
//
// THE SOLUTION — Dual-Trigger Buffer:
// ------------------------------------
// We accumulate incoming tokens in a local buffer string.
// We only flush that buffer (dispatch to the worker) when EITHER:
//   A) 1,500ms have passed since the last dispatch (time-based throttle)
//   B) A sentence-ending pause is detected (punctuation heuristic)
//
// This limits worker calls to at most ~40/minute instead of ~720/minute.
// The graph still feels live — nodes appear within 1.5s of you saying the word.
//
//                    ┌─────────────────────────────────────┐
//  Speech API ──────►│         BUFFER (string)             │
//  (8–12 events/sec) │                                     │──► Worker
//                    │  Flush when: A) 1500ms elapsed      │   (≤1 call/1500ms)
//                    │             B) Sentence pause        │
//                    └─────────────────────────────────────┘
// =============================================================================

import { useEffect, useRef, useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// CONSTANTS — tweak these to tune the feel of the demo
// ---------------------------------------------------------------------------

// How long to wait before force-flushing the buffer (milliseconds).
// WHY 1500ms: fast enough that nodes feel "live" during demo, slow enough
// that the worker is never overwhelmed. Below 800ms you risk queuing.
const THROTTLE_MS = 1500;

// Characters that signal a natural sentence boundary.
// WHY include "...": speech recognition often emits "..." on long pauses
// before it finalises. Treating it as a flush trigger means the graph
// updates at the natural end of a thought, not mid-word.
const SENTENCE_ENDERS = new Set([".", "!", "?", "…", "..."]);

// Minimum buffer length before we bother sending to the worker.
// WHY 15 chars: prevents dispatching on very short utterances like "um" or
// "okay" that would just add noise to the graph.
const MIN_FLUSH_LENGTH = 15;

// ---------------------------------------------------------------------------
// HOOK DEFINITION
// ---------------------------------------------------------------------------

/**
 * @param {Object}   options
 * @param {Function} options.onWorkerDispatch   - Called with the buffered text
 *                                                when a flush is triggered.
 *                                                Signature: (text: string) => void
 * @param {Function} options.onTranscriptUpdate - Called on every speech event
 *                                                with the latest partial text.
 *                                                For updating the live transcript panel.
 *                                                Signature: (text: string) => void
 * @param {Function} options.onError            - Called if the Speech API errors.
 *                                                Signature: (errorCode: string) => void
 *
 * @returns {Object} {
 *   isListening: boolean,
 *   isSupported: boolean,
 *   start: () => void,
 *   stop: () => void,
 *   injectDemoText: (text: string) => void,   ← backup for mic failures
 *   clearTranscript: () => void,
 * }
 */
export function useSpeechRecognition({
  onWorkerDispatch,
  onTranscriptUpdate,
  onError,
}) {
  const [isListening, setIsListening] = useState(false);

  // WHY useRef for everything below (not useState):
  // These values are read and written inside event callbacks. If we used
  // useState, each callback would close over a stale snapshot of state from
  // the last render. useRef gives us a mutable box that always holds the
  // current value, regardless of when the callback was created.
  const recognitionRef    = useRef(null);
  const bufferRef         = useRef("");      // Accumulated unprocessed text
  const lastFlushTimeRef  = useRef(0);       // Timestamp of the last dispatch
  const flushTimerRef     = useRef(null);    // The active setTimeout ID
  const isListeningRef    = useRef(false);   // Mirror of isListening for callbacks
  const fullTranscriptRef = useRef("");      // Full cumulative transcript

  // Keep isListeningRef in sync with the state value.
  // WHY both: React state (isListening) is for the UI (button label etc.).
  // The ref (isListeningRef) is for the event callbacks where state is stale.
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);

  // ---------------------------------------------------------------------------
  // BUFFER FLUSH LOGIC
  // ---------------------------------------------------------------------------

  /**
   * Dispatches the accumulated buffer to the worker, then resets it.
   *
   * WHY a separate function (not inline):
   * Both the time-based timer AND the sentence-pause detector need to
   * call the same flush logic. Extracting it prevents code duplication
   * and ensures both paths behave identically.
   *
   * @param {string} reason - "timer" | "sentence" | "manual" | "demo"
   *                          Logged to console for debugging during dev.
   */
  const flushBuffer = useCallback((reason = "timer") => {
    const text = bufferRef.current.trim();

    // Don't dispatch empty or trivially short buffers
    if (text.length < MIN_FLUSH_LENGTH) return;

    // Update timing BEFORE the async dispatch.
    // WHY: if we updated after, and the dispatch triggered a re-render that
    // reset the buffer before updating the timestamp, we'd lose the timing
    // guard and potentially double-flush.
    lastFlushTimeRef.current = Date.now();
    bufferRef.current = "";

    // Clear any pending timer — it's been superseded by this flush.
    // WHY: without this, a sentence-pause flush at t=0.8s would still
    // be followed by the timer flush at t=1.5s, dispatching an empty
    // (or stale) buffer to the worker.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    if (process.env.NODE_ENV === "development") {
      console.debug(`[VoiceCanvas] Buffer flush (${reason}): "${text.slice(0, 50)}…"`);
    }

    onWorkerDispatch?.(text);
  }, [onWorkerDispatch]);

  // ---------------------------------------------------------------------------
  // SCHEDULE A TIMED FLUSH
  // ---------------------------------------------------------------------------

  /**
   * Arms a timer to flush the buffer after THROTTLE_MS milliseconds.
   *
   * WHY we reset it on every call (clearTimeout then setTimeout):
   * This is the "debounce within a throttle" pattern. Each new word
   * resets the countdown. The flush only fires if the user pauses
   * for a full THROTTLE_MS with no new words — OR if the forced
   * max-wait logic kicks in (see inside the callback below).
   *
   * Concretely: if you speak continuously for 10 seconds, the timer
   * flush fires at t=1.5, t=3.0, t=4.5... even though you never paused.
   * That's the "max wait" behaviour — guaranteed graph updates even for
   * non-stop speech.
   */
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);

    flushTimerRef.current = setTimeout(() => {
      // Double-check: only flush if there's new content.
      // This catches the edge case where a sentence-pause flush
      // already emptied the buffer before this timer fired.
      if (bufferRef.current.trim().length >= MIN_FLUSH_LENGTH) {
        flushBuffer("timer");
      }
    }, THROTTLE_MS);
  }, [flushBuffer]);

  // ---------------------------------------------------------------------------
  // PROCESS INCOMING SPEECH EVENT
  // ---------------------------------------------------------------------------

  /**
   * Called on every Speech API onresult event.
   * Decides whether to immediately flush (sentence pause) or
   * let the timer handle it.
   *
   * @param {string}  newText   - The incremental new words in this event
   * @param {boolean} isFinal   - True when the API finalises a sentence
   */
  const processSpeechToken = useCallback((newText, isFinal) => {
    // Accumulate into the buffer
    bufferRef.current += newText;

    // ── Path A: Sentence-end detected ───────────────────────────────────────
    // isFinal fires when the recognition engine is confident it's heard
    // a complete utterance (it detected a pause after speech).
    // We also check the last character as a belt-and-suspenders measure,
    // because some browser implementations set isFinal late.
    const lastChar = newText.trim().slice(-1);
    const isSentenceEnd = isFinal || SENTENCE_ENDERS.has(lastChar);

    if (isSentenceEnd && bufferRef.current.trim().length >= MIN_FLUSH_LENGTH) {
      flushBuffer("sentence");
      return;
    }

    // ── Path B: Force-flush if we've waited too long ─────────────────────────
    // Even without a sentence end, if THROTTLE_MS has passed since
    // the last dispatch, flush now. This prevents a talkative user
    // (who never pauses for punctuation) from starving the graph.
    const elapsed = Date.now() - lastFlushTimeRef.current;
    if (elapsed >= THROTTLE_MS && bufferRef.current.trim().length >= MIN_FLUSH_LENGTH) {
      flushBuffer("timer");
      return;
    }

    // ── Path C: Schedule a deferred flush ───────────────────────────────────
    // If neither condition above fired, arm the timer. It will flush
    // once THROTTLE_MS passes without a new token or sentence-end.
    scheduleFlush();
  }, [flushBuffer, scheduleFlush]);

  // ---------------------------------------------------------------------------
  // WEB SPEECH API SETUP
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Feature detection — not all browsers support this.
    // WHY check both: Chrome/Edge use unprefixed SpeechRecognition.
    // Safari (iOS/macOS) still requires the webkit prefix as of 2026.
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn("[VoiceCanvas] Web Speech API not supported in this browser.");
      return; // isSupported will remain false
    }

    const rec = new SpeechRecognition();

    // ── Configuration ────────────────────────────────────────────────────────

    // WHY continuous:true — the default mode stops after one utterance.
    // We need it to run indefinitely until the user clicks Stop.
    rec.continuous = true;

    // WHY interimResults:true — without this, onresult only fires once
    // a sentence is "finalised" (~1-3s delay). With it, we get partial
    // results in real-time, which makes the transcript panel feel alive.
    // The graph only updates on final results or the throttle timer,
    // so enabling this doesn't flood the worker.
    rec.interimResults = true;

    rec.lang = "en-US";

    // maxAlternatives: we only use the top hypothesis (index 0).
    // Setting it to 1 reduces processing overhead on the browser side.
    rec.maxAlternatives = 1;

    // ── Event: speech result ─────────────────────────────────────────────────
    rec.onresult = (event) => {
      let interimText = "";
      let finalText   = "";

      // WHY iterate from event.resultIndex (not 0):
      // event.results is cumulative — it includes ALL results since the
      // session started. resultIndex tells us the first NEW result in this
      // event. Iterating from 0 would re-process every past result every
      // single event — exponentially growing work.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript + " ";
        } else {
          interimText += transcript;
        }
      }

      // Update the full running transcript (for the UI panel)
      if (finalText) {
        fullTranscriptRef.current += finalText;
      }

      // Notify the UI of the latest text (interim OR final).
      // The UI panel shows both — interim text displays in a lighter colour.
      const displayText = fullTranscriptRef.current + interimText;
      onTranscriptUpdate?.(displayText, { interimText, finalText });

      // Feed the throttle buffer
      if (finalText)   processSpeechToken(finalText, true);
      if (interimText) processSpeechToken(interimText, false);
    };

    // ── Event: speech errors ─────────────────────────────────────────────────
    rec.onerror = (event) => {
      // WHY ignore 'no-speech': this fires after ~5s of silence and is
      // completely normal behaviour — not an error. Showing an error
      // message for this would confuse users who paused to think.
      if (event.error === "no-speech") return;

      // 'aborted' fires when we call rec.stop() ourselves. Not an error.
      if (event.error === "aborted") return;

      console.error("[VoiceCanvas] Speech API error:", event.error);
      onError?.(event.error);
      setIsListening(false);
    };

    // ── Event: recognition ends unexpectedly ─────────────────────────────────
    rec.onend = () => {
      // WHY auto-restart:
      // Browsers auto-stop speech recognition after periods of silence,
      // after ~60s on some browsers, or after a tab loses focus briefly.
      // If the user is still in "listening" mode (isListeningRef.current),
      // we restart automatically so the demo isn't silently broken.
      if (isListeningRef.current) {
        try {
          rec.start();
        } catch (e) {
          // If start() throws (e.g. already running), ignore it.
          // This can happen in rapid start/stop cycles during testing.
          if (e.name !== "InvalidStateError") {
            console.warn("[VoiceCanvas] Failed to auto-restart:", e.message);
          }
        }
      }
    };

    recognitionRef.current = rec;

    // Cleanup on unmount
    return () => {
      try { rec.stop(); } catch (_) {}
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  // WHY empty dependency array:
  // We only want to create ONE SpeechRecognition instance for the lifetime
  // of the component. The callbacks (onWorkerDispatch, onTranscriptUpdate)
  // are captured via closure through processSpeechToken and flushBuffer,
  // both of which are useCallback-memoised. Re-creating the recogniser
  // on every render would cause it to start/stop in rapid cycles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // PUBLIC API — START / STOP
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    if (!recognitionRef.current || isListeningRef.current) return;

    // Reset state for a fresh session
    bufferRef.current        = "";
    lastFlushTimeRef.current = Date.now();
    fullTranscriptRef.current = "";

    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (err) {
      // "InvalidStateError" means it's already running — safe to ignore.
      if (err.name !== "InvalidStateError") {
        console.error("[VoiceCanvas] Could not start recognition:", err);
        onError?.("start-failed");
      }
    }
  }, [onError]);

  const stop = useCallback(() => {
    if (!recognitionRef.current || !isListeningRef.current) return;

    // Flush whatever is left in the buffer before stopping.
    // WHY: the last few words the user spoke might not have triggered
    // a flush yet. Without this, the last sentence is lost.
    flushBuffer("manual");

    try {
      recognitionRef.current.stop();
    } catch (_) {}

    setIsListening(false);
  }, [flushBuffer]);

  // ---------------------------------------------------------------------------
  // DEMO MODE — Backup injection if the microphone fails
  // ---------------------------------------------------------------------------

  /**
   * Directly injects text into the pipeline, bypassing the Speech API entirely.
   *
   * WHY this exists:
   * Hardware can fail. Browser permissions can be denied at the worst moment.
   * In Demo Mode, you call injectDemoText() with a pre-written paragraph,
   * and the graph builds as if you had spoken it. Judges can't tell the
   * difference because the pipeline (buffer → worker → D3) is identical.
   *
   * How to use during demo:
   *   1. Have a backup paragraph ready in a variable at the top of App.jsx.
   *   2. Keep a hidden keyboard shortcut (e.g. Ctrl+Shift+D) that calls
   *      injectDemoText(DEMO_PARAGRAPH).
   *   3. If the mic fails, hit the shortcut calmly and keep presenting.
   *
   * @param {string} text - The text to inject (can be long — we split it)
   */
  const injectDemoText = useCallback((text) => {
    if (!text?.trim()) return;

    console.info("[VoiceCanvas] Demo mode: injecting text");

    // Simulate the way real speech arrives: split by sentence, dispatch
    // each sentence with a 300ms delay between them. This makes the graph
    // build progressively rather than all at once, which looks more natural.
    const sentences = text
      .replace(/([.!?])\s+/g, "$1\n")  // Split on sentence boundaries
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    sentences.forEach((sentence, i) => {
      setTimeout(() => {
        // Update the transcript panel
        fullTranscriptRef.current += sentence + " ";
        onTranscriptUpdate?.(fullTranscriptRef.current, {
          finalText:   sentence,
          interimText: "",
        });

        // Dispatch directly to the worker — bypass the throttle entirely
        // since we control the pacing via setTimeout above.
        onWorkerDispatch?.(sentence);
      }, i * 350); // 350ms between sentences — feels like natural speech pace
    });
  }, [onWorkerDispatch, onTranscriptUpdate]);

  // ---------------------------------------------------------------------------
  // UTILITY: CLEAR
  // ---------------------------------------------------------------------------

  const clearTranscript = useCallback(() => {
    fullTranscriptRef.current = "";
    bufferRef.current         = "";
    onTranscriptUpdate?.("", { finalText: "", interimText: "" });
  }, [onTranscriptUpdate]);

  // ---------------------------------------------------------------------------
  // RETURN VALUE
  // ---------------------------------------------------------------------------

  return {
    isListening,

    // Let the UI know if this browser supports the API at all
    isSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),

    start,
    stop,
    injectDemoText,
    clearTranscript,
  };
}