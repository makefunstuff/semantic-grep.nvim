export function initials(name) {
  return name.split(/\s+/).filter(Boolean).map(word => word[0].toUpperCase()).slice(0, 2).join('')
}
