/**
 * @file backend/src/data/mockData.js
 * @description Seed dataset for the demo banking environment.
 * Contains the mock authenticated user (`Tejas`, balance ₹58,250.75), an initial ledger of 10
 * transactions spanning October–November 2026 across various categories, and saved beneficiaries (Rahul, Priya).
 */

export const MOCK_USER = {
  id: 'mock-user-001',
  name: 'Tejas',
  accountLast4: '2048',
  balance: 58250.75,
  currency: 'INR',
  cardLast4: '7812',
  cardBlocked: false
};

// Dates are intentionally fixed so the assessment demo is predictable.
export const MOCK_TRANSACTIONS = [
  { id: 'txn-1001', date: '2026-11-08', description: 'Swiggy Order', merchant: 'Swiggy', category: 'food', type: 'debit', amount: 450 },
  { id: 'txn-1002', date: '2026-11-07', description: 'Uber Ride', merchant: 'Uber', category: 'transport', type: 'debit', amount: 250 },
  { id: 'txn-1003', date: '2026-11-06', description: 'Cafe Coffee Day', merchant: 'Cafe Coffee Day', category: 'food', type: 'debit', amount: 320 },
  { id: 'txn-1004', date: '2026-11-05', description: 'Amazon Shopping', merchant: 'Amazon', category: 'shopping', type: 'debit', amount: 1299 },
  { id: 'txn-1005', date: '2026-11-04', description: 'Zomato Order', merchant: 'Zomato', category: 'food', type: 'debit', amount: 680 },
  { id: 'txn-1006', date: '2026-11-02', description: 'Airtel Broadband', merchant: 'Airtel', category: 'bills', type: 'debit', amount: 799 },
  { id: 'txn-1007', date: '2026-11-01', description: 'Monthly Salary', merchant: 'Employer', category: 'income', type: 'credit', amount: 45000 },
  { id: 'txn-1008', date: '2026-10-30', description: 'Grocery Store', merchant: 'Reliance Fresh', category: 'food', type: 'debit', amount: 1450 },
  { id: 'txn-1009', date: '2026-10-28', description: 'Electricity Bill', merchant: 'TP Central Odisha', category: 'bills', type: 'debit', amount: 1120 },
  { id: 'txn-1010', date: '2026-10-25', description: 'Movie Tickets', merchant: 'BookMyShow', category: 'entertainment', type: 'debit', amount: 540 }
];

export const MOCK_RECIPIENTS = {
  rahul: { name: 'Rahul', accountLast4: '4821' },
  priya: { name: 'Priya', accountLast4: '9274' }
};
