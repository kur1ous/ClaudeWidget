import type { JSX } from 'react'

// Original SVG recreation of Claude's starburst mark (not the trademarked asset):
// a sunburst of tapered rays radiating from centre. `fill="currentColor"` lets CSS
// drive the colour (terracotta) and `.sparkle` handles the animation/glow.
const RAYS = 12
const CENTER = 12

// One ray pointing up from centre: a slim diamond tapering to a point.
const RAY_PATH = `M ${CENTER} 1 L ${CENTER + 1.6} ${CENTER - 2.2} L ${CENTER} ${CENTER} L ${CENTER - 1.6} ${CENTER - 2.2} Z`

export function Sparkle({ active }: { active: boolean }): JSX.Element {
  return (
    <span className={`sparkle${active ? ' active' : ''}`} aria-label="Claude">
      <svg viewBox="0 0 24 24" width="14" height="14" role="img">
        <g fill="currentColor">
          {Array.from({ length: RAYS }, (_, i) => (
            <path key={i} d={RAY_PATH} transform={`rotate(${(360 / RAYS) * i} ${CENTER} ${CENTER})`} />
          ))}
        </g>
      </svg>
    </span>
  )
}
