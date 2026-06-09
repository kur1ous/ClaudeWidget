// Per-million-token USD rates, used only to show an *estimated equivalent*
// cost (subscription usage is not billed per token). Update as prices change.
interface Rate {
  input: number
  output: number
  cacheWrite: number // 5m cache creation
  cacheRead: number
}

const RATES: Record<string, Rate> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
}

const FALLBACK: Rate = RATES.sonnet

export function rateFor(model: string | null | undefined): Rate {
  if (!model) return FALLBACK
  const m = model.toLowerCase()
  if (m.includes('opus')) return RATES.opus
  if (m.includes('sonnet')) return RATES.sonnet
  if (m.includes('haiku')) return RATES.haiku
  return FALLBACK
}

export function estimateCost(
  model: string | null | undefined,
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number
): number {
  const r = rateFor(model)
  return (
    (input * r.input +
      output * r.output +
      cacheCreation * r.cacheWrite +
      cacheRead * r.cacheRead) /
    1_000_000
  )
}
