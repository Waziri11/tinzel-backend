const completed = ['awaiting_balance_payment', 'balance_payment_review', 'client_approved', 'print_document_prep', 'print_manager_review', 'printing_sent', 'printing_in_progress', 'printing_completed', 'dispatched', 'delivered', 'closed'];
// Holds retain the underlying stage. An unresolved correction stays with its
// requester while the designer works and while the manager reviews the fix.
const columnExpression = {
  $let: {
    vars: {
      stage: { $cond: [{ $eq: ['$status', 'on_hold'] }, '$previousStatusBeforeHold', '$status'] },
      latest: { $arrayElemAt: [{ $ifNull: ['$revisionRequests', []] }, -1] },
    },
    in: {
      $switch: {
        branches: [
          { case: { $in: ['$$stage', completed] }, then: 'completed' },
          {
            case: { $or: [
              { $eq: ['$$stage', 'revision_requested'] },
              { $and: [
                { $in: ['$$stage', ['assigned', 'in_design', 'draft_manager_review']] },
                { $in: ['$$latest.status', ['open', 'submitted_for_review']] },
              ] },
            ] },
            then: { $cond: [{ $eq: ['$$latest.source', 'client'] }, 'client', 'manager'] },
          },
        ],
        default: 'new',
      },
    },
  },
};

export function designerColumnFilter(column) {
  if (!['new', 'manager', 'client', 'completed'].includes(column)) return null;
  return { $expr: { $eq: [columnExpression, column] } };
}
