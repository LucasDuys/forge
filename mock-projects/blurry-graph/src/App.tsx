import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { regressions } from './config';

// Ten nodes, static data. Labels double as both node text and
// the source-of-truth for the synthesis panel Agreed/Disputed split.
type NodeDatum = d3.SimulationNodeDatum & {
  id: string;
  label: string;
  stance: 'agreed' | 'disputed';
};

type LinkDatum = d3.SimulationLinkDatum<NodeDatum> & {
  source: string;
  target: string;
};

const NODES: NodeDatum[] = [
  { id: 'n1', label: 'Alpha', stance: 'agreed' },
  { id: 'n2', label: 'Bravo', stance: 'agreed' },
  { id: 'n3', label: 'Charlie', stance: 'agreed' },
  { id: 'n4', label: 'Delta', stance: 'agreed' },
  { id: 'n5', label: 'Echo', stance: 'agreed' },
  { id: 'n6', label: 'Foxtrot', stance: 'disputed' },
  { id: 'n7', label: 'Golf', stance: 'disputed' },
  { id: 'n8', label: 'Hotel', stance: 'disputed' },
  { id: 'n9', label: 'India', stance: 'disputed' },
  { id: 'n10', label: 'Juliet', stance: 'disputed' }
];

const LINKS: LinkDatum[] = [
  { source: 'n1', target: 'n2' },
  { source: 'n1', target: 'n3' },
  { source: 'n2', target: 'n4' },
  { source: 'n3', target: 'n5' },
  { source: 'n4', target: 'n6' },
  { source: 'n5', target: 'n7' },
  { source: 'n6', target: 'n8' },
  { source: 'n7', target: 'n9' },
  { source: 'n8', target: 'n10' },
  { source: 'n9', target: 'n10' }
];

const WIDTH = 800;
const HEIGHT = 600;
const NODE_RADIUS = 14;

export function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // When `off` is true, nothing regresses -- this is the golden-path flag.
  const haloOn = !regressions.off && regressions.halo;
  const zoomOutOn = !regressions.off && regressions.zoomOut;
  const synthesisBroken = !regressions.off && regressions.synthesis;

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    if (svg.empty()) return;

    svg.selectAll('*').remove();

    const container = svg.append('g').attr('class', 'zoom-layer');

    // Deep-clone nodes/links so the simulation can mutate x/y without
    // poisoning the module-level constants between hot reloads.
    const nodes: NodeDatum[] = NODES.map((n) => ({ ...n }));
    const links: LinkDatum[] = LINKS.map((l) => ({ ...l }));

    const simulation = d3
      .forceSimulation<NodeDatum>(nodes)
      .force(
        'link',
        d3
          .forceLink<NodeDatum, LinkDatum>(links)
          .id((d) => d.id)
          .distance(80)
      )
      .force('charge', d3.forceManyBody().strength(-220))
      .force('center', d3.forceCenter(WIDTH / 2, HEIGHT / 2))
      .force('collide', d3.forceCollide(NODE_RADIUS + 4));

    const link = container
      .append('g')
      .attr('class', 'links')
      .attr('stroke', '#888')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', 1.5);

    const nodeGroup = container
      .append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('data-testid', 'graph-node');

    // Regression 1: translucent halo ring 3x node radius on every node.
    // Overlaps neighbours at the default force layout distances, which
    // is the bug the visual verifier should flag.
    if (haloOn) {
      nodeGroup
        .append('circle')
        .attr('class', 'halo')
        .attr('r', NODE_RADIUS * 3)
        .attr('fill', 'rgba(99, 102, 241, 0.25)')
        .attr('stroke', 'rgba(99, 102, 241, 0.4)')
        .attr('stroke-width', 1);
    }

    nodeGroup
      .append('circle')
      .attr('class', 'node')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d) => (d.stance === 'agreed' ? '#4ade80' : '#f87171'))
      .attr('stroke', '#1f2937')
      .attr('stroke-width', 1.5);

    nodeGroup
      .append('text')
      .attr('class', 'label')
      .attr('text-anchor', 'middle')
      .attr('dy', NODE_RADIUS + 14)
      .attr('font-family', 'system-ui, sans-serif')
      .attr('font-size', 12)
      .attr('fill', '#111')
      .text((d) => d.label);

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as NodeDatum).x ?? 0)
        .attr('y1', (d) => (d.source as NodeDatum).y ?? 0)
        .attr('x2', (d) => (d.target as NodeDatum).x ?? 0)
        .attr('y2', (d) => (d.target as NodeDatum).y ?? 0);
      nodeGroup.attr('transform', (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });

    // Regression 2: random zoom-out on mount. Scale of ~0.15-0.25 makes
    // nodes appear as a tiny cluster offset from centre.
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform.toString());
      });

    svg.call(zoom);

    if (zoomOutOn) {
      const k = 0.15 + Math.random() * 0.1;
      svg.call(zoom.transform, d3.zoomIdentity.scale(k));
    }

    return () => {
      simulation.stop();
    };
  }, [haloOn, zoomOutOn]);

  return (
    <div
      style={{
        display: 'flex',
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100vh',
        background: '#fafafa'
      }}
    >
      <main style={{ flex: 1, padding: 16 }}>
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Blurry Graph</h1>
        <svg
          ref={svgRef}
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          style={{ border: '1px solid #ddd', background: '#fff' }}
        />
      </main>
      <aside
        data-testid="synthesis"
        style={{
          width: 280,
          borderLeft: '1px solid #ddd',
          padding: 16,
          background: '#fff'
        }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>Synthesis</h2>
        {synthesisBroken ? null : (
          <>
            <section>
              <h3>Agreed</h3>
              <ul>
                {NODES.filter((n) => n.stance === 'agreed').map((n) => (
                  <li key={n.id}>{n.label}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Disputed</h3>
              <ul>
                {NODES.filter((n) => n.stance === 'disputed').map((n) => (
                  <li key={n.id}>{n.label}</li>
                ))}
              </ul>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
