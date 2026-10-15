import { StaffUser } from '../models/StaffUser.model.js';
import { AuditLog } from '../models/AuditLog.model.js';

/**
 * Automatically assigns an order to the eligible designer with lowest active workload.
 * If all designers are at maximum capacity, moves order to 'queued_for_assignment'.
 */
export const autoAssignOrder = async (order, assignedBy = null) => {
  // Find eligible, active designers who have not exceeded their max workload
  const availableDesigners = await StaffUser.find({
    role: 'designer',
    isActive: true,
    deletedAt: null,
    isEligibleForAssignment: true,
    $expr: { $lt: ['$currentActiveWorkload', '$maxActiveWorkload'] },
  }).sort({ currentActiveWorkload: 1, updatedAt: 1 });

  if (!availableDesigners || availableDesigners.length === 0) {
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

    return { success: false, queued: true, message: 'All designers at capacity. Queued for assignment.' };
  }

  const selectedDesigner = availableDesigners[0];

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

  // Increment designer's active workload
  await StaffUser.findByIdAndUpdate(selectedDesigner._id, {
    $inc: { currentActiveWorkload: 1 },
  });

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
      newWorkload: selectedDesigner.currentActiveWorkload + 1,
    },
  });

  return {
    success: true,
    designer: selectedDesigner,
    message: `Order assigned to ${selectedDesigner.name}`,
  };
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

  // If reassigning, decrement previous designer's workload
  if (previousDesignerId && previousDesignerId.toString() !== targetDesignerId.toString()) {
    await StaffUser.findByIdAndUpdate(previousDesignerId, {
      $inc: { currentActiveWorkload: -1 },
    });
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

  return { success: true, designer: targetDesigner };
};

/**
 * Releases workload when an order completes or is archived.
 */
export const releaseOrderWorkload = async (order) => {
  if (order.assignedDesigner) {
    await StaffUser.findByIdAndUpdate(order.assignedDesigner, {
      $inc: { currentActiveWorkload: -1 },
    });
  }
};
