// Shared version sort: oldest first, "nightly" always last
export function sortVersions(versions) {
  return [...versions].sort((a, b) => {
    if (a === 'nightly') return 1
    if (b === 'nightly') return -1
    const aParts = a.replace(/^[vV]/, '').split('.').map(s => parseInt(s) || 0)
    const bParts = b.replace(/^[vV]/, '').split('.').map(s => parseInt(s) || 0)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}
