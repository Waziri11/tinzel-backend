import { Router } from 'express';
import { getItems, createItem, deleteItem } from '../controllers/item.controller.js';

const router = Router();

router.get('/', getItems);
router.post('/', createItem);
router.delete('/:id', deleteItem);

export default router;
