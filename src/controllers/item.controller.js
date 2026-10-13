import { Item } from '../models/item.model.js';
import { getDBStatus } from '../config/db.js';

// In-memory fallback if MongoDB is not yet connected
let fallbackItems = [
  {
    _id: 'sample-1',
    title: 'Welcome to Tinzel MERN Stack',
    description: 'Frontend and Backend are connected successfully via Express API.',
    status: 'completed',
    createdAt: new Date().toISOString(),
  },
  {
    _id: 'sample-2',
    title: 'Configure MongoDB',
    description: 'Provide MONGODB_URI in .env to persist records in MongoDB.',
    status: 'in-progress',
    createdAt: new Date().toISOString(),
  },
];

export const getItems = async (req, res) => {
  try {
    if (getDBStatus() === 'connected') {
      const items = await Item.find().sort({ createdAt: -1 });
      return res.status(200).json({ success: true, source: 'mongodb', data: items });
    }
    return res.status(200).json({ success: true, source: 'memory-fallback', data: fallbackItems });
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

    if (getDBStatus() === 'connected') {
      const newItem = await Item.create({ title, description, status });
      return res.status(201).json({ success: true, source: 'mongodb', data: newItem });
    }

    const fallbackItem = {
      _id: `item-${Date.now()}`,
      title,
      description: description || '',
      status: status || 'pending',
      createdAt: new Date().toISOString(),
    };
    fallbackItems.unshift(fallbackItem);
    return res.status(201).json({ success: true, source: 'memory-fallback', data: fallbackItem });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const { id } = req.params;
    if (getDBStatus() === 'connected') {
      const deleted = await Item.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }
      return res.status(200).json({ success: true, message: 'Item deleted successfully' });
    }

    fallbackItems = fallbackItems.filter((item) => item._id !== id);
    return res.status(200).json({ success: true, message: 'Item deleted from fallback store' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
