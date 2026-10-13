import bcrypt from 'bcryptjs';
import { StaffUser } from '../models/StaffUser.model.js';
import { MagazineForm } from '../models/MagazineForm.model.js';
import { SystemConfig } from '../models/SystemConfig.model.js';

export const seedInitialData = async () => {
  try {
    const staffCount = await StaffUser.countDocuments();
    if (staffCount === 0) {
      console.log('[Seed] Seeding initial staff accounts...');
      const defaultPasswordHash = await bcrypt.hash('tinzel123', 10);

      await StaffUser.create([
        {
          name: 'System Admin',
          email: 'admin@tinzel.com',
          passwordHash: defaultPasswordHash,
          role: 'admin',
          phone: '+255711000001',
          isActive: true,
        },
        {
          name: 'Production Manager',
          email: 'manager@tinzel.com',
          passwordHash: defaultPasswordHash,
          role: 'manager',
          phone: '+255711000002',
          isActive: true,
        },
        {
          name: 'Zawadi Mwangi',
          email: 'designer1@tinzel.com',
          passwordHash: defaultPasswordHash,
          role: 'designer',
          phone: '+255711000003',
          isActive: true,
          isEligibleForAssignment: true,
          maxActiveWorkload: 5,
          currentActiveWorkload: 0,
        },
        {
          name: 'Juma Kassim',
          email: 'designer2@tinzel.com',
          passwordHash: defaultPasswordHash,
          role: 'designer',
          phone: '+255711000004',
          isActive: true,
          isEligibleForAssignment: true,
          maxActiveWorkload: 5,
          currentActiveWorkload: 0,
        },
      ]);
      console.log('[Seed] Default staff created (password: tinzel123)');
    }

    const formCount = await MagazineForm.countDocuments();
    if (formCount === 0) {
      console.log('[Seed] Seeding initial magazine forms...');
      await MagazineForm.create([
        {
          title: 'Harusi Yetu - Wedding Edition',
          slug: 'wedding-magazine',
          description: 'Personalized luxury wedding magazine celebrating your union with custom layouts and high-res photography.',
          magazineType: 'Wedding Magazine',
          price: 75000,
          currency: 'TZS',
          lipaNambaInstructions: {
            tillNumber: '55667788',
            accountName: 'Tinzel Media Ltd',
            instructions: 'Lipa kupitia M-Pesa / Tigo Pesa ukichagua Lipa kwa Simu (Lipa Namba: 55667788). Weka jina lako kama kumbukumbu.',
          },
          fields: [
            {
              fieldId: 'couple_names',
              label: 'Majina ya Mahorusi (Bride & Groom)',
              type: 'text',
              required: true,
              order: 1,
              helperText: 'Mfano: Emmanuel & Neema',
            },
            {
              fieldId: 'event_date',
              label: 'Tarehe ya Harusi',
              type: 'date',
              required: true,
              order: 2,
            },
            {
              fieldId: 'venue',
              label: 'Ukumbi / Eneo la Sherehe',
              type: 'text',
              required: true,
              order: 3,
              helperText: 'Mfano: Serena Hotel, Dar es Salaam',
            },
            {
              fieldId: 'love_story',
              label: 'Hadithi Yenu Fupi ya Mapenzi',
              type: 'textarea',
              required: false,
              order: 4,
              helperText: 'Maneno 100-300 yatakayowekwa kwenye ukurasa wa kwanza wa jarida.',
            },
            {
              fieldId: 'photos',
              label: 'Picha za Harusi & Send-Off',
              type: 'photo_upload',
              required: true,
              order: 5,
              helperText: 'Pakia picha zenye ubora wa juu (angalau picha 5)',
              validationRules: { minPhotos: 5, maxPhotos: 20 },
            },
          ],
          isActive: true,
        },
        {
          title: 'Birthday Celebration Special',
          slug: 'birthday-special',
          description: 'A bespoke milestone birthday magazine highlighting memories, tributes, and milestones.',
          magazineType: 'Birthday Magazine',
          price: 50000,
          currency: 'TZS',
          lipaNambaInstructions: {
            tillNumber: '55667788',
            accountName: 'Tinzel Media Ltd',
            instructions: 'Lipa kupitia Lipa Namba 55667788.',
          },
          fields: [
            {
              fieldId: 'celebrant_name',
              label: 'Jina la Msherehekeaji',
              type: 'text',
              required: true,
              order: 1,
            },
            {
              fieldId: 'age',
              label: 'Umri Unaosherehekewa (Age)',
              type: 'number',
              required: true,
              order: 2,
            },
            {
              fieldId: 'tribute',
              label: 'Ujumbe wa Ponzi / Tribute Message',
              type: 'textarea',
              required: false,
              order: 3,
            },
            {
              fieldId: 'photos',
              label: 'Picha za Kumbukumbu',
              type: 'photo_upload',
              required: true,
              order: 4,
              validationRules: { minPhotos: 3, maxPhotos: 15 },
            },
          ],
          isActive: true,
        },
      ]);
      console.log('[Seed] Default forms created');
    }

    const configCount = await SystemConfig.countDocuments();
    if (configCount === 0) {
      await SystemConfig.create([
        {
          key: 'printer_whatsapp_phone',
          value: '+255712345678',
          description: 'Account-free printing partner WhatsApp phone number',
        },
        {
          key: 'assignment_strategy',
          value: 'lowest_workload',
          description: 'Automated designer assignment strategy',
        },
      ]);
    }
  } catch (error) {
    console.warn(`[Seed Notice] Seed script encountered an issue: ${error.message}`);
  }
};
