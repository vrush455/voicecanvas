export default function TranscriptPanel({ transcript, isListening }) {
  return (
    <div className="w-72 h-full bg-gray-900 border-r border-gray-800 p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`} />
        <span className="text-xs text-gray-400 font-medium">
          {isListening ? 'Listening...' : 'Not listening'}
        </span>
      </div>
      <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
        {transcript || 'Click Start Mapping to begin...'}
      </p>
    </div>
  )
}