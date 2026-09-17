export function adjacentTabKey(order: string[], current: string | undefined, offset: -1 | 1) {
  if (!current || order.length === 0) return
  const index = order.indexOf(current)
  if (index === -1) return
  return order[(index + offset + order.length) % order.length]
}

export function tabOrderRebased(prevKeys: string[], propsKeys: string[]) {
  const prevShared = prevKeys.filter((key) => propsKeys.includes(key))
  const nextShared = propsKeys.filter((key) => prevKeys.includes(key))
  const rank = new Map(prevShared.map((key, index) => [key, index]))
  return nextShared.some((key, index) => index > 0 && rank.get(key)! < rank.get(nextShared[index - 1])!)
}

export function mergeVisibleTabOrder(all: string[], current: string[], next: string[]) {
  const visible = new Set(current)
  const reordered = next.values()
  return all.map((key) => (visible.has(key) ? (reordered.next().value ?? key) : key))
}
