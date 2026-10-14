import mongoose from 'mongoose';

const formFieldSchema = new mongoose.Schema(
  {
    fieldId: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['text', 'textarea', 'photo_upload', 'dropdown', 'radio', 'date', 'number'],
      required: true,
      default: 'text',
    },
    required: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      default: 0,
    },
    helperText: {
      type: String,
      default: '',
    },
    options: {
      type: [String],
      default: [],
    },
    validationRules: {
      minPhotos: { type: Number, default: 0 },
      maxPhotos: { type: Number, default: 10 },
      minChar: { type: Number, default: 0 },
      maxChar: { type: Number, default: 5000 },
    },
  },
  { _id: false }
);

const magazineFormSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Form title is required'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Form slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    magazineType: {
      type: String,
      default: 'Standard Event Magazine',
    },
    price: {
      type: Number,
      required: true,
      default: 50000,
    },
    currency: {
      type: String,
      default: 'TZS',
    },
    coverImageUrl: {
      type: String,
      default: '/brand/magazine-cover-sample.jpg',
    },
    lipaNambaInstructions: {
      tillNumber: { type: String, default: '55667788' },
      accountName: { type: String, default: 'Tinzel Media Ltd' },
      instructions: {
        type: String,
        default:
          'Lipa kupitia M-Pesa / Tigo Pesa / Airtel Money ukitumia Lipa Namba (Till Number). Weka jina lako kama reference.',
      },
    },
    fields: [formFieldSchema],
    isActive: {
      type: Boolean,
      default: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  }
);

export const MagazineForm = mongoose.model('MagazineForm', magazineFormSchema);
