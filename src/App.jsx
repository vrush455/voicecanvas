import { useState, useEffect, useRef, useCallback } from "react";
import GraphCanvas from "./components/GraphCanvas";
import TranscriptPanel from "./components/TranscriptPanel";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";

const DEMO_PARAGRAPH = `
  Climate change is transforming ecosystems across Europe and Asia.
  Scientists at NASA and the United Nations have documented rising sea levels
  threatening coastal cities like Venice and Bangkok.
  Renewable energy companies in Germany and California are deploying
  solar and wind solutions faster than ever before.
  Greta Thunberg and António Guterres continue to push world leaders
  toward the Paris Agreement targets.
`;

const ENTITY_COLOR_GROUP = {
  PER:  "person",
  LOC:  "location",
  ORG:  "organisation",
  MISC: "misc",
};

function updateGraphFromEntities(entities, setNodes, setEdges) {
  setNodes(prev => {
    const existingIds = new Set(prev.map(n => n.id));
    const newNodes = entities
      .filter(e => !existingIds.has(e.id))
      .map(e => ({
        id:    e.id,
        label: e.label,
        group: ENTITY_COLOR_GROUP[e.group] ?? "misc",
        score: e.score,
      }));
    return newNodes.length > 0 ? [...prev, ...newNodes] : prev;
  });

  setEdges(prev => {
    const newEdges = entities.slice(1).map((e, i) => ({
      source: entities[i].id,
      target: e.id,
      id:     `${entities[i].id}--${e.id}`,
    }));
    const existingEdgeIds = new Set(prev.map(edge => edge.id));
    const uniqueNew = newEdges.filter(edge => !existingEdgeIds.has(edge.id));
    return uniqueNew.length > 0 ? [...prev, ...uniqueNew] : prev;
  });
}

export default function App() {
  const [nodes,      setNodes]      = useState([]);
  const [edges,      setEdges]      = useState([]);
  const [transcript, setTranscript] = useState("");
  const [modelLoad,  setModelLoad]  = useState({ loading: true, percent: 0, file: "" });

  const workerRef = useRef(null);

  useEffect(() => {
    const worker = new Worker(
      new URL("./nlp.worker.js", import.meta.url),
      { type: "module" }
    );

    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        setModelLoad({ loading: true, percent: Math.round(data.percent ?? 0), file: data.file ?? "" });
      } else if (data.type === "ready") {
        setModelLoad({ loading: false, percent: 100, file: "" });
      } else if (data.type === "result") {
        if (data.entities?.length) {
          updateGraphFromEntities(data.entities, setNodes, setEdges);
        }
      } else if (data.type === "error") {
        console.error("[Worker]", data.message);
      }
    };

    worker.onerror = (err) => {
      console.error("[Worker crashed]", err.message);
    };

    workerRef.current = worker;
    worker.postMessage({ type: "init" });

    return () => worker.terminate();
  }, []);

  const handleWorkerDispatch = useCallback((text) => {
    workerRef.current?.postMessage({ type: "analyze", text });
  }, []);

  const handleTranscriptUpdate = useCallback((fullText) => {
    setTranscript(fullText);
  }, []);

  const {
    isListening,
    isSupported,
    start,
    stop,
    injectDemoText,
  } = useSpeechRecognition({
    onWorkerDispatch:   handleWorkerDispatch,
    onTranscriptUpdate: handleTranscriptUpdate,
    onError: (code) => console.error("Speech error:", code),
  });

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        injectDemoText(DEMO_PARAGRAPH);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [injectDemoText]);

  const handleClear = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setTranscript("");
  }, []);

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

      {modelLoad.loading && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gray-950/90 gap-4">
          <p className="text-sm text-gray-400">Loading AI model…</p>
          <div className="w-64 h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all duration-300"
              style={{ width: `${modelLoad.percent}%` }}
            />
          </div>
          <p className="text-xs text-gray-600">{modelLoad.file} — {modelLoad.percent}%</p>
        </div>
      )}

      <TranscriptPanel transcript={transcript} isListening={isListening} />

      <GraphCanvas nodes={nodes} edges={edges} />

      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3">
        {!isSupported && (
          <span className="text-xs text-red-400 bg-red-900/30 px-3 py-1 rounded-full">
            Speech API not supported — use Demo Mode (Ctrl+Shift+D)
          </span>
        )}

        <button
          onClick={isListening ? stop : start}
          className={`px-6 py-3 rounded-full font-medium text-sm transition-all
            ${isListening
              ? "bg-red-500 hover:bg-red-600 animate-pulse"
              : "bg-violet-600 hover:bg-violet-700"
            }`}
        >
          {isListening ? "⏹  Stop" : "🎙  Start Mapping"}
        </button>

        {nodes.length > 0 && (
          <button
            onClick={handleClear}
            className="px-4 py-3 rounded-full text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-all"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}