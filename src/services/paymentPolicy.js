export function requiredDeposit(order) {
  const total = order.totalPrice ?? order.formId?.price ?? order.price;
  if (total == null || !Number.isFinite(Number(total)) || Number(total) < 0) {
    throw Object.assign(new Error('The order price is unavailable. Review the order price before confirming payment.'), { status: 409 });
  }
  return Math.ceil(Number(total) / 2);
}
