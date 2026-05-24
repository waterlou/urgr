export default function IconDisplay({ name, fallback = 'folder', className = '' }) {
  const icon = name || fallback
  const isIconName = /^[a-z][a-z0-9_]*$/i.test(icon)
  if (isIconName) {
    return <span className={`icon ${className}`}>{icon}</span>
  }
  return <span className={className}>{icon}</span>
}
