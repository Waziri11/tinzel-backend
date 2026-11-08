export const EXPRESS_FEE = 20000;
export const EXPRESS_HOURS = 24;
export const EXPRESS_ORDER_SORT = { isExpress: -1, expressDueAt: 1, updatedAt: -1, _id: -1 };
const HOUR = 60 * 60 * 1000;
const EAT_OFFSET = 3 * HOUR;

// Every hour Monday–Saturday counts. Sundays are excluded in Africa/Dar_es_Salaam.
export function expressDeadline(start) {
  let cursor = new Date(start).getTime();
  if (!Number.isFinite(cursor)) throw new TypeError('Invalid express start time');
  let remaining = EXPRESS_HOURS * HOUR;
  while (remaining > 0) {
    const local = new Date(cursor + EAT_OFFSET);
    const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - EAT_OFFSET;
    if (local.getUTCDay() === 0) cursor = midnight;
    else {
      const elapsed = Math.min(remaining, midnight - cursor);
      cursor += elapsed;
      remaining -= elapsed;
    }
  }
  return new Date(cursor);
}

export function orderPricing(form, selection = false) {
  if (![true, false, 'true', 'false'].includes(selection)) {
    throw Object.assign(new Error('Choose standard or express delivery'), { status: 400 });
  }
  const isExpress = selection === true || selection === 'true';
  const currency = form.currency || 'TZS';
  if (isExpress && !['TZS', 'TSH'].includes(currency.toUpperCase())) {
    throw Object.assign(new Error('Express delivery is available for orders priced in Tanzanian shillings'), { status: 400 });
  }
  const basePrice = Number(form.price);
  if (!Number.isFinite(basePrice) || basePrice < 0) throw Object.assign(new Error('This edition has no valid price'), { status: 400 });
  const expressFee = isExpress ? EXPRESS_FEE : 0;
  return { isExpress, basePrice, expressFee, totalPrice: basePrice + expressFee, currency };
}

export function publicOrderPricing(order, fallback = {}) {
  const basePrice = order.basePrice ?? fallback.price;
  const expressFee = order.expressFee ?? 0;
  return {
    isExpress: order.isExpress === true, basePrice, expressFee,
    price: order.totalPrice ?? (basePrice == null ? undefined : basePrice + expressFee),
    currency: order.currency || fallback.currency || 'TZS',
    expressStartedAt: order.expressStartedAt,
    expressDueAt: order.expressDueAt,
    completedAt: order.completedAt,
  };
}

export function installExpressOrder(schema) {
  schema.pre('save', function () {
    // A later workflow save or payment retry must never restart the clock.
    if (this.isExpress && this.paymentDetails?.verifiedAt && !this.expressStartedAt) {
      this.expressStartedAt = this.paymentDetails.verifiedAt;
      this.expressDueAt = expressDeadline(this.expressStartedAt);
    }
  });
}
