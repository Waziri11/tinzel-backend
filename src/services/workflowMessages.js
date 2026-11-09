import { requiredDeposit } from './paymentPolicy.js';
import { messageContent } from './accountMessages.js';

const copy = {
  balance_payment_requested: ['Balance payment required', 'Malipo yaliyobaki yanahitajika', 'The customer approved the magazine. Verify the remaining {balance} before printing.', 'Mteja ameidhinisha jarida. Thibitisha malipo yaliyobaki ya {balance} kabla ya uchapishaji.'],
  balance_payment_submitted: ['Payment awaiting approval', 'Malipo yanasubiri idhini', 'The customer reported a payment of {amount}. Check reference {paymentReference} and approve it in the Payment section.', 'Mteja ametuma taarifa za malipo ya {amount}. Kagua kumbukumbu {paymentReference} na uidhinishe kwenye sehemu ya Malipo.'],
  balance_payment_verified: ['Payment approved', 'Malipo yameidhinishwa', 'Payment of {amount} was approved. Remaining balance: {balance}.', 'Malipo ya {amount} yameidhinishwa. Salio lililobaki: {balance}.'],
  balance_payment_complete: ['Full payment approved', 'Malipo yote yameidhinishwa', 'The order is fully paid. Prepare the approved magazine for printing.', 'Malipo ya oda yamekamilika. Andaa jarida lililoidhinishwa kwa uchapishaji.'],
  balance_payment_rejected: ['Payment needs correction', 'Malipo yanahitaji marekebisho', 'The reported payment could not be confirmed. {reason}', 'Malipo uliyotuma hayakuweza kuthibitishwa. {reason}'],
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

// Customer updates describe their magazine and next action, without staff handoff instructions.
const customerCopy = {
  balance_payment_requested: ['Pay the remaining balance', 'Lipa kiasi kilichobaki', 'Your magazine is approved. Pay the remaining {balance} using your order’s payment instructions, then send your payment reference. Printing starts after we confirm full payment.', 'Jarida lako limeidhinishwa. Lipa kiasi kilichobaki cha {balance} kwa kufuata maelekezo kwenye oda yako, kisha tuma kumbukumbu ya malipo. Uchapishaji utaanza baada ya kuthibitisha malipo yote.'],
  balance_payment_submitted: ['Payment sent for verification', 'Malipo yametumwa kwa uthibitisho', 'We received your payment reference for {amount}. We will verify it before printing.', 'Tumepokea kumbukumbu yako ya malipo ya {amount}. Tutayathibitisha kabla ya uchapishaji.'],
  balance_payment_verified: ['Payment confirmed', 'Malipo yamethibitishwa', 'We confirmed your payment of {amount}. Your remaining balance is {balance}.', 'Tumethibitisha malipo yako ya {amount}. Kiasi kilichobaki ni {balance}.'],
  balance_payment_complete: ['Payment complete', 'Malipo yamekamilika', 'Thank you! Your full payment is confirmed. Your approved magazine can now move to printing.', 'Asante! Malipo yako yote yamethibitishwa. Jarida lako lililoidhinishwa sasa linaweza kuendelea kwa uchapishaji.'],

  client_submission: ['We have your order', 'Tumepokea oda yako', 'Your magazine details are saved. Pay {deposit} as your deposit using the payment instructions on your order. We will begin designing your magazine once this payment is confirmed.', 'Taarifa za jarida lako zimehifadhiwa. Lipa {deposit} kama malipo ya awali kwa kufuata maelekezo kwenye oda yako. Tutaanza kubuni jarida lako malipo haya yakithibitishwa.'],
  payment_verified: ['Payment received', 'Malipo yamepokelewa', 'Thank you! Your payment is confirmed. We will start work on your magazine next.', 'Asante! Malipo yako yamethibitishwa. Hatua inayofuata ni kuanza kubuni jarida lako.'],
  draft_released: ['Your magazine is ready to review', 'Jarida lako liko tayari kwa mapitio yako', 'Open your magazine preview (version {version}) and check every page. Approve it for printing or tell us what you would like changed.', 'Fungua jarida lako (toleo la {version}) na upitie kila ukurasa. Idhinisha uchapishaji au tuambie marekebisho unayotaka.'],
  printing_in_progress: ['Your magazine is being printed', 'Jarida lako linachapishwa', 'We are printing your magazine. Next, we will get it ready for delivery.', 'Tunachapisha jarida lako. Hatua inayofuata ni kuliandaa kwa uwasilishaji.'],
  order_dispatched: ['Your magazine is on its way', 'Jarida lako liko njiani', 'Your magazine is on its way to you. Track your order for delivery updates.', 'Jarida lako liko njiani kukufikia. Fuatilia oda yako kupata taarifa za uwasilishaji.'],
  order_closed: ['Your magazine has been delivered', 'Jarida lako limewasilishwa', 'Your order is complete. Thank you for choosing Tinzel!', 'Oda yako imekamilika. Asante kwa kuchagua Tinzel!'],
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
  if (type === 'balance_payment_verified' && event.balanceRemaining === 0) key = 'balance_payment_complete';
  const words = (recipient.role === 'client' && customerCopy[key]) || copy[key];
  if (!words) throw new Error('Unsupported workflow notification');

  const ref = order.trackingId || '';
  const values = { ref, client: order.clientName, magazine: order.formTitle || (sw ? 'jarida' : 'magazine details'), version: event.version || 1 };
  const total = order.totalPrice ?? order.formId?.price ?? order.price;
  const currency = order.currency || order.formId?.currency || 'TZS';
  const currencyLabel = ['TZS', 'TSH'].includes(currency.toUpperCase()) ? 'TSh' : currency;
  const money = amount => `${currencyLabel} ${Number(amount || 0).toLocaleString('en-TZ', { maximumFractionDigits: 2 })}`;
  Object.assign(values, { balance: money(event.balanceRemaining), amount: money(event.paymentAmount), paymentReference: event.paymentReference || '', reason: event.paymentReason || '' });
  values.deposit = total != null && Number.isFinite(Number(total)) && Number(total) >= 0
    ? `${currencyLabel} ${requiredDeposit(order).toLocaleString('en-TZ')}`
    : (sw ? 'kiasi kilichoonyeshwa kwenye oda yako' : 'the amount shown on your order');
  const body = words[sw ? 3 : 2].replace(/\{(\w+)\}/g, (_, name) => values[name]);
  const lines = [body];
  if (order.isExpress) {
    const due = order.expressDueAt && new Date(order.expressDueAt).toLocaleString(sw ? 'sw-TZ' : 'en-GB', { timeZone: 'Africa/Dar_es_Salaam', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    lines.unshift(sw ? 'EXPRESS — Oda ya kipaumbele.' : 'EXPRESS — Priority order.');
    lines.push(due
      ? `${sw ? 'Muda wa mwisho' : 'Due'}: ${due} EAT. ${sw ? 'Jumapili haihesabiwi.' : 'Sundays excluded.'}`
      : (sw ? 'Saa 24 baada ya malipo ya awali kuthibitishwa; Jumapili haihesabiwi. Ada ya Express: TSh 20,000.' : '24 hours from deposit confirmation; Sundays excluded. Express fee: TSh 20,000.'));
  }
  if (recipient.role !== 'client' && key !== 'order_submitted') {
    lines.push([order.clientName, order.formTitle].filter(Boolean).join(' · '));
  }
  if (ref && type !== 'print_dispatched' && !['manager', 'admin', 'designer'].includes(recipient.role)) lines.push(ref);
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
  return messageContent((order.isExpress ? 'EXPRESS · ' : '') + words[sw ? 1 : 0], lines.filter(Boolean).join('\n'), language(lang), recipient.channel === 'in_system' ? null : actionUrl, recipient.role === 'client' ? (sw ? 'Fuatilia oda yangu' : 'Track my order') : undefined);
}
