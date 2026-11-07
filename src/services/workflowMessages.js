import { messageContent } from './accountMessages.js';

const copy = {
  order_submitted: ['New magazine submission', 'Oda mpya ya jarida', '{client} submitted {magazine}. Verify payment.', '{client} ametuma taarifa za {magazine}. Thibitisha malipo.'],
  client_submission: ['Order received', 'Tumepokea oda yako', 'We received your magazine details. Follow the payment instructions on your order.', 'Tumepokea taarifa za jarida lako. Fuata maelekezo ya malipo kwenye oda yako.'],
  payment_verified: ['Payment confirmed', 'Malipo yamethibitishwa', 'Payment received. Track your magazine below.', 'Tumepokea malipo. Fuatilia jarida lako hapa chini.'],
  assignment_queued: ['Order needs a designer', 'Oda inahitaji mbunifu', 'Payment received. Assign a designer when one is available.', 'Malipo yamepokelewa. Mkabidhi mbunifu oda hii akipatikana.'],
  order_assigned: ['New design order', 'Oda mpya ya usanifu', 'Start the design using the submitted details and photos.', 'Anza usanifu kwa kutumia taarifa na picha zilizotumwa.'],
  draft_uploaded: ['Draft ready', 'Rasimu iko tayari', 'Review draft {version}.', 'Kagua rasimu ya toleo la {version}.'],
  draft_released: ['Review your magazine', 'Kagua jarida lako', 'Review version {version}. Approve it or send corrections.', 'Kagua toleo la {version}. Liidhinishe au tuma marekebisho.'],
  draft_returned: ['Draft needs changes', 'Rasimu inahitaji marekebisho', 'Make the requested changes to version {version} and upload the new draft.', 'Rekebisha toleo la {version} kulingana na maoni, kisha pakia rasimu mpya.'],
  client_revision_requested: ['Changes requested', 'Marekebisho yameombwa', 'Update version {version} using the customer’s feedback.', 'Rekebisha toleo la {version} kulingana na maoni ya mteja.'],
  revision_update: ['Changes requested', 'Marekebisho yameombwa', 'The customer requested changes to version {version}.', 'Mteja ameomba marekebisho ya toleo la {version}.'],
  client_approved: ['Magazine approved', 'Jarida limeidhinishwa', 'Version {version} was approved. Upload the print file.', 'Toleo la {version} limeidhinishwa. Pakia faili la uchapishaji.'],
  approval_update: ['Magazine approved', 'Jarida limeidhinishwa', 'The customer approved version {version}.', 'Mteja ameidhinisha toleo la {version}.'],
  print_document_uploaded: ['Print file ready', 'Faili la uchapishaji liko tayari', 'Review the print file for version {version} and authorize printing.', 'Kagua faili la toleo la {version} na uidhinishe uchapishaji.'],
  print_dispatched: ['New print job', 'Kazi mpya ya uchapishaji', 'Open the print file. Reply POKEA {ref} to confirm receipt.', 'Fungua faili la uchapishaji. Jibu POKEA {ref} kuthibitisha umelipokea.'],
  print_sms: ['New print job', 'Kazi mpya ya uchapishaji', 'Open WhatsApp and reply POKEA {ref} to confirm receipt.', 'Fungua WhatsApp na ujibu POKEA {ref} kuthibitisha umepokea faili.'],
  printing_in_progress: ['Printing started', 'Uchapishaji umeanza', 'Your magazine is being printed.', 'Jarida lako linachapishwa.'],
  print_update: ['Printing started', 'Uchapishaji umeanza', 'The magazine is being printed.', 'Jarida linachapishwa.'],
  printing_completed: ['Printing complete', 'Uchapishaji umekamilika', 'Printing is complete. Arrange delivery.', 'Jarida limechapishwa. Panga usafirishaji.'],
  order_dispatched: ['Magazine dispatched', 'Jarida limesafirishwa', 'Your magazine is on its way.', 'Jarida lako liko njiani.'],
  order_closed: ['Magazine delivered', 'Jarida limewasilishwa', 'Delivery confirmed. The order is complete.', 'Jarida limepokelewa. Oda imekamilika.'],
};

const staffUpdates = {
  client_revision_requested: 'revision_update',
  client_approved: 'approval_update',
  printing_in_progress: 'print_update',
};

export const language = value => value === 'en' ? 'en' : 'sw';

export function workflowMessage(type, order, event, recipient, lang, actionUrl) {
  const sw = language(lang) === 'sw';
  const staff = ['manager', 'admin'].includes(recipient.role);
  let key = (staff && staffUpdates[type]) || type;
  if (type === 'order_submitted' && recipient.role === 'client') key = 'client_submission';
  if (type === 'print_dispatched' && recipient.channel !== 'whatsapp') key = 'print_sms';
  const words = copy[key];
  if (!words) throw new Error('Unsupported workflow notification');

  const ref = order.trackingId || '';
  const values = { ref, client: order.clientName, magazine: order.formTitle || (sw ? 'jarida' : 'magazine details'), version: event.version || 1 };
  const body = words[sw ? 3 : 2].replace(/\{(\w+)\}/g, (_, name) => values[name]);
  const lines = [body];
  if (recipient.role !== 'client' && key !== 'order_submitted') {
    lines.push([order.clientName, order.formTitle].filter(Boolean).join(' · '));
  }
  if (ref && type !== 'print_dispatched') lines.push(ref);
  if (type === 'payment_verified') {
    const { amountPaid, lipaNambaReference } = order.paymentDetails || {};
    if (amountPaid > 0) lines.push(`TZS ${amountPaid.toLocaleString(sw ? 'sw-TZ' : 'en-TZ')}`);
    if (lipaNambaReference) lines.push(lipaNambaReference);
  }
  if (type === 'order_dispatched') {
    const { carrier, trackingReference } = order.dispatchDetails || {};
    if (carrier || trackingReference) lines.push([carrier, trackingReference].filter(Boolean).join(' · '));
  }
  if (type === 'print_dispatched' && recipient.channel === 'whatsapp') {
    const specs = order.printDocument?.specs || {}, unknown = sw ? 'Haijawekwa' : 'Not recorded';
    lines.push(`${sw ? 'Toleo lililoidhinishwa' : 'Approved version'}: ${values.version}`, `${sw ? 'Nakala' : 'Copies'}: ${specs.quantity ?? unknown}`, `${sw ? 'Karatasi' : 'Paper'}: ${specs.paperType || unknown}`, `${sw ? 'Kava' : 'Cover'}: ${specs.coverFinish || unknown}`, `${sw ? 'Ufungaji' : 'Binding'}: ${specs.binding || unknown}`);
  }
  return messageContent(words[sw ? 1 : 0], lines.filter(Boolean).join('\n'), language(lang), recipient.channel === 'in_system' ? null : actionUrl);
}
