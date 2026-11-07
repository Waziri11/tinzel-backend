const completed = ['client_approved', 'print_document_prep', 'print_manager_review', 'printing_sent', 'printing_in_progress', 'printing_completed', 'dispatched', 'delivered', 'closed'];
// Only the latest return determines the lane. Earlier rounds remain in order history.
export function designerColumnFilter(column) {
  if (column === 'new') return { status: { $nin: [...completed, 'revision_requested'] } };
  if (column === 'completed') return { status: { $in: completed } };
  if (column === 'manager' || column === 'client') return {
    status: 'revision_requested',
    $expr: { $eq: [{ $ifNull: [{ $arrayElemAt: ['$revisionRequests.source', -1] }, 'manager'] }, column] },
  };
  return null;
}
