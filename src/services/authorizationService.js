// Every permission has an explicit role and resource policy. Unknown actions deny.
const staff = actor => actor && actor.isActive !== false && !actor.deletedAt;
const assigned = (actor, order) => order && String(order.assignedDesigner) === String(actor._id);
export function permits(actor, action, order) {
  if (!staff(actor)) return false;
  const privileged = ['admin', 'manager'].includes(actor.role);
  switch (action) {
    case 'proof.view':
    case 'photo.read': return Boolean(order && (privileged || actor.role === 'designer' && assigned(actor, order)));
    case 'magazine.download_original':
    case 'draft.review':
    case 'print.authorize': return Boolean(order && privileged);
    case 'draft.upload': return Boolean(order && (actor.role === 'admin' || actor.role === 'designer' && assigned(actor, order)));
    case 'settings.manage':
    case 'privileged_accounts.manage': return actor.role === 'admin';
    case 'designers.manage': return privileged;
    default: return false;
  }
}
export const requirePermission = (action, resource = req => req.order) => (req, res, next) => {
  if (!permits(req.user, action, resource(req))) return res.status(403).json({message:'Permission denied'});
  next();
};
