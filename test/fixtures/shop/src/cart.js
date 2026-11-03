export function total(cart) {
  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)
}
