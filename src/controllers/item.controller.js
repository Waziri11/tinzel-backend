import { Item } from '../models/item.model.js';

export const getItems = async (_req, res) => {
  try {
    const items = await Item.find().sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, source: 'mongodb', data: items });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createItem = async (req, res) => {
  try {
    const { title, description, status } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const newItem = await Item.create({ title, description, status });
    return res.status(201).json({ success: true, source: 'mongodb', data: newItem });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Item.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    return res.status(200).json({ success: true, message: 'Item deleted successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
