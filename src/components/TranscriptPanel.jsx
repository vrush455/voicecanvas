import { useEffect, useRef } from "react";

export default function TranscriptPanel({ transcript, isListening, nodeCount = 0 }) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom as transcript grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const wordCount = transcript
    ? transcript.trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="w-72 h-full bg-gray-900 border-r border-gray-800 flex flex-col">

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Live Transcript
          </span>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full transition-colors
              ${isListening ? "bg-red-500 animate-pulse" : "bg-gray-600"}`}
            />
            <span className="text-xs text-gray-500">
              {isListening ? "Listening" : "Idle"}
            </span>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex gap-3">
          <div className="bg-gray-800 rounded-md px-2 py-1 flex-1 text-center">
            <p className="text-lg font-semibold text-white leading-none">{nodeCount}</p>
            <p className="text-xs text-gray-500 mt-0.5">nodes</p>
          </div>
          <div className="bg-gray-800 rounded-md px-2 py-1 flex-1 text-center">
            <p className="text-lg font-semibold text-white leading-none">{wordCount}</p>
            <p className="text-xs text-gray-500 mt-0.5">words</p>
          </div>
        </div>
      </div>

      {/* Transcript body */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {transcript ? (
          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
            {transcript}
          </p>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
            <span className="text-3xl">🎙</span>
            <p className="text-sm text-gray-600">Click Start Mapping<br/>and begin speaking</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-gray-800 flex-shrink-0">
        <p className="text-xs text-gray-700 text-center">
          Ctrl+Shift+D for demo mode
        </p>
      </div>
    </div>
  );
}