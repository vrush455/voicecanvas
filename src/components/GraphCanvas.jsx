import { useEffect, useRef } from "react";
import * as d3 from "d3";

// Color map: entity type → node color
const GROUP_COLORS = {
  person:       "#8B5CF6", // violet
  location:     "#10B981", // emerald
  organisation: "#F59E0B", // amber
  misc:         "#6366F1", // indigo
};

export default function GraphCanvas({ nodes, edges }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const width  = svgRef.current.clientWidth  || window.innerWidth - 288;
    const height = svgRef.current.clientHeight || window.innerHeight;

    // ── Build simulation once ───────────────────────────────────────────────
    // WHY: We create the simulation once and mutate it on every data change.
    // Re-creating it would fling all existing nodes to random positions.
    if (!simRef.current) {
      simRef.current = d3.forceSimulation()
        .force("link",      d3.forceLink().id(d => d.id).distance(120))
        .force("charge",    d3.forceManyBody().strength(-350))
        .force("center",    d3.forceCenter(width / 2, height / 2))
        .force("collision", d3.forceCollide(48));
    }

    const sim = simRef.current;

    // ── Zoom behaviour ──────────────────────────────────────────────────────
    // Only attach zoom once (check if already set)
    if (!svg.select("g.zoom-root").size() || svg.select("g.zoom-root").empty()) {
      const zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .on("zoom", (event) => {
          svg.select("g.zoom-root").attr("transform", event.transform);
        });
      svg.call(zoom);

      // Create the root group that zoom transforms
      svg.append("g").attr("class", "zoom-root")
        .append("g").attr("class", "links");
      svg.select("g.zoom-root")
        .append("g").attr("class", "nodes");
    }

    const linkGroup = svg.select("g.links");
    const nodeGroup = svg.select("g.nodes");

    // ── LINKS ───────────────────────────────────────────────────────────────
    const linkSel = linkGroup
      .selectAll("line")
      .data(edges, d => d.id)
      .join(
        enter => enter.append("line")
          .attr("stroke", "#374151")
          .attr("stroke-width", 1.5)
          .attr("stroke-opacity", 0)
          .call(el => el.transition().duration(600)
            .attr("stroke-opacity", 0.7)),
        update => update,
        exit   => exit.transition().duration(300)
          .attr("stroke-opacity", 0).remove()
      );

    // ── NODES ───────────────────────────────────────────────────────────────
    const nodeSel = nodeGroup
      .selectAll("g.node")
      .data(nodes, d => d.id)
      .join(
        enter => {
          const g = enter.append("g").attr("class", "node")
            .style("cursor", "pointer");

          // Outer glow ring — fades out after pop-in
          g.append("circle")
            .attr("r", 0)
            .attr("fill", "none")
            .attr("stroke", d => GROUP_COLORS[d.group] ?? GROUP_COLORS.misc)
            .attr("stroke-width", 6)
            .attr("stroke-opacity", 0.3)
            .call(c => c.transition().duration(600)
              .attr("r", 22)
              .transition().duration(800)
              .attr("stroke-opacity", 0).attr("r", 32));

          // Main filled circle — bouncy pop-in
          g.append("circle")
            .attr("class", "main-circle")
            .attr("r", 0)
            .attr("fill",         d => GROUP_COLORS[d.group] ?? GROUP_COLORS.misc)
            .attr("fill-opacity", 0.9)
            .attr("stroke", "white")
            .attr("stroke-width", 1.5)
            .call(c => c.transition().duration(500)
              .ease(d3.easeBackOut.overshoot(1.4))
              .attr("r", 18));

          // Label below the node
          g.append("text")
            .text(d => d.label)
            .attr("text-anchor", "middle")
            .attr("dy", 34)
            .attr("fill", "#E5E7EB")
            .attr("font-size", 11)
            .attr("font-family", "system-ui, sans-serif")
            .attr("pointer-events", "none")
            .attr("opacity", 0)
            .call(t => t.transition().delay(300).duration(400)
              .attr("opacity", 1));

          // Hover: brighten + show type badge
          g.on("mouseenter", function (event, d) {
            d3.select(this).select(".main-circle")
              .transition().duration(150)
              .attr("r", 22).attr("fill-opacity", 1);
          })
          .on("mouseleave", function () {
            d3.select(this).select(".main-circle")
              .transition().duration(150)
              .attr("r", 18).attr("fill-opacity", 0.9);
          });

          // Drag behaviour
          // WHY: Users should be able to reposition nodes manually.
          // fx/fy "pins" a node; setting them null on dragend releases it.
          g.call(
            d3.drag()
              .on("start", (event, d) => {
                if (!event.active) sim.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
              })
              .on("drag", (event, d) => {
                d.fx = event.x;
                d.fy = event.y;
              })
              .on("end", (event, d) => {
                if (!event.active) sim.alphaTarget(0);
                d.fx = null;
                d.fy = null;
              })
          );

          return g;
        },
        update => update,
        exit   => exit.transition().duration(300)
          .style("opacity", 0).remove()
      );

    // ── Feed simulation ─────────────────────────────────────────────────────
    sim.nodes(nodes);
    sim.force("link").links(edges);

    // WHY alpha(0.3) not 1.0:
    // A full restart flings existing nodes to random positions.
    // 0.3 adds just enough energy to settle new nodes in without chaos.
    sim.alpha(0.3).restart();

    // ── Tick: update DOM positions every simulation step ────────────────────
    sim.on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      nodeSel.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

  }, [nodes, edges]);

  // ── Empty state ─────────────────────────────────────────────────────────
  return (
    <div className="relative flex-1 h-full bg-gray-950">
      <svg ref={svgRef} className="w-full h-full" />

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-gray-700 text-sm">Speak to grow your knowledge graph</p>
          <p className="text-gray-800 text-xs mt-1">People · Places · Organisations</p>
        </div>
      )}

      {/* Legend */}
      {nodes.length > 0 && (
        <div className="absolute top-4 right-4 flex flex-col gap-1.5 bg-gray-900/80 backdrop-blur px-3 py-2 rounded-lg border border-gray-800">
          {Object.entries(GROUP_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
              <span className="text-xs text-gray-400 capitalize">{type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}