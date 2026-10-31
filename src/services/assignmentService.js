import { kickWorkflowNotifications } from './workflowNotificationService.js';
import { StaffUser } from '../models/StaffUser.model.js';
import { Order } from '../models/Order.model.js';
import { AuditLog } from '../models/AuditLog.model.js';


/**
 * Automatically assigns an order to the eligible designer with lowest active workload.
 * If all designers are at maximum capacity, moves order to 'queued_for_assignment'.
 * Uses atomic reservations to prevent race conditions during concurrent assignments.
 */
export const autoAssignOrder = async (order, assignedBy = null) => {
  // Find eligible, active designers sorted by current active workload ascending
  const availableDesigners = await StaffUser.find({
    role: 'designer',
    isActive: true,
    deletedAt: null,
    isEligibleForAssignment: true,
    $expr: { $lt: ['$currentActiveWorkload', '$maxActiveWorkload'] },
  }).sort({ currentActiveWorkload: 1, updatedAt: 1 });

  let selectedDesigner = null;

  // Atomically attempt to claim a workload slot from candidate designers in order of lowest workload
  for (const candidate of availableDesigners) {
    const claimed = await StaffUser.findOneAndUpdate(
      {
        _id: candidate._id,
        role: 'designer',
        isActive: true,
        deletedAt: null,
        isEligibleForAssignment: true,
        $expr: { $lt: ['$currentActiveWorkload', '$maxActiveWorkload'] },
      },
      { $inc: { currentActiveWorkload: 1 } },
      { new: true }
    );
    if (claimed) {
      selectedDesigner = claimed;
      break;
    }
  }

  if (!selectedDesigner) {
    order.status = 'queued_for_assignment';
    await order.save();

    await AuditLog.create({
      actor: { type: 'system', name: 'Auto-Assignment Engine' },
      action: 'ORDER_QUEUED_NO_CAPACITY',
      orderId: order._id,
      details: {
        reason: 'All active designers are currently at max capacity',
      },
    });

    await kickWorkflowNotifications(order._id);
    return { success: false, queued: true, message: 'All designers at capacity. Queued for assignment.' };
  }

  try {
    // Assign order
    order.assignedDesigner = selectedDesigner._id;
    order.status = 'assigned';
    order.assignmentHistory.push({
      designerId: selectedDesigner._id,
      designerName: selectedDesigner.name,
      assignedAt: new Date(),
      assignedBy: assignedBy ? assignedBy._id : null,
      reason: 'Auto-assignment (Lowest active workload)',
    });

    await order.save();

    await AuditLog.create({
      actor: {
        type: assignedBy ? assignedBy.role : 'system',
        id: assignedBy ? assignedBy._id : null,
        name: assignedBy ? assignedBy.name : 'Auto-Assignment Engine',
      },
      action: 'ORDER_ASSIGNED',
      orderId: order._id,
      details: {
        designerId: selectedDesigner._id,
        designerName: selectedDesigner.name,
        newWorkload: selectedDesigner.currentActiveWorkload,
      },
    });

    try {
      await kickWorkflowNotifications(order._id);
    } catch (notifErr) {
      console.warn(`[Assignment Notification Warning] ${notifErr.message}`);
    }

    return {
      success: true,
      designer: selectedDesigner,
      message: `Order assigned to ${selectedDesigner.name}`,
    };
  } catch (err) {
    // Rollback reserved workload slot if order update failed
    await StaffUser.findByIdAndUpdate(selectedDesigner._id, [
      { $set: { currentActiveWorkload: { $max: [0, { $subtract: ['$currentActiveWorkload', 1] }] } } },
    ], { updatePipeline: true });
    throw err;
  }
};

/**
 * Manually assigns or reassigns an order to a specific designer.
 */
export const manualAssignOrder = async (order, targetDesignerId, reason, managerUser) => {
  const targetDesigner = await StaffUser.findOne({
    _id: targetDesignerId,
    role: 'designer',
    isActive: true,
    deletedAt: null,
  });

  if (!targetDesigner) {
    throw new Error('Target designer not found or inactive');
  }

  const previousDesignerId = order.assignedDesigner;

  // If reassigning, decrement previous designer's workload (clamped to 0)
  if (previousDesignerId && previousDesignerId.toString() !== targetDesignerId.toString()) {
    await StaffUser.findByIdAndUpdate(previousDesignerId, [
      { $set: { currentActiveWorkload: { $max: [0, { $subtract: ['$currentActiveWorkload', 1] }] } } },
    ], { updatePipeline: true });
  }

  // If new designer or reassigned from another, increment new designer's workload
  if (!previousDesignerId || previousDesignerId.toString() !== targetDesignerId.toString()) {
    await StaffUser.findByIdAndUpdate(targetDesignerId, {
      $inc: { currentActiveWorkload: 1 },
    });
  }

  order.assignedDesigner = targetDesigner._id;
  if (order.status === 'queued_for_assignment' || order.status === 'payment_verified') {
    order.status = 'assigned';
  }

  order.assignmentHistory.push({
    designerId: targetDesigner._id,
    designerName: targetDesigner.name,
    assignedAt: new Date(),
    assignedBy: managerUser._id,
    reason: reason || 'Manual manager assignment',
  });

  await order.save();

  await AuditLog.create({
    actor: {
      type: 'manager',
      id: managerUser._id,
      name: managerUser.name,
    },
    action: 'ORDER_REASSIGNED',
    orderId: order._id,
    details: {
      targetDesignerId,
      designerName: targetDesigner.name,
      previousDesignerId,
      reason,
    },
  });

  try {
    await kickWorkflowNotifications(order._id);
  } catch (notifErr) {
    console.warn(`[Reassignment Notification Warning] ${notifErr.message}`);
  }

  return { success: true, designer: targetDesigner };
};

/**
 * Releases workload when an order completes or is archived. Clamped to min 0.
 */
export const releaseOrderWorkload = async (order) => {
  if (order.assignedDesigner) {
    await StaffUser.findByIdAndUpdate(order.assignedDesigner, [
      { $set: { currentActiveWorkload: { $max: [0, { $subtract: ['$currentActiveWorkload', 1] }] } } },
    ], { updatePipeline: true });
  }
};

/**
 * Reconciles staff designer workload counts against actual active orders in the database.
 */
export const reconcileDesignerWorkloads = async () => {
  const activeStatuses = [
    'assigned',
    'in_design',
    'draft_manager_review',
    'client_review',
    'revision_requested',
  ];

  const designers = await StaffUser.find({ role: 'designer', deletedAt: null }).lean();
  const results = [];

  for (const designer of designers) {
    const actualCount = await Order.countDocuments({
      assignedDesigner: designer._id,
      status: { $in: activeStatuses },
    });

    if (designer.currentActiveWorkload !== actualCount) {
      await StaffUser.findByIdAndUpdate(designer._id, {
        $set: { currentActiveWorkload: actualCount },
      });
      results.push({
        designerId: designer._id,
        name: designer.name,
        previousWorkload: designer.currentActiveWorkload,
        correctedWorkload: actualCount,
      });
    }
  }

  return results;
};
