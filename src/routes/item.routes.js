import { Router } from 'express';
import { getItems, createItem, deleteItem } from '../controllers/item.controller.js';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
  }
  return next();
});

router.use(verifyStaffToken, requireRoles('admin'));

router.get('/', getItems);
router.post('/', createItem);
router.delete('/:id', deleteItem);

export default router;
