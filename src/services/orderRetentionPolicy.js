export const RETENTION_KEY = 'magazine_retention_days';
export const DEFAULT_RETENTION_DAYS = 7;
export const TERMINAL_STATUSES = ['delivered', 'closed'];
export const validRetentionDays = value => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650;
export function installOrderRetention(schema) {
  schema.pre('save', function () {
    if (this.isModified('status')) {
      if (TERMINAL_STATUSES.includes(this.status)) this.completedAt ||= this.deliveryDetails?.confirmedAt || new Date();
      else this.completedAt = undefined;
    }
  });
  // Deletion is a durable, hidden state. Ordinary requests cannot reopen or modify it.
  schema.pre(/^(find|countDocuments|update)/, function () { this.where({ retentionDeletingAt: null }); });
  schema.pre('aggregate', function () { this.pipeline().unshift({ $match: { retentionDeletingAt: null } }); });
}
