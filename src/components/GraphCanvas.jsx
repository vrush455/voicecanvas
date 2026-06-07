export default function GraphCanvas({ nodes, edges }) {
  return (
    <svg className="flex-1 h-full bg-gray-950">
      <g className="links" />
      <g className="nodes" />
    </svg>
  )
}