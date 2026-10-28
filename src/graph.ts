export interface GraphNode {
  readonly hash: string
  readonly parents: readonly string[]
}

export interface GraphEdge {
  /**
   * pass: a lane that runs through the row (bending left when it joins a first parent's lane); in: a lane that ends at
   * this commit; out: a lane to a parent.
   */
  readonly kind: "pass" | "in" | "out"
  readonly from: number
  readonly to: number
  readonly color: number
}

export interface GraphRow {
  readonly col: number
  readonly color: number
  readonly edges: readonly GraphEdge[]
  /** Lanes that continue below this row, with their colors, for drawing through expanded content. */
  readonly below: readonly { readonly lane: number; readonly color: number }[]
  readonly width: number
}

/** Assigns each commit, in topological order, a lane, and the edges that connect it to its children and parents. */
export function layout(nodes: readonly GraphNode[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const counter = { next: 0 }

  return nodes.map((node) => {
    const before = lanes.slice()
    const beforeColors = colors.slice()
    const found = lanes.indexOf(node.hash)
    const col = found === -1 ? free(lanes) : found
    if (found === -1) {
      lanes[col] = node.hash
      colors[col] = counter.next++
    }
    const color = colors[col] ?? 0
    const edges: GraphEdge[] = []

    before.forEach((hash, lane) => {
      if (hash === node.hash) edges.push({ kind: "in", from: lane, to: col, color: beforeColors[lane] ?? 0 })
    })
    lanes.forEach((hash, lane) => {
      if (hash === node.hash) lanes[lane] = null
    })

    node.parents.forEach((parent, index) => {
      const existing = lanes.indexOf(parent)
      // The first parent keeps this lane; a lane further right that waits for the same commit bends into it, so the
      // main line stays straight instead of drifting right after every merge of a branch cut from an older commit.
      if (index === 0 && existing > col && lanes[col] === null) {
        edges.push({ kind: "pass", from: existing, to: col, color: colors[existing] ?? 0 })
        edges.push({ kind: "out", from: col, to: col, color })
        lanes[existing] = null
        lanes[col] = parent
        return
      }
      if (existing !== -1) {
        edges.push({ kind: "out", from: col, to: existing, color: index === 0 ? color : (colors[existing] ?? 0) })
        return
      }
      const lane = index === 0 && lanes[col] === null ? col : free(lanes)
      lanes[lane] = parent
      colors[lane] = index === 0 ? color : counter.next++
      edges.push({ kind: "out", from: col, to: lane, color: colors[lane] ?? 0 })
    })

    before.forEach((hash, lane) => {
      if (hash !== null && hash !== node.hash && lanes[lane] === hash)
        edges.push({ kind: "pass", from: lane, to: lane, color: beforeColors[lane] ?? 0 })
    })

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }

    return {
      col,
      color,
      edges,
      below: lanes.flatMap((hash, lane) => (hash === null ? [] : [{ lane, color: colors[lane] ?? 0 }])),
      width: Math.max(before.length, lanes.length, col + 1),
    }
  })
}

function free(lanes: (string | null)[]) {
  const index = lanes.indexOf(null)
  if (index !== -1) return index
  lanes.push(null)
  return lanes.length - 1
}
