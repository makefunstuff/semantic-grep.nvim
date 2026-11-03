export function rows(text) {
  return text.trim().split('\n').map(line => line.split(',').map(cell => cell.trim()))
}
