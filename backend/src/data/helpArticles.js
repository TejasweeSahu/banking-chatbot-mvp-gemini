/**
 * Grounded help-centre content for the assistant's FAQ answers. The assistant
 * may only quote policy/timelines from these articles (via search_help_articles).
 * Timelines reflect common Indian banking practice and are illustrative for this demo.
 */

export const HELP_ARTICLES = [
  {
    id: 'upi-failed-debited',
    title: 'UPI payment failed but money was debited',
    tags: ['upi', 'failed', 'debited', 'deducted', 'reversal', 'refund'],
    body: 'If a UPI payment fails after your account is debited, the amount is automatically reversed to your account, usually within T+1 working day. If the reversal has not happened after 1 working day, raise a complaint under "Failed UPI transaction" with the transaction reference. Banks pay compensation for delayed reversals as per RBI turnaround-time rules. A payment marked "Failed" in Northstar with no debit means no money left your account.'
  },
  {
    id: 'upi-pending',
    title: 'UPI or IMPS payment is pending',
    tags: ['pending', 'upi', 'imps', 'processing', 'stuck', 'hold'],
    body: 'A pending payment is waiting for confirmation from the beneficiary bank. The amount is held and reduces your available balance. Most pending payments resolve within 1 working day: they either complete or the money is returned automatically. Do not retry the same payment while it is pending to avoid paying twice. If it is still pending after 2 working days, raise a "Pending payment" complaint.'
  },
  {
    id: 'refund-timelines',
    title: 'Merchant refund timelines',
    tags: ['refund', 'return', 'merchant', 'credited', 'cancel', 'order'],
    body: 'Refunds are initiated by the merchant. After the merchant processes a refund, card refunds typically take 5–7 working days and UPI refunds 1–3 working days to reach your account. If the merchant confirms the refund was sent but you have not received it after 7 working days, raise a "Refund" complaint with the original transaction.'
  },
  {
    id: 'duplicate-charge',
    title: 'Charged twice for the same purchase',
    tags: ['duplicate', 'twice', 'double', 'charged', 'two'],
    body: 'If you see two identical charges from the same merchant within minutes, first check with the merchant whether two orders were placed. If only one order exists, raise a "Duplicate charge" complaint. Northstar will investigate with the merchant\'s bank; resolution typically takes up to 7 working days. The duplicate amount is credited back if confirmed.'
  },
  {
    id: 'card-block',
    title: 'Blocking a lost or stolen card',
    tags: ['card', 'block', 'lost', 'stolen', 'freeze', 'fraud'],
    body: 'Block your card immediately if it is lost, stolen or you notice transactions you do not recognise. A permanent block (lost, stolen, suspicious activity) cannot be reversed and a replacement card is issued in 5–7 working days. A temporary block can be removed at any time. Blocking a card does not affect UPI or net banking.'
  },
  {
    id: 'dispute',
    title: 'Disputing a card transaction (chargeback)',
    tags: ['dispute', 'chargeback', 'unauthorised', 'unauthorized', 'fraud', 'not recognise', 'goods not received'],
    body: 'You can dispute a card transaction you did not authorise, or where goods/services were not delivered. Raise a "Transaction dispute" complaint with the transaction. Disputes are processed through the card network and can take up to 30–45 days. Report unauthorised electronic transactions within 3 days to limit your liability to zero under RBI guidelines.'
  },
  {
    id: 'transfer-methods',
    title: 'UPI, IMPS, NEFT and RTGS — limits and timings',
    tags: ['upi', 'imps', 'neft', 'rtgs', 'limit', 'transfer', 'timing', 'method'],
    body: 'UPI: up to ₹1,00,000 per transaction, instant, requires the beneficiary\'s UPI ID. IMPS: up to ₹5,00,000, instant, 24×7. NEFT: up to ₹10,00,000 in this app, settles in half-hourly batches 24×7. RTGS: minimum ₹2,00,000, real-time. Northstar applies a daily limit of ₹2,00,000 for transfers to beneficiaries. Transfers between your own accounts are instant.'
  },
  {
    id: 'add-beneficiary',
    title: 'Adding a beneficiary safely',
    tags: ['beneficiary', 'add', 'payee', 'new'],
    body: 'Transfers can only be made to saved beneficiaries. Add a beneficiary with their name, account number and IFSC (UPI ID optional). Always verify details directly with the recipient. Northstar will never ask you to add a beneficiary over a phone call.'
  },
  {
    id: 'complaint-escalation',
    title: 'Complaint resolution and escalation',
    tags: ['complaint', 'escalate', 'grievance', 'ombudsman', 'not resolved', 'sla', 'human', 'agent'],
    body: 'Every complaint gets a reference number and a target resolution date. If it is not resolved by that date, or you are unhappy with the response, you can escalate it; escalated complaints are reviewed by a senior grievance officer within 3 working days. You can also call the 24×7 helpline at 1800-000-0000 (simulated). If the bank does not resolve your complaint within 30 days, you may approach the RBI Ombudsman.'
  },
  {
    id: 'security',
    title: 'Keeping your account secure',
    tags: ['otp', 'pin', 'password', 'phishing', 'scam', 'security', 'cvv'],
    body: 'Northstar will never ask for your OTP, UPI PIN, card PIN, CVV or password — not by phone, SMS, email or in this chat. Never share them with anyone. You do not need to enter your UPI PIN to receive money.'
  },
  {
    id: 'available-balance',
    title: 'Why my available balance differs from my balance',
    tags: ['available', 'balance', 'hold', 'difference', 'ledger'],
    body: 'Your available balance is your account balance minus amounts on hold for pending payments. When a pending payment completes, the hold becomes a regular debit; if it fails, the hold is released.'
  }
];
